'use strict';
// The one home for "is this process safe for Harbor to kill?" — enforced in code, never
// left to the UI. Every kill path calls this first. Pure function, unit-tested, because
// this is the rule whose failure is most expensive (killing the wrong PID).

// A process is PROTECTED (Kill refused) if ANY of:
//   - it is Harbor's own process (never kill ourselves)
//   - it is a low/system PID (0 = kernel scheduler, 1 = launchd)
//   - it is an Apple system binary (executable under /System/ or /usr/libexec/), EVEN IF you
//     own it. macOS runs many per-user system agents (ControlCenter, sharingd, …) as your uid;
//     killing those can destabilise your login session, so they count as "critical system PIDs"
//     regardless of ownership.
//   - it is not owned by the current user (root daemons, other users' processes). We only ever
//     let you kill things you own; root-owned processes (uid 0) fall out of this automatically.
//
// Returns { protected: boolean, reason: string|null }. `reason` is shown in the UI so
// you know WHY Kill is disabled on a row.
const SYSTEM_PATHS = ['/System/', '/usr/libexec/', '/usr/sbin/', '/Library/Apple/'];

function classify(proc, ctx) {
  const { selfPid, currentUid } = ctx;

  if (proc.pid === selfPid) {
    return { protected: true, reason: 'This is Harbor itself' };
  }
  if (!Number.isInteger(proc.pid) || proc.pid <= 1) {
    return { protected: true, reason: 'System process' };
  }
  // Apple system binaries by executable path — protected even when owned by you.
  const exe = firstToken(proc.command);
  if (exe && SYSTEM_PATHS.some((p) => exe.startsWith(p))) {
    return { protected: true, reason: 'macOS system process' };
  }
  // uid may be null if lsof did not report it; treat unknown ownership as protected
  // (fail safe — refuse rather than risk killing something we can't attribute to you).
  if (proc.uid == null) {
    return { protected: true, reason: 'Unknown owner' };
  }
  if (proc.uid !== currentUid) {
    return { protected: true, reason: 'Not owned by you' };
  }
  return { protected: false, reason: null };
}

function firstToken(command) {
  if (!command || typeof command !== 'string') return null;
  return command.trim().split(/\s+/)[0] || null;
}

module.exports = { classify };
