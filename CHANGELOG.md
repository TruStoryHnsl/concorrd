# Changelog

All notable changes to Concord will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-04-23

### Changed — User-scoped Discord bridge (breaking for admins)
- **Bridge is now user-scoped.** Admin "Enable / Disable / Rotate / Force-Reset" controls are gone. Each user connects their own Discord account from user-settings → **Connections**. Admins have no path to trigger, read, or revoke another user's session. See `docs/bridges/user-scoped-bridge-redesign.md` for the full design.
- **Bridge infrastructure is now invisible.** On concord-api startup, the lifespan bootstrap reconciles `registration.yaml` against `tuwunel.toml` and self-heals common drift states (fresh-install, orphaned entries, mismatched appservice IDs). Operators no longer click Enable; the bridge is always-on.
- **Admin "Bridges" settings tab removed.** Client settings navigation no longer shows Bridges for web admins or desktop Tauri users. All self-service flows live under the new **Connections** tab on every account.
- **Relay-bot mode retired.** Messages from Matrix users without a personal Discord connection no longer go to Discord via a shared admin bot. If this matters for a deployment, users must connect their own account.
- **Admin endpoints deleted**: `POST /api/admin/bridges/discord/{enable,disable,rotate,force-reset}`. The corresponding client wrappers (`discordBridgeHttpEnable` / `Disable` / `Rotate` / `ForceReset`) are gone.
- **Admin endpoints kept (temporarily)**: `GET /status`, `/guilds`, `/channels/{id}`, `/bot-profile`, `/bot-invite-url`; `POST /bot-token`, `/bot-profile`, `/login-relay`. Voice-bridge setup still relies on these until its own user-mode port lands. Will be removed in a follow-up.

### Added
- **Per-user Discord connections** — `GET /api/users/me/discord` (status), `POST /api/users/me/discord/login` (trigger bridge-bot DM + `login` command), `POST /api/users/me/discord/logout` / `DELETE /api/users/me/discord` (revoke). All authenticated as the caller; no admin override. `client/src/api/bridges.ts` exports `userDiscordStatus`, `userDiscordLogin`, `userDiscordLogout`.
- **Connections settings tab** (`client/src/components/settings/UserConnectionsTab.tsx`) — Connect / Disconnect buttons, 5s status polling, DiscordTosModal gate on first connect. Auto-resumes the login flow after ToS acceptance so users don't have to double-click.
- **Lifespan bridge bootstrap** (`server/services/bridge_bootstrap.py`) — reconciles registration + tuwunel.toml on every concord-api start. Fresh-install, orphan cleanup, drift re-injection, and full reset on ID-mismatch are all handled. Never blocks startup; logs degraded state for the admin to see via the status endpoint's `desync` field.

### Security — token-at-rest caveat (web client only)
- The mautrix-discord process stores per-user Discord tokens in its own on-host database. An operator with host or database access could theoretically read them. This caveat is documented in the `DiscordTosModal` users must accept before their first connect, and will be closed when the native Tauri client ships with a client-side bridge (tokens never leave the device). Web users accept this trade for convenience.
- Scrubbed leaked bridge tokens from `config/tuwunel.toml` (originally committed in `fd221f3`; rotate if you were running that revision).

