'use strict';
/* Harbor frontend — vanilla JS, no build. Fetches /api/state, renders services + ports,
   drives start/stop/kill (with force-kill confirm) and copyable Tailscale links, and handles
   the Touch ID (WebAuthn) unlock/enroll flow. */

// ---- token: injected for loopback, or supplied once via ?token= on the phone --------------
const url = new URL(location.href);
let TOKEN = window.HARBOR_TOKEN || '';
if (url.searchParams.get('token')) {
  TOKEN = url.searchParams.get('token');
  sessionStorage.setItem('harbor_token', TOKEN);
  url.searchParams.delete('token'); // don't leave the token in the address bar / history
  history.replaceState(null, '', url.pathname);
}
if (!TOKEN) TOKEN = sessionStorage.getItem('harbor_token') || '';
let UNLOCK = sessionStorage.getItem('harbor_unlock') || '';

// ---- tiny helpers -------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(path, opts = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (TOKEN) headers['x-harbor-token'] = TOKEN;
  if (UNLOCK) headers['x-harbor-unlock'] = UNLOCK;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || res.statusText);
    err.status = res.status;
    err.code = body && body.code;
    throw err;
  }
  return body;
}

// Wrap a destructive call so that a TOUCH_ID_REQUIRED response transparently runs Touch ID and retries.
async function withTouchId(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.code === 'TOUCH_ID_REQUIRED') {
      await doTouchIdUnlock();
      return await fn(); // retry once now that we hold an unlock
    }
    throw err;
  }
}

// ---- WebAuthn (Touch ID) ------------------------------------------------------------------
const b64urlToBuf = (s) => {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const arr = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i);
  return arr.buffer;
};
const bufToB64url = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function doTouchIdUnlock() {
  const options = await api('/api/webauthn/auth/options', { method: 'POST', body: '{}' });
  options.challenge = b64urlToBuf(options.challenge);
  (options.allowCredentials || []).forEach((c) => (c.id = b64urlToBuf(c.id)));
  const cred = await navigator.credentials.get({ publicKey: options });
  const payload = {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      authenticatorData: bufToB64url(cred.response.authenticatorData),
      clientDataJSON: bufToB64url(cred.response.clientDataJSON),
      signature: bufToB64url(cred.response.signature),
      userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : undefined,
    },
  };
  const result = await api('/api/webauthn/auth/verify', { method: 'POST', body: JSON.stringify(payload) });
  if (!result.verified || !result.unlock) throw new Error('Touch ID verification failed');
  UNLOCK = result.unlock;
  sessionStorage.setItem('harbor_unlock', UNLOCK);
  toast('Unlocked with Touch ID');
}

async function doTouchIdEnroll() {
  try {
    const options = await api('/api/webauthn/register/options', { method: 'POST', body: '{}' });
    options.challenge = b64urlToBuf(options.challenge);
    options.user.id = b64urlToBuf(options.user.id);
    (options.excludeCredentials || []).forEach((c) => (c.id = b64urlToBuf(c.id)));
    const cred = await navigator.credentials.create({ publicKey: options });
    const payload = {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: cred.authenticatorAttachment,
      response: {
        attestationObject: bufToB64url(cred.response.attestationObject),
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        transports: cred.response.getTransports ? cred.response.getTransports() : [],
      },
    };
    const result = await api('/api/webauthn/register/verify', { method: 'POST', body: JSON.stringify(payload) });
    if (result.verified) { toast('Touch ID enabled — destructive actions now require it on localhost'); load(); }
    else toast('Touch ID setup did not complete');
  } catch (err) {
    if (err.code === 'NEEDS_LOCALHOST') openModal('Open http://localhost:7070', 'Touch ID setup only works over the localhost hostname (not 127.0.0.1 or the tailnet name). Open <b>http://localhost:7070</b> on this Mac and try again.', [closeBtn()]);
    else toast('Touch ID error: ' + err.message);
  }
}

// ---- modal --------------------------------------------------------------------------------
function openModal(title, bodyHtml, footButtons) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  const foot = $('#modalFoot');
  foot.innerHTML = '';
  footButtons.forEach((b) => foot.appendChild(b));
  $('#modalBack').classList.add('show');
}
function closeModal() { $('#modalBack').classList.remove('show'); }
function closeBtn(label = 'Close') { const b = document.createElement('button'); b.textContent = label; b.className = 'ghost'; b.onclick = closeModal; return b; }
$('#modalBack').addEventListener('click', (e) => { if (e.target === $('#modalBack')) closeModal(); });

