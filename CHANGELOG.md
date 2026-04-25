# Changelog

All notable changes to Concord will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.7.0] - 2026-04-25

### Added — app channels (extensions as channels under "Applications")
- **`channel_type: "app"`** is now a first-class server-side channel kind. Previously only the client knew about it; the server's `ChannelCreate` Pydantic was `Literal["text", "voice"]` so attempting to persist an app channel 422'd. Extended to `Literal["text", "voice", "app"]` and the request body now accepts `extension_id` + `app_access` (`"all"` | `"admin_only"`).
- `Channel` model gained `extension_id: str | None` and `app_access: str | None`. Both are `NULL` for text/voice channels. `extension_id` references the installed extension by id (no FK — the registry is the data-volume `installed_extensions.json`, not a DB table). `database._lightweight_migrations` adds the columns idempotently to existing DBs.
- `POST /api/servers/{server_id}/channels` validates app channels: `extension_id` must reference an extension that's actually installed (otherwise 400). `app_access` defaults to `"all"` when omitted.
- New `PATCH /api/servers/{server_id}/channels/{channel_id}/app-access` toggles access mode on existing app channels (owner only). Text/voice channels return 400.
- `ChannelOut` now includes both `extension_id` and `app_access`. The client side already had this typing in place; this just unblocks the server end of the wire.
- Worldview-map (and every other extension in the catalog) can now be added to a server as a channel under the "Applications" group, instead of being embedded inside an existing channel's right pane. Click the channel → the extension iframe takes the full chat-area pane.

## [0.6.1] - 2026-04-24

### Added
- **`GET /api/extensions/{ext_id}/public-config`** — unauthenticated companion to the auth-gated `/users/me/extensions/{id}/browser-config`. Returns the same browser-safe key set (filters out `*_secret` / `*_client_id` / `sentinel_instance_id`), so an extension's static iframe bridge can fetch operator-managed defaults synchronously at boot — no auth-token threading through the SDK. The trust boundary is unchanged: keys returned here are the same ones the SDKs (Cesium, AISStream, TomTom, Windy) would have read from the request the iframe makes anyway.

## [0.6.0] - 2026-04-24

### Added — extension upstream-API proxy
- **`/api/ext-proxy/{ext_id}/{provider}/{path:path}`** lets installed extensions hit upstream APIs that need an OAuth client_secret without ever shipping the secret to the browser. Built around a small provider registry: `opensky` (OAuth2 client_credentials → Bearer), `sentinel` (OAuth2 → Sentinel Hub WMS, instance-id-scoped), `nycdot` (no auth, just forwarded). New providers register by adding an entry in `routers/ext_proxy.py::PROVIDERS`. OAuth tokens are cached in-process for `expires_in − 60s` and refreshed transparently.
- **Per-extension secrets store** in `instance.json[extension_secrets][ext_id]`. Admin endpoints `GET/PATCH /api/admin/extensions/{ext_id}/secrets` upsert with masked reads and accept `null` / `""` to clear individual fields.
- **`GET /api/users/me/extensions/{ext_id}/browser-config`** surfaces operator-stored, browser-safe extension config to authenticated users (filters out `*_secret` and `*_client_id` keys). Lets the iframe pre-populate browser-direct API keys from instance defaults when localStorage is empty, without granting the iframe access to the OAuth client_secret.
- Companion package `concord-extensions/packages/worldview-map`: the legacy Cesium OSINT-globe extension ported to the new catalog format. Layers that need OAuth (flights/OpenSky, satellites/Sentinel) route through the new `/api/ext-proxy/`; browser-direct layers (Cesium tiles, AISStream maritime, TomTom traffic, Windy weather) read keys from per-user localStorage via an in-extension Settings overlay.

## [0.5.1] - 2026-04-24

### Fixed
- **Voice chat crash *actually* fixed this time.** The v0.4.0 attempt added `webAudioMix: true` to `RoomOptions`, which was necessary but not sufficient: LiveKit's `Room.createLocalTracks` calls `track.setProcessor(...)` while the track is being constructed — *before* it runs `track.setAudioContext(this.audioContext)` in line 26604 of the esm bundle. So the processor check `!this.audioContext` always threw during track creation regardless of `webAudioMix`. The user kept seeing the three-toast pileup (`Microphone unavailable` → `Audio context needs to be set on LocalAudioTrack` → `Client initiated disconnect`). Real fix: `buildLiveKitAudioCaptureOptions` no longer includes a `processor` field. The noise-gate / HP filter / master-volume processor is attached exclusively post-publish via the guarded `useEffect` in `VoiceChannel.tsx`, which runs *after* LiveKit has wired `audioContext` onto the track. Added a regression test (`noiseGate.test.ts::does NOT attach a processor to capture options`) so a future refactor can't reintroduce the field without going red.

## [0.5.0] - 2026-04-24

