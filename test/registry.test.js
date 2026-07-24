'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { reconcile } = require('../server/lib/registry');

const records = [
  { name: 'alive', pid: 100, ports: [3000] },
  { name: 'dead', pid: 200, ports: [3001] },
  { name: 'reused', pid: 300, ports: [3002] },
  { name: 'noverify', pid: 400, ports: [3003] },
];

test('reconcile adopts live processes still on their port, drops dead/reused ones', () => {
  const alivePids = new Set([100, 300, 400]);
  const { adopt, stale } = reconcile(records, {
    isAlive: (pid) => alivePids.has(pid),
    portsOf: (pid) => {
      if (pid === 100) return [3000];        // still on its port -> adopt
      if (pid === 300) return [9999];        // alive but on a different port -> pid reused -> stale
      if (pid === 400) return null;          // lsof unavailable -> trust liveness -> adopt
      return [];
    },
  });
  assert.deepStrictEqual(adopt.map((r) => r.name).sort(), ['alive', 'noverify']);
  const staleByName = Object.fromEntries(stale.map((s) => [s.name, s.why]));
  assert.match(staleByName.dead, /no longer running/);
  assert.match(staleByName.reused, /pid reused/);
});

test('reconcile adopts a legacy record that used {port} instead of {ports}', () => {
  const { adopt } = reconcile([{ name: 'legacy', pid: 500, port: 8080 }], {
    isAlive: () => true,
    portsOf: () => [8080],
  });
  assert.deepStrictEqual(adopt.map((r) => r.name), ['legacy']);
});

test('reconcile is a no-op on an empty registry', () => {
  const { adopt, stale } = reconcile([], { isAlive: () => true, portsOf: () => null });
  assert.deepStrictEqual(adopt, []);
  assert.deepStrictEqual(stale, []);
});