// ---- actions ------------------------------------------------------------------------------
async function killPid(pid, name) {
  try {
    const r = await withTouchId(() => api('/api/kill', { method: 'POST', body: JSON.stringify({ pid }) }));
    if (r.status === 'needs-force') return confirmForce(() => forceKill(pid), name, pid);
    toast(`${name} (pid ${pid}) ${r.status}`);
    load();
  } catch (err) { toast('Kill failed: ' + err.message); }
}
async function forceKill(pid) {
  try {
    await withTouchId(() => api('/api/kill', { method: 'POST', body: JSON.stringify({ pid, force: true }) }));
    toast(`pid ${pid} force-killed (-9)`);
    closeModal(); load();
  } catch (err) { toast('Force kill failed: ' + err.message); }
}
async function startService(name) {
  try { await api(`/api/services/${encodeURIComponent(name)}/start`, { method: 'POST', body: '{}' }); toast(`Starting ${name}…`); setTimeout(load, 600); }
  catch (err) { toast('Start failed: ' + err.message); }
}
async function toggleAutostart(name, current) {
  try {
    const r = await api(`/api/services/${encodeURIComponent(name)}/autostart`, { method: 'POST', body: JSON.stringify({ enabled: !current }) });
    toast(`${name}: autostart ${r.autostart ? 'on' : 'off'}`);
    load();
  } catch (err) { toast('Autostart toggle failed: ' + err.message); }
}
async function stopService(name) {
  try {
    const r = await withTouchId(() => api(`/api/services/${encodeURIComponent(name)}/stop`, { method: 'POST', body: '{}' }));
    if (r.status === 'needs-force') return confirmForce(() => forceStop(name), name);
    toast(`${name} ${r.status}`); load();
  } catch (err) { toast('Stop failed: ' + err.message); }
}
async function forceStop(name) {
  try {
    await withTouchId(() => api(`/api/services/${encodeURIComponent(name)}/stop`, { method: 'POST', body: JSON.stringify({ force: true }) }));
    toast(`${name} force-killed (-9)`); closeModal(); load();
  } catch (err) { toast('Force stop failed: ' + err.message); }
}
// Explicit confirmation before any -9 (safety requirement).
function confirmForce(onConfirm, name, pid) {
  const go = document.createElement('button');
  go.textContent = 'Force kill (-9)'; go.className = 'danger'; go.onclick = onConfirm;
  openModal(
    'Force kill?',
    `<b>${esc(name)}</b>${pid ? ` (pid ${pid})` : ''} did not stop within 3 seconds after SIGTERM.<br><br>Sending <code>kill -9</code> is immediate and gives the process no chance to clean up. Continue?`,
    [closeBtn('Cancel'), go]
  );
}
async function showLogs(name) {
  try {
    const r = await api(`/api/services/${encodeURIComponent(name)}/logs`);
    openModal(`Logs — ${name} (last ${r.lines.length} lines)`, `<pre>${esc(r.lines.join('\n'))}</pre>`, [closeBtn()]);
  } catch (err) { toast('Could not load logs: ' + err.message); }
}

// ---- copy Tailscale link ------------------------------------------------------------------
async function copyLink(el, link) {
  try {
    await navigator.clipboard.writeText(link);
    el.classList.add('copied');
    const prev = el.querySelector('.label').textContent;
    el.querySelector('.label').textContent = 'Copied!';
    setTimeout(() => { el.classList.remove('copied'); el.querySelector('.label').textContent = prev; }, 1400);
  } catch { toast('Copy failed — ' + link); }
}

// ---- render -------------------------------------------------------------------------------
let TAILNET = null;

function tailLink(port) {
  return TAILNET ? `http://${TAILNET}:${port}` : null;
}
function copyChip(link) {
  return `<span class="copy" data-link="${esc(link)}" role="button" tabindex="0" title="Copy ${esc(link)}">🔗 <span class="label">${esc(link)}</span></span>`;
}

function renderServices(services) {
  const card = $('#servicesCard');
  if (!services.length) { card.innerHTML = `<div class="empty">No services defined. Add some to <code>services.json</code> and hit Refresh.</div>`; return; }
  card.innerHTML = services.map((s) => {
    const kind = s.running ? 'ok' : 'idle';
    const label = s.running ? 'running' : 'stopped';
    const ports = s.ports.map((p) => `<span class="port-chip">:${p}</span>`).join(' ');
    const links = s.running ? s.ports.map((p) => tailLink(p)).filter(Boolean).map(copyChip).join(' ') : '';
    // autostart toggle — persisted to services.json; takes effect at Harbor's next launch.
    const autostart = `<button class="switch ${s.autostart ? 'on' : ''}" role="switch" aria-checked="${s.autostart}"
        data-act="autostart" data-name="${esc(s.name)}" data-enabled="${s.autostart ? '1' : '0'}"
        title="Start &quot;${esc(s.name)}&quot; automatically when Harbor launches at login">
        <span class="knob"></span><span class="switch-label">autostart</span></button>`;
    const runBtns = s.running
      ? `${s.managed ? `<button class="danger" data-act="stop" data-name="${esc(s.name)}">Stop</button>` : `<span class="lock" title="Running, but not started by Harbor">running externally</span>`}
         <button class="ghost" data-act="logs" data-name="${esc(s.name)}">Logs</button>`
      : `<button class="primary" data-act="start" data-name="${esc(s.name)}">Start</button>
         <button class="ghost" data-act="logs" data-name="${esc(s.name)}">Logs</button>`;
    const actions = autostart + runBtns;
    return `<div class="row ${kind}">
      <span class="dot ${kind}"></span>
      <div class="main">
        <div class="name">${esc(s.name)} <span class="kind ${kind}">${label}</span> ${ports}</div>
        <div class="sub">${esc(s.command)}${s.pid ? ` · pid ${s.pid}` : ''} ${links}</div>
      </div>
      <div class="actions">${actions}</div>
    </div>`;
  }).join('');
}

