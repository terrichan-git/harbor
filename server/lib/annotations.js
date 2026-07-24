'use strict';
// User annotations for listening processes: a custom name + description so you know what a port is
// ("jumpr-local" -> "Jumpr — customer dashboard, local dev"). Stored in data/annotations.json
// (git-ignored user state, like the token). This is the only writer of that file.
//
// Identity/key: the working directory when we have one (a project's dir is stable across restarts
// and port changes), else the port. So renaming a project sticks even when its pid/port changes,
// and two instances of the same project dir share one annotation.

const fs = require('fs');
const { PATHS } = require('./paths');

// Stable annotation key for a listener. Returns null if we have neither a cwd nor a port.
function keyFor(listener) {
  if (listener && listener.cwd) return `cwd:${listener.cwd}`;
  const port = listener && listener.ports && listener.ports[0];
  return port ? `port:${port}` : null;
}

function load(filePath = PATHS.ANNOTATIONS) {
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function get(key, filePath = PATHS.ANNOTATIONS) {
  return load(filePath)[key] || null;
}

// Upsert an annotation. Empty name AND description removes it (a clean "clear"). Returns the stored
// value (or null when cleared).
function set(key, { name, description } = {}, filePath = PATHS.ANNOTATIONS) {
  if (!key || typeof key !== 'string') return { ok: false, error: 'missing key' };
  const store = load(filePath);
  const n = (name || '').trim();
  const d = (description || '').trim();
  if (!n && !d) {
    delete store[key];
  } else {
    store[key] = { name: n, description: d };
  }
  try {
    fs.mkdirSync(PATHS.DATA, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    return { ok: false, error: `Could not write annotations: ${err.message}` };
  }
  return { ok: true, value: store[key] || null };
}

module.exports = { keyFor, load, get, set };
