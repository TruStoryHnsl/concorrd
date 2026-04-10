# Discord Bridge — Sandboxed Matrix Application Service

Status: **DESIGN / DOCUMENTATION STAGE** (INS-024). No bridge service is
currently deployed on orrgate. This document is the operator runbook and
sandbox-boundary contract that MUST be satisfied before the
`concord-discord-bridge` Docker service lands in `docker-compose.yml`.

Source of truth: `PLAN.md > PRIORITY: Discord Bridge — Sandboxed Integration
(INS-024)`.

## 1. Goal

Bridge Discord guilds/channels into Concord's Matrix rooms with bidirectional
message relay, while strictly containing:

- Discord API credentials (bot token, application ID)
- Discord rate-limit failures
- The bridge daemon's dependency surface and any CVE exposure it carries
- Any crashes, panics, or unhandled errors in the bridge itself

None of these may degrade `tuwunel`, `concord-api`, the LiveKit SFU, or any
other Concord service. A Discord API outage is a cosmetic degradation of the
bridged rooms only — everything else keeps running.

## 2. Why an Application Service (AS), not a bot or custom protocol

Matrix ships a formalized **Application Service API** designed for exactly
this pattern: an out-of-process daemon that the homeserver trusts to own a
namespace of virtual users and room aliases, receives homeserver events via a
push transaction API, and sends events back via the standard client-server
API authenticated by an `as_token`.

That shape is the correct sandbox boundary:

- The AS lives in its own container, runs its own process tree, has its own
  dependencies, and speaks HTTP to the homeserver over a well-defined
  contract.
- The homeserver loads a single registration YAML file that describes the
  namespace and tokens. That file is the only shared artifact.
- No shared Python/Node/Go runtime, no shared volumes, no shared secrets.

The alternative — running a Discord bot as another thread inside
`concord-api` or another process inside the `tuwunel` container — does not
satisfy the sandbox requirement because a crash or supply-chain compromise in
the bot code would land inside one of the core Concord services.

## 3. Bridge daemon selection

Two actively-used Matrix↔Discord bridges exist. We pick one before writing
Docker Compose config, not after.

