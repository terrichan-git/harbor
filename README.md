# ⚓ Harbor — a local port manager for macOS

Harbor lists everything listening on a TCP port, lets you start/stop a saved set of
"known services," kill rogue processes, and hands you copyable Tailscale links so you can
open any dev server from your phone. One Node process, no database, no cloud.

![colors: green = known service running · gray = known service stopped · yellow = unknown process](server/public/favicon.svg)

## What it does

- **Lists TCP listeners** (`lsof` + `ps`) with process name, PID, port(s), and the full launch command.
- **Kill** any process you own, with a **force `kill -9`** step that only fires after you confirm.
- **Known services** defined in [`services.json`](services.json): Start ones that are stopped,
  Stop ones that are running. Matched to live processes **by port**.
- **Survive & re-adopt**: services Harbor starts keep running if Harbor restarts/crashes, and get
  re-attached on the next launch.
- **Tailscale links**: per-port `http://<machine>.<tailnet>.ts.net:<port>` you can copy in one click,
  and Harbor's own UI is reachable from your phone (token-protected).
- **Touch ID** (optional): gate destructive actions on this Mac behind Touch ID.
- Colour code: **green** = known service running · **gray** = known service stopped ·
  **yellow** = unknown/rogue process. Protected processes show a 🔒 and can't be killed.

## Requirements

- macOS, Node ≥ 18.
- [Tailscale](https://tailscale.com) (optional) for the phone/copy-link features — install it and
  sign in on each device, turn on **MagicDNS**. Harbor works fully without it; the links just hide.

## Setup

```bash
npm install
npm start
```

Open **http://localhost:7070**. That's it — on this Mac the UI needs no token.

> **Port already in use?** Harbor defaults to 7070. If something else owns it, run on another port:
> ```bash
> HARBOR_PORT=7071 npm start
> ```

### Define your services

Edit [`services.json`](services.json). Each entry:

```json
{ "name": "api", "cwd": "~/projects/my-api", "command": "npm run dev", "port": 8080, "autostart": false }
```

- `port` may be a single number or an array (`[4000, 4001]`) for multi-port services.
- `autostart: true` starts the service when Harbor launches at login (default `false`).
- `cwd` may use `~`. The command runs through your shell in that directory.

Hit **Refresh** (or the list auto-refreshes every 4s) to pick up changes.

## Reach it from your phone (Tailscale)

With Tailscale up, Harbor prints a tokenized URL on startup:

```
http://<your-machine>.<tailnet>.ts.net:7070/?token=<token>
```

Open that once on your phone (on the same tailnet); it stores the token and drops it from the
address bar. From then on you can Start/Stop/Kill remotely. The token lives in `data/token`
(git-ignored, `chmod 600`) and is required for every state-changing request.

## Touch ID (optional, this Mac only)

Open Harbor via **http://localhost:7070** (the hostname `localhost`, not `127.0.0.1`) and click
**Set up Touch ID**. After enrolling, Kill/Stop from this Mac require a fingerprint. It never
replaces the token — the phone still uses the token. (WebAuthn needs the `localhost` hostname; see
HANDOFF.md for why.)

## Launch at login

```bash
npm run install-login     # installs a LaunchAgent: starts at login, relaunches if it crashes
npm run uninstall-login   # removes it (services it started keep running)
```

Logs from the login-launched process go to `data/harbor.out.log`.

## Run it

```bash
npm start            # foreground on :7070 (or HARBOR_PORT)
npm test             # unit tests for the deterministic core
```

## How it's built

```
server/server.js        Express: serves the frontend + JSON API, binds 0.0.0.0
server/lib/             one home per concern — ports, services, processes, registry,
                        safety, tailscale, auth, webauthn
server/public/          static frontend (no build step)
scripts/                launch-at-login + icon generator
test/                   node --test suite
services.json           your known-services config (committed; edit freely)
data/                   runtime state — token, PID files, logs (git-ignored, NOT source)
```

See **HANDOFF.md** for architecture, the trap list, and the security model.

## Safety notes

- Harbor never kills its own process, PID 0/1, Apple system binaries (`/System`, `/usr/libexec`, …),
  or anything you don't own.
- `kill -9` always requires an explicit confirmation.
- Bound to `0.0.0.0` so the tailnet can reach it — which is why the token is mandatory. Keep your
  tailnet private (don't use `tailscale funnel`).
