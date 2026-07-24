'use strict';
// Start / stop / kill — the side-effecting process control. The tricky bits (process groups,
// the TERM→wait→KILL force-kill flow) are commented heavily; the DECISIONS they rely on are
// unit-tested in safety.js and registry.js.

const fs = require('fs');
const { spawn } = require('child_process');
const registry = require('./registry');
const { expandHome, PATHS } = require('./paths');

const GRACE_MS = 3000; // how long we wait for a graceful SIGTERM before offering -9
const POLL_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Signal an entire process GROUP. process.kill(-pgid, sig) — the NEGATIVE pid — targets the
// whole group, which is how we take down a dev server AND the children it forked. This only
// works because we start services detached (below), making the child a group leader.
function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false; // group already gone
    if (err.code === 'EPERM') return true; // exists but not signalable by us; treat as alive
    throw err;
  }
}

function groupAlive(pgid) {
  // Signal 0 = existence check, no signal delivered.
  return signalGroup(pgid, 0);
}

function pidAlive(pid) {
  return registry.isAlive(pid);
}

// Start a known service. Spawns the command through a shell in the service's cwd, DETACHED so
// it survives Harbor restarting/crashing (PRD decision #1) and becomes its own group leader.
// stdout+stderr are redirected to a per-service append log. Writes a PID file for control + re-adoption.
function startService(service) {
  registry.ensureDirs();
  const logPath = `${PATHS.LOGS}/${service.name}.log`;
  const cwd = expandHome(service.cwd);

  if (!fs.existsSync(cwd)) {
    throw new Error(`working directory does not exist: ${cwd}`);
  }

  // 'a' = append so restarts accumulate rather than truncate the log.
  const logFd = fs.openSync(logPath, 'a');
  fs.writeSync(logFd, `\n=== harbor started "${service.name}" at ${new Date().toISOString()} ===\n`);

  const child = spawn('/bin/sh', ['-c', service.command], {
    cwd,
    detached: true, // new session + process group; child.pid IS the pgid
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  fs.closeSync(logFd); // the child holds its own dup'd fd now

  // unref so this child does not keep the Node event loop / Harbor process alive.
  child.unref();

  const record = {
    name: service.name,
    pid: child.pid,
    pgid: child.pid, // detached leader: group id equals the pid
    port: service.ports[0],
    ports: service.ports,
    command: service.command,
    cwd,
    logPath,
    startedAt: new Date().toISOString(),
  };
  registry.write(record);
  return record;
}

// Stop a managed service (or force a plain pid). Two-phase force-kill:
//   1. SIGTERM the group and poll up to GRACE_MS.
//   2. If it dies -> done. If it's still alive -> DO NOT auto-escalate. Return
//      { status: 'needs-force' } so the UI can CONFIRM before we ever send -9.
//   3. A second call with force:true sends SIGKILL to the group.
// This satisfies both "offer -9 if it doesn't die in ~3s" and "confirm before any -9".
async function stopManaged(record, { force = false } = {}) {
  const { pgid } = record;

  if (force) {
    signalGroup(pgid, 'SIGKILL');
    await sleep(POLL_MS);
    registry.remove(record.name);
    return { status: 'killed', forced: true };
  }

  if (!groupAlive(pgid)) {
    registry.remove(record.name);
    return { status: 'already-stopped' };
  }

  signalGroup(pgid, 'SIGTERM');

  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (!groupAlive(pgid)) {
      registry.remove(record.name);
      return { status: 'stopped' };
    }
  }

  // Still alive after the grace period — hand the decision back to the user.
  return { status: 'needs-force' };
}

// Kill an arbitrary listening process from the ports list. If Harbor manages it (a PID file
// exists for that pid), route through the group-aware stop so children go too. Otherwise signal
// the single pid. Same TERM→confirm→KILL contract.
async function killPid(pid, { force = false } = {}) {
  const managed = registry.readAll().find((r) => r.pid === pid);
  if (managed) {
    return stopManaged(managed, { force });
  }

  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(pid, signal);
  } catch (err) {
    if (err.code === 'ESRCH') return { status: 'already-stopped' };
    throw err;
  }

  if (force) {
    await sleep(POLL_MS);
    return { status: 'killed', forced: true };
  }

  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (!pidAlive(pid)) return { status: 'stopped' };
  }
  return { status: 'needs-force' };
}

module.exports = {
  startService,
  stopManaged,
  killPid,
  groupAlive,
  signalGroup,
  GRACE_MS,
};
