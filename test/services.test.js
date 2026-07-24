'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validate, match, normalisePorts } = require('../server/lib/services');

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

test('validate rejects malformed top-level shapes', () => {
  assert.match(validate(null).errors[0], /not an object/);
  assert.match(validate({}).errors[0], /"services" array/);
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
