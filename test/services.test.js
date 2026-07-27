'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validate, match, normalisePorts, normaliseHealthPath, setFlag, setAutostart, setKeepAlive, addService, removeService } = require('../server/lib/services');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('normalisePorts accepts number or array', () => {
  assert.deepStrictEqual(normalisePorts(3000), [3000]);
  assert.deepStrictEqual(normalisePorts([4000, 4001]), [4000, 4001]);
  assert.deepStrictEqual(normalisePorts(undefined), []);
});

test('validate normalises good services and reports bad ones without dropping the batch', () => {
  const { services, errors } = validate({
    services: [
      { name: 'web', cwd: '~/x', command: 'npm run dev', port: 3000 },
      { name: 'multi', cwd: '~/y', command: 'run', port: [4000, 4001], autostart: true },
      { name: 'noport', cwd: '~/z', command: 'run' },
      { name: 'web', cwd: '~/dup', command: 'run', port: 9 }, // duplicate name
      { cwd: '~/n', command: 'run', port: 1 }, // missing name
      { name: 'badport', cwd: '~/b', command: 'run', port: 70000 },
    ],
  });
  assert.deepStrictEqual(services.map((s) => s.name), ['web', 'multi']);
  assert.deepStrictEqual(services[1].ports, [4000, 4001]);
  assert.strictEqual(services[1].autostart, true);
  assert.strictEqual(services[0].autostart, false); // defaults to false
  assert.strictEqual(errors.length, 4);
});

test('normaliseHealthPath adds a leading slash and treats blank/non-string as no check', () => {
  assert.strictEqual(normaliseHealthPath('/health'), '/health');
  assert.strictEqual(normaliseHealthPath('health'), '/health');
  assert.strictEqual(normaliseHealthPath('  /ready '), '/ready');
  assert.strictEqual(normaliseHealthPath(''), null);
  assert.strictEqual(normaliseHealthPath(undefined), null);
  assert.strictEqual(normaliseHealthPath(123), null);
});

test('setFlag toggles autostart/keepAlive independently and rejects unknown flags', () => {
  const tmp = path.join(os.tmpdir(), `harbor-flag-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ services: [{ name: 'a', cwd: '~/x', command: 'c', port: 3000 }] }, null, 2));
  try {
    assert.strictEqual(setKeepAlive('a', true, tmp).keepAlive, true);
    assert.strictEqual(setAutostart('a', true, tmp).autostart, true);
    const after = JSON.parse(fs.readFileSync(tmp, 'utf8')).services[0];
    assert.strictEqual(after.keepAlive, true); // both set, independent
    assert.strictEqual(after.autostart, true);
    assert.strictEqual(setKeepAlive('a', false, tmp).keepAlive, false);
    assert.strictEqual(JSON.parse(fs.readFileSync(tmp, 'utf8')).services[0].autostart, true); // untouched
    assert.strictEqual(setFlag('a', 'bogus', true, tmp).ok, false); // unknown flag refused
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('validate defaults keepAlive to false and honours true', () => {
  const { services } = validate({ services: [
    { name: 'a', cwd: '~/x', command: 'c', port: 3000, keepAlive: true },
    { name: 'b', cwd: '~/y', command: 'c', port: 3001 },
  ] });
  assert.strictEqual(services[0].keepAlive, true);
  assert.strictEqual(services[1].keepAlive, false);
});

test('validate carries a normalised health path (and null when absent)', () => {
  const { services } = validate({
    services: [
      { name: 'a', cwd: '~/x', command: 'c', port: 3000, health: 'status' },
      { name: 'b', cwd: '~/y', command: 'c', port: 3001 },
    ],
  });
  assert.strictEqual(services[0].health, '/status');
  assert.strictEqual(services[1].health, null);
});

test('validate rejects malformed top-level shapes', () => {
  assert.match(validate(null).errors[0], /not an object/);
  assert.match(validate({}).errors[0], /"services" array/);
});

test('setAutostart flips only the target flag and preserves the rest of the file', () => {
  // Write path tested against a THROWAWAY copy — never the real services.json.
  const tmp = path.join(os.tmpdir(), `harbor-svc-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({
    $comment: 'keep me',
    services: [
      { name: 'web', cwd: '~/x', command: 'c', port: 3000, autostart: false },
      { name: 'api', cwd: '~/y', command: 'c', port: 8080, autostart: false },
    ],
  }, null, 2));
  try {
    const r = setAutostart('api', true, tmp);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.autostart, true);
    const after = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    assert.strictEqual(after.$comment, 'keep me');           // untouched
    assert.strictEqual(after.services[0].autostart, false);  // web untouched
    assert.strictEqual(after.services[1].autostart, true);   // api flipped
    // unknown service is a clean error, file unchanged
    assert.strictEqual(setAutostart('nope', true, tmp).ok, false);
  } finally {
    fs.rmSync(tmp, { force: true }); // leave no test data behind
  }
});

