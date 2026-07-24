'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const anno = require('../server/lib/annotations');

test('keyFor prefers cwd, falls back to port, null when neither', () => {
  assert.strictEqual(anno.keyFor({ cwd: '/Users/dev/Jumpr', ports: [4321] }), 'cwd:/Users/dev/Jumpr');
  assert.strictEqual(anno.keyFor({ cwd: null, ports: [3000] }), 'port:3000');
  assert.strictEqual(anno.keyFor({ cwd: null, ports: [] }), null);
});

test('set upserts and clears; write path tested against a throwaway file', () => {
  const tmp = path.join(os.tmpdir(), `harbor-anno-${process.pid}.json`);
  try {
    let r = anno.set('cwd:/x', { name: 'Jumpr', description: 'customer dashboard' }, tmp);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(anno.get('cwd:/x', tmp), { name: 'Jumpr', description: 'customer dashboard' });

    // update just the description
    anno.set('cwd:/x', { name: 'Jumpr', description: 'now with notes' }, tmp);
    assert.strictEqual(anno.get('cwd:/x', tmp).description, 'now with notes');

    // clearing both fields removes the entry
    r = anno.set('cwd:/x', { name: '', description: '  ' }, tmp);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(anno.get('cwd:/x', tmp), null);

    // missing key is a clean error
    assert.strictEqual(anno.set('', { name: 'x' }, tmp).ok, false);
  } finally {
    fs.rmSync(tmp, { force: true }); // leave no test data behind
  }
});
