'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('../server/lib/auth');

// Minimal fake Express request.
function req({ headers = {}, remote = '127.0.0.1', query = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (h) => lower[h.toLowerCase()], socket: { remoteAddress: remote }, query };
}

test('isLoopback recognises v4, v6 and mapped addresses', () => {
  assert.strictEqual(auth.isLoopback(req({ remote: '127.0.0.1' })), true);
  assert.strictEqual(auth.isLoopback(req({ remote: '::1' })), true);
  assert.strictEqual(auth.isLoopback(req({ remote: '::ffff:127.0.0.1' })), true);
  assert.strictEqual(auth.isLoopback(req({ remote: '100.64.0.9' })), false); // a tailnet peer
});

test('sameSiteOrigin allows same host and no-origin, rejects cross-site', () => {
  // no Origin header (curl / same-origin navigation) -> allowed
  assert.strictEqual(auth.sameSiteOrigin(req({ headers: { host: 'localhost:7070' } })), true);
  // matching Origin -> allowed
  assert.strictEqual(auth.sameSiteOrigin(req({ headers: { host: 'localhost:7070', origin: 'http://localhost:7070' } })), true);
  // cross-site Origin -> rejected (this is the DNS-rebind / CSRF guard)
  assert.strictEqual(auth.sameSiteOrigin(req({ headers: { host: 'localhost:7070', origin: 'http://evil.example' } })), false);
});

test('presentedToken reads header first, then query', () => {
  assert.strictEqual(auth.presentedToken(req({ headers: { 'x-harbor-token': 'H' } })), 'H');
  assert.strictEqual(auth.presentedToken(req({ query: { token: 'Q' } })), 'Q');
  assert.strictEqual(auth.presentedToken(req()), null);
});
