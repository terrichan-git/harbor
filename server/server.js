'use strict';
// Harbor — one process, one port. Serves the static frontend AND the JSON API. Binds 0.0.0.0
// so the tailnet can reach it (PRD: remote control), protected by the token in auth.js.

const fs = require('fs');
const path = require('path');
const express = require('express');

const { PATHS } = require('./lib/paths');
const ports = require('./lib/ports');
const servicesLib = require('./lib/services');
const registry = require('./lib/registry');
const processes = require('./lib/processes');
const safety = require('./lib/safety');
const tailscale = require('./lib/tailscale');
const auth = require('./lib/auth');
const webauthn = require('./lib/webauthn');

// Default port lives in one place (lib/config); 7071 because 7070 is commonly taken by other
// local dev servers. Override at runtime with HARBOR_PORT.
const PORT = Number(process.env.HARBOR_PORT) || require('./lib/config').DEFAULT_PORT;
const HOST = '0.0.0.0';
const SELF_PID = process.pid;
const CURRENT_UID = process.getuid();

const app = express();
app.use(express.json());

// ---- startup: token + re-adopt anything still running -----------------------
auth.getOrCreateToken();
reconcileOnStartup();

// Re-adopt services that survived a previous Harbor (PRD decision #1). Reconcile decision is the
// unit-tested pure function; here we just apply it: keep the live ones, delete stale PID files.
// Identity is verified by port (see registry.reconcile) using a live lsof snapshot.
async function reconcileOnStartup() {
  const records = registry.readAll();
  if (!records.length) return;
  let pidPorts = new Map();
  try {
    const listeners = await ports.listListeners();
    pidPorts = new Map(listeners.map((l) => [l.pid, l.ports]));
  } catch {
    /* lsof unavailable — reconcile falls back to trusting liveness */
  }
  const { adopt, stale } = registry.reconcile(records, {
    isAlive: registry.isAlive,
    // null when we have no lsof snapshot at all, so reconcile trusts liveness instead of disowning.
    portsOf: (pid) => (pidPorts.size ? pidPorts.get(pid) || [] : null),
  });
  for (const s of stale) registry.remove(s.name);
  if (adopt.length) console.log(`[harbor] re-adopted ${adopt.length} running service(s): ${adopt.map((a) => a.name).join(', ')}`);
  if (stale.length) console.log(`[harbor] cleaned ${stale.length} stale PID file(s)`);
}

// ---- static frontend --------------------------------------------------------
// index.html is served with the token injected for loopback requests, so the laptop UI works
// with zero token entry. Remote requests get a blank token and must supply ?token= once.
app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(PATHS.PUBLIC, 'index.html'), 'utf8');
  const token = auth.isLoopback(req) ? auth.getOrCreateToken() : '';
  html = html.replace('__HARBOR_TOKEN__', token);
  res.type('html').send(html);
});
app.use(express.static(PATHS.PUBLIC));

