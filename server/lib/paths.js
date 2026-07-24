'use strict';
// Single home for every path Harbor uses. Everything resolves from the project
// root (two levels up from server/lib), NOT from process.cwd() — because the
// LaunchAgent may start us with an arbitrary cwd. Never guess these elsewhere.
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');

const PATHS = {
  ROOT,
  PUBLIC: path.join(ROOT, 'server', 'public'),
  SERVICES_JSON: path.join(ROOT, 'services.json'),
  DATA: path.join(ROOT, 'data'),
  PIDS: path.join(ROOT, 'data', 'pids'),
  LOGS: path.join(ROOT, 'data', 'logs'),
  TOKEN: path.join(ROOT, 'data', 'token'),
  WEBAUTHN: path.join(ROOT, 'data', 'webauthn.json'),
  LAUNCH_LOG: path.join(ROOT, 'data', 'harbor.out.log'),
};

// Expand a leading ~ in a service cwd to the user's home directory.
function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

module.exports = { PATHS, expandHome };
