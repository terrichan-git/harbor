'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseLsof, parseAddress, parsePsCommands, commandToName, mergeListeners } = require('../server/lib/ports');

test('parseAddress handles ipv4, wildcard, and bracketed ipv6', () => {
  assert.deepStrictEqual(parseAddress('127.0.0.1:5432'), { address: '127.0.0.1', port: 5432 });
  assert.deepStrictEqual(parseAddress('*:3000'), { address: '*', port: 3000 });
  assert.deepStrictEqual(parseAddress('[::1]:8080'), { address: '[::1]', port: 8080 });
  assert.strictEqual(parseAddress('garbage'), null);
});

test('parseLsof groups fields per process and yields one row per socket', () => {
  // -F pcuLn style output: p/u/c are process-level, each n is a listening socket
  const out = ['p501', 'u501', 'cnode', 'n*:3000', 'n127.0.0.1:3001', 'p777', 'u0', 'cpostgres', 'n*:5432'].join('\n');
  const rows = parseLsof(out);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], { pid: 501, uid: 501, comm: 'node', address: '*', port: 3000 });
  assert.deepStrictEqual(rows[1], { pid: 501, uid: 501, comm: 'node', address: '127.0.0.1', port: 3001 });
  assert.deepStrictEqual(rows[2], { pid: 777, uid: 0, comm: 'postgres', address: '*', port: 5432 });
});

test('parsePsCommands keeps full command incl. spaces', () => {
  const out = '  501 /usr/local/bin/node /path/dev.js --port 3000\n  777 postgres: writer process';
  const map = parsePsCommands(out);
  assert.strictEqual(map.get(501), '/usr/local/bin/node /path/dev.js --port 3000');
  assert.strictEqual(map.get(777), 'postgres: writer process');
});

test('commandToName is the basename of the first token', () => {
  assert.strictEqual(commandToName('/usr/local/bin/node dev.js', 'x'), 'node');
  assert.strictEqual(commandToName('/Applications/Foo.app/Contents/MacOS/Foo', 'x'), 'Foo');
  assert.strictEqual(commandToName('', 'fallback'), 'fallback');
});

test('mergeListeners collapses multi-port processes and sorts by port', () => {
  const rows = [
    { pid: 501, uid: 501, comm: 'node', address: '*', port: 3001 },
    { pid: 501, uid: 501, comm: 'node', address: '127.0.0.1', port: 3000 },
    { pid: 777, uid: 0, comm: 'postgres', address: '*', port: 5432 },
  ];
  const ps = new Map([[501, '/usr/local/bin/node dev.js'], [777, 'postgres: writer']]);
  const merged = mergeListeners(rows, ps);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].pid, 501);
  assert.deepStrictEqual(merged[0].ports, [3000, 3001]); // deduped + sorted
  assert.strictEqual(merged[0].name, 'node');
  assert.strictEqual(merged[0].command, '/usr/local/bin/node dev.js');
  // Real postgres shows in ps as "postgres: writer process", so the first token is "postgres:".
  // This documents that quirk rather than pretending ps output is always clean.
  assert.strictEqual(merged[1].name, 'postgres:');
});

test('mergeListeners tolerates a pid that ps did not return (exited between calls)', () => {
  const rows = [{ pid: 999, uid: 501, comm: 'ghost', address: '*', port: 4000 }];
  const merged = mergeListeners(rows, new Map());
  assert.strictEqual(merged[0].name, 'ghost'); // falls back to lsof comm
  assert.match(merged[0].command, /unavailable/);
});
