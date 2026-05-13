# concord

Self-hosted Discord replacement on Matrix. Voice, soundboards, server discovery, optional federation — your control plane, your data.

## What it is

A small-community chat platform that looks and feels like Discord but runs on infrastructure you own. Five Docker services, one `install.sh`, one `.env` file. Tuwunel handles Matrix (auth, rooms, presence, federation), LiveKit handles WebRTC voice, a FastAPI service handles the Discord-style server/invite/soundboard model that Matrix doesn't natively expose, and Caddy fronts it all with auto-HTTPS.

The same compiled React bundle ships as a web app and as a Tauri 2 desktop app. Native iOS/Android packages are in progress with full feature parity (no capability deltas between web and native).

A separate experimental fork — [concord-beta](https://github.com/TruStoryHnsl/concord-beta) — is exploring native peer-to-peer mesh chat (Tauri + Rust + libp2p, Reticulum discovery, WireGuard tunnels for video). It shares the product vision but is a fundamentally different transport architecture and an independent codebase.

## Why

Discord is great until you remember someone else owns the kill switch. Concord is the same UX without that — same channels, same roles, same voice rooms, same soundboard, but the homeserver, the recordings, the user database, the moderation tools, and the federation policy all live on a box you can `ssh` into.

Most of the existing Matrix clients are excellent at being Matrix clients and bad at feeling like Discord. Most "self-hosted Discord" forks are great at feeling like Discord and bad at being open. Concord is a wrapper layer — a Discord-shaped server/invite/soundboard model on top of Matrix — so you get the federation and end-to-end story for free, and the UX still feels like the thing your friends already know how to use.

Beyond chat, the longer-term direction is for concord to be the swiss-army knife for self-hosted comms — a single client that talks Matrix, federates with other concord instances, bridges in legacy networks where it's worth it, and (via concord-beta's mesh track) eventually carries traffic over Reticulum + WireGuard when there's no homeserver in the loop at all. Concord is infrastructure, not a service. Users should have privacy from the admin too.

Posture: personal-scale tool first, scaling later. Single-user and small-community deployments today; commercial polish (native apps, donation-based monetization, App Store distribution) is the path forward — but every functional capability stays free in the browser-accessible web UI.

## Architecture

```
                        ┌──────────────────┐
                        │   web client     │  React 19 + TS + Vite
                        │ (browser/Tauri)  │
                        └────────┬─────────┘
                                 │ HTTPS
                                 ▼
                       ┌───────────────────┐
                       │   Caddy (web)     │  auto-HTTPS, static bundle,
                       │  reverse-proxy    │  path-based routing
                       └─────┬───────┬─────┘
                             │       │
              ┌──────────────┘       └──────────────┐
              │                                     │
              ▼                                     ▼
   ┌──────────────────┐                  ┌──────────────────────┐
   │     tuwunel      │◀──restart────┐   │     concord-api      │
   │ (Matrix homesvr) │              │   │     (FastAPI)        │
   │  conduwuit fork  │              │   │  servers, invites,   │
   │  RocksDB ~170MB  │              │   │  DMs, soundboard,    │
   └──────────────────┘              │   │  TOTP, moderation,   │
              ▲                      │   │  admin, federation   │
              │ federation           │   └─────┬───────────┬────┘
              ▼                      │         │           │
        other Matrix                 │   docker-socket-    │
        homeservers                  └───proxy (CONTAINERS=1│
                                         POST=1, no host   │
                                         socket)           │
                                                           │ tokens
                                                           ▼
                                                ┌──────────────────┐
                                                │     LiveKit      │
                                                │   (WebRTC SFU)   │
                                                │  voice + sound-  │
                                                │  board injection │
                                                └──────────────────┘
                                                       ▲
                                            optional   │
                                                       ▼
                                                ┌──────────────┐
                                                │ coturn TURN  │
                                                │ (or external │
                                                │  metered.ca) │
                                                └──────────────┘
```

