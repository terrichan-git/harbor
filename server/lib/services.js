'use strict';
// Known-services config: load + validate services.json, and match running listeners to
// services BY PORT (the match key you chose — see PRD decision #3). Validation and matching
// are pure and unit-tested; loading from disk is the thin wrapper around them.

const fs = require('fs');
const { PATHS } = require('./paths');

// Validate the parsed services.json object. Returns { services: [...normalised], errors: [...] }.
// Normalisation collapses `port` (number) and `port`/`ports` (array) into a numeric ports[].
// A service with validation errors is dropped from `services` and its problem reported —
// one bad entry never takes down the rest.
function validate(raw) {
  const errors = [];
  const services = [];
  if (!raw || typeof raw !== 'object') {
    return { services, errors: ['services.json is not an object'] };
  }
  const list = raw.services;
  if (!Array.isArray(list)) {
    return { services, errors: ['services.json must have a "services" array'] };
  }

  const seenNames = new Set();
  list.forEach((s, i) => {
    const where = `service[${i}]${s && s.name ? ` "${s.name}"` : ''}`;
    if (!s || typeof s !== 'object') {
      errors.push(`${where}: not an object`);
      return;
    }
    if (!s.name || typeof s.name !== 'string') {
      errors.push(`${where}: missing string "name"`);
      return;
    }
    if (seenNames.has(s.name)) {
      errors.push(`${where}: duplicate name "${s.name}"`);
      return;
    }
    if (!s.command || typeof s.command !== 'string') {
      errors.push(`${where}: missing string "command"`);
      return;
    }
    if (!s.cwd || typeof s.cwd !== 'string') {
      errors.push(`${where}: missing string "cwd"`);
      return;
    }
    const ports = normalisePorts(s.port !== undefined ? s.port : s.ports);
    if (!ports.length) {
      errors.push(`${where}: needs a "port" (number) or array of ports`);
      return;
    }
    if (ports.some((p) => !Number.isInteger(p) || p <= 0 || p > 65535)) {
      errors.push(`${where}: ports must be integers 1–65535`);
      return;
    }
    seenNames.add(s.name);
    services.push({
      name: s.name,
      cwd: s.cwd,
      command: s.command,
      ports,
      autostart: s.autostart === true,
    });
  });

  return { services, errors };
}

function normalisePorts(port) {
  if (port === undefined || port === null) return [];
  return Array.isArray(port) ? port.map(Number) : [Number(port)];
}

// Load + validate from disk. Missing file is not fatal — you may not have defined services yet.
function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(PATHS.SERVICES_JSON, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { services: [], errors: [] };
    return { services: [], errors: [`Could not read services.json: ${err.message}`] };
  }
  return validate(raw);
}

// Given the defined services and the live listeners, decide each service's state and flag
// rogue processes. A service is "running" if ANY of its declared ports has a listener.
// Returns:
//   { serviceStates: [{ ...service, running, listener }], portToService: Map<port,name> }
// portToService lets the listener list colour a row green (known) vs yellow (rogue).
function match(services, listeners) {
  const portToService = new Map();
  for (const svc of services) {
    for (const p of svc.ports) {
      // First service to claim a port wins; a collision is a config smell, surfaced by validate's
      // duplicate-name guard only, so we also note nothing here and just keep the first.
      if (!portToService.has(p)) portToService.set(p, svc.name);
    }
  }

  const listenerByPort = new Map();
  for (const l of listeners) {
    for (const p of l.ports) {
      if (!listenerByPort.has(p)) listenerByPort.set(p, l);
    }
  }

  const serviceStates = services.map((svc) => {
    let listener = null;
    for (const p of svc.ports) {
      if (listenerByPort.has(p)) {
        listener = listenerByPort.get(p);
        break;
      }
    }
    return { ...svc, running: !!listener, listener };
  });

  return { serviceStates, portToService };
}

module.exports = { validate, load, match, normalisePorts };
