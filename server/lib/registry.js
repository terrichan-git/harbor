'use strict';
// Tracks the services Harbor STARTED, so it can stop them cleanly and re-adopt them after a
// restart (PRD decision #1: survive-and-re-adopt). Each started service gets a PID file at
// data/pids/<name>.json holding everything needed to control it without this process's memory:
//   { name, pid, pgid, port, command, cwd, logPath, startedAt }
//
// pgid (process-group id) is the important field: we spawn detached so the child becomes its
// own group leader (pgid === pid), and we stop it by signalling the whole GROUP (see processes.js)
// so dev-server children don't orphan.

const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths');

function pidFilePath(name) {
  // Service names come from your own config; still, keep them to a safe filename.
  const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(PATHS.PIDS, `${safe}.json`);
}

function ensureDirs() {
  fs.mkdirSync(PATHS.PIDS, { recursive: true });
  fs.mkdirSync(PATHS.LOGS, { recursive: true });
}

function write(record) {
  ensureDirs();
  fs.writeFileSync(pidFilePath(record.name), JSON.stringify(record, null, 2));
}

function read(name) {
  try {
    return JSON.parse(fs.readFileSync(pidFilePath(name), 'utf8'));
  } catch {
    return null;
  }
}

function remove(name) {
  try {
    fs.unlinkSync(pidFilePath(name));
  } catch {
    /* already gone */
  }
}

function readAll() {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(PATHS.PIDS)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(PATHS.PIDS, f), 'utf8')));
    } catch {
      /* skip corrupt file */
    }
  }
  return out;
}

// Is a pid still alive? kill(pid, 0) sends no signal but performs the existence/permission
// check: it throws ESRCH if the pid is gone, and EPERM if it exists but we can't signal it
// (still "alive"). This is the standard liveness probe.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// PURE re-adoption decision, unit-tested. Given the PID-file records and injected probes,
// split them into:
//   adopt: process still alive AND still serving one of its recorded ports — re-attach.
//   stale: process gone, or alive but no longer on our port (pid reused) — the PID file is deleted.
//
// Identity is verified by PORT, matching the app's whole matching model. An earlier version
// compared the stored SHELL command to the live `ps` command — but the shell exec's the real
// binary, so `python3 -m http.server` on disk became `Python -m http.server` live and a healthy
// service was wrongly disowned. Port identity avoids that: a reused pid would have to coincidentally
// be listening on the exact same port, and if it somehow were, it *is* serving that port anyway.
//
// portsOf(pid) returns the array of ports that pid is currently listening on (from live lsof),
// or null when that information is unavailable — in which case we fall back to trusting liveness.
function reconcile(records, { isAlive: alive, portsOf }) {
  const adopt = [];
  const stale = [];
  for (const rec of records) {
    if (!alive(rec.pid)) {
      stale.push({ ...rec, why: 'process no longer running' });
      continue;
    }
    const recPorts = rec.ports && rec.ports.length ? rec.ports : (rec.port != null ? [rec.port] : []);
    const live = portsOf(rec.pid);
    if (live != null && recPorts.length && !recPorts.some((p) => live.includes(p))) {
      stale.push({ ...rec, why: 'pid alive but no longer listening on its port (pid reused)' });
    } else {
      adopt.push(rec);
    }
  }
  return { adopt, stale };
}

module.exports = {
  pidFilePath,
  ensureDirs,
  write,
  read,
  remove,
  readAll,
  isAlive,
  reconcile,
};
