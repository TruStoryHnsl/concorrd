# User-Scoped Discord Bridge — Redesign

**Status:** Design approved 2026-04-21. Implementation sequencing TBD.

## Problem

Today's bridge is admin-scoped:

- One instance-wide Discord bot token, owned by the admin.
- Admin decides which guilds get bridged (by inviting the bot).
- Admin's bridge process reads every message in every bridged channel.
- Admin has conduwuit DB access → can read every bridged Discord conversation.

This is wrong:

1. Admin can silently surveil everyone's Discord activity.
2. Users without admin privileges can't bridge the guilds *they* care about —
   they're stuck with the admin's picks.
3. The flagship instance owns the production bot, so other instances can't
   re-use it. Every new instance needs its own admin to create a Discord
   app, which is operational friction with no privacy benefit for non-admin
   users.

## Goal

**Discord bridging becomes a personal setting, not an instance-wide service.**

- Each user connects their own Discord account from *their* profile settings.
- Each user sees the guilds their own Discord account has access to.
- No admin-gated "enable bridge" step. The bridge infrastructure runs
  invisibly as part of the instance; users don't even see it as an admin
  feature.
- Admin loses the ability to set up a bot-owned relay. There is no relay.

## Trust model (web client — acceptable caveat)

The bridge process is still server-side, so:

- Per-user Discord tokens are stored by mautrix-discord in its own DB on
  the instance's disk.
- A malicious or compromised instance operator with server/DB access
  could read stored tokens and spy on bridged conversations.

