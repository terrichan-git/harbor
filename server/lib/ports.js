'use strict';
// Discover everything listening on a TCP port, with an accurate name + full command.
//
// Two-step, because neither tool alone is enough:
//   1. `lsof -F` gives us pid + uid + bind address + port, robustly (field-per-line,
//      no fragile column parsing). But lsof's own command string is TRUNCATED to ~9
//      chars, so it can't supply "the full command that launched it".
//   2. `ps -o command=` gives the full, untruncated command line per pid.
//
// The parsing functions are exported and pure so they can be unit-tested without
// actually shelling out (the trust boundary where a format change would bite silently).

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classify } = require('./classify');

const LSOF = '/usr/sbin/lsof';
const PS = '/bin/ps';

function run(cmd, args) {
  return new Promise((resolve) => {
    // lsof exits non-zero (1) when it simply finds nothing — that's not an error for us,
    // so we resolve on stdout regardless of exit code and let the parser decide.
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(stdout || '');
    });
  });
}

// Parse `lsof -nP -iTCP -sTCP:LISTEN -F pcuLn` output.
// -F emits one field per line: the field type is the first char, value is the rest.
//   p<pid>  starts a new process record
//   u<uid>  process owner
//   c<comm> process command (truncated — we keep it only as a fallback name)
//   n<name> a socket name, e.g. "*:3000", "127.0.0.1:5432", "[::1]:8080"
// Because we filtered to -sTCP:LISTEN, every n line here is a listening socket.
// Returns one row per (pid, port) — a process listening on N ports yields N rows.
function parseLsof(output) {
  const rows = [];
  let cur = null;
  for (const line of output.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      cur = { pid: Number(val), uid: null, comm: null };
    } else if (!cur) {
      continue;
    } else if (tag === 'u') {
      cur.uid = Number(val);
    } else if (tag === 'c') {
      cur.comm = val;
    } else if (tag === 'n') {
      const parsed = parseAddress(val);
      if (parsed) {
        rows.push({ pid: cur.pid, uid: cur.uid, comm: cur.comm, address: parsed.address, port: parsed.port });
      }
    }
  }
  return rows;
}

// Split a socket name into address + numeric port on the LAST colon. Works for IPv4
// ("127.0.0.1:5432" -> 5432), wildcard ("*:3000" -> 3000) and bracketed IPv6
// ("[::1]:8080" -> 8080), because the port never contains a colon and IPv6 addresses
// are bracketed, so the final colon always precedes the port.
function parseAddress(name) {
  const idx = name.lastIndexOf(':');
  if (idx === -1) return null;
  const port = Number(name.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  return { address: name.slice(0, idx), port };
}

// Parse `ps -o pid=,command=` output into { pid -> fullCommand }. The command is the
// remainder of the line after the pid, so it can safely contain spaces.
function parsePsCommands(output) {
  const map = new Map();
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) map.set(Number(m[1]), m[2].trim());
  }
  return map;
}

// Derive a short "process name" from a full command: basename of the first token.
// "/usr/local/bin/node dev.js" -> "node"; "/Applications/Foo.app/.../Foo" -> "Foo".
function commandToName(command, fallback) {
  if (!command) return fallback || 'unknown';
  const first = command.trim().split(/\s+/)[0];
  const base = first.split('/').pop();
  return base || fallback || 'unknown';
}

// Parse `lsof -a -d cwd -Fpn -p <csv>` into { pid -> cwd }. Each process contributes a `p<pid>`
// line followed by an `n<path>` line (its one cwd, because we filtered to -d cwd).
function parseLsofCwd(output) {
  const map = new Map();
  let pid = null;
  for (const line of output.split('\n')) {
    if (!line) continue;
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid != null) map.set(pid, line.slice(1));
  }
  return map;
}

// Turn a process's working directory (and its package.json name, if any) into a friendly project
// label — so five `node` servers read as "Jumpr", "my-api", … instead of all saying "node".
// Prefers the package.json "name" (scope stripped: "@acme/jumpr" -> "jumpr"); falls back to the
// cwd's basename. Returns null for uninformative cwds (home dir or /), so the caller keeps the
// generic process name in that case.
function projectLabel(cwd, pkgName, homeDir) {
  if (pkgName && typeof pkgName === 'string') {
    const base = pkgName.split('/').pop();
    if (base) return base;
  }
  if (!cwd || cwd === '/' || cwd === homeDir) return null;
  const base = path.basename(cwd);
  return base || null;
}

// Read the "name" field from <cwd>/package.json, or null. Best-effort — most dev servers run from
// their project root, so this catches the common case without walking the tree.
function readPkgName(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return typeof pkg.name === 'string' ? pkg.name : null;
  } catch {
    return null;
  }
}

// Collapse per-socket lsof rows + ps commands into one record per pid, with a ports[] list.
function mergeListeners(lsofRows, psCommands) {
  const byPid = new Map();
  for (const r of lsofRows) {
    let rec = byPid.get(r.pid);
    if (!rec) {
      rec = { pid: r.pid, uid: r.uid, ports: [], addresses: [], comm: r.comm };
      byPid.set(r.pid, rec);
    }
    if (!rec.ports.includes(r.port)) rec.ports.push(r.port);
    if (!rec.addresses.includes(r.address)) rec.addresses.push(r.address);
  }
  const out = [];
  for (const rec of byPid.values()) {
    const command = psCommands.get(rec.pid) || '';
    rec.ports.sort((a, b) => a - b);
    out.push({
      pid: rec.pid,
      uid: rec.uid,
      name: commandToName(command, rec.comm),
      command: command || '(command unavailable — process may have exited)',
      ports: rec.ports,
      addresses: rec.addresses,
    });
  }
  // Stable, predictable ordering: by lowest port then pid.
  out.sort((a, b) => (a.ports[0] || 0) - (b.ports[0] || 0) || a.pid - b.pid);
  return out;
}

// Live query: returns the merged listener records, each enriched with cwd + project label.
async function listListeners() {
  const lsofOut = await run(LSOF, ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcuLn']);
  const rows = parseLsof(lsofOut);
  const pids = [...new Set(rows.map((r) => r.pid))];
  let psCommands = new Map();
  let cwdByPid = new Map();
  if (pids.length) {
    // Two batched lookups over the same pid set: full commands, and working directories.
    const [psOut, cwdOut] = await Promise.all([
      run(PS, ['-o', 'pid=,command=', '-p', pids.join(',')]),
      run(LSOF, ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]),
    ]);
    psCommands = parsePsCommands(psOut);
    cwdByPid = parseLsofCwd(cwdOut);
  }
  const merged = mergeListeners(rows, psCommands);
  const home = os.homedir();
  for (const rec of merged) {
    const cwd = cwdByPid.get(rec.pid) || null;
    const project = projectLabel(cwd, cwd ? readPkgName(cwd) : null, home);
    const { category, appName } = classify({ command: rec.command, cwd }, { homeDir: home });
    rec.cwd = cwd;
    rec.project = project;
    rec.category = category; // 'project' | 'app' | 'system' | 'tool' | 'unknown'
    rec.appName = appName;
    // Primary display label: the app's real name for installed apps (so a helper daemon whose cwd
    // basename is "MacOS" reads as its app), else the project name, else the generic process name.
    rec.label = (category === 'app' && appName) || project || rec.name;
  }
  return merged;
}

module.exports = {
  listListeners,
  // exported for unit tests:
  parseLsof,
  parseAddress,
  parsePsCommands,
  commandToName,
  mergeListeners,
  parseLsofCwd,
  projectLabel,
};