### Added
- **Mobile logout** — always-visible 44×44 account button in the mobile top bar opens an `AccountSheet` glass panel with username and a Logout action. Reachable from every mobile view (chat, channels, DMs, servers, settings). Fallback Logout button also appended to the bottom of `SettingsPanel`. (INS-001)
- **Markdown rendering in chat** — chat message bodies now render markdown via `react-markdown` + `remark-gfm` with a hardened `rehype-sanitize` schema. Supports bold, italic, inline `code`, fenced code blocks, ordered/unordered lists, links (open in new tab with `rel="noopener noreferrer"`), headings (h1–h6), and blockquotes. URL link previews still work because URL extraction runs on the raw body before parsing. New deps: `react-markdown ^9`, `remark-gfm ^4`, `rehype-sanitize ^6`. (INS-002)
- **Auto-growing chat input** — `MessageInput` is now a `<textarea>` that grows to `min(40vh, 8 lines)` then becomes internally scrollable. The chat history reflows upward automatically because the form is `flex-shrink-0` inside a `flex-col min-h-0` parent. Plain Enter sends, Shift+Enter inserts a newline, IME composition is guarded, and edit-mode/Escape behavior is preserved. (INS-003)
- **Mobile navigation redesign** — flat 5-icon `BottomNav` replaced with a floating glass nav: sliding pill indicator, slightly elevated center "Chat" tab with primary glow, `active:scale-95` press feedback, ≥44×44 tap targets, `cubic-bezier(0.16,1,0.3,1)` 280ms transition. Same five `MobileView` destinations and `onChange`/`onSettingsOpen` API as before. (INS-001)
- **Runtime federation allowlist** — Admin → Federation now applies allowlist changes live via a Matrix server restart. Previously edits required manually copying a regex string into `.env` and recreating the container. New "Apply Changes" button with confirmation modal surfaces the brief downtime (~10-15s) before restart.
- `docker-socket-proxy` sidecar (`tecnativa/docker-socket-proxy`) scoped to `CONTAINERS=1 POST=1` so concord-api can restart the conduwuit container without mounting the host docker socket directly.
- `server/services/tuwunel_config.py` — atomic read/write helper for the new TOML config, with file locking and tmp-file-then-rename semantics to prevent torn reads.
- `server/services/docker_control.py` — thin async wrapper around the docker-socket-proxy API for restarting compose services by label.
- `scripts/migrate-federation-config.sh` — one-time migration helper that moves legacy `.env` federation vars into `config/tuwunel.toml`. Invoked automatically by `install.sh` on every run (no-op when nothing to migrate).
- `GET /api/admin/federation` now returns `pending_apply` (derived from TOML mtime vs. last successful apply timestamp) so the UI badge survives page reloads.
- `POST /api/admin/federation/apply` — new endpoint that triggers the container restart.

### Changed
- **Mobile scroll containers chained** — added `min-h-0` through the `ChatLayout` mobile shell, `SettingsPanel` tab content, and `ServerSettingsPanel` tab content so every mobile view scrolls top to bottom without clipping. `SubmitPage` switched to `items-start sm:items-center` + `overflow-y-auto` to fix mobile clipping. (INS-001)
- **Global text wrapping** — added `.concord-message-body` rule (`overflow-wrap: anywhere; word-break: break-word; min-width: 0`) so long unbroken strings in chat messages no longer cause horizontal overflow on mobile. (INS-001)
- **Federation config moved from `.env` to `config/tuwunel.toml`.** The three keys `CONDUWUIT_ALLOW_FEDERATION`, `CONDUWUIT_FORBIDDEN_REMOTE_SERVER_NAMES`, and `CONDUWUIT_ALLOWED_REMOTE_SERVER_NAMES` are no longer read by docker-compose.yml. They are preserved (commented-out) by the migration script for reference. All other `CONDUWUIT_*` env vars are unchanged.
- Federation allowlist regex patterns are now fully anchored (`^escaped-name$`). The previous implementation only anchored the end with `$`, which permitted unintended substring matches. **Security hardening.**
- `PUT /api/admin/federation/allowlist` now rejects invalid hostnames with HTTP 400 instead of silently dropping them. RFC-1123 hostname validation applies.
- `docker-compose.yml` now bind-mounts `./config/tuwunel.toml` into both `conduwuit` (RO) and `concord-api` (RW) containers.

### Fixed
- **Mobile users could not log out** — there was no logout affordance reachable from any mobile view. (INS-001)
- **Mobile pages clipped instead of scrolling** in several settings/server-settings/submit views due to missing `min-h-0` on parent flex columns. (INS-001)
- **Long unbroken strings in chat messages overflowed horizontally** on narrow viewports. (INS-001)
- Allowlist edits made in the admin UI now actually take effect without manual `.env` editing and container recreation. Previously the UI accepted changes but the running Tuwunel process silently ignored them until a human operator intervened.

### Security
- **Chat message rendering is now sanitized.** Markdown is parsed via `react-markdown` and run through `rehype-sanitize` with a hardened schema: dangerous tags (`script`, `iframe`, `style`, `object`, `embed`) are filtered, all `on*` event handlers are stripped, `href` URLs are restricted to `http`/`https`/`mailto`, and `src` URLs are restricted to `http`/`https`. Hostile bodies like `<img src=x onerror=alert(1)>` and `[click](javascript:...)` no longer execute. (INS-002)

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