function renderPorts(listeners) {
  const card = $('#portsCard');
  if (!listeners.length) { card.innerHTML = `<div class="empty">Nothing is listening on a TCP port.</div>`; return; }
  card.innerHTML = listeners.map((l) => {
    const kind = l.kind === 'known' ? 'ok' : 'warn';
    const ports = l.ports.map((p) => `<span class="port-chip">:${p}</span>`).join(' ');
    const links = l.ports.map((p) => tailLink(p)).filter(Boolean).map(copyChip).join(' ');
    const badge = l.kind === 'known'
      ? `<span class="kind ok">${esc(l.serviceName)}</span>`
      : `<span class="kind warn">rogue</span>`;
    // Primary label is the enriched project name; show the generic process name as a small tag
    // when it differs (e.g. "Jumpr" with a "node" tag), so identity and runtime are both visible.
    const procTag = l.label && l.name && l.label !== l.name ? `<span class="proc-tag">${esc(l.name)}</span>` : '';
    const action = l.protected
      ? `<span class="lock" title="${esc(l.protectedReason)}">🔒 ${esc(l.protectedReason)}</span>`
      : `<button class="danger" data-act="kill" data-pid="${l.pid}" data-name="${esc(l.label || l.name)}">Kill</button>`;
    return `<div class="row ${kind}">
      <span class="dot ${kind}"></span>
      <div class="main">
        <div class="name">${esc(l.label || l.name)} ${procTag} ${badge} ${ports}</div>
        <div class="sub">pid ${l.pid} · ${esc(l.command)} ${links}</div>
      </div>
      <div class="actions">${action}</div>
    </div>`;
  }).join('');
}

function renderBanners(state) {
  const b = [];
  if (state.configErrors && state.configErrors.length) {
    b.push(`<div class="banner danger"><b>services.json:</b> ${state.configErrors.map(esc).join(' · ')}</div>`);
  }
  if (!state.tailscale.host) {
    b.push(`<div class="banner warn">Tailscale not detected — remote/copy links are hidden until it's up. (Harbor is still fully usable on this Mac.)</div>`);
  }
  $('#banners').innerHTML = b.join('');
}

// ---- load + auto-refresh ------------------------------------------------------------------
let refreshTimer = null;

async function load() {
  try {
    const state = await api('/api/state');
    TAILNET = state.tailscale.host;
    $('#selfInfo').textContent = `this is Harbor · pid ${state.self.pid} · :${state.self.port}`;
    $('#touchIdBtn').hidden = state.touchId.enrolled || location.hostname !== 'localhost';
    renderBanners(state);
    renderServices(state.services);
    renderPorts(state.listeners);
    $('#lastRefresh').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    if (err.status === 401) {
      $('#banners').innerHTML = `<div class="banner danger">Access needs a token. Open the tailnet URL with <code>?token=…</code> (shown in Harbor's terminal on startup).</div>`;
    } else {
      toast('Refresh error: ' + err.message);
    }
  }
}

// pause auto-refresh while a modal is open so it doesn't yank content mid-decision
function tick() { if (!$('#modalBack').classList.contains('show')) load(); }

// ---- events (delegated) -------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const copy = e.target.closest('.copy');
  if (copy) return copyLink(copy, copy.dataset.link);
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, name, pid } = btn.dataset;
  if (act === 'kill') killPid(Number(pid), name);
  else if (act === 'start') startService(name);
  else if (act === 'stop') stopService(name);
  else if (act === 'logs') showLogs(name);
  else if (act === 'autostart') toggleAutostart(name, btn.dataset.enabled === '1');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  const copy = e.target.closest && e.target.closest('.copy');
  if (copy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); copyLink(copy, copy.dataset.link); }
});

$('#refreshBtn').onclick = load;
$('#touchIdBtn').onclick = doTouchIdEnroll;

// theme toggle (persisted); default follows the OS
const savedTheme = localStorage.getItem('harbor_theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const isDark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('harbor_theme', next);
};

// go
load();
refreshTimer = setInterval(tick, 4000);