**This caveat is acceptable because** the native (Tauri) client will ship
shortly with a client-side bridge (tokens never leave the user's device).
Web users trade privacy for convenience, with the ToS surfacing the
tradeoff on first connect.

**Until native ships**, the Matrix rooms mirroring Discord conversations
are unencrypted (bridges can't support E2E on Discord-side content).
Users who want full privacy should wait for the native app.

## Out of scope (for this redesign)

- Per-user isolated bridge *processes* (option B from the scoping
  discussion). Requires container-per-user lifecycle, resource limits,
  and dynamic appservice provisioning. Revisit after native ships.
- Moving the mautrix-discord bridge itself client-side. That's the
  native-app work, tracked separately.
- Replacing the single appservice registration with per-user ones.
  Kept as one per instance — it's instance-scoped infrastructure, not
  user-scoped identity.

## Design

### Architecture

```
                           ┌─────────────────────────┐
                           │  concord-api (server)   │
                           │                         │
   ┌────────┐              │  - user profile CRUD    │
   │ User A │ ── Matrix ──▶│  - NO bridge admin API  │
   └────────┘              │                         │
                           │  POST /users/me/        │
   ┌────────┐              │       discord/login-    │
   │ User B │ ── Matrix ──▶│       relay             │
   └────────┘              └──────────┬──────────────┘
                                      │ trigger DM
                                      ▼
              ┌───────────────────────────────────────┐
              │  mautrix-discord (one process)        │
              │                                       │
              │  User A ← logged in via QR → Discord A│
              │  User B ← logged in via QR → Discord B│
              │                                       │
              │  tokens per-user in bridge DB         │
              │  guilds per-user based on each login  │
              └───────────────────────────────────────┘
```

### What stays

- The mautrix-discord container runs exactly one process per instance.
- The `concord_discord_2` appservice registration in `tuwunel.toml`.
- The per-user login flow: user DMs `@discordbot:server` with `login`,
  scans the QR code with their Discord phone app. This is mautrix's
  supported user-mode.
- Per-user identity (puppeting): their Discord messages appear as them.

### What goes

- `config/mautrix-discord/config.yaml` → the `relaybot` + `bot_token`
  fields. The bridge runs WITHOUT a relay bot.
- `config/discord-bridge.env` → no bot token to configure.
- `POST /admin/bridges/discord/bot-token` → deleted.
- `POST /admin/bridges/discord/enable|disable|rotate|force-reset` →
  deleted (bridge is always on).
- `GET /admin/bridges/discord/status` → deleted. Replaced with
  `GET /discord/health` (public, returns only {ok: bool, version}).
- `GET /admin/bridges/discord/guilds` → deleted (admin had the bot's
  guild list; there's no admin bot anymore).
- `GET /admin/bridges/discord/bot-profile` → deleted.
- `GET /admin/bridges/discord/bot-invite-url` → deleted.
- `BridgesTab.tsx` admin UI → deleted.
- The `🎮 Bridges` entry in admin settings navigation → removed.
- Guild picker (admin tool for choosing which guilds to bridge) → deleted.

### What's new

**Backend — per-user connections surface:**

New router: `routers/user_connections.py` (not admin-gated).

```
GET    /users/me/discord          → my connection status {connected, name, avatar}
POST   /users/me/discord/login    → trigger login-relay DM from bridge bot
POST   /users/me/discord/logout   → purge my session from bridge DB
DELETE /users/me/discord          → alias for /logout
```

All endpoints authenticate as the caller (existing `get_user_id` dep).
Zero admin check — admins have no more access to these than regular
users. When acting on the bridge DB, we scope by the caller's MXID.

**Bridge lifecycle:**

Moved to startup bootstrap in `concord-api` lifespan:

- On first boot: generate fresh appservice registration, write
  `registration.yaml` + inject `tuwunel.toml` appservice entry,
  restart conduwuit.
- On every boot after: verify registration exists and matches tuwunel;
  if mismatch (e.g. constant changed), auto-force-reset and
  re-register.

This replaces the admin "Enable" button. Infrastructure is invisible.

**Frontend — user profile:**

New component: `client/src/components/settings/UserConnectionsTab.tsx`.
Lives under the user's own profile settings, not admin settings.

```
Profile
  ↳ Connections
      ↳ Discord
         [Connect with Discord]   (if not connected)
         [Connected as @alice#1234, Disconnect]   (if connected)
```

Connect flow:
1. User clicks Connect → ToS modal (existing `DiscordTosModal`).
2. User accepts → frontend calls `POST /users/me/discord/login`.
3. Backend triggers the bridge bot to DM the user with a QR code.
4. User scans QR with Discord phone app.
5. Frontend polls `GET /users/me/discord` until `connected: true`.
6. User's guilds auto-appear as Matrix rooms, scoped to their account.

### Security invariants

1. **No cross-user reads.** `/users/me/discord` never returns another
   user's data. Bridge DB queries always filter by `Depends(get_user_id)`.
2. **Token storage caveat documented in ToS.** First connect requires
   acceptance.
3. **Admin cannot trigger another user's login.** The login-relay
   endpoint requires the caller to be the user being logged in.
4. **Admin cannot read another user's session.** The GET endpoint also
   scoped to caller.
5. **Tokens never serialised over API.** The API returns connection
   status (boolean + Discord username/avatar for display only). The
   actual OAuth token lives in the bridge DB, visible only to
   mautrix-discord + whoever has host-level DB access.

## Migration from today's state

For existing installs with an admin-configured bot:

1. **Preserve their data.** The appservice registration stays exactly as
   is (same `as_token`/`hs_token`, same sender bot). Users currently
   connected via user-mode continue working.
2. **Retire the bot-mode relay.** The admin's bot token is removed from
   `config/discord-bridge.env`. Messages from Matrix → Discord authored
   by users *without* a personal login no longer go to Discord (they
   used to go via the relay bot; now they just don't bridge). Relay-
   dependent users see a one-time notice prompting them to connect
   their personal Discord.
3. **Delete admin UI.** The Bridges admin tab disappears after upgrade.
4. **Docs migration note** shipping in CHANGELOG.

## Implementation sequence (proposed)

Land as separate PRs for easy revert:

1. **PR1: Backend user-connections router** — new `/users/me/discord/*`
   endpoints. Doesn't break existing admin endpoints yet. Add tests.
2. **PR2: Lifespan bridge bootstrap** — auto-generate registration +
   tuwunel.toml entry on first boot. Verify on subsequent boots. Add
   tests.
3. **PR3: Frontend UserConnectionsTab** — add the user-profile UI wired
   to the new API. Don't remove admin tab yet.
4. **PR4: Retire admin bot-mode** — remove `discord_bridge.env` reading,
   delete `bot-token`/`enable`/`disable`/`rotate`/`force-reset`
   endpoints, drop admin BridgesTab and settings nav entry.
5. **PR5: Docs + ToS update** — CHANGELOG, admin migration guide, ToS
   copy surfacing the token-at-rest caveat for web users.

Each PR is independently shippable; stopping after any of PR1–PR3 leaves
the system in a working state with both surfaces temporarily available.
