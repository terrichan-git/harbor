'use strict';
// One-command restart of the login-launched Harbor, to pick up SERVER-CODE changes.
//
// Note: Harbor has NO build step — the frontend is served straight from server/public, so edits to
// the UI show on a plain browser refresh. Only server-side changes need this restart. (This is the
// inverse of the usual "rebuild before it shows" trap: nothing to build.)

const { execFileSync } = require('child_process');
const { DEFAULT_PORT } = require('../server/lib/config');

const LABEL = 'com.harbor.portmanager';
const domain = `gui/${process.getuid()}`;

try {
  execFileSync('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`], { stdio: 'ignore' });
  console.log(`Restarted Harbor (login service) — http://localhost:${DEFAULT_PORT}`);
} catch {
  console.error(
    'Harbor is not installed as a login service.\n' +
    '  Run it once at login:  npm run install-login\n' +
    '  Or run in foreground:  npm start'
  );
  process.exit(1);
}
