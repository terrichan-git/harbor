'use strict';
// Classify a listening process by TYPE, so the ports list distinguishes "an app I'm building"
// from "an installed app" from "a macOS service". Rule-based on the executable path + working
// directory — the boundary here is a genuine path pattern, so a classifier (not a model) is right.
//
// The rules were derived from the actual corpus on the build machine, not invented:
//   node in ~/Claude/.../Jumpr            -> project   (your dev app)
//   /Applications/Raycast.app/.../Raycast -> app       (installed application)
//   ~/Library/.../Aside Daemon.app/...    -> app       (an installed app's helper daemon)
//   /Applications/Dia.app/.../agent-server-> app       (Dia)
//   /System/.../ControlCenter, /usr/libexec/rapportd -> system
//
// Categories: 'project' | 'app' | 'system' | 'tool' | 'unknown'. For 'app' we also return the
// app's display name (from the .app bundle). NB: this is the DISPLAY taxonomy; the security
// "can I kill it?" rule lives separately in safety.js (intentionally not coupled to display).

const path = require('path');

// Apple system binaries — mirror of safety.js's list (kept separate on purpose: security must not
// depend on display logic). Keep the two in sync if you extend either.
const SYSTEM_PATHS = ['/System/', '/usr/libexec/', '/usr/sbin/', '/Library/Apple/'];

// Common runtimes a dev server is launched with. Used only as a secondary hint; the primary
// project signal is "running from a source directory you own".
const INTERPRETERS = new Set([
  'node', 'deno', 'bun', 'python', 'python2', 'python3', 'ruby', 'php', 'java',
  'dotnet', 'perl', 'ts-node', 'tsx', 'vite', 'next', 'nodemon',
]);

function firstToken(command) {
  if (!command || typeof command !== 'string') return '';
  return command.trim().split(/\s+/)[0] || '';
}

// The display name of the app owning a path: the FIRST "<name>.app" segment (outermost bundle).
// "/Applications/Dia.app/Contents/Resources/.../agent-server" -> "Dia".
function appNameFrom(p) {
  if (!p) return null;
  const m = p.match(/([^/]+)\.app(?:\/|$)/);
  return m ? m[1] : null;
}

// Classify. `ctx.homeDir` lets tests pin $HOME. Returns { category, appName }.
function classify({ command, cwd } = {}, ctx = {}) {
  const home = ctx.homeDir || '';
  const exe = firstToken(command);

  // 1. macOS system binaries (by executable path).
  if (SYSTEM_PATHS.some((p) => exe.startsWith(p))) {
    return { category: 'system', appName: null };
  }

  // 2. Installed application — a .app bundle in the executable OR the working directory
  //    (covers both /Applications apps and their ~/Library helper daemons).
  const appName = appNameFrom(exe) || appNameFrom(cwd);
  if (appName || exe.startsWith('/Applications/') || (home && cwd && cwd.startsWith(path.join(home, 'Library') + '/'))) {
    return { category: 'app', appName };
  }

  // 3. Your project — running from a source directory you own (under $HOME, but not ~/Library,
  //    which we already treated as app data above). Catches both interpreters and compiled binaries.
  if (home && cwd && cwd.startsWith(home + '/')) {
    return { category: 'project', appName: null };
  }

  // 4. A CLI tool / service — interpreter or a Homebrew/local binary with no owned source dir
  //    (e.g. a `brew services` postgres running with cwd=/).
  const base = exe.split('/').pop();
  if (INTERPRETERS.has(base) || exe.startsWith('/usr/local/') || exe.startsWith('/opt/homebrew/')) {
    return { category: 'tool', appName: null };
  }

  // 5. Genuinely unrecognised — the true "rogue".
  return { category: 'unknown', appName: null };
}

module.exports = { classify, appNameFrom };
