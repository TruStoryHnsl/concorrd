# Changelog

All notable changes to Concord will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-04-24

### Added
- **Extension catalog + one-click install from the concord-extensions library.** Admin → Extensions lists every package published in the `concord-extensions` workspace (worldview, botc, card-suite, chess-checkers, game-maker at time of writing) and lets the instance admin install or uninstall each one. Implementation:
  - `GET /api/admin/extensions/catalog` proxies the remote catalog (default: `https://raw.githubusercontent.com/TruStoryHnsl/concord-extensions/main/catalog.json`, override via `CONCORD_EXTENSION_CATALOG_URL`) and also returns the set of already-installed ids so the UI can render Install / Installed / Uninstall buttons.
  - `POST /api/admin/extensions/install {extension_id}` downloads the bundle_url from the catalog (not from the client — no arbitrary-URL installs), extracts the zip into `<DATA_DIR>/extensions/<id>/` with traversal-safe path clamping and a 50 MB size cap, and registers the extension in `<DATA_DIR>/installed_extensions.json`.
  - `DELETE /api/admin/extensions/{id}` reverses both.
  - Installed bundles are served by FastAPI at `/ext/<id>/*` — resolved relatively inside the iframe (`./assets/...`), clamped to the extension's own dir so `../etc/passwd` 404s instead of leaking the host.
  - `routers/extensions.py` now reads the persistent registry on the data volume (falling back to the old bundled `server/extensions.json` only when the data-volume file is missing), so installs survive image rebuilds.

## [0.3.0] - 2026-04-24

### Added
- **Instance-admin invite management.** New Admin → Invites section lists every invite token on the instance (across all servers), lets the admin create new tokens with an optional server_id (defaults to the instance's default lobby), and revokes any invite regardless of server membership. Backed by a new `DELETE /api/admin/invites/{id}` endpoint (bypasses the server-admin check the server-scoped DELETE enforces). Closes the "I can't issue account-creation tokens without picking a server first" gap.
- **Open-registration toggle** in Admin → Instance. Persists to `instance.json::open_registration` and takes precedence over the `OPEN_REGISTRATION` env var at runtime, so operators can flip the invite gate from the UI without shelling into the host. The env var remains the bootstrap default on fresh installs. `/api/instance` and `/api/register` share a single `_open_registration_enabled` resolver so they can't disagree.

### Fixed
- **Discord bridge DM room spawning.** `create_dm_room` consults the caller's `m.direct` account data and reuses a live DM with the bridge bot (both parties still joined) before falling back to `POST /createRoom`. Previous behaviour was to create a fresh room on every call — consecutive Connect clicks left a trail of orphan DMs and the "login" command often landed in a room the bot had never joined, producing the "UI says QR sent but no DM arrives" symptom. Newly-created DMs are registered in `m.direct` so the next call finds them.

## [0.2.4] - 2026-04-24

### Fixed
- **Voice chat crashed on join with "Audio context needs to be set on LocalAudioTrack"** — LiveKit Room options now pass `webAudioMix: true` so LocalAudioTracks get an AudioContext attached at creation. Without it, our `ConcordNoiseGateProcessor.init()` (which reads `opts.audioContext`) aborted before any track work, the error bubbled through `onError → voiceDisconnect`, and the user saw a cascade of three toasts ending in "Client initiated disconnect". The post-publish `setProcessor` useEffect in `VoiceChannel` also got a `micTrack.audioContext` guard so the short window during track swaps / reconnects doesn't resurrect the same crash.
- **Notifications didn't clear reliably** — `markRoomRead` now walks back to the last unread-contributing event (`m.room.message` / `m.room.encrypted` / `m.sticker` / `m.call.invite`) instead of anchoring the marker on whatever tail event happened to be there. State events / redactions / reactions don't advance the server's "unread run", so the old behaviour often left the badge lit after a channel was actually read. `useUnreadCounts` + `useHighlightCounts` now also listen to `ClientEvent.AccountData` so `m.fully_read` updates refresh the badge immediately rather than waiting for an unrelated Timeline/Receipt tick. `setRoomReadMarkers` errors are surfaced via `console.warn` so the next regression has a trace.
- **"Connection Failed — NetworkError" when adding a sibling Concord instance as a source** — `CORS_ORIGINS` env is now forwarded into the `concord-api` container via `docker-compose.yml` (it was being read from the host `.env` but never reaching the container, so FastAPI's CORSMiddleware saw an empty allow-list and fell back to the localhost/tauri-only default). Operators still set the actual domains in their `.env`; this just wires the plumbing.

### Added
- **Discord tile in the Add Source picker.** User-scoped Discord still lives under Settings → Connections (one-click connect, ToS gate, no deep-linked modal step), but the Add Source menu now shows a Discord entry that routes the user there instead of the previous silence. Parity with Concord / Matrix / Mozilla / Reticulum options.

### Changed
- **Server-scoped tabs in Settings collapse to a single "Server Settings" row.** Previously each admin server rendered its own full-width tab strip (so admin-ing N servers produced N stacked rows); now one row with a server dropdown expands the selected server's tabs inline. Non-admin servers opened via gear context menu still appear in the picker. Reduces vertical footprint without removing any controls.

## [0.2.3] - 2026-04-24

### Fixed
- **First-boot picker re-appears on every refresh for pre-INS-050 instances.** Any Concord instance provisioned before the INS-050 Host/Join picker landed has an `instance.json` that records `default_server_seeded` / `welcome_posted` but was never migrated to carry the newer `first_boot_complete` flag. `/api/instance` returned `first_boot: true` on every request for those installs, so the picker was stuck in front of the real UI. Added `_is_first_boot(settings)` which honours the explicit flag when present but also treats either legacy provisioning marker as proof that first boot is long past. `/api/register` uses the same helper so the invite-gate bypass doesn't silently open on upgraded instances.

## [0.2.2] - 2026-04-23

### Removed
- **Legacy `ext/worldview` submodule** — Worldview's canonical source now lives in the `concord-extensions` workspace (`packages/worldview/`) as a Vite/TS extension package. The empty gitlink, `worldview` compose service, Caddy `/ext/worldview/*` reverse-proxy, and the `server/extensions.json` registration have all been dropped. Concord's extension-integration surfaces (`client/src/components/extension/*`, session model, InputRouter, SDK) are unchanged.

## [0.2.1] - 2026-04-23

### Fixed
- **Client build** — `ExtensionEmbed.surfaces` now accepts both layout-level `SurfaceDescriptor[]` and session-model `ExtensionSurface[]`, normalizing the latter via a new `toSurfaceDescriptor` helper. `ChatLayout.tsx:1747` had been passing store-level surfaces into a prop typed against the SDK descriptor since the `efa90fe` merge, breaking `tsc -b && vite build`. Dev was unaffected because Vite's dev transform skips type-checking. Supersedes the unbuildable v0.2.0 artifact.

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
