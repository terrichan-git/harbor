# Harbor — architecture & trap list

The highest-value doc here is the **trap list**. Each entry is an hour someone doesn't spend
rediscovering something. Add to it the moment something surprises you.

## Architecture in one screen

- **One Node/Express process**, binds `0.0.0.0:7071` by default (overridable via `HARBOR_PORT`). Serves the
  static frontend AND the JSON API. No database — state is flat files under `data/`.
- **`server/lib/` — one home per concern**, each invoked (never re-implemented) by routes:
  - `ports.js` — `lsof -F` + `ps -o command=` → merged listener records. Pure parsers exported for tests.
  - `services.js` — load/validate `services.json`; match listeners to services **by port**.
  - `registry.js` — PID files + the pure `reconcile()` re-adoption decision.
  - `processes.js` — spawn (detached), stop (group kill), the TERM→wait→KILL force flow.
  - `safety.js` — the pure "is this killable?" rule.
  - `tailscale.js`, `auth.js`, `webauthn.js` — tailnet host, token boundary, Touch ID.
- **Deterministic core is unit-tested** (`npm test`): lsof parsing, port matching, config
  validation, re-adoption, safety classification, auth origin/loopback logic. 26 tests.

## The three expensive-to-reverse decisions (as built)

1. **Process ownership: detached + survive-and-re-adopt.** Services spawn with `detached: true`
   (own session/process group, `pgid === pid`), tracked by `data/pids/<name>.json`. They outlive
   Harbor. On startup `reconcile()` re-adopts any PID that's alive **and still listening on its
   recorded port**. Stop signals the whole group (`process.kill(-pgid, …)`).
2. **Auth = shared token, required for all mutations**, plus an Origin/Host same-site check.
   Reads are token-free from loopback only. Touch ID is an *additional* localhost gate, not a
   replacement.
3. **Match running↔known by declared port.** `services.json` carries `port`/`ports`; matching,
   colouring, and re-adoption all key off it.

---

## Trap list

- **launchd has a minimal PATH.** `node` and `tailscale` live in `/usr/local/bin` (Homebrew) on
  this machine — NOT on launchd's default PATH. `scripts/install-login.js` pins an absolute node
  path in the plist and sets `PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin`.
  This is the #1 reason a login-launched Node app silently never starts.
- **Tailscale may be down at login.** `tailscale.js` returns `null` on any failure and the UI hides
  remote/copy links until a later refresh succeeds. Never make startup depend on it.
- **Loopback-specific binds shadow `0.0.0.0`.** During the build, another app was bound to
  `127.0.0.1:7070`. Harbor bound `*:7070` with NO error, but loopback traffic went to the more
  specific `127.0.0.1` socket — so `curl 127.0.0.1:7070` hit the *other* app. If Harbor seems to
  serve someone else's page, check `lsof -nP -iTCP:7070 -sTCP:LISTEN` for a second listener and
  set `HARBOR_PORT`.
- **Re-adoption identity is by PORT, not command.** An earlier version compared the stored *shell*
  command (`python3 -m http.server`) to the live `ps` command — but the shell exec's the real
  binary (`.../Python -m http.server`), so a healthy service was wrongly disowned as "pid reused,"
  its PID file deleted, and it kept running unmanaged on its port. Fixed: re-adopt if alive AND
  listening on the recorded port. (`registry.reconcile`, `test/registry.test.js`.)
- **Detached spawning is what makes group-kill work.** `process.kill(-pgid, sig)` (negative pid)
  only targets a group if the child is a group leader, which `detached: true` gives us. Without it,
  Stop would kill the shell but orphan the dev server's children.
- **Force-kill never auto-escalates.** `SIGTERM` → poll 3s → if alive, return `needs-force`; the
  UI must confirm before a second call sends `SIGKILL`. Verified live against a TERM-ignoring
  process (3.09s to `needs-force`, no silent `-9`).
