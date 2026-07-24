'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classify } = require('../server/lib/safety');

const ctx = { selfPid: 4242, currentUid: 501 };

test('refuses to kill Harbor itself', () => {
  const r = classify({ pid: 4242, uid: 501 }, ctx);
  assert.strictEqual(r.protected, true);
  assert.match(r.reason, /Harbor/);
});

test('refuses system pids 0 and 1', () => {
  assert.strictEqual(classify({ pid: 1, uid: 0 }, ctx).protected, true);
  assert.strictEqual(classify({ pid: 0, uid: 0 }, ctx).protected, true);
});

test('refuses processes not owned by the current user', () => {
  const r = classify({ pid: 900, uid: 0 }, ctx); // root-owned
  assert.strictEqual(r.protected, true);
  assert.match(r.reason, /Not owned/);
});

test('refuses when owner is unknown (fail safe)', () => {
  assert.strictEqual(classify({ pid: 900, uid: null }, ctx).protected, true);
});

test('refuses Apple system binaries even when you own them', () => {
  // ControlCenter runs as your uid but lives under /System — killing it is dangerous.
  const r = classify({ pid: 698, uid: 501, command: '/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter' }, ctx);
  assert.strictEqual(r.protected, true);
  assert.match(r.reason, /system/i);
  assert.strictEqual(classify({ pid: 800, uid: 501, command: '/usr/libexec/sharingd' }, ctx).protected, true);
});

test('allows a normal user-owned process', () => {
  const r = classify({ pid: 5001, uid: 501, command: '/usr/local/bin/node dev.js' }, ctx);
  assert.strictEqual(r.protected, false);
  assert.strictEqual(r.reason, null);
});
