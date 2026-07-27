'use strict';
// Optional per-service health check: ping http://127.0.0.1:<port><path> and report whether it
// answered with a 2xx/3xx. Distinguishes "bound but not serving / erroring" from "actually up".
// Results are cached briefly so the 4s /api/state poll doesn't hammer the endpoint, and each ping
// has a short timeout so a hung server can't stall the dashboard.

const http = require('http');

const TTL_MS = 5000;
const TIMEOUT_MS = 1500;
const cache = new Map(); // name -> { at, healthy }

function checkOnce(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: TIMEOUT_MS }, (res) => {
      res.resume(); // drain
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false)); // connection refused, reset, etc.
  });
}

// Cached health for a service. Returns true/false; caches per name for TTL_MS.
async function getHealth(name, port, path) {
  const c = cache.get(name);
  if (c && Date.now() - c.at < TTL_MS) return c.healthy;
  const healthy = await checkOnce(port, path);
  cache.set(name, { at: Date.now(), healthy });
  return healthy;
}

module.exports = { getHealth, checkOnce, TTL_MS };
