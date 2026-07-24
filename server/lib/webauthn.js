'use strict';
// Touch ID unlock via WebAuthn (platform authenticator). This is the LAPTOP-side extra gate on
// destructive actions (kill / stop) — layered on top of the token, never replacing it.
//
// Why this shape:
//   - The browser has no direct Touch ID API; the only web path is WebAuthn, which Apple backs
//     with Touch ID. Crypto verification is the part you must NOT hand-roll, so we use
//     @simplewebauthn/server; the browser side uses the built-in navigator.credentials API
//     (no client library, no build step — see public/app.js).
//   - WebAuthn requires a secure context. http://localhost qualifies (no HTTPS needed), so the
//     gate is offered ONLY when you reach Harbor via the hostname "localhost". Over 127.0.0.1
//     (rpID can't be an IP) or the plain-http tailnet name it is skipped — the token still applies.
//
// On success we mint a short-lived, HMAC-signed "unlock" string (keyed by the app token, so it
// needs no server-side session store). The client returns it on destructive calls; requireUnlock()
// verifies signature + expiry. Enforcement only kicks in when a credential is enrolled AND the
// request arrives on localhost — so enrolling can never lock you out from 127.0.0.1 or the phone.

const fs = require('fs');
const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { PATHS } = require('./paths');
const auth = require('./auth');

const RP_NAME = 'Harbor';
const UNLOCK_TTL_MS = 5 * 60 * 1000; // a Touch ID unlock is good for 5 minutes

// ---- credential storage (data/webauthn.json) --------------------------------
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.WEBAUTHN, 'utf8'));
  } catch {
    return { credentials: [] };
  }
}
function saveStore(store) {
  fs.mkdirSync(PATHS.DATA, { recursive: true });
  fs.writeFileSync(PATHS.WEBAUTHN, JSON.stringify(store, null, 2), { mode: 0o600 });
}
function isEnrolled() {
  return loadStore().credentials.length > 0;
}

// A single pending challenge is fine for a single-user local tool.
let pendingChallenge = null;

// rpID/origin are derived from the request host. Only "localhost" is a valid rpID here.
function context(req) {
  const host = req.get('host') || '';
  const hostname = host.split(':')[0];
  const usable = hostname === 'localhost';
  return {
    hostname,
    usable,
    rpID: hostname,
    origin: `${req.protocol}://${host}`,
  };
}

async function registrationOptions(req) {
  const ctx = context(req);
  if (!ctx.usable) {
    const err = new Error('Touch ID setup must be done from http://localhost:7070');
    err.code = 'NEEDS_LOCALHOST';
    throw err;
  }
  const store = loadStore();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: ctx.rpID,
    userID: new TextEncoder().encode('harbor-owner'),
    userName: 'Harbor owner',
    attestationType: 'none',
    excludeCredentials: store.credentials.map((c) => ({ id: c.id })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform', // Touch ID, not a roaming key
      userVerification: 'required',
      residentKey: 'preferred',
    },
  });
  pendingChallenge = options.challenge;
  return options;
}

async function verifyRegistration(req) {
  const ctx = context(req);
  const verification = await verifyRegistrationResponse({
    response: req.body,
    expectedChallenge: pendingChallenge,
    expectedOrigin: ctx.origin,
    expectedRPID: ctx.rpID,
  });
  if (!verification.verified || !verification.registrationInfo) {
    return { verified: false };
  }
  const { credential } = verification.registrationInfo;
  const store = loadStore();
  store.credentials.push({
    id: credential.id, // base64url string
    publicKey: Buffer.from(credential.publicKey).toString('base64'),
    counter: credential.counter,
    transports: req.body.response.transports || [],
  });
  saveStore(store);
  pendingChallenge = null;
  return { verified: true };
}

async function authenticationOptions(req) {
  const ctx = context(req);
  const store = loadStore();
  const options = await generateAuthenticationOptions({
    rpID: ctx.rpID,
    userVerification: 'required',
    allowCredentials: store.credentials.map((c) => ({ id: c.id, transports: c.transports })),
  });
  pendingChallenge = options.challenge;
  return options;
}

async function verifyAuthentication(req) {
  const ctx = context(req);
  const store = loadStore();
  const cred = store.credentials.find((c) => c.id === req.body.id);
  if (!cred) return { verified: false };

  const verification = await verifyAuthenticationResponse({
    response: req.body,
    expectedChallenge: pendingChallenge,
    expectedOrigin: ctx.origin,
    expectedRPID: ctx.rpID,
    credential: {
      id: cred.id,
      publicKey: Uint8Array.from(Buffer.from(cred.publicKey, 'base64')),
      counter: cred.counter,
    },
  });
  if (!verification.verified) return { verified: false };

  // Persist the incremented signature counter (clone-detection hygiene).
  cred.counter = verification.authenticationInfo.newCounter;
  saveStore(store);
  pendingChallenge = null;
  return { verified: true, unlock: mintUnlock() };
}

// ---- unlock token (HMAC over expiry, keyed by the app token) ----------------
function mintUnlock() {
  const exp = Date.now() + UNLOCK_TTL_MS;
  const payload = `exp=${exp}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}
function sign(payload) {
  return crypto.createHmac('sha256', auth.getOrCreateToken()).update(payload).digest('base64url');
}
function unlockValid(value) {
  if (!value || typeof value !== 'string') return false;
  const [b64, mac] = value.split('.');
  if (!b64 || !mac) return false;
  const payload = Buffer.from(b64, 'base64url').toString();
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const m = payload.match(/^exp=(\d+)$/);
  return !!m && Date.now() < Number(m[1]);
}

// Middleware: gate destructive actions with Touch ID, but ONLY when a credential is enrolled
// AND the request arrives on localhost (where an unlock is actually obtainable). Otherwise it is
// a no-op and the token/loopback policy in auth.js is the sole gate.
function requireUnlock() {
  return (req, res, next) => {
    if (!isEnrolled()) return next();
    const hostname = (req.get('host') || '').split(':')[0];
    if (hostname !== 'localhost') return next();
    if (unlockValid(req.get('x-harbor-unlock'))) return next();
    return res.status(401).json({ error: 'touch-id-required', code: 'TOUCH_ID_REQUIRED' });
  };
}

module.exports = {
  isEnrolled,
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
  requireUnlock,
  unlockValid,
};