test('addService appends a validated entry, refuses duplicates and invalid input', () => {
  const tmp = path.join(os.tmpdir(), `harbor-add-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ $comment: 'x', services: [{ name: 'web', cwd: '~/x', command: 'c', port: 3000 }] }, null, 2));
  try {
    const r = addService({ name: 'jumpr', cwd: '~/Projects/Jumpr', command: 'npm run dev', port: 4321 }, tmp);
    assert.strictEqual(r.ok, true);
    const after = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    assert.strictEqual(after.$comment, 'x');                  // preserved
    assert.strictEqual(after.services.length, 2);
    assert.strictEqual(after.services[1].name, 'jumpr');
    assert.strictEqual(after.services[1].port, 4321);
    assert.strictEqual(after.services[1].autostart, false);

    assert.strictEqual(addService({ name: 'jumpr', cwd: '~/x', command: 'c', port: 9999 }, tmp).ok, false); // dup name
    assert.strictEqual(addService({ name: 'noport', cwd: '~/x', command: 'c' }, tmp).ok, false);            // invalid
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('removeService deletes the entry and errors on unknown name', () => {
  const tmp = path.join(os.tmpdir(), `harbor-rm-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ services: [{ name: 'web', cwd: '~/x', command: 'c', port: 3000 }, { name: 'jumpr', cwd: '~/j', command: 'npm start', port: 4321 }] }, null, 2));
  try {
    const r = removeService('jumpr', tmp);
    assert.strictEqual(r.ok, true);
    const after = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    assert.deepStrictEqual(after.services.map((s) => s.name), ['web']);
    assert.strictEqual(removeService('nope', tmp).ok, false);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('match flags a service running when any declared port has a listener', () => {
  const services = [
    { name: 'web', cwd: '~/x', command: 'c', ports: [3000], autostart: false },
    { name: 'docs', cwd: '~/y', command: 'c', ports: [4000, 4001], autostart: false },
    { name: 'off', cwd: '~/z', command: 'c', ports: [9999], autostart: false },
  ];
  const listeners = [
    { pid: 100, ports: [3000] },
    { pid: 200, ports: [4001] }, // second port of docs
    { pid: 300, ports: [5555] }, // rogue
  ];
  const { serviceStates, portToService } = match(services, listeners);
  const byName = Object.fromEntries(serviceStates.map((s) => [s.name, s]));
  assert.strictEqual(byName.web.running, true);
  assert.strictEqual(byName.web.listener.pid, 100);
  assert.strictEqual(byName.docs.running, true);
  assert.strictEqual(byName.docs.listener.pid, 200);
  assert.strictEqual(byName.off.running, false);
  assert.strictEqual(byName.off.listener, null);
  // portToService lets the ports list colour rows: 3000/4000/4001 known, 5555 absent (rogue)
  assert.strictEqual(portToService.get(3000), 'web');
  assert.strictEqual(portToService.get(4001), 'docs');
  assert.strictEqual(portToService.has(5555), false);
});
