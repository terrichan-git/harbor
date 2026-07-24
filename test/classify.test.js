'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classify, appNameFrom } = require('../server/lib/classify');

const HOME = '/Users/dev';
const ctx = { homeDir: HOME };

// Cases lifted from the ACTUAL corpus on the build machine (not invented).
test('your dev projects: interpreter running from owned source dir', () => {
  assert.strictEqual(classify({ command: 'node index.js', cwd: `${HOME}/Claude/Projects/Project Happiness/Jumpr/local` }, ctx).category, 'project');
  assert.strictEqual(classify({ command: 'node src/server.js', cwd: `${HOME}/Documents/Harbor/port-manager` }, ctx).category, 'project');
  // absolute interpreter path still counts as project when cwd is owned source
  assert.strictEqual(classify({ command: '/usr/local/bin/node server/server.js', cwd: `${HOME}/Claude/Harbor` }, ctx).category, 'project');
});

test('installed apps: .app bundle in executable or cwd', () => {
  const raycast = classify({ command: '/Applications/Raycast.app/Contents/MacOS/Raycast', cwd: '/' }, ctx);
  assert.strictEqual(raycast.category, 'app');
  assert.strictEqual(raycast.appName, 'Raycast');

  // Dia ships a helper whose binary is deep inside the bundle — still "Dia".
  const dia = classify({ command: '/Applications/Dia.app/Contents/Resources/agent-server-resources/dist/agent-server', cwd: `${HOME}/Library/Application Support/Dia/User Data/Default/AgentServer` }, ctx);
  assert.strictEqual(dia.category, 'app');
  assert.strictEqual(dia.appName, 'Dia');

  // App helper daemon: bare exe name, but cwd is inside a .app under ~/Library.
  const aside = classify({ command: 'Aside', cwd: `${HOME}/Library/Application Support/Aside/AsideDaemon/mac-arm64/1.26/Aside Daemon.app/Contents/MacOS` }, ctx);
  assert.strictEqual(aside.category, 'app');
  assert.strictEqual(aside.appName, 'Aside Daemon');
});

test('macOS system: /System and /usr/libexec', () => {
  assert.strictEqual(classify({ command: '/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter', cwd: '/' }, ctx).category, 'system');
  assert.strictEqual(classify({ command: '/usr/libexec/rapportd', cwd: '/' }, ctx).category, 'system');
});

test('tool: brew/CLI service with no owned source dir', () => {
  assert.strictEqual(classify({ command: '/opt/homebrew/opt/postgresql/bin/postgres -D /opt/homebrew/var/postgres', cwd: '/' }, ctx).category, 'tool');
});

test('unknown: unrecognised path with no owned cwd', () => {
  assert.strictEqual(classify({ command: '/tmp/mystery-binary', cwd: '/' }, ctx).category, 'unknown');
});

test('appNameFrom picks the outermost .app', () => {
  assert.strictEqual(appNameFrom('/Applications/Dia.app/Contents/Resources/x'), 'Dia');
  assert.strictEqual(appNameFrom('/no/bundle/here'), null);
});