'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseLsof, parseAddress, parsePs, commandToName, mergeListeners, parseLsofCwd, projectLabel, suggestStartCommand } = require('../server/lib/ports');

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

test('parsePs pulls cpu/rss/etime and keeps the space-containing command last', () => {
  const out = '  501 12.5 180224 03:15:22 /usr/local/bin/node /path/dev.js --port 3000\n'
            + '  777  0.0  20480 2-04:00:01 postgres: writer process';
  const map = parsePs(out);
  assert.deepStrictEqual(map.get(501), { cpu: 12.5, rssKb: 180224, etime: '03:15:22', command: '/usr/local/bin/node /path/dev.js --port 3000' });
  assert.deepStrictEqual(map.get(777), { cpu: 0, rssKb: 20480, etime: '2-04:00:01', command: 'postgres: writer process' });
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
  const ps = new Map([
    [501, { cpu: 3.2, rssKb: 180224, etime: '01:02:03', command: '/usr/local/bin/node dev.js' }],
    [777, { cpu: 0, rssKb: 20480, etime: '15:00', command: 'postgres: writer' }],
  ]);
  const merged = mergeListeners(rows, ps);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].pid, 501);
  assert.deepStrictEqual(merged[0].ports, [3000, 3001]); // deduped + sorted
  assert.strictEqual(merged[0].name, 'node');
  assert.strictEqual(merged[0].command, '/usr/local/bin/node dev.js');
  assert.strictEqual(merged[0].cpu, 3.2);       // stats carried through
  assert.strictEqual(merged[0].rssKb, 180224);
  assert.strictEqual(merged[0].etime, '01:02:03');
  // Real postgres shows in ps as "postgres: writer process", so the first token is "postgres:".
  assert.strictEqual(merged[1].name, 'postgres:');
});

test('mergeListeners tolerates a pid that ps did not return (exited between calls)', () => {
  const rows = [{ pid: 999, uid: 501, comm: 'ghost', address: '*', port: 4000 }];
  const merged = mergeListeners(rows, new Map());
  assert.strictEqual(merged[0].name, 'ghost'); // falls back to lsof comm
  assert.match(merged[0].command, /unavailable/);
});

test('parseLsofCwd maps pid to working directory', () => {
  const out = ['p71201', 'n/Users/dev/Projects/Jumpr', 'p40716', 'n/Users/dev/my-api'].join('\n');
  const map = parseLsofCwd(out);
  assert.strictEqual(map.get(71201), '/Users/dev/Projects/Jumpr');
  assert.strictEqual(map.get(40716), '/Users/dev/my-api');
});

test('projectLabel prefers package.json name (scope stripped), else cwd basename', () => {
  const home = '/Users/dev';
  assert.strictEqual(projectLabel('/Users/dev/Projects/Jumpr', null, home), 'Jumpr');
  assert.strictEqual(projectLabel('/Users/dev/x', '@acme/jumpr', home), 'jumpr'); // pkg name wins, scope stripped
  assert.strictEqual(projectLabel('/Users/dev/x', 'my-api', home), 'my-api');
});

test('projectLabel returns null for uninformative cwds so the generic name is kept', () => {
  const home = '/Users/dev';
  assert.strictEqual(projectLabel(home, null, home), null); // home dir
  assert.strictEqual(projectLabel('/', null, home), null);  // root
  assert.strictEqual(projectLabel(null, null, home), null); // unknown
});

test('suggestStartCommand prefers npm scripts over the raw runtime command', () => {
  assert.strictEqual(suggestStartCommand({ dev: 'vite' }, '/usr/local/bin/node x'), 'npm run dev');
  assert.strictEqual(suggestStartCommand({ start: 'node .' }, 'node x'), 'npm start');
  assert.strictEqual(suggestStartCommand({}, '/usr/local/bin/node server.js'), '/usr/local/bin/node server.js');
});