| Component | Image / source | Role |
|---|---|---|
| **tuwunel** | `ghcr.io/matrix-construct/tuwunel:main` | Matrix homeserver — auth, rooms, messages, presence, federation. Conduwuit successor, RocksDB-backed (~170 MB RAM vs Synapse 500 MB+). Compose name is still `conduwuit` for back-compat. |
| **concord-api** | built from `./server` (FastAPI / Python) | The Discord-shaped overlay Matrix doesn't ship. Routers: admin, servers, invites, direct invites, DMs, voice, soundboard, webhooks, moderation, registration, TOTP, stats, media, preview. Services: matrix_admin, livekit_tokens, email, bot, tuwunel_config, docker_control. |
| **livekit** | `livekit/livekit-server:v1.8` | WebRTC SFU. Voice/video routing + soundboard audio injection into rooms. |
| **docker-socket-proxy** | `tecnativa/docker-socket-proxy` | Locked-down sidecar (`CONTAINERS=1 POST=1`). Lets concord-api restart tuwunel for live federation-policy hot-swap without ever giving the API the host docker socket. |
| **web** (Caddy) | built from `./web` | Reverse proxy, auto-HTTPS via Let's Encrypt, static React bundle, path-based routing. |
| **coturn** | embedded service (optional) | TURN relay for clients behind strict NATs. External `metered.ca` is supported as an alternative. |
| **client** | `./client` (React 19 + TS + Vite + Zustand) | SPA — talks to tuwunel, concord-api, and LiveKit through Caddy. Mobile-first responsive layout, dark theme, floating glass bottom nav. |
| **Tauri 2 desktop app** | `./src-tauri` | Wraps the same compiled React bundle. Stores target server URL in a local Tauri store so one binary can point at any concord instance. |

All five Docker services run on an internal `concord` bridge network. The web client is the only thing exposed to the user.

## Quickstart

```bash
git clone https://github.com/TruStoryHnsl/concord.git
cd concord
chmod +x install.sh
./install.sh
```

The installer is interactive (`back` at any prompt to step backwards). It will:

1. Check prerequisites (Docker, Docker Compose).
2. Name your server and create your admin account.
3. Configure networking (custom domain with auto-HTTPS, or local-only HTTP on `:8080`).
4. Set up optional integrations (SMTP, Freesound for soundboards, embedded coturn or external metered.ca).
5. Run any pending federation-config migrations (`scripts/migrate-federation-config.sh`).
6. Generate all secrets.
7. Build and launch all services.

Manual setup if you'd rather:

```bash
cp .env.example .env
# edit .env — at minimum CONDUWUIT_SERVER_NAME and SITE_ADDRESS
docker compose up -d --build
```

Local frontend hacking with Vite HMR (swaps the production Caddy bundle for a dev server):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

Desktop app (Tauri 2 — needs Rust + Node locally):

```bash
cd client && npm install && cd ..
cargo tauri dev      # development
cargo tauri build    # produces a native installer for your OS
```

#### Windows installer

CI ([`.github/workflows/windows-build.yml`](.github/workflows/windows-build.yml)) builds an MSI and an NSIS `.exe` on every push to `main`. Grab the artifact:

