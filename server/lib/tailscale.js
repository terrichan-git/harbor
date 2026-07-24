'use strict';
// Resolve this machine's Tailscale (MagicDNS) hostname so the UI can build copyable
// http://<host>:<port> links for each listening port, and show its own remote URL.
//
// Degrades gracefully: at login Tailscale may not be connected yet, or the CLI may be
// missing — in every failure case we return null and the UI simply shows no tailnet links
// until a later refresh succeeds. TAILNET_HOST env var overrides discovery if set.

const { execFile } = require('child_process');

// tailscale installs here via Homebrew (confirmed on this machine) or ships inside the app bundle.
const CANDIDATES = [
  process.env.TAILSCALE_BIN,
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  'tailscale',
].filter(Boolean);

function tryOne(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['status', '--json'], { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try {
        const status = JSON.parse(stdout);
        // Self.DNSName is fully-qualified with a trailing dot, e.g. "mymac.tailnet-xxxx.ts.net."
        const dns = status.Self && status.Self.DNSName;
        if (!dns) return resolve(null);
        // Only usable if the tailnet is actually up.
        if (status.BackendState && status.BackendState !== 'Running') return resolve(null);
        resolve(dns.replace(/\.$/, ''));
      } catch {
        resolve(null);
      }
    });
  });
}

let cache = { host: null, at: 0 };

async function getHost() {
  if (process.env.TAILNET_HOST) return process.env.TAILNET_HOST;
  // Cache for 30s so a fast auto-refresh loop doesn't spawn tailscale constantly.
  if (cache.host && Date.now() - cache.at < 30000) return cache.host;
  for (const bin of CANDIDATES) {
    const host = await tryOne(bin);
    if (host) {
      cache = { host, at: Date.now() };
      return host;
    }
  }
  cache = { host: null, at: Date.now() };
  return null;
}

module.exports = { getHost };
