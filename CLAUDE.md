# CLAUDE.md

Harbor — local macOS port manager. Full brief in **AGENTS.md**; architecture + trap list in
**HANDOFF.md**. Read those first.

## The two or three things that will trip you up immediately

1. **The frontend has no build step**, but it IS served by the server — edit `server/public/*`
   and just refresh. The server injects the token into `index.html` at request time (loopback only).
2. **Port 7070 may be taken on this machine.** Another local app can hold `127.0.0.1:7070` and
   shadow Harbor's `0.0.0.0` bind with no error. Use `HARBOR_PORT=7071 npm start` and check
   `lsof -nP -iTCP:<port> -sTCP:LISTEN` if the wrong page loads. (See HANDOFF trap list.)
3. **Re-adoption matches by PORT, not command** — don't "fix" it back to a command compare; that
   was a real bug (a live service got disowned). See `registry.reconcile` + HANDOFF.

## Commands

```bash
npm start                 # foreground, :7071 (or HARBOR_PORT)
npm test                  # 37 unit tests
npm run install-login     # LaunchAgent: start at login
```