### Changed — Discord user integration moved from bridge to OAuth2 (breaking)
- **`/api/users/me/discord/*` now means Discord OAuth2, not the mautrix-discord bridge.** Per-user QR-login-via-bridge was the wrong mental model: the bridge is an admin/operator integration, a user signing in is a personal OAuth account connection. New endpoints:
  - `GET /api/users/me/discord/oauth/config` — reports whether OAuth is usable on this instance.
  - `POST /api/users/me/discord/oauth/start` — returns Discord's authorize URL with a CSRF state token.
  - `GET /api/users/me/discord/oauth/callback` — exchanges the code for access + refresh tokens, upserts `UserDiscordOAuth`, redirects the user back.
  - `DELETE /api/users/me/discord/oauth` — revokes and deletes the row.
  - `GET /api/users/me/discord` — now returns OAuth-backed status (username, global name, avatar) instead of the bridge-timeline heuristic.
  - `GET /api/users/me/discord/guilds` — lists the caller's Discord servers using the `guilds` scope. Transparent token refresh on 401.
  - `GET /api/users/me/discord/guilds/{id}/channels` + `GET /api/users/me/discord/channels/{id}/messages` + `POST .../messages` — best-effort Phase-3 hybrid. Uses the mautrix-discord captured-session token (read from the bridge's SQLite volume) when present; otherwise returns `limited_by_discord: true` so the UI can explain the gap. Discord's OAuth2 scopes do not include message read/send for third-party web apps — this is a hard Discord-policy limit.
- **Removed endpoints** (breaking): `POST /api/users/me/discord/login`, `POST /api/users/me/discord/logout`. The whole bridge-QR flow is out. Admin-level bridge configuration remains under `/api/admin/bridges/discord/*`.
- **UserDiscordOAuth + DiscordOAuthState tables** land via `Base.metadata.create_all` on startup — no migration file required; SQLite picks them up automatically.

### Added — credentials move from .env to the admin UI
- **`/api/admin/integrations/discord-oauth` GET/PATCH**: operators set the Discord OAuth Client ID + Client Secret from Admin → Integrations → Discord OAuth. Values persist to `instance.json` and take precedence over the legacy `DISCORD_OAUTH_CLIENT_ID` / `DISCORD_OAUTH_CLIENT_SECRET` env vars (kept only as bootstrap defaults). No container restart required to rotate keys; the consuming router reads at call time.
- **Admin UI**: new Admin → Integrations section with a Discord OAuth card — redirect URL computed server-side so operators can paste it into Discord's developer portal verbatim; secret field is write-only with a masked read-back (`x***y (len N)`).

### Added — user-facing Discord browser
- **Settings → Connections → "Sign in with Discord"** kicks off the OAuth redirect. The same card hosts a "Browse servers" button once connected.
- **DiscordBrowser overlay**: guild rail → channels list → messages pane → composer. Polls messages every 4s via the captured-session hybrid. Renders a clear amber explainer card when only OAuth scopes are available ("Enable the mautrix-discord bridge + QR-capture flow for full read/send, or open the guild in Discord directly").

### Removed
- `server/routers/user_connections.py` and its test file — the bridge-based per-user login surface is gone; the file's helpers (`_send_as_user`, `_bridge_bot_mxid`) had no remaining callers after the OAuth cutover.
- Client-side `userDiscordLogin` / `userDiscordLogout` / `UserDiscordStatus` in `client/src/api/bridges.ts`. Replacements live in `client/src/api/concord.ts`.

## [0.4.4] - 2026-04-24

### Fixed
- **Discord connection status now reflects real bridge state.** `GET /api/users/me/discord` was a stub that always returned `connected: false`, so the UI always showed Connect — even after a successful login. Clicking Connect on a connected account produced "You're already logged in" (invisibly) and ate the QR reply. The endpoint now opens (or reuses) the user's management DM with the bridge bot and scans recent messages for the bot's reply phrases (`already logged in`, `successfully logged in`, `pong` → connected; `not logged in`, `logged out` → disconnected). Best-effort — the real fix is the mautrix-discord provisioning API (shared-secret HTTP), but that requires bridge config changes operators haven't opted into.

### Changed
- **Dropped the pin icon next to DM threads.** The per-row pin/unpin button was unnecessary chrome. Pin state still affects sort order (pinned DMs render above the regular stack in the sidebar); the surface for toggling it just lives elsewhere now.

## [0.4.3] - 2026-04-24

### Fixed
- **Discord Connect silently returned "You're already logged in" and no QR.** The DM room and the `login` command were reaching the bridge (confirmed by inspecting the room timeline — @discordbot replied "You're already logged in"), but mautrix-discord tracks login state per-MXID in its own SQLite DB, so a stale session there short-circuited the QR generation. The `/api/users/me/discord` status endpoint is still a stub that always returns `connected: false`, so the UI kept showing Connect — and every click just refreshed the same error. `user_discord_login` now sends `logout` before `login` (with a 2s settle gap), clearing any stale bridge session so the `login` that follows actually produces a fresh QR.

## [0.4.2] - 2026-04-24

### Changed
- **Click an image in chat → in-app lightbox, not a new tab.** The `m.image` renderer previously wrapped every message image in `<a target="_blank">`, which kicked users to a new browser tab on every click and broke stay-in-app flow (especially on mobile). New `ImageLightboxTrigger` opens a full-screen overlay with the image; Esc or backdrop click closes it; a separate "Open original" button is still available for the save/share case. Body scroll is locked while the lightbox is up so the chat behind doesn't scroll under the mouse wheel.

## [0.4.1] - 2026-04-24

### Fixed
- **Caddy didn't route `/ext/*` to concord-api**, so installed extension bundles fell through to the SPA catch-all and returned concord's own `index.html` instead of the extension. Added `handle /ext/*` → `concord-api:8000` in both `config/Caddyfile` and `config/Caddyfile.dev`. Replaces the legacy `handle_path /ext/worldview/* -> worldview:8080` block that was tied to the deprecated Python-server worldview container.

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
