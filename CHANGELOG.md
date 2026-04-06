# Changelog

All notable changes to Concord will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Runtime federation allowlist** — Admin → Federation now applies allowlist changes live via a Matrix server restart. Previously edits required manually copying a regex string into `.env` and recreating the container. New "Apply Changes" button with confirmation modal surfaces the brief downtime (~10-15s) before restart.
- `docker-socket-proxy` sidecar (`tecnativa/docker-socket-proxy`) scoped to `CONTAINERS=1 POST=1` so concord-api can restart the conduwuit container without mounting the host docker socket directly.
- `server/services/tuwunel_config.py` — atomic read/write helper for the new TOML config, with file locking and tmp-file-then-rename semantics to prevent torn reads.
- `server/services/docker_control.py` — thin async wrapper around the docker-socket-proxy API for restarting compose services by label.
- `scripts/migrate-federation-config.sh` — one-time migration helper that moves legacy `.env` federation vars into `config/tuwunel.toml`. Invoked automatically by `install.sh` on every run (no-op when nothing to migrate).
- `GET /api/admin/federation` now returns `pending_apply` (derived from TOML mtime vs. last successful apply timestamp) so the UI badge survives page reloads.
- `POST /api/admin/federation/apply` — new endpoint that triggers the container restart.

### Changed
- **Federation config moved from `.env` to `config/tuwunel.toml`.** The three keys `CONDUWUIT_ALLOW_FEDERATION`, `CONDUWUIT_FORBIDDEN_REMOTE_SERVER_NAMES`, and `CONDUWUIT_ALLOWED_REMOTE_SERVER_NAMES` are no longer read by docker-compose.yml. They are preserved (commented-out) by the migration script for reference. All other `CONDUWUIT_*` env vars are unchanged.
- Federation allowlist regex patterns are now fully anchored (`^escaped-name$`). The previous implementation only anchored the end with `$`, which permitted unintended substring matches. **Security hardening.**
- `PUT /api/admin/federation/allowlist` now rejects invalid hostnames with HTTP 400 instead of silently dropping them. RFC-1123 hostname validation applies.
- `docker-compose.yml` now bind-mounts `./config/tuwunel.toml` into both `conduwuit` (RO) and `concord-api` (RW) containers.

### Fixed
- Allowlist edits made in the admin UI now actually take effect without manual `.env` editing and container recreation. Previously the UI accepted changes but the running Tuwunel process silently ignored them until a human operator intervened.

## [0.1.0] - 2026-03-31

### Added
- Kinetic Node UI redesign (Space Grotesk + Manrope fonts, surface hierarchy, glassmorphism, gradient CTAs, Material Symbols)
- Mobile bottom navigation — persistent access to Servers, Channels, Chat, Settings
- Lobby auto-join for all users (new registrations and existing logins)
- Welcome message with getting-started guide in lobby #welcome channel
- Dev mode deployment (Vite HMR via docker-compose.dev.yml)
- Self-containment feasibility report

### Changed
- Project restructured from v1/v2 directories to semantic versioning
- Former v2 (Tauri/libp2p beta) moved to `beta/` directory
- Scope changed from commercial to public

### Fixed
- Mobile navigation bug — menu items were unreachable without drawer discovery