| Project | Language | License | Maintenance signal | Puppetting | Relay mode |
|---|---|---|---|---|---|
| [`mautrix-discord`](https://github.com/mautrix/discord) | Go | **AGPLv3** | Active (mautrix suite, weekly commits typical) | Yes | Yes |
| [`matrix-appservice-discord`](https://github.com/matrix-org/matrix-appservice-discord) | Node.js | Apache-2.0 | Legacy — functional but slower cadence | Limited | Yes |

**Recommendation: `mautrix-discord`.**

Rationale:

1. The mautrix suite (Go-based) is the best-maintained family of Matrix
   bridges currently deployed in production at scale (mautrix-whatsapp,
   mautrix-telegram, mautrix-signal, mautrix-discord). Bug fixes and Discord
   API drift patches land promptly.
2. Puppetting mode — where each Discord user is mirrored as a virtual Matrix
   user — produces a significantly better UX than relay-bot mode because
   author attribution, avatars, and mentions round-trip correctly.
3. Go binaries are a single static artifact in the container, which reduces
   the attack surface relative to a Node.js dependency tree.
4. The mautrix bridges share a common configuration style, so operators who
   run multiple bridges benefit from consistent runbooks.

### License audit — AGPLv3 vs Concord's commercial scope

Concord is tagged `commercial` in `.scope`. The commercial scope profile
requires that all dependencies have licenses compatible with the project's
distribution plan. `mautrix-discord` is licensed under **AGPLv3**, which has
a specific implication worth flagging explicitly:

- **Operator deployment on orrgate (first deployment target):** Fine. Running
  an AGPLv3 binary on infrastructure we operate does not, on its own, trigger
  copyleft. We are the operator and the only users are us; no "network
  interaction by third parties" obligation kicks in yet.
- **Self-hosted operators deploying Concord:** Fine under the same reading,
  provided they are deploying the upstream `mautrix-discord` binary image
  (which is already AGPLv3-licensed) through Docker Compose. They are not
  receiving a modified `mautrix-discord` from us; they are pulling the
  upstream image.
- **Concord as a SaaS offering to third-party users:** **Flag.** AGPLv3's
  Section 13 requires that users interacting with the software over a network
  be offered the complete corresponding source code of the version they
  interact with. If we ever offer a hosted Concord service that includes the
  Discord bridge, we must provide a path for users to obtain the bridge's
  source (upstream is fine — we just publicize the link and the exact tag in
  use). This is not a blocker; it is a disclosure requirement.
- **Concord distributed as a packaged product:** The Discord bridge is an
  **optional add-on Docker service**, not a statically-linked component of
  the Concord binary. Our packaged product (desktop/mobile Tauri apps, the
  Matrix server stack) does not incorporate `mautrix-discord` code at the
  compilation or link level. The AGPL obligations apply only to operators
  who choose to enable the bridge, and only to the bridge itself, not to the
  rest of Concord.

**Action:** when the bridge lands, add a short notice to the Concord user
docs stating that the optional Discord bridge runs under AGPLv3, and link to
the `mautrix-discord` upstream for source access. Do NOT commingle the
bridge's code with Concord's own source tree.

Fallback: if `mautrix-discord`'s maintenance signal drops or a concrete AGPL
blocker is discovered for a distribution channel we care about, the
Apache-2.0 `matrix-appservice-discord` is the declared fallback. Its UX is
weaker (less puppetting polish) but its license is unambiguously permissive.

## 4. Sandbox boundary

This is the **contract** that `docker-compose.yml` must enforce when the
service lands. Any divergence from this list must be documented and
re-reviewed.

### 4.1 Container identity

- Service name: `concord-discord-bridge`
- Image: `dock.mau.dev/mautrix/discord:<pinned-tag>` (no `:latest`)
- Runs as a non-root user inside the container (mautrix images already do
  this).
- Restart policy: `unless-stopped`.

### 4.2 Credentials

- Discord bot token and Discord application ID live **only** in
  `config/discord-bridge.env` at the repo root. That file is `.gitignore`d.
- `config/discord-bridge.env` is mounted read-only into the bridge container
  via `env_file:` in `docker-compose.yml`.
- No other Concord service has this file mounted. `tuwunel`, `concord-api`,
  and `livekit` do not see the Discord bot token under any circumstance.
- Rotation: operators rotate the Discord bot token by editing
  `config/discord-bridge.env` and running
  `docker compose up -d concord-discord-bridge`.

### 4.3 Shared volumes

- The bridge container gets ONE shared artifact: the AS registration file
  (`config/discord-registration.yaml`), mounted read-only into the
  `tuwunel` container and read-write into the bridge container (the bridge
  needs to regenerate it on first run; subsequent runs treat it as stable).
- No other shared volumes. The bridge's SQLite/Postgres state lives in its
  own named volume `concord-discord-bridge-data`.
- `tuwunel`'s media store volume is NOT shared with the bridge. Attachments
  relayed across the bridge are uploaded via the Matrix client-server API
  using the `as_token`, not by writing into the homeserver's disk.

### 4.4 Network boundary

- The bridge container is on the existing `concord-internal` Docker network
  (same network as `tuwunel` and `concord-api`).
- The bridge contacts `tuwunel` at `http://tuwunel:8008` (internal DNS) for
  the AS push transaction endpoint.
- The bridge contacts Discord's public API at `https://discord.com/api/v10`
  and `wss://gateway.discord.gg/` over the default egress network.
- The bridge does NOT expose a port to the host. The homeserver reaches the
  bridge at `http://concord-discord-bridge:29334` over the internal network
  only.
- Egress firewall: if/when orrgate's firewall gets explicit egress rules,
  the bridge container needs `discord.com` and `gateway.discord.gg`
  allow-listed. Nothing else.

### 4.5 Blast radius

A bridge crash, OOM, Discord rate-limit storm, or bad upstream push MUST
result in:

- `docker compose stop concord-discord-bridge` / container exit / bridge
  container entering `restarting` state.
- Zero impact on `tuwunel`, `concord-api`, `livekit`, or `caddy`.
- Matrix rooms that are NOT bridged keep working normally.
- Matrix rooms that ARE bridged continue to relay messages among their
  Matrix-side participants; only the Discord-side relay is degraded until
  the bridge comes back.

Verification: the acceptance criterion in PLAN.md INS-024 says
`docker compose stop concord-discord-bridge` must not affect any other
Concord service. This MUST be tested during the first deployment window
on orrgate.

## 5. Application Service registration

The bridge generates a registration YAML on first run. The file has this
shape (values filled in by the bridge at generation time):

```yaml
id: discord
url: http://concord-discord-bridge:29334
as_token: <random secret>
hs_token: <random secret>
sender_localpart: _discord_bot
rate_limited: false
namespaces:
  users:
    - exclusive: true
      regex: "@_discord_.*:<concord-server-name>"
  aliases:
    - exclusive: true
      regex: "#_discord_.*:<concord-server-name>"
  rooms: []
```

- `id`: logical identifier. Unique per bridge.
- `url`: where the homeserver pushes transactions.
- `as_token` / `hs_token`: shared secrets between homeserver and bridge.
  Rotated by regenerating the registration file.
- `sender_localpart`: the bridge's own Matrix bot account.
- `namespaces.users`: virtual Matrix users the bridge owns. The `exclusive:
  true` flag prevents regular users from registering in this range.
- `namespaces.aliases`: room aliases the bridge owns.
- `namespaces.rooms`: empty — the bridge mints rooms on demand rather than
  claiming a static set.

Tuwunel loads this file via its `app_service_registration` config key
(pointing at the mounted read-only path). The homeserver must be restarted
after the registration file changes — plan for a ~5 second Matrix service
blip on each bridge-registration change.

## 6. Relayed event matrix

The bridge covers a well-defined subset of Discord ↔ Matrix events. Anything
not in this table is explicitly dropped; the operator runbook tells users
how to fall back.

| Direction | Event | Relayed? | Notes |
|---|---|---|---|
| Discord → Matrix | Text message | Yes | Author puppetted as virtual `@_discord_<userid>:concord` |
| Discord → Matrix | Message edit | Yes | Emitted as `m.room.message` with `m.new_content` |
| Discord → Matrix | Message delete | Yes | Emitted as `m.room.redaction` |
| Discord → Matrix | Reaction (add/remove) | Yes | Emitted as `m.reaction` / redaction |
| Discord → Matrix | Attachment (image/video/audio/file) | Yes | Downloaded by bridge, re-uploaded to Matrix media store under `as_token` |
| Discord → Matrix | Embed (link preview) | Yes | Flattened to message body with link; original embed dropped |
| Discord → Matrix | Sticker | Yes (as image) | Discord sticker URL re-uploaded as `m.image` |
| Discord → Matrix | Thread creation | Yes | Mapped to Matrix threads (`m.thread`) |
| Discord → Matrix | Voice state change (join/leave call) | **No** | Out of scope; LiveKit owns Matrix voice |
| Discord → Matrix | Guild member join/leave | Yes | Emitted as `m.room.member` join/leave on the virtual user |
| Discord → Matrix | Typing indicator | Yes | `m.typing` |
| Discord → Matrix | Presence | **No** | Too noisy; dropped |
| Matrix → Discord | Text message | Yes | Sent as the bridge bot, with author prefix |
| Matrix → Discord | Message edit | Yes | Discord API `PATCH /channels/{id}/messages/{id}` |
| Matrix → Discord | Message delete | Yes | Discord API `DELETE /channels/{id}/messages/{id}` |
| Matrix → Discord | Reaction (add/remove) | Yes | Discord API reaction endpoints |
| Matrix → Discord | Attachment (image/video/audio/file) | Yes | Downloaded from Matrix, re-uploaded to Discord via multipart form |
| Matrix → Discord | Reply (`m.in_reply_to`) | Yes | Mapped to Discord reply reference |
| Matrix → Discord | Thread reply | Yes where Discord supports it |
| Matrix → Discord | Typing indicator | Yes | Discord typing API |
| Matrix → Discord | Voice invites | **No** | LiveKit is Matrix-only |
| Matrix → Discord | Read receipts | **No** | Discord has no matching concept |

Mentions are translated in both directions: `@alice` on Matrix becomes
`<@discord_id>` on Discord, and vice versa. Unresolvable mentions (the
target user is not bridged) fall back to plain text.

## 7. Operator runbook

All commands assume `cd /docker/stacks/concord` on `orrgate` unless
otherwise noted.

### 7.1 Adding a new Discord server

1. Create a Discord application and bot account at
   `https://discord.com/developers/applications`. Grant the bot the
   `applications.commands`, `bot`, and the standard message/content intents
   (`GUILD_MESSAGES`, `MESSAGE_CONTENT`, `GUILD_MEMBERS`).
2. Record the bot token in `config/discord-bridge.env`:
   ```
   MAUTRIX_DISCORD_BOT_TOKEN=<token>
   MAUTRIX_DISCORD_APPLICATION_ID=<app-id>
   ```
3. Invite the bot to the Discord guild you want to bridge, using the OAuth2
   URL generated by Discord's developer portal with the scopes above.
4. From a Matrix client signed in as a bridge admin (the account listed
   under `bridge.permissions` in the mautrix-discord config), DM the bridge
   bot (`@_discord_bot:concord`) with `login`. The bridge will respond with
   a QR code or token prompt — follow it to associate your Matrix account
   with the Discord bot.
5. Send `guilds status` to the bridge bot in the same DM to confirm the
   Discord guild is visible.
6. Send `guilds bridge <guild_id>` to start mirroring channels into Matrix
   rooms. Channels appear as `#_discord_<guild>_<channel>:concord` aliases.

### 7.2 Rotating the Discord bot token

1. Generate a new token in the Discord developer portal (this invalidates
   the old one immediately on Discord's side).
2. Update `config/discord-bridge.env` with the new token.
3. Restart the bridge: `docker compose up -d concord-discord-bridge`.
4. Watch the logs: `docker compose logs -f concord-discord-bridge`. You
   should see a successful Gateway WebSocket handshake within 10 seconds.

The AS registration file tokens (`as_token`, `hs_token`) are separate from
the Discord bot token. They are rotated by regenerating the registration
file; see section 7.4.

### 7.3 Debugging bridged messages not appearing

1. Check bridge health:
   `docker compose ps concord-discord-bridge` — should be `running`.
2. Check bridge logs for the affected channel:
   `docker compose logs --tail=200 concord-discord-bridge | grep -i <channel-name>`.
3. Check that the guild is bridged: DM the bridge bot `guilds status`.
4. Check that the virtual user can see the room: DM the bridge bot
   `rooms status <matrix-room-id>`.
5. Check Discord rate limits: look for `429` responses in the bridge logs.
   Persistent 429s mean the bridge is being throttled by Discord — reduce
   traffic or increase the bridge's rate-limit backoff.
6. If the bridge's SQLite state gets corrupted: stop the service, back up
   the `concord-discord-bridge-data` volume, and follow mautrix-discord's
   upstream recovery docs.

### 7.4 Regenerating the AS registration file

Only do this if you changed the bridge's Matrix-side identity (e.g. renamed
the homeserver or rotated AS tokens for security reasons):

1. `docker compose stop concord-discord-bridge`.
2. Delete `config/discord-registration.yaml`.
3. `docker compose run --rm concord-discord-bridge /usr/bin/mautrix-discord -g -c /data/config.yaml -r /data/registration.yaml`
4. Copy the new registration YAML to `config/discord-registration.yaml`.
5. Restart both services:
   `docker compose up -d tuwunel concord-discord-bridge`.
6. The homeserver will re-register the bridge with the new tokens.

### 7.5 Shutting the bridge down cleanly

Two levels.

**Temporary (maintenance window, token rotation, or bridge upgrade):**
```
docker compose stop concord-discord-bridge
```
Other Concord services are unaffected. Bridged rooms continue to relay
among their Matrix-side participants; Discord-side relay pauses until the
bridge comes back. No data loss.

**Permanent (operator decides to drop the Discord integration):**
```
docker compose rm -s -f concord-discord-bridge
# Optionally remove state:
docker volume rm concord_concord-discord-bridge-data
```
Then remove the `concord-discord-bridge` service block from
`docker-compose.yml` and remove the `app_service_registration` entry from
the tuwunel config. Restart `tuwunel` to drop the AS namespace. The virtual
users and bridged rooms remain in the Matrix database as ghosts — run
`tuwunel-admin` purge commands if you want them gone entirely.

## 8. What this bridge explicitly does NOT do

- Does not implement a new discovery protocol. The Matrix federation
  allowlist (shipped 2026-04 in `server/routers/admin.py` and
  `client/src/hooks/useFederation.ts`) stays inside the Matrix federation
  graph and does not interact with the Discord bridge. The "Explore" menu
  (INS-025) shows federated *Matrix* servers only; Discord guilds are
  exposed as regular rooms inside the local homeserver, not as federated
  peers.
- Does not bridge voice/video. LiveKit is the Matrix voice provider;
  Discord voice channels are ignored.
- Does not relay presence or read receipts, to keep the event volume
  predictable.
- Does not give the bridge any access to `concord-api`. Concord's
  application-layer features (soundboard, moderation, TOTP, federation
  admin, stats) are invisible to the bridge.

## 9. Acceptance checklist (PLAN.md INS-024 #2)

Before marking the bridge-docs task complete, confirm:

- [x] Exact set of containers that hold Discord credentials is documented
      (exactly one: `concord-discord-bridge`).
- [x] Network edges between the bridge container and `tuwunel` /
      `concord-api` are documented.
- [x] AS registration schema and namespace are documented.
- [x] Matrix events relayed in each direction and which are dropped are
      documented (section 6).
- [x] Operator runbook covers add-server, rotate-token, debug, shutdown
      (section 7).
- [x] Commercial-scope license audit of the chosen bridge daemon is
      documented (section 3, AGPLv3 analysis).

## 10. Open follow-ups (not blocking)

- The implementation task (INS-024 #1) — actually adding the service block
  to `docker-compose.yml`, writing `config/discord-bridge.env.example`,
  writing the bridge's mautrix-discord config YAML, and deploying to
  orrgate — is the next step once this document is reviewed.
- A future enhancement could relay Discord voice-channel state into
  Matrix as `m.room.message` announcements ("X joined the voice channel"),
  without actually bridging the audio. Not in scope for INS-024.
- Puppetting mode requires each Concord user to individually log into
  Discord via the bridge bot. Whether to force that on or keep the simpler
  relay-bot mode as the default is a UX decision for the first deployment.

## 11. Desktop Mode (Embedded Bridge)

INS-024 Waves 3–5 added a desktop-mode deployment path: the bridge runs as
a `bubblewrap`-sandboxed child process of the Concord Tauri desktop app, not
as a Docker container. This section documents the desktop-mode architecture.

### 11.1 Architecture overview

In desktop mode, the Concord Tauri application manages the full bridge
lifecycle:

1. An embedded tuwunel Matrix homeserver runs as a child process
   (`MatrixFederationTransport`).
2. The mautrix-discord bridge runs as a second child process
   (`DiscordBridgeTransport`) wrapped in `bubblewrap` (`bwrap`) for sandbox
   isolation.
3. The bridge connects to tuwunel over the loopback network
   (`127.0.0.1:<port>`) using the Application Service registration.
4. The cross-transport pre-pass in `ServitudeHandle::start` wires the
   appservice registration path into tuwunel via `CONDUWUIT_APPSERVICES`
   before either process starts.

### 11.2 Binary discovery

The mautrix-discord binary is located using the same discovery order as the
tuwunel binary:

1. `MAUTRIX_DISCORD_BIN` environment variable (dev override)
2. `<current_exe_dir>/resources/discord_bridge/mautrix-discord` (bundled)
3. `<current_exe_dir>/mautrix-discord` (sibling binary)
4. `PATH` lookup (last resort)

### 11.3 Sandbox boundary (bubblewrap)

The bridge runs inside a `bubblewrap` namespace jail with the following
configuration:

| Flag | Purpose |
|------|---------|
| `--unshare-user` | Separate user namespace (no uid mapping to host) |
| `--unshare-pid` | Separate PID namespace |
| `--unshare-ipc` | Separate IPC namespace |
| `--unshare-uts` | Separate UTS namespace |
| `--unshare-cgroup` | Separate cgroup namespace |
| `--clearenv` | Wipe all host environment variables |
| `--cap-drop ALL` | Drop all Linux capabilities |
| `--die-with-parent` | SIGKILL the bridge if Concord exits |
| `--new-session` | Separate session (no terminal control) |
| `--share-net` | **Required** — bridge needs loopback + Discord gateway |

Read-only mounts (whitelist):

- `/usr` → `/usr`
- `/lib` → `/lib`
- `/lib64` → `/lib64`
- `/etc/ssl` → `/etc/ssl`
- `/etc/resolv.conf` → `/etc/resolv.conf`
- `/etc/ca-certificates` → `/etc/ca-certificates`
- `<host mautrix-discord binary>` → `/usr/local/bin/mautrix-discord`

Single read-write mount:

- `<bridge data dir>` → `/data`

**No `/home` access.** The bridge cannot read, write, or traverse any path
under `/home`. This is enforced by the whitelist-only mount set and verified
by automated tests (`test_build_sandboxed_argv_does_not_leak_host_home`,
`test_sandbox_blocks_home_read`).

If `bwrap` is not installed, the bridge **refuses to start**. There is no
silent unsandboxed fallback — this is a commercial-scope hard requirement.

### 11.4 Token storage

- **Discord bot token**: stored via `tauri-plugin-stronghold` (argon2 KDF)
  on the frontend side, written to `config.yaml` (0600 permissions) in the
  bridge data directory when the user configures the bridge.
- **AS/HS tokens**: generated as 32-byte cryptographically random hex strings
  by the Rust backend. Written to both `config.yaml` and `registration.yaml`
  (0600 permissions).
- **Discord user token** (puppeting mode): flows directly from Discord to
  the bridge process via QR code login. The Concord app never sees or stores
  this token. It lives in the bridge's SQLite database inside the sandboxed
  data directory.

### 11.5 Data directory layout

`$XDG_DATA_HOME/concord/discord-bridge/` (default:
`~/.local/share/concord/discord-bridge/`):

```
discord-bridge/
  config.yaml           — bridge configuration (0600)
  registration.yaml     — AS registration for tuwunel (0600)
  mautrix-discord.db    — bridge SQLite state (mautrix-owned)
```

The directory itself is created with mode 0700.

### 11.6 BridgesTab UI

The desktop app includes a 5-step setup walkthrough in
`Settings > Bridges > Discord Bridge`:

1. **Create Discord Application** — link to developer portal
2. **Enable Required Intents** — Server Members + Message Content
3. **Paste Bot Token** — securely stored, never logged
4. **Invite Bot to Server** — OAuth2 URL generation guide
5. **Enable Bridge** — toggle in the UI, persisted to settings store

User-mode (puppeting) is available via a separate section gated behind
`DiscordTosModal` — the user must check a consent checkbox and the acceptance
timestamp is recorded as an audit trail.

### 11.7 Non-critical transport behavior

The Discord bridge is a **non-critical** transport. If it fails to start or
crashes at runtime:

- The servitude handle stays in `Running` state.
- The failure is recorded in `ServitudeHandle::degraded_transports()`.
- The UI shows "Bridge degraded" with the failure reason.
- All other transports (including tuwunel) continue operating normally.
- Bridged Matrix rooms continue to relay among their Matrix-side
  participants; only the Discord relay is paused.

## 12. Docker vs Desktop Comparison

| Aspect | Docker Mode | Desktop Mode |
|--------|------------|--------------|
| Sandbox | Docker container isolation | bubblewrap (bwrap) Linux namespaces |
| Binary source | `dock.mau.dev/mautrix/discord:<tag>` | Bundled in Tauri resources |
| Token storage | `config/discord-bridge.env` (host file, gitignored) | Stronghold vault (encrypted on disk) |
| AS registration | Shared Docker volume mount | Generated in `$XDG_DATA_HOME/concord/discord-bridge/` |
| tuwunel connection | `http://tuwunel:8008` (Docker internal DNS) | `http://127.0.0.1:<port>` (loopback) |
| Network isolation | Docker bridge network, no host port exposed | bwrap `--share-net` (loopback + egress only) |
| Lifecycle management | `docker compose up/down` | Servitude transport start/stop via Tauri commands |
| Blast radius | Container crash/restart, other containers unaffected | Non-critical transport → `degraded` state, tuwunel unaffected |
| Configuration UI | Manual YAML editing + env file | BridgesTab walkthrough in Settings |
| OS support | Any Docker-capable host | **Linux only** (bwrap dependency) |
| Bridge state persistence | Docker named volume | `$XDG_DATA_HOME` directory |

## 13. Threat Model — Credential Containment

This section documents which processes have access to which secrets in both
deployment modes. The design principle is **minimum privilege**: each process
sees only the credentials it needs to function.

### 13.1 Discord bot token

| Property | Value |
|----------|-------|
| Who sees it | mautrix-discord process only |
| Storage | `config.yaml` (0600) in bridge data dir |
| Passed to tuwunel? | **No** |
| Passed to concord-api? | **No** |
| Appears in logs? | **No** — enforced by `redact_for_logging()` |
| Rotation | User enters new token in BridgesTab (desktop) or edits env file (Docker) |

### 13.2 AS token / HS token

| Property | Value |
|----------|-------|
| Who sees it | tuwunel + mautrix-discord (shared secret for AS authentication) |
| Storage | `registration.yaml` (0600) + `config.yaml` (0600) |
| tuwunel reads from | `CONDUWUIT_APPSERVICES` env var → registration YAML path |
| Bridge reads from | `config.yaml` and `-r` flag inside sandbox |
| Appears in logs? | **No** — enforced by `redact_for_logging()` (Rust) and `redact_for_logging()` (Python) |
| Rotation | Regenerate registration → restart both tuwunel and bridge |

### 13.3 Discord user token (puppeting mode)

| Property | Value |
|----------|-------|
| Who sees it | mautrix-discord process only |
| How obtained | QR code login flow inside the bridge |
| Storage | Bridge's SQLite database (`mautrix-discord.db`) inside sandbox |
| Concord app sees it? | **No** — the token flows Discord → bridge, never through Concord |
| Rotation | User re-authenticates via the bridge bot |

### 13.4 Stronghold vault

The Stronghold vault is an encrypted on-disk store managed by
`tauri-plugin-stronghold` with argon2 KDF. It stores the bot token for the
BridgesTab UI's "has token been set" check. The vault is a secondary store
— the primary copy of the bot token is `config.yaml`. The vault is local to
the desktop app and is not accessible to tuwunel or the bridge process.

## 14. Runbook Addendum — Desktop Mode

### 14.1 tuwunel AS hot-reload

**Not supported.** Tuwunel (conduwuit) loads Application Service registrations
at startup only. After any of the following changes, the servitude must be
stopped and restarted:

- AS token rotation (regenerating `registration.yaml`)
- Changing the bridge's namespace regexes
- Adding or removing a bridge

A restart causes a **~5 second Matrix federation blip** while tuwunel
reinitializes its RocksDB state and re-registers the AS namespaces.

### 14.2 Token rotation (desktop mode)

1. User opens `Settings > Bridges > Discord Bridge`.
2. User generates a new token in the Discord developer portal (this
   invalidates the old token on Discord's side immediately).
3. User pastes the new token in the BridgesTab token input.
4. `config.yaml` and `registration.yaml` are rewritten with the new token
   and fresh AS/HS tokens.
5. User must stop and restart the servitude via `Settings > Node Hosting`
   (stop → start) for tuwunel to pick up the new registration.

### 14.3 Bundle-size impact

| Component | Approximate size |
|-----------|-----------------|
| mautrix-discord Go binary (static) | ~15–20 MB |
| tuwunel binary | ~25–30 MB |
| Concord Tauri app (without bridges) | ~40–45 MB |
| **Total AppImage target** | **~90 MB** |

The mautrix-discord binary is statically compiled (Go produces fully static
binaries by default). No Go runtime dependencies are needed inside the
sandbox.

### 14.4 Debugging the desktop bridge

1. Check the servitude status in `Settings > Node Hosting`. If the Discord
   bridge shows as "degraded", the failure reason is displayed.
2. Check the Concord app logs for `concord::bridge` log entries.
3. Verify `bwrap` is installed: `which bwrap` — if missing, the bridge
   refuses to start with an actionable error message.
4. Verify the mautrix-discord binary is bundled: check for the file at
   `<app_dir>/resources/discord_bridge/mautrix-discord`.
5. Check `$XDG_DATA_HOME/concord/discord-bridge/config.yaml` for correct
   bot token and server address.

## 15. Dependency License Audit (Refreshed INS-024 Wave 5)

### mautrix-discord

- **License**: AGPLv3
- **Version**: upstream `dock.mau.dev/mautrix/discord` (Docker) / Go binary
  (desktop)
- **Status**: No version change since initial audit (section 3). Analysis
  remains valid.
- **Key finding**: AGPLv3 obligations apply only to the bridge process itself,
  which is process-isolated from Concord's own codebase. No linking, no code
  commingling. Operators who enable the bridge are pulling/running upstream
  AGPLv3 software. See section 3 for the full analysis.

### bubblewrap (bwrap)

- **License**: GPLv2 (LGPLv2+ for the library portion)
- **Distribution**: System package — NOT bundled with Concord. Users install
  it via their package manager (`apt install bubblewrap`, `pacman -S
  bubblewrap`).
- **Implication**: No distribution obligation for Concord. The GPLv2
  obligations rest with the system package distributors (Debian, Arch, etc.),
  not with Concord.
- **Desktop-mode dependency**: bubblewrap is a hard requirement for the
  desktop bridge. Without it, the bridge refuses to start. This is documented
  in the error message and in section 11.3.
