# AGENTS.md

**Harbor** — a local macOS port manager. One Node/Express process, flat-file state (no DB),
static frontend (no build step). Lists TCP listeners, manages known services from `services.json`,
kills processes safely, exposes Tailscale links.

## Run

```bash
npm install
npm start            # http://localhost:7071  (override with HARBOR_PORT=8090)
npm test             # node --test — the deterministic core
```

The laptop UI needs no token. Remote (Tailscale) access needs the token printed at startup / in
`data/token`.

## Layout

- `server/server.js` — routes + static serving; binds `0.0.0.0`.
- `server/lib/*` — one module per concern (ports, services, processes, registry, safety,
  tailscale, auth, webauthn). Invariants live here; routes call them, never re-implement them.
- `server/public/*` — vanilla JS/CSS frontend, no build.
- `scripts/` — `install-login` / `uninstall-login` (LaunchAgent), `gen-icon`.
- `test/` — unit tests. `data/` — runtime state, git-ignored.

## Before you change anything

Read **HANDOFF.md** — architecture + the trap list (launchd PATH, port shadowing, re-adopt-by-port,
process groups, Touch-ID-needs-localhost, force-kill contract). Add a trap the moment you hit one.

## Conventions

- No new runtime deps without a reason; local-first, no cloud.
- Any process-killing or safety rule change → update `server/lib/safety.js` (the one home) and its
  test. Test destructive paths against processes you own; leave nothing running behind.
