'use strict';
// The wire-credential boundary. A single shared token is the thing that authenticates any
// request that could change state (start/stop/kill). This is what protects the app once it is
// bound to 0.0.0.0 and reachable over the tailnet — see PRD "Auth (final)".
//
// Policy (assumption A1, as approved):
//   - Mutations (start/stop/kill): token REQUIRED from every origin, plus an Origin/Host check
//     to stop a malicious web page from POSTing to your machine (DNS-rebind / CSRF).
//   - Reads: allowed WITHOUT a token from loopback (so the laptop UI is zero-friction); token
//     REQUIRED for reads from any non-loopback (tailnet) address.
// Touch ID / WebAuthn is a SEPARATE, additional gate layered on top for the laptop (webauthn.js);
// it never replaces this token.

const fs = require('fs');
const crypto = require('crypto');
const { PATHS } = require('./paths');

let TOKEN = null;

// Create the token once (32 random bytes, hex) and persist it 0600 so only you can read it.
// data/ is git-ignored, so the token never enters git or the frontend bundle.
function getOrCreateToken() {
  if (TOKEN) return TOKEN;
  try {
    TOKEN = fs.readFileSync(PATHS.TOKEN, 'utf8').trim();
    if (TOKEN) return TOKEN;
  } catch {
    /* generate below */
  }
  TOKEN = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(PATHS.DATA, { recursive: true });
  fs.writeFileSync(PATHS.TOKEN, TOKEN, { mode: 0o600 });
  fs.chmodSync(PATHS.TOKEN, 0o600);
  return TOKEN;
}

// Constant-time comparison so token validity can't be probed by timing.
function tokenValid(provided) {
  if (!provided || typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(getOrCreateToken());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// A request presents the token via the x-harbor-token header (preferred) or ?token= query
// (used once when you first open the tailnet URL on your phone; the page then stores it and
// switches to the header).
// Read one cookie value from a raw Cookie header ("a=1; harbor_token=abc; b=2").
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      try { return decodeURIComponent(v); } catch { return v; }
    }
  }
  return null;
}

// A request presents the token via the x-harbor-token header, a ?token= query (first phone open),
// OR a durable cookie. The cookie is what keeps a home-screen web app signed in: iOS evicts
// localStorage after ~7 days, but a server-set first-party cookie survives and rides along on every
// request automatically — including the app's cold-launch page load.
function presentedToken(req) {
  return req.get('x-harbor-token') || (req.query && req.query.token) || parseCookie(req.get('cookie'), 'harbor_token') || null;
}

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

// Middleware: whenever a request carries a VALID token (by any means), (re)set the durable cookie.
// Server-set + first-party + HttpOnly, so it dodges iOS's localStorage eviction and can't be read
// by page scripts. Not `Secure` because Harbor is served over plain HTTP (localhost + the tailnet).
// SameSite=Lax + the existing Origin check (below) keep it safe from CSRF: the cookie is not sent on
// cross-site POSTs, so a malicious page still can't drive a mutation.
function refreshTokenCookie() {
  return (req, res, next) => {
    const t = presentedToken(req);
    if (t && tokenValid(t)) {
      res.setHeader('Set-Cookie', `harbor_token=${encodeURIComponent(t)}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax; HttpOnly`);
    }
    next();
  };
}

// Reject cross-site requests to mutating routes. A browser sends Origin on cross-origin POSTs;
// we only accept requests whose Origin host matches the Host we're serving (or has no Origin,
// e.g. curl / same-origin GETs). This blocks a random page you visit from driving Harbor even
// if it somehow knew the token.
function sameSiteOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true; // non-browser or same-origin navigation
  try {
    const originHost = new URL(origin).host;
    return originHost === req.get('host');
  } catch {
    return false;
  }
}

// Express middleware factories.
function requireForMutation() {
  return (req, res, next) => {
    if (!sameSiteOrigin(req)) {
      return res.status(403).json({ error: 'cross-site request refused' });
    }
    if (!tokenValid(presentedToken(req))) {
      return res.status(401).json({ error: 'missing or invalid token' });
    }
    next();
  };
}

function requireForRead() {
  return (req, res, next) => {
    if (isLoopback(req)) return next();
    if (!tokenValid(presentedToken(req))) {
      return res.status(401).json({ error: 'missing or invalid token' });
    }
    next();
  };
}

module.exports = {
  getOrCreateToken,
  tokenValid,
  isLoopback,
  presentedToken,
  parseCookie,
  sameSiteOrigin,
  refreshTokenCookie,
  requireForMutation,
  requireForRead,
};
