'use strict';
/* Harbor frontend — vanilla JS, no build. Fetches /api/state, renders services + ports,
   drives start/stop/kill (with force-kill confirm) and copyable Tailscale links, and handles
   the Touch ID (WebAuthn) unlock/enroll flow. */

// ---- token: injected for loopback, or supplied once via ?token= on the phone --------------
const url = new URL(location.href);
let TOKEN = window.HARBOR_TOKEN || '';
if (url.searchParams.get('token')) {
  TOKEN = url.searchParams.get('token');
  localStorage.setItem('harbor_token', TOKEN);
  // Keep ?token= in the URL on purpose. iOS "Add to Home Screen" captures the CURRENT url as the
  // web app's launch url, and a home-screen web app has its OWN storage (separate from Safari) that
  // iOS evicts after ~7 days. Keeping the token in the launch url lets the app re-authenticate on
  // every cold launch. In standalone mode there's no address bar, so it stays out of sight. The
  // server also sets a durable HttpOnly cookie (see auth.refreshTokenCookie) as a second layer.
}
if (!TOKEN) TOKEN = localStorage.getItem('harbor_token') || sessionStorage.getItem('harbor_token') || '';
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
// Rename / describe a listener. Opens a small form; Save writes the annotation (keyed by cwd/port).
function openEditModal(ds) {
  const body = `
    <div class="field">
      <label for="annoName">Name</label>
      <input id="annoName" type="text" maxlength="60" value="${esc(ds.cname || '')}" placeholder="${esc(ds.label || '')}">
    </div>
    <div class="field">
      <label for="annoDesc">Description</label>
      <textarea id="annoDesc" rows="3" maxlength="280" placeholder="What is this? Notes for future you…">${esc(ds.desc || '')}</textarea>
    </div>
    <p class="muted" style="margin:0">Applies to this project (matched by its folder), so it sticks across restarts. Clear both fields to remove.</p>`;
  const save = document.createElement('button');
  save.textContent = 'Save';
  save.className = 'primary';
  save.onclick = () => saveAnnotation(ds.key);
  openModal('Rename / describe', body, [closeBtn('Cancel'), save]);
  setTimeout(() => { const el = $('#annoName'); if (el) el.focus(); }, 30);
}
async function saveAnnotation(key) {
  const name = $('#annoName').value.trim();
  const description = $('#annoDesc').value.trim();
  try {
    await api('/api/annotations', { method: 'POST', body: JSON.stringify({ key, name, description }) });
    toast(name || description ? 'Saved' : 'Cleared');
    closeModal();
    load();
  } catch (err) { toast('Save failed: ' + err.message); }
}
// Promote a detected listener to a known service. Pre-fills name/dir/command/port from what Harbor
// detected; you confirm the start command (e.g. `npm run dev`).
function openPromoteModal(ds) {
  const body = `
    <div class="field">
      <label for="svcName">Service name</label>
      <input id="svcName" type="text" maxlength="60" value="${esc(ds.label || '')}">
    </div>
    <div class="field">
      <label for="svcCmd">Start command</label>
      <input id="svcCmd" type="text" value="${esc(ds.command || '')}">
    </div>
    <div class="field">
      <label for="svcPort">Port(s)</label>
      <input id="svcPort" type="text" value="${esc(ds.port || '')}">
    </div>
    <div class="field">
      <label for="svcCwd">Working directory</label>
      <input id="svcCwd" type="text" value="${esc(ds.cwd || '')}">
    </div>
    <p class="muted" style="margin:0">Harbor will run <b>the start command</b> in this directory. Once saved it appears under Known services with Start / Stop / autostart, and shows “needs restart” if it goes down.</p>`;
  const save = document.createElement('button');
  save.textContent = 'Add service';
  save.className = 'primary';
  save.onclick = savePromote;
  openModal('Promote to service', body, [closeBtn('Cancel'), save]);
}
async function savePromote() {
  const name = $('#svcName').value.trim();
  const command = $('#svcCmd').value.trim();
  const port = $('#svcPort').value.trim();
  const cwd = $('#svcCwd').value.trim();
  if (!name || !command || !port || !cwd) return toast('All fields are required');
  try {
    await api('/api/services', { method: 'POST', body: JSON.stringify({ name, command, port, cwd }) });
    toast(`Added “${name}” as a service`);
    closeModal();
    load();
  } catch (err) { toast('Could not add service: ' + err.message); }
}
// Demote a service back to a plain listening port (removes the definition; never stops the process).
function confirmDemote(name) {
  const go = document.createElement('button');
  go.textContent = 'Demote to listening port';
  go.onclick = () => demoteService(name);
  openModal('Demote service?',
    `Demote <b>${esc(name)}</b> back to a plain listening port? This removes it from Known services — it is <b>not</b> stopped. If it's still running it'll reappear below under Listening ports.`,
    [closeBtn('Cancel'), go]);
}
async function demoteService(name) {
  try {
    await api(`/api/services/${encodeURIComponent(name)}/remove`, { method: 'POST', body: '{}' });
    toast(`Demoted “${name}” to a listening port`);
    closeModal();
    load();
  } catch (err) { toast('Demote failed: ' + err.message); }
}
// Connect a phone: show a QR of the tokenized tailnet URL (fetched loopback-only). Scan once → the
// phone opens Harbor and stores the token in localStorage, staying connected.
async function openPairModal() {
  openModal('Connect a phone', '<p class="muted">Generating…</p>', [closeBtn()]);
  try {
    const r = await api('/api/pair');
    $('#modalBody').innerHTML = `
      <div style="text-align:center">
        <div class="qr">${r.svg}</div>
        <p class="muted" style="margin-top:var(--s-3)">Scan with your phone's camera — it must be on the same Tailscale tailnet. Harbor opens and stays connected across restarts.</p>
        <div class="field" style="margin-top:var(--s-3); text-align:left">
          <label>Or type this URL on your phone</label>
          <input type="text" readonly value="${esc(r.url)}" onclick="this.select()">
        </div>
      </div>`;
  } catch (err) {
    $('#modalBody').innerHTML = `<div class="banner warn">${esc(err.message)}</div>`;
  }
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

// Harbor's own process, shown in a dedicated card at the very top. Informational only — no
// Start/Stop/Restart, because Harbor is kept alive by launchd (managing it here would be circular).
function renderSelf(state) {
  const card = $('#selfCard');
  const self = state.listeners.find((l) => l.isSelf);
  if (!self) { card.innerHTML = ''; return; }
  const ports = self.ports.map((p) => `<span class="port-chip">:${p}</span>`).join(' ');
  const links = self.ports.map((p) => tailLink(p)).filter(Boolean).map(copyChip).join(' ');
  card.innerHTML = `<div class="card self">
    <div class="row ok">
      <span class="dot ok"></span>
      <div class="main">
        <div class="name">⚓ Harbor <span class="kind ok">this app</span> ${ports}</div>
        <div class="sub">pid ${self.pid} · kept alive by launchd (starts at login)</div>
        ${links ? `<div class="links">${links}</div>` : ''}
      </div>
      <div class="actions"><span class="muted">not manageable here</span></div>
    </div>
  </div>`;
}

function serviceRowHtml(s) {
  // status: running (green) | down = was up, now gone, needs restart (amber) | stopped (gray)
  const status = s.status || (s.running ? 'running' : 'stopped');
  const kind = status === 'running' ? 'ok' : status === 'down' ? 'warn' : 'idle';
  const label = status === 'running' ? 'running' : status === 'down' ? 'needs restart' : 'stopped';
  const ports = s.ports.map((p) => `<span class="port-chip">:${p}</span>`).join(' ');
  const links = s.running ? s.ports.map((p) => tailLink(p)).filter(Boolean).map(copyChip).join(' ') : '';
  // A custom name overrides the display heading; the service's real id shows as a small tag.
  const display = s.customName || s.name;
  const idTag = s.customName ? `<span class="proc-tag">${esc(s.name)}</span>` : '';
  const desc = s.description ? `<div class="desc">${esc(s.description)}</div>` : '';
  const editBtn = s.annoKey
    ? `<button class="ghost icon" data-act="edit" data-key="${esc(s.annoKey)}" data-label="${esc(s.name)}" data-cname="${esc(s.customName || '')}" data-desc="${esc(s.description || '')}" title="Rename / describe">✎</button>`
    : '';
  const demoteBtn = `<button class="ghost" data-act="demote" data-name="${esc(s.name)}" title="Demote to a plain listening port — removes the service definition; does not stop the process">Demote</button>`;
  // autostart toggle — persisted to services.json; takes effect at Harbor's next launch.
  const autostart = `<button class="switch ${s.autostart ? 'on' : ''}" role="switch" aria-checked="${s.autostart}"
      data-act="autostart" data-name="${esc(s.name)}" data-enabled="${s.autostart ? '1' : '0'}"
      title="Start &quot;${esc(s.name)}&quot; automatically when Harbor launches at login">
      <span class="knob"></span><span class="switch-label">autostart</span></button>`;
  const startLabel = status === 'down' ? 'Restart' : 'Start';
  const runBtns = s.running
    ? `${s.managed ? `<button class="danger" data-act="stop" data-name="${esc(s.name)}">Stop</button>` : `<span class="lock" title="Running, but not started by Harbor">running externally</span>`}
       <button class="ghost" data-act="logs" data-name="${esc(s.name)}">Logs</button>`
    : `<button class="primary" data-act="start" data-name="${esc(s.name)}">${startLabel}</button>
       <button class="ghost" data-act="logs" data-name="${esc(s.name)}">Logs</button>`;
  return `<div class="row ${kind}">
    <span class="dot ${kind}"></span>
    <div class="main">
      <div class="name">${esc(display)} ${idTag} <span class="kind ${kind}">${label}</span> ${ports}</div>
      <div class="sub">${esc(s.command)}${s.pid ? ` · pid ${s.pid}` : ''}</div>
      ${links ? `<div class="links">${links}</div>` : ''}
      ${desc}
    </div>
    <div class="actions">${editBtn}${autostart}${runBtns}${demoteBtn}</div>
  </div>`;
}

function renderServices(services) {
  const card = $('#servicesCard');
  if (!services.length) { card.innerHTML = `<div class="empty">No services defined. Add some to <code>services.json</code>, or promote a project below with <b>+ Service</b>.</div>`; return; }
  const buckets = new Map();
  for (const s of services) {
    const k = serviceGroupKey(s);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(s);
  }
  let html = '';
  for (const g of SERVICE_GROUPS) {
    const items = buckets.get(g.key);
    if (!items || !items.length) continue;
    const isCollapsed = collapsedServices.has(g.key);
    html += `<div class="card group ${isCollapsed ? 'collapsed' : ''}" data-group="${g.key}" data-scope="services">
      <button class="group-head" data-toggle="${g.key}" data-scope="services" aria-expanded="${!isCollapsed}">
        <span class="chevron">▾</span>
        <span class="dot ${g.tone}"></span>
        <span class="group-title">${g.label}</span>
        <span class="group-count">${items.length}</span>
      </button>
      <div class="group-body"${isCollapsed ? ' hidden' : ''}>${items.map(serviceRowHtml).join('')}</div>
    </div>`;
  }
  card.innerHTML = html;
}

// Map a listener to a display tone + category badge. Known services stay green; everything else is
// labelled by what it IS — your project, an installed app, a macOS service, a CLI tool, or a
// genuinely unrecognised process.
function categoryMeta(l) {
  if (l.kind === 'known') return { tone: 'ok', badge: esc(l.serviceName) };
  switch (l.category) {
    case 'project': return { tone: 'proj', badge: 'your project' };
    case 'app':     return { tone: 'app',  badge: l.appName ? `app · ${esc(l.appName)}` : 'app' };
    case 'system':  return { tone: 'sys',  badge: 'system' };
    case 'tool':    return { tone: 'tool', badge: 'tool' };
    default:        return { tone: 'warn', badge: 'unrecognized' };
  }
}

// Category groups, in display order. A listener matched to a known service groups under 'known';
// everything else groups by its classifier category.
// Known services live in their own section above, so the ports list groups only unmanaged things.
const PORT_GROUPS = [
  { key: 'project', label: 'Your projects',    tone: 'proj' },
  { key: 'app',     label: 'Installed apps',   tone: 'app' },
  { key: 'tool',    label: 'Tools & services', tone: 'tool' },
  { key: 'system',  label: 'System',           tone: 'sys' },
  { key: 'unknown', label: 'Unrecognized',     tone: 'warn' },
];
const groupKeyFor = (l) => (l.kind === 'known' ? 'known' : (l.category || 'unknown'));

// Service groups: running vs stopped (a "needs restart" service lives under Stopped but keeps its
// amber badge).
const SERVICE_GROUPS = [
  { key: 'running', label: 'Running', tone: 'ok' },
  { key: 'stopped', label: 'Stopped', tone: 'idle' },
];
const serviceGroupKey = (s) => (s.status === 'running' ? 'running' : 'stopped');

// Collapsed groups persist across the 4s auto-refresh (which rebuilds the DOM). Ports and services
// keep independent collapse state.
const collapsedPorts = new Set(JSON.parse(localStorage.getItem('harbor_collapsed') || '[]'));
const collapsedServices = new Set(JSON.parse(localStorage.getItem('harbor_svc_collapsed') || '[]'));
function collapseStore(scope) {
  return scope === 'services'
    ? { set: collapsedServices, key: 'harbor_svc_collapsed' }
    : { set: collapsedPorts, key: 'harbor_collapsed' };
}

function rowHtml(l) {
  const meta = categoryMeta(l);
  const ports = l.ports.map((p) => `<span class="port-chip">:${p}</span>`).join(' ');
  const links = l.ports.map((p) => tailLink(p)).filter(Boolean).map(copyChip).join(' ');
  const badge = `<span class="kind ${meta.tone}">${meta.badge}</span>`;
  // Primary label is the enriched name; show the generic process name as a small tag when it
  // differs (e.g. "Jumpr" with a "node" tag), so identity and runtime are both visible.
  const procTag = l.label && l.name && l.label !== l.name ? `<span class="proc-tag">${esc(l.name)}</span>` : '';
  const desc = l.description ? `<div class="desc">${esc(l.description)}</div>` : '';
  // Rename / describe — available when the listener has a stable key (cwd or port).
  const editBtn = l.annoKey
    ? `<button class="ghost icon" data-act="edit" data-key="${esc(l.annoKey)}" data-label="${esc(l.label || l.name)}" data-cname="${esc(l.customName || '')}" data-desc="${esc(l.description || '')}" title="Rename / describe">✎</button>`
    : '';
  // Promote to a managed service — only when it isn't already a known service and it has a working
  // dir to start from (so Harbor can Start/Stop/autostart it and flag it when it goes down).
  const promoteBtn = (l.kind !== 'known' && l.cwd)
    ? `<button class="ghost" data-act="promote" data-label="${esc(l.label || l.name)}" data-cwd="${esc(l.cwd)}" data-command="${esc(l.suggestedCommand || l.command || '')}" data-port="${esc(l.ports.join(','))}" title="Manage this as a service (Start/Stop/autostart)">+ Service</button>`
    : '';
  const action = l.protected
    ? `<span class="lock" title="${esc(l.protectedReason)}">🔒 ${esc(l.protectedReason)}</span>`
    : `<button class="danger" data-act="kill" data-pid="${l.pid}" data-name="${esc(l.label || l.name)}">Kill</button>`;
  return `<div class="row ${meta.tone}">
    <span class="dot ${meta.tone}"></span>
    <div class="main">
      <div class="name">${esc(l.label || l.name)} ${procTag} ${badge} ${ports}</div>
      <div class="sub">pid ${l.pid} · ${esc(l.command)}</div>
      ${links ? `<div class="links">${links}</div>` : ''}
      ${desc}
    </div>
    <div class="actions">${promoteBtn}${editBtn}${action}</div>
  </div>`;
}

function renderPorts(listeners) {
  const card = $('#portsCard');
  if (!listeners.length) { card.innerHTML = `<div class="empty">Nothing is listening on a TCP port.</div>`; return; }
  const buckets = new Map();
  for (const l of listeners) {
    const k = groupKeyFor(l);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(l);
  }
  let html = '';
  for (const g of PORT_GROUPS) {
    const items = buckets.get(g.key);
    if (!items || !items.length) continue;
    const isCollapsed = collapsedPorts.has(g.key);
    // Each category is its own collapsible card.
    html += `<div class="card group ${isCollapsed ? 'collapsed' : ''}" data-group="${g.key}" data-scope="ports">
      <button class="group-head" data-toggle="${g.key}" data-scope="ports" aria-expanded="${!isCollapsed}">
        <span class="chevron">▾</span>
        <span class="dot ${g.tone}"></span>
        <span class="group-title">${g.label}</span>
        <span class="group-count">${items.length}</span>
      </button>
      <div class="group-body"${isCollapsed ? ' hidden' : ''}>${items.map(rowHtml).join('')}</div>
    </div>`;
  }
  card.innerHTML = html;
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
    // Pairing (QR with the token) is a laptop-only affordance — never expose it on the phone.
    $('#pairBtn').hidden = !(location.hostname === 'localhost' || location.hostname === '127.0.0.1');
    renderBanners(state);
    renderSelf(state);
    // Harbor itself is shown only in its own top section — keep it out of the groups so it
    // can't be treated as a normal (circular) known service.
    renderServices(state.services.filter((s) => !s.isSelf));
    // Listening ports = UNMANAGED listeners only. Known services already have their own section
    // above, so exclude them here (and Harbor itself) to avoid showing the same thing twice.
    renderPorts(state.listeners.filter((l) => !l.isSelf && l.kind !== 'known'));
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
  // Collapse/expand a category group. Toggle the DOM directly (snappy) and persist, so the next
  // auto-refresh render honours it.
  const head = e.target.closest('button[data-toggle]');
  if (head) {
    const k = head.dataset.toggle;
    const { set, key } = collapseStore(head.dataset.scope);
    if (set.has(k)) set.delete(k); else set.add(k);
    localStorage.setItem(key, JSON.stringify([...set]));
    const grp = head.closest('.group');
    const nowCollapsed = set.has(k);
    grp.classList.toggle('collapsed', nowCollapsed);
    grp.querySelector('.group-body').hidden = nowCollapsed;
    head.setAttribute('aria-expanded', String(!nowCollapsed));
    return;
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, name, pid } = btn.dataset;
  if (act === 'kill') killPid(Number(pid), name);
  else if (act === 'start') startService(name);
  else if (act === 'stop') stopService(name);
  else if (act === 'logs') showLogs(name);
  else if (act === 'autostart') toggleAutostart(name, btn.dataset.enabled === '1');
  else if (act === 'edit') openEditModal(btn.dataset);
  else if (act === 'promote') openPromoteModal(btn.dataset);
  else if (act === 'demote') confirmDemote(name);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  const copy = e.target.closest && e.target.closest('.copy');
  if (copy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); copyLink(copy, copy.dataset.link); }
});

$('#refreshBtn').onclick = load;
$('#touchIdBtn').onclick = doTouchIdEnroll;
$('#pairBtn').onclick = openPairModal;

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
