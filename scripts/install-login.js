'use strict';
// Installs Harbor as a per-user LaunchAgent so it starts at login and relaunches if it crashes.
// Writes a plist with ABSOLUTE paths and an explicit PATH — the #1 reason login-launched Node
// apps silently fail is launchd's minimal PATH not containing node/tailscale (see HANDOFF.md).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL = 'com.harbor.portmanager';
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath; // absolute path to the node running THIS script
const SERVER = path.join(ROOT, 'server', 'server.js');
const LOG = path.join(ROOT, 'data', 'harbor.out.log');
const PORT = require(path.join(ROOT, 'server', 'lib', 'config')).DEFAULT_PORT;
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const uid = process.getuid();

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.mkdirSync(path.dirname(plistPath), { recursive: true });

// Include /usr/local/bin and /opt/homebrew/bin so `tailscale` (and node, if symlinked there)
// resolve. Harbor calls tailscale by absolute-path candidates too, but this keeps the env sane.
const PATH_ENV = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin';

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${SERVER}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${PATH_ENV}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;

fs.writeFileSync(plistPath, plist);
console.log(`wrote ${plistPath}`);

// bootout any previous copy (ignore "not loaded" errors), then bootstrap + kickstart the new one.
const domain = `gui/${uid}`;
try { execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
try {
  execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
  execFileSync('launchctl', ['enable', `${domain}/${LABEL}`], { stdio: 'ignore' });
  execFileSync('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`], { stdio: 'ignore' });
  console.log('\nHarbor is now running and will start at every login.');
  console.log(`  Open   http://localhost:${PORT}`);
  console.log(`  Logs   ${LOG}`);
  console.log('  Stop   npm run uninstall-login');
} catch (err) {
  console.error('\nlaunchctl failed:', err.message);
  console.error('You can still run Harbor in the foreground with `npm start`.');
  process.exit(1);
}
