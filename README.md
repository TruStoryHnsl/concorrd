# Concord

A Discord replacement built on the [Matrix](https://matrix.org/) protocol. Self-hosted, open-source, designed for small communities. Current version: **0.1.0**.

## Features

### Chat
- **Text chat** — Rooms, threads, DMs, typing indicators, read receipts, media uploads
- **Sanitized markdown rendering** — Bold, italic, code blocks, lists, links, headings, blockquotes; hostile HTML is filtered via `rehype-sanitize`
- **Auto-growing chat input** — Multi-line composer that grows up to 8 lines, Shift+Enter for newline, IME-aware
- **URL link previews** — Inline previews for shared links

### Voice
- **Voice channels** — WebRTC voice/video via LiveKit SFU
- **Soundboard** — Upload your own clips or import from the Freesound library, play directly into voice channels
- **Optional TURN relay** — Embedded coturn or external metered.ca for clients behind strict NATs

### Server model
- **Discord-style servers** — Channels, roles, permissions
- **Invites** — Link invites, email invites, and direct user invites
- **Server discovery** — Browse and join public servers on the same homeserver
- **Webhooks** — External services can post messages into channels
- **TOTP / 2FA** — Per-user time-based one-time passwords
- **Moderation tools** — Server-level moderation actions for admins/mods

### Operations
- **Admin panel** — Global dashboard for managing servers, users, federation, and bug reports
- **Runtime federation control** — Allowlist/blocklist edits apply live via a controlled container restart; no `.env` editing required
- **Server stats** — Activity and usage metrics surfaced in the admin UI
- **Auto-HTTPS** — Caddy reverse proxy with automatic Let's Encrypt certificates

### Clients
- **Web client** — React 19 + TypeScript SPA, dark theme, mobile-first responsive layout with floating glass bottom nav
- **Desktop app** — Tauri 2 wrapper around the same web client, with persistent server-URL settings store

## Architecture

Five Docker services on an internal `concord` bridge network:

| Service | Image | Purpose |
|---------|-------|---------|
| **Tuwunel** (`conduwuit`) | `ghcr.io/matrix-construct/tuwunel:main` | Matrix homeserver — auth, rooms, messages, presence, federation |
| **concord-api** | built from `./server` | FastAPI backend — servers, invites, DMs, soundboard, moderation, TOTP, admin, federation control |
| **LiveKit** | `livekit/livekit-server:v1.8` | WebRTC SFU — voice/video routing, soundboard injection |
| **docker-socket-proxy** | `tecnativa/docker-socket-proxy` | Minimal-privilege sidecar (`CONTAINERS=1 POST=1`) so concord-api can restart Tuwunel for federation hot-swap without mounting the host docker socket |
| **web** (Caddy) | built from `./web` | Reverse proxy, auto-HTTPS, static file serving for the React bundle |

The web client is a React 19 + TypeScript SPA that talks to Tuwunel, the Concord API, and LiveKit through Caddy. The desktop app reuses the same compiled bundle inside a Tauri 2 shell.

## Quick Start

### Prerequisites

- Docker and Docker Compose
- A server or machine with at least 1GB RAM

### Install

```bash
git clone https://github.com/TruStoryHnsl/concord.git
cd concord
chmod +x install.sh
./install.sh
```

The install wizard is interactive (type `back` at any prompt to step backwards) and will:

1. Check prerequisites (Docker, Docker Compose)
2. Name your server and create your admin account
3. Configure networking (domain with auto-HTTPS, or local-only HTTP)
4. Set up optional integrations (email, Freesound soundboard library, TURN relay)
5. Run any pending federation-config migrations (`scripts/migrate-federation-config.sh`)
6. Generate all secrets automatically
7. Build and launch all services

### Manual Setup

If you prefer to configure manually:

```bash
cp .env.example .env
# Edit .env with your values
docker compose up -d --build
```

Then register your first account at your configured URL.

### Dev mode

For local frontend hacking with Vite HMR:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

This swaps the production Caddy bundle for a Vite dev server so client changes hot-reload without a rebuild.

### Desktop app

The Tauri 2 desktop wrapper lives in `src-tauri/`. It bundles the same React client and stores its target Concord server URL in a local Tauri store, so a single binary can point at any Concord instance.

```bash
# From the repo root, with Rust + Node installed
cd client && npm install && cd ..
cargo tauri dev    # development
cargo tauri build  # produces a native installer for your OS
```

## Configuration

All configuration is in the `.env` file (`docker-compose.yml` reads it directly). Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `CONDUWUIT_SERVER_NAME` | — | Server identity — appears in user IDs (**cannot** change after first run) |
| `INSTANCE_NAME` | `${CONDUWUIT_SERVER_NAME}` | Display title on login page (safe to change anytime) |
| `SITE_ADDRESS` | `:8080` | Domain for auto-HTTPS, or `:8080` / `:80` for HTTP-only |
| `HTTP_PORT` | `8080` | Host port for the web interface |
| `BIND_HOST` | `0.0.0.0` | Interface to bind on the host (set to `127.0.0.1` for local-only) |
| `LIVEKIT_TCP_PORT` | `7881` | LiveKit TCP signaling port |
| `LIVEKIT_UDP_START` / `_END` | `50000` / `50100` | LiveKit RTP UDP range |
| `ADMIN_USER_IDS` | — | Comma-separated Matrix user IDs with admin access |

Federation settings (`allow_federation`, `forbidden_remote_server_names`, `allowed_remote_server_names`) are **no longer in `.env`** — they live in `config/tuwunel.toml` and are managed at runtime by the Admin → Federation panel. See [Runtime federation control](#runtime-federation-control) below.

### Optional Services

| Variables | Purpose |
|-----------|---------|
| `SMTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_FROM` | Email invitations |
| `FREESOUND_API_KEY` | Sound effect library for soundboards |
| `TURN_SECRET` / `TURN_HOST` / `TURN_DOMAIN` | Embedded coturn TURN relay (config in `config/turnserver.conf`) |
| `METERED_APP_NAME` / `METERED_API_KEY` | External metered.ca TURN relay (alternative to embedded coturn) |

### Switching to HTTPS

Set `SITE_ADDRESS` to your domain, `HTTP_PORT` to `80`, and restart. Caddy handles certificates automatically. The installer creates `docker-compose.override.yml` to map port 443.

### Runtime federation control

`config/tuwunel.toml` is bind-mounted **read-only** into the Tuwunel container and **read-write** into concord-api. The admin UI rewrites it via `services/tuwunel_config.py` (atomic tmp-file-then-rename so reads are never torn) and then calls `services/docker_control.py`, which talks to the `docker-socket-proxy` sidecar to restart the Tuwunel container. The brief downtime (~10–15 s) is surfaced in the UI before the restart fires.

This is why concord-api does **not** mount the host docker socket directly: the proxy is locked to `CONTAINERS=1 POST=1` so even a fully compromised concord-api can only list and restart containers, not pull images, mount volumes, or touch other services.

Allowlist regex patterns are fully anchored (`^escaped-name$`) and hostnames are validated against RFC-1123 before being written to disk.

## Project Structure

```
concord/
├── client/                    # React 19 + TypeScript + Vite SPA
│   └── src/
│       ├── api/               # REST clients (Matrix, Concord API, LiveKit)
│       ├── components/        # UI components
│       ├── hooks/             # React hooks
│       └── stores/            # Zustand state management
├── server/                    # Python FastAPI backend
│   ├── main.py                # App entrypoint
│   ├── routers/               # admin, servers, invites, direct_invites, dms,
│   │                          # voice, soundboard, webhooks, moderation,
│   │                          # registration, totp, stats, media, preview
│   ├── services/              # matrix_admin, livekit_tokens, email, bot,
│   │                          # tuwunel_config, docker_control
│   └── Dockerfile
├── src-tauri/                 # Tauri 2 desktop app (wraps client/)
├── web/                       # Dockerfile for Caddy + client bundle
├── config/                    # Caddyfile, Caddyfile.dev, livekit.yaml,
│                              # turnserver.conf, tuwunel.toml
├── scripts/                   # build-linux.sh, migrate-federation-config.sh
├── branding/                  # Logo, brand guidelines, favicon generator
├── beta/                      # Archived v2 prototype (Tauri + libp2p) — read-only
├── docker-compose.yml
├── docker-compose.dev.yml     # Vite HMR overlay for local frontend dev
├── docker-compose.override.yml # Generated by installer for HTTPS port mapping
├── install.sh                 # Interactive install wizard
├── .env.example               # Configuration template
├── CHANGELOG.md
└── VERSION
```

## Routing

Caddy fronts everything on `${HTTP_PORT}` (default `8080`):

| Path | Backend | Notes |
|------|---------|-------|
| `/` | Static React bundle (Caddy) | Hashed assets cached forever, `index.html` `no-cache` |
| `/_matrix/*` | Tuwunel `:6167` | Client-server API, `flush_interval -1` for streaming |
| `/_matrix/federation/*` | Tuwunel `:6167` | Server-server federation API |
| `/_matrix/key/*` | Tuwunel `:6167` | Federation key exchange |
| `/.well-known/matrix/*` | Tuwunel `:6167` | Client + server discovery |
| `/api/*` | concord-api `:8000` | FastAPI backend |
| `/livekit/*` | LiveKit `:7880` | WebSocket signaling (path-stripped) |
| `/downloads/*` | Caddy `file_server` | Forced `Content-Disposition: attachment` for desktop installers |

## Management

```bash
# View logs
docker compose logs -f

# Restart services
docker compose restart

# Stop everything
docker compose down

# Rebuild after code changes
docker compose up -d --build

# View specific service logs
docker compose logs -f concord-api
docker compose logs -f conduwuit
```

## Technical Notes

- **Tuwunel** is the successor to Conduwuit (image: `ghcr.io/matrix-construct/tuwunel:main`). It uses RocksDB internally (~170 MB RAM vs Synapse's 500 MB+). The compose service is still named `conduwuit` for backward compatibility.
- The `CONDUWUIT_SERVER_NAME` is baked into the Matrix database on first run and cannot be changed without wiping data.
- Environment variables use the `CONDUWUIT_` prefix for backward compatibility with Conduwuit-era configs.
- The web client build happens inside Docker (multi-stage build) — no Node.js required on the host. The desktop app build, however, needs Rust + Node locally.
- **Caddy** automatically provisions and renews HTTPS certificates when `SITE_ADDRESS` is set to a domain name.
- All bind mounts that point at `config/` are **directory mounts**, not single-file mounts. Single-file binds pin a specific inode at container start, so atomic tmp-file-then-rename writes (used by `tuwunel_config.py` and by `git pull`) become invisible inside the container until restart. Directory mounts track changes by path.

## Project history

The current build is `0.1.0` (released 2026-03-31). An earlier v2 prototype that explored Tauri + libp2p as a peer-to-peer transport now lives in `beta/` as a read-only archive — it is not part of the running stack and is preserved only for reference.

See [CHANGELOG.md](./CHANGELOG.md) for the full release history.

## License

MIT