- **Protected processes:** Harbor itself, PID ≤ 1, executables under
  `/System` `/usr/libexec` `/usr/sbin` `/Library/Apple` (Apple system agents run as YOUR uid —
  e.g. ControlCenter, rapportd — and are dangerous to kill), anything not owned by you, and unknown
  owners (fail safe). Everything else you own is killable.
- **Touch ID / WebAuthn only works over the `localhost` hostname.** WebAuthn needs a secure context;
  `http://localhost` qualifies but `http://127.0.0.1` (rpID can't be an IP) and the plain-http
  tailnet name do not. So enrollment and the unlock gate are offered ONLY when `host === localhost`.
  The gate is also skipped on 127.0.0.1/tailnet so enrolling can never lock you out there.
- **WebAuthn credentials are browser-profile-bound.** The platform credential is registered in one
  browser on one Mac; if you use a second browser you'll enroll again there. Expected, not a bug.
- **`ps` naming quirks.** The "process name" is the basename of the command's first token, so
  postgres shows as `postgres:` (its ps line is `postgres: writer process`). Cosmetic.
- **The frontend re-renders innerHTML every 4s (auto-refresh).** This invalidates any cached DOM
  node reference and, in the worst case, could land a click on a row that just re-rendered.
  Auto-refresh is paused while a modal is open. If this becomes annoying, switch to a diff-based
  render or pause-on-hover. (Low priority for a single-user tool.)
- **`data/` is state, not source.** Holds `token` (chmod 600), `pids/`, `logs/`, `webauthn.json`,
  `harbor.out.log`. Git-ignored and NOT regenerable — if you enroll Touch ID or care about a stable
  token, back up `data/token` and `data/webauthn.json` separately. Deleting `data/` resets the
  token (phones must re-open the new tokenized URL) and un-enrolls Touch ID.

## Autostart & name enrichment (added after v1)

- **Autostart toggle writes `services.json`.** `POST /api/services/:name/autostart` flips the flag
  via `servicesLib.setAutostart` (the *only* writer of that file). It re-serialises with
  `JSON.stringify(…, 2)`, so the file is **reformatted to canonical JSON** (inline arrays expand to
  multi-line). Values are preserved; formatting is not. The committed `services.json` is already in
  canonical form so toggles produce minimal diffs. `setAutostart` takes an optional `filePath` so
  the write path is unit-tested against a throwaway copy (`test/services.test.js`).
- **Autostart runs at every Harbor launch, not just login.** `reconcileOnStartup` starts any
  `autostart:true` service not already listening on its port. It's idempotent across KeepAlive
  relaunches (a re-adopted / already-up service is skipped). Consequence: if you manually Stop an
  autostart service and Harbor later restarts (crash + KeepAlive), it comes back. Intended for a
  "always want this up" flag; note it if it surprises you.
- **Listener names are enriched from the working directory.** `ports.listListeners` runs a second
  batched `lsof -a -d cwd` to get each pid's cwd, then `projectLabel` derives a friendly name:
  `package.json` "name" (scope stripped) → else cwd basename → else the generic process name.
  `readPkgName` reads `<cwd>/package.json` on each refresh (cheap for ~a dozen listeners; add an
  mtime cache if listener counts ever explode). cwd `/` or the home dir are treated as
  uninformative so the generic name ("ControlCenter") is kept.

## Frontend note

Frontend is static (`server/public/`), no build step. `index.html` contains a `__HARBOR_TOKEN__`
placeholder the server fills in for loopback requests only. If you rename that placeholder, update
`server.js`'s `/` route.

## Verified (measurements, not expectations)

- `npm test`: 26/26 pass.
- Auth: mutation w/o token → 401; non-loopback read w/o token → 401; with token → 200;
  cross-site Origin → 403.
- Start/Stop/Kill and force-kill exercised live (API + real UI clicks); ports freed, PID files
  removed, no orphans, no console errors.
- Survive-and-re-adopt: service survived Harbor being killed, re-adopted on restart, stopped cleanly.