// ---- read API ---------------------------------------------------------------
// The whole dashboard state in one call: listeners (classified + coloured), service states,
// tailscale host, and whether Touch ID is enrolled.
app.get('/api/state', auth.requireForRead(), async (req, res) => {
  try {
    const listeners = await ports.listListeners();
    const { services, errors } = servicesLib.load();
    const { serviceStates, portToService } = servicesLib.match(services, listeners);

    const managedPids = new Set(registry.readAll().map((r) => r.pid));

    const enriched = listeners.map((l) => {
      const guard = safety.classify(l, { selfPid: SELF_PID, currentUid: CURRENT_UID });
      // A listener is "known" (green) if any of its ports maps to a service; else "rogue" (yellow).
      const serviceName = l.ports.map((p) => portToService.get(p)).find(Boolean) || null;
      return {
        ...l,
        protected: guard.protected,
        protectedReason: guard.reason,
        serviceName,
        managed: managedPids.has(l.pid),
        kind: serviceName ? 'known' : 'rogue',
      };
    });

    const host = await tailscale.getHost();
    res.json({
      self: { pid: SELF_PID, port: PORT },
      listeners: enriched,
      services: serviceStates.map((s) => ({
        name: s.name,
        ports: s.ports,
        command: s.command,
        cwd: s.cwd,
        autostart: s.autostart,
        running: s.running,
        pid: s.listener ? s.listener.pid : null,
        managed: s.listener ? managedPids.has(s.listener.pid) : false,
      })),
      configErrors: errors,
      tailscale: { host },
      touchId: { enrolled: webauthn.isEnrolled() },
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// last ~100 lines of a service's log
app.get('/api/services/:name/logs', auth.requireForRead(), (req, res) => {
  const { services } = servicesLib.load();
  const svc = services.find((s) => s.name === req.params.name);
  if (!svc) return res.status(404).json({ error: 'unknown service' });
  const logPath = path.join(PATHS.LOGS, `${req.params.name}.log`);
  try {
    const text = fs.readFileSync(logPath, 'utf8');
    const lines = text.split('\n');
    res.json({ lines: lines.slice(-100) });
  } catch {
    res.json({ lines: ['(no log yet — start the service to create one)'] });
  }
});

// ---- mutating API (token + same-site, plus Touch ID on destructive actions) -
const mutate = auth.requireForMutation();
const destructive = [auth.requireForMutation(), webauthn.requireUnlock()];

// Kill a listening process by pid. force:true = SIGKILL (only sent after the UI confirms).
app.post('/api/kill', destructive, async (req, res) => {
  const pid = Number(req.body && req.body.pid);
  const force = req.body && req.body.force === true;
  if (!Number.isInteger(pid)) return res.status(400).json({ error: 'pid required' });

  // Re-check the guard server-side — never trust the client that a pid is killable.
  const listeners = await ports.listListeners();
  const target = listeners.find((l) => l.pid === pid);
  if (target) {
    const guard = safety.classify(target, { selfPid: SELF_PID, currentUid: CURRENT_UID });
    if (guard.protected) return res.status(403).json({ error: `refused: ${guard.reason}` });
  }
  try {
    const result = await processes.killPid(pid, { force });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/services/:name/start', mutate, (req, res) => {
  const { services } = servicesLib.load();
  const svc = services.find((s) => s.name === req.params.name);
  if (!svc) return res.status(404).json({ error: 'unknown service' });
  try {
    const record = processes.startService(svc);
    res.json({ status: 'started', pid: record.pid });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/services/:name/stop', destructive, async (req, res) => {
  const force = req.body && req.body.force === true;
  const record = registry.read(req.params.name);
  if (!record) {
    // Not started by Harbor (or already stopped). If it's running as a rogue match, the user
    // should use Kill on the ports row instead.
    return res.status(409).json({ error: 'not managed by Harbor — use Kill on the ports list' });
  }
  try {
    const result = await processes.stopManaged(record, { force });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---- WebAuthn / Touch ID enrollment + unlock --------------------------------
// Enrollment is a mutation (token-gated). It only works over localhost (webauthn.js enforces).
app.post('/api/webauthn/register/options', mutate, async (req, res) => {
  try {
    res.json(await webauthn.registrationOptions(req));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err), code: err.code || null });
  }
});
app.post('/api/webauthn/register/verify', mutate, async (req, res) => {
  try {
    res.json(await webauthn.verifyRegistration(req));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});
// Getting an unlock only requires proving Touch ID; it is itself the auth, so no token needed
// (and it is only meaningful/enforced on localhost anyway).
app.post('/api/webauthn/auth/options', async (req, res) => {
  try {
    res.json(await webauthn.authenticationOptions(req));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});
app.post('/api/webauthn/auth/verify', async (req, res) => {
  try {
    res.json(await webauthn.verifyAuthentication(req));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// ---- listen -----------------------------------------------------------------
app.listen(PORT, HOST, () => {
  const token = auth.getOrCreateToken();
  console.log(`\n  Harbor listening on http://localhost:${PORT}  (bound ${HOST})`);
  console.log(`  Laptop UI works with no token. For your phone over Tailscale, open:`);
  tailscale.getHost().then((host) => {
    if (host) console.log(`    http://${host}:${PORT}/?token=${token}\n`);
    else console.log(`    http://<your-machine>.<tailnet>.ts.net:${PORT}/?token=${token}   (tailscale not detected yet)\n`);
  });
});
