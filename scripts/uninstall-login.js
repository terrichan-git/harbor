'use strict';
// Removes the LaunchAgent: stops the running job (launchctl relaunches it otherwise, because of
// KeepAlive) and deletes the plist. Services Harbor started are NOT touched — they keep running
// (detached) and can be stopped from the UI next time Harbor runs, or left alone.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL = 'com.harbor.portmanager';
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = `gui/${process.getuid()}`;

try { execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'inherit' }); }
catch { console.log('(job was not loaded)'); }

try { fs.unlinkSync(plistPath); console.log(`removed ${plistPath}`); }
catch { console.log('(no plist to remove)'); }

console.log('Harbor will no longer start at login. Anything it started earlier is still running.');