1. Open the latest **Windows build** run on [GitHub Actions](https://github.com/TruStoryHnsl/concord/actions/workflows/windows-build.yml).
2. Download either `concord-windows-msi` or `concord-windows-nsis` from the run's Artifacts panel (14-day retention).
3. Unzip; double-click the installer.

You'll see **"Windows protected your PC"** on first launch. The build is unsigned (no code-signing cert yet), so SmartScreen warns on every download. Click **More info → Run anyway** to proceed. Once signing lands the warning goes away — tracked separately, not blocking on it for the open-source distribution.

What the first launch looks like:

- Installer drops Concord to `%PROGRAMFILES%\Concord\` (MSI) or `%LOCALAPPDATA%\Programs\Concord\` (NSIS / per-user install).
- The app boots into a **Server Picker** screen (Join an existing server / Host your own). It does NOT pre-configure any server — you point it at a Concord or Matrix homeserver of your choice. Enter `concordchat.net` if you want to try the public instance.
- Embedded chat database (tuwunel) lives at `%APPDATA%\concord\tuwunel\` and is preserved across reinstalls. App config (server URL, encryption keys) lives at `%APPDATA%\com.concord.chat\` and is wiped by uninstall.

Building it yourself on Windows: see [`docs/native-apps/windows-install.md`](docs/native-apps/windows-install.md) for the full bootstrap (`scripts/win-dev-bootstrap.ps1`) + native build (`scripts/build_windows_native.ps1`).

> Note: cross-compiling Windows installers from Linux is currently blocked by libsodium-sys-stable's POSIX-only build deps in the iota_stronghold tree. Use the Windows CI workflow or a real Windows host. `scripts/build_windows_wsl.sh` exits with a clear diagnostic if you try.

#### Uninstalling Concord

**Windows.** Open **Settings → Apps → Installed apps**, find **Concord**, and click **Uninstall**. The NSIS uninstaller removes:

- The install dir (`%LOCALAPPDATA%\Programs\Concord\`).
- The HKCU uninstall registry entry.
- Per-user config under `%APPDATA%\com.concord.chat\` (settings, auth tokens, webkit cache).
- Any legacy `%APPDATA%\Concord\` folder from pre-1.0 builds.

The embedded chat database under `%APPDATA%\concord\tuwunel\` is **preserved** so a future reinstall picks up where you left off. To wipe chat history too, delete that folder manually after uninstall.

Reinstalling over an existing version: the installer prompts to close any running Concord, then clears the install dir before extracting the new build. Older versions that hit "Concord already installed / uninstall fails" can run the new installer directly — it self-repairs.

**macOS.** Drag `/Applications/Concord.app` to the Trash, then run the bundled uninstall helper from Terminal to clean per-user state:

```bash
/Applications/Concord.app/Contents/Resources/uninstall.sh
```

(Run it BEFORE dragging the .app to Trash, or unzip the .dmg again to recover the script.) The helper removes the .app bundle, `~/Library/Application Support/Concord`, `~/Library/Caches/com.concord.chat`, `~/Library/Logs/Concord`, `~/Library/Preferences/com.concord.chat.plist`, and the macOS launch-services cache for `com.concord.chat`.

**Linux** (`.deb`/`.rpm`/AppImage). `.deb` and `.rpm` are managed by your package manager — `sudo apt remove concord` or `sudo dnf remove concord` cleans the install plus the postrm-script-managed cache. AppImage users delete the `.AppImage` file plus `~/.local/share/concord/` and `~/.config/concord/`.

Day-to-day:

```bash
docker compose logs -f                  # all services
docker compose logs -f concord-api      # just the API
docker compose logs -f conduwuit        # just the homeserver
docker compose restart                  # restart everything
docker compose up -d --build            # rebuild after code changes
```

### Configuration

All config lives in `.env` (`docker-compose.yml` reads it directly). Key settings:

| Variable | Default | Notes |
|---|---|---|
| `CONDUWUIT_SERVER_NAME` | — | Server identity. Baked into Matrix DB on first run — **cannot** change without wiping data. |
| `INSTANCE_NAME` | `${CONDUWUIT_SERVER_NAME}` | Display title on login page. Safe to change anytime. |
| `SITE_ADDRESS` | `:8080` | Domain for auto-HTTPS, or `:8080` / `:80` for HTTP-only. |
| `HTTP_PORT` | `8080` | Host port for the web interface. |
| `BIND_HOST` | `0.0.0.0` | Set to `127.0.0.1` for local-only. |
| `LIVEKIT_TCP_PORT` | `7881` | LiveKit signaling. |
| `LIVEKIT_UDP_START` / `_END` | `50000` / `50100` | LiveKit RTP UDP range. |
| `ADMIN_USER_IDS` | — | Comma-separated Matrix IDs with admin access. |

Federation settings (`allow_federation`, allow/blocklists) live in `config/tuwunel.toml`, not `.env`. They're managed live by the Admin → Federation panel: `services/tuwunel_config.py` rewrites the file via atomic tmp-file-then-rename, then `services/docker_control.py` calls the locked-down docker-socket-proxy to restart tuwunel. Brief downtime (~10–15 s) is surfaced in the UI before the restart fires. This is why concord-api never mounts the host docker socket directly.

Optional services:

| Variables | Purpose |
|---|---|
| `SMTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_FROM` | Email invitations |
| `FREESOUND_API_KEY` | Sound effect library for soundboards |
| `TURN_SECRET` / `TURN_HOST` / `TURN_DOMAIN` / `TURN_EXTERNAL_IP` | Embedded coturn TURN relay (config in `config/turnserver.conf`) |
| `TURN_TLS_*` | Optional TLS TURN listener for locked-down networks |
| `METERED_APP_NAME` / `METERED_API_KEY` | External metered.ca TURN (alternative to embedded coturn) |

### Routing (Caddy on `${HTTP_PORT}`)

| Path | Backend | Notes |
|---|---|---|
| `/` | static React bundle | Hashed assets cached forever, `index.html` `no-cache` |
| `/_matrix/*` | tuwunel `:6167` | Client-server API, `flush_interval -1` for streaming |
| `/_matrix/federation/*` | tuwunel `:6167` | Server-server federation |
| `/_matrix/key/*` | tuwunel `:6167` | Federation key exchange |
| `/.well-known/matrix/*` | tuwunel `:6167` | Client + server discovery |
| `/api/*` | concord-api `:8000` | FastAPI backend |
| `/livekit/*` | LiveKit `:7880` | WebSocket signaling (path-stripped) |
| `/downloads/*` | Caddy `file_server` | Forced `Content-Disposition: attachment` for desktop installers |

## Installation

Five distribution channels — one Docker stack for the server, four native installers for end users. All artifacts live on the [GitHub releases page](https://github.com/TruStoryHnsl/concord/releases/latest). The native installers are unsigned (project-owner policy: free distribution path only), so first-launch warnings from SmartScreen / Gatekeeper are expected and harmless.

### Docker / self-hosted server

The fastest path is the prebuilt stack archive published with each release as `concord-docker-stack-v0.X.Y.zip`. Unzip it, copy `.env.example` to `.env`, edit the two required values (`CONDUWUIT_SERVER_NAME` and `SITE_ADDRESS`), and run `docker compose up -d`. The compose file pulls prebuilt container images from `ghcr.io/trustoryhnsl/concord-web:<version>` and `ghcr.io/trustoryhnsl/concord-concord-api:<version>` (both tagged `latest` too), so a vanilla operator never has to build from source. For full configuration options including TURN, federation, and SMTP, see [Quickstart](#quickstart) above.

### Windows native

Download `Concord_<version>_x64-setup.exe` from the latest [Windows release](https://github.com/TruStoryHnsl/concord/releases?q=windows) and run it — the NSIS installer registers Concord under "Add or Remove Programs". If Windows reports "Concord is already installed" but the Start-menu entry has vanished, run `Uninstall Concord.exe` from the install directory (default `%LOCALAPPDATA%\Programs\Concord\`) to clean state, then re-run the installer. The app self-updates via Settings → About → "Check for updates" once installed.

### macOS (Apple Silicon)

Download `Concord_<version>_aarch64.dmg` from the latest [macOS Apple Silicon release](https://github.com/TruStoryHnsl/concord/releases?q=macos-arm64), open it, and drag `Concord.app` to `/Applications`. First launch will be blocked by Gatekeeper — right-click the app, choose Open, and confirm at the warning dialog. To uninstall: run `/Applications/Concord.app/Contents/Resources/uninstall.sh` (a small helper bundled with the app) to remove the app and scrub `~/Library/Application Support/concord/` and `~/Library/Preferences/com.concord.app.plist`.

### macOS (Intel)

Same flow as Apple Silicon — download the Intel-specific `Concord_<version>_x64.dmg` from the latest [macOS Intel release](https://github.com/TruStoryHnsl/concord/releases?q=macos-intel) and drag to `/Applications`. The embedded homeserver (`tuwunel`) is a separate x86_64 build, so do not install the arm64 .dmg on Intel hardware (it will refuse to launch). Uninstall is the same `uninstall.sh` helper inside `Concord.app/Contents/Resources/`.

### Linux

Download `concord_<version>_amd64.AppImage` from the latest [Linux release](https://github.com/TruStoryHnsl/concord/releases?q=linux), make it executable (`chmod +x concord_*_amd64.AppImage`), and run it directly. No system installation is performed; the AppImage is self-contained. To uninstall, delete the AppImage and scrub `~/.local/share/concord/` and `~/.config/concord/` to remove the embedded homeserver database and any cached credentials.

## Features

- Text chat with rooms, threads, DMs, typing indicators, read receipts, media uploads
- Sanitized markdown rendering — bold, italic, code blocks, lists, links, headings, blockquotes; hostile HTML filtered via `rehype-sanitize`
- Auto-growing chat composer (multi-line, grows up to 8 lines, Shift+Enter for newline, IME-aware)
- Inline URL link previews
- Voice/video channels via LiveKit SFU
- Soundboard — upload your own clips or import from Freesound, play directly into voice channels
- Optional TURN relay (embedded coturn or external metered.ca)
- Discord-style server/channel/role/permission model on top of Matrix
- Link invites, email invites, direct user invites
- Server discovery — browse and join public servers on the same homeserver
- Webhooks — external services can post into channels
- TOTP / 2FA per user
- Server-level moderation tools for admins/mods
- Admin dashboard — global server/user/federation/bug-report management
- Live federation control — allowlist/blocklist edits applied via controlled tuwunel restart, no `.env` editing
- Server activity / usage stats in the admin UI
- Auto-HTTPS via Caddy + Let's Encrypt
- Web client (React 19 + TypeScript + Vite SPA, dark theme, mobile-first)
- Desktop app (Tauri 2 wrapper, persistent server-URL store)
- Native iOS/Android — in progress, full web-client parity targeted
- Built-in servitude module (in progress) — desktop and mobile builds host a stable concord room from the same app, no separate daemon

## Status

Current build: **0.7.5** (web + desktop). Single-instance deployments tested — production stack runs on the maintainer's home-lab and serves a small group. Active development; not yet a "set up once and forget" appliance.

What's stable today:
- Web + Tauri desktop, voice + soundboard, federation, install wizard, runtime federation control, server discovery, webhooks, TOTP, admin panel, moderation.

What's in progress:
- Native mobile apps (iOS/Android, Tauri 2, full feature parity, donation-based monetization).
- Embedded servitude module — host a concord server from inside the desktop/mobile app, no docker required for end users.
- Universal sources panel — Matrix federation, other concord instances, and (via concord-beta) Reticulum mesh, all surfaced as first-class sources in the same UI.
- Game center — chat-integrated games (jackbox-style party games, card games, story games, tabletop emulator–style integration).
- Mobile UI refresh — swipe-only navigation, dockable pill menu, hardware-state status bar, edge-tap shortcuts.

What's NOT supported:
- Multi-tenant SaaS hosting — concord assumes one homeserver per instance.
- Migrating `CONDUWUIT_SERVER_NAME` after first run (Matrix limitation, not a concord limitation).
- End-to-end encryption parity with the official Matrix clients (E2EE works at the Matrix layer; the concord-specific surfaces — soundboard, server discovery, etc. — are not all E2EE).

## Related projects

- **[concord-beta](https://github.com/TruStoryHnsl/concord-beta)** — experimental fork: native peer-to-peer mesh chat (Tauri + Rust + libp2p), Reticulum discovery, WireGuard P2P video. Independent codebase, same product vision. Treat current concord as production and concord-beta as research.
- **[concord-extensions](https://github.com/TruStoryHnsl/concord-extensions)** — extension scaffolding (e.g. `worldview`) that runs against the concord client.

See [CHANGELOG.md](./CHANGELOG.md) for the full release history and [PLAN.md](./PLAN.md) for the master development map.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Conventional commits + feature branches required. Bug reports and feature requests via the issue templates in `.github/ISSUE_TEMPLATE/`.

## License

MIT — see [LICENSE](./LICENSE).
