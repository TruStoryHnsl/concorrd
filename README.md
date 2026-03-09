# Concord

A Discord replacement built on the [Matrix](https://matrix.org/) protocol. Self-hosted, open-source, designed for small communities.

## Features

- **Text chat** — Rooms, threads, typing indicators, read receipts, media uploads
- **Voice channels** — WebRTC voice/video via LiveKit SFU
- **Soundboard** — Upload audio clips or import from Freesound library, play into voice channels
- **Server model** — Discord-style servers with channels, roles, invites, and permissions
- **Server discovery** — Browse and join public servers
- **Invite system** — Link invites, email invites, and direct user invites
- **Admin panel** — Global admin dashboard for managing servers, users, and bug reports
- **Webhooks** — External message posting into channels
- **Dark theme** — Full dark UI with Tailwind CSS

## Architecture

Four Docker services behind Nginx:

| Service | Purpose |
|---------|---------|
| **Tuwunel** | Matrix homeserver (auth, rooms, messages, presence) |
| **Concord API** | FastAPI backend (servers, invites, soundboard, admin) |
| **LiveKit** | WebRTC SFU (voice/video routing, soundboard injection) |
| **Nginx** | Reverse proxy, static file serving |

The client is a React + TypeScript SPA that talks to all three backends.

## Quick Start

### Prerequisites

- Docker and Docker Compose
- A server or machine with at least 1GB RAM

### Install

```bash
git clone https://github.com/YOU/concorrd.git
cd concorrd
chmod +x install.sh
./install.sh
```

The install wizard will:
1. Check prerequisites (Docker, Docker Compose)
2. Ask for your domain/hostname and ports
3. Create your admin account
4. Generate all secrets automatically
5. Build and launch all services

### Manual Setup

If you prefer to configure manually:

```bash
cp .env.example .env
# Edit .env with your values
docker compose up -d --build
```

Then register your first account at `http://your-host:8080`.

## Configuration

All configuration is in the `.env` file. Key settings:

| Variable | Description |
|----------|-------------|
| `CONDUWUIT_SERVER_NAME` | Your domain (cannot change after first run) |
| `CONDUWUIT_REGISTRATION_TOKEN` | Prevents unauthorized account creation |
| `LIVEKIT_API_KEY` / `_SECRET` | Voice/video authentication |
| `ADMIN_USER_IDS` | Comma-separated Matrix user IDs with admin access |
| `NGINX_HTTP_PORT` | Web interface port (default: 8080) |

### Optional Services

| Variable | Purpose |
|----------|---------|
| `METERED_APP_NAME` / `_API_KEY` | TURN relay for voice behind strict NATs |
| `SMTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_FROM` | Email invitations |
| `FREESOUND_API_KEY` | Sound effect library for soundboards |

## Project Structure

```
concorrd/
├── client/           # React + TypeScript + Vite
│   └── src/
│       ├── api/          # REST clients (Matrix, Concord API, LiveKit)
│       ├── components/   # UI components
│       ├── hooks/        # React hooks
│       └── stores/       # Zustand state management
├── server/           # Python FastAPI backend
│   ├── routers/          # API route handlers
│   └── services/         # Matrix admin, LiveKit tokens, email, bot
├── config/           # Nginx, LiveKit configuration
├── web/              # Multi-stage Docker build for client
├── docker-compose.yml
├── install.sh        # Interactive install wizard
└── .env.example      # Configuration template
```

## Routing

| Path | Backend |
|------|---------|
| `/` | Static React app (Nginx) |
| `/_matrix/` | Tuwunel (Matrix homeserver) |
| `/api/` | Concord API (FastAPI) |
| `/livekit/` | LiveKit (WebRTC signaling) |

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
docker compose logs -f concorrd-api
docker compose logs -f conduwuit
```

## Technical Notes

- **Tuwunel** is the successor to Conduwuit. It uses RocksDB internally (~170MB RAM vs Synapse's 500MB+).
- The `CONDUWUIT_SERVER_NAME` is baked into the Matrix database on first run and cannot be changed without wiping data.
- Environment variables use the `CONDUWUIT_` prefix for backward compatibility with Conduwuit-era configs.
- The client build happens inside Docker (multi-stage build) — no Node.js required on the host.

## License

MIT
