# Discord Bridge: Admin Migration Guide

This guide is for operators upgrading a Concord instance from the old
admin-scoped bridge (bot-mode + admin Enable button) to the new
user-scoped model.

See also: `user-scoped-bridge-redesign.md` (full design) and the
`[Unreleased]` section of `CHANGELOG.md` (shipped surface changes).

## TL;DR

1. Update, rebuild, restart concord-api.
2. The first startup auto-registers the appservice and restarts
   conduwuit. (Expect a ~10s downtime.)
3. The "Bridges" tab is gone from settings. There is nothing to click.
4. Tell your users to go to Settings → Connections to connect their
   own Discord account.
5. If you had a relay bot configured, it stops relaying messages.
   Users who were depending on it will see a one-time prompt to
   connect their own Discord. You can ignore the old `bot-token`
   file on disk; it is no longer read.

## What changed for operators

| Old flow                                       | New flow                                     |
|-----------------------------------------------|---------------------------------------------|
| Admin creates a Discord app + bot             | No admin bot. Each user connects their own. |
| Admin pastes bot token in Settings → Bridges  | No admin input surface.                     |
| Admin clicks Enable                            | Lifespan bootstrap auto-registers.          |
| Admin clicks Disable / Rotate / Force-Reset    | Endpoints deleted. Bootstrap self-heals.    |
| Users without Discord accounts could still    | No relay: they can't see or reply to        |
| participate via the bot relay                  | Discord until they connect their own.       |

## What changed for users

Users visit **Settings → Connections** and click **Connect with Discord**.
On first connect, the Discord ToS modal surfaces the web-client trust
model (see below). After accepting, the backend creates a DM between
them and `@discordbot:<your-server>`, posts `login`, and the bridge
responds with a QR code. The user scans it with their Discord phone
app. Their guilds then appear as Matrix rooms scoped to their own
login.

Disconnect: Settings → Connections → **Disconnect**. Sends `logout` to
the bridge, which purges the Discord session from its DB.

## Trust model (web client)

The mautrix-discord process stores per-user Discord tokens in a
SQLite DB on the instance's disk. A malicious or compromised operator
with host or database access could read those tokens and monitor
bridged traffic.

Users are shown this caveat in the Discord ToS modal before their
first connect. It is acceptable for the web client because:

- The native Tauri client ships imminently with a client-side bridge.
  Tokens never leave the user's device in that path.
- Matrix rooms mirroring Discord conversations are **not** E2E-
  encrypted — the bridge needs plaintext to forward to Discord.
  Operators could already read traffic-at-rest via conduwuit's DB,
  regardless of the Discord bridge.

Users who want full privacy should wait for the native client.

## Migration steps

### Upgrade

```bash
git pull
docker compose pull concord-api
docker compose up -d
```

### Verify bootstrap

Watch logs for the first boot after upgrade:

```bash
docker compose logs -f concord-api | grep -i 'bridge bootstrap'
```

Expected one of:

- `bridge bootstrap: {'action': 'noop', ...}` — already in sync from
  a prior admin Enable. Nothing to do.
- `bridge bootstrap: {'action': 'fresh_enable', ...}` — no prior
  registration, or ID-mismatch detected. Fresh tokens generated;
  conduwuit restarted (~10s).
- `bridge bootstrap: {'action': 'reconciled_tuwunel', ...}` — drift
  detected and repaired in place. Conduwuit restarted.
- `bridge bootstrap: {'action': 'degraded', ...}` — a file was
  unreadable or the docker socket was unreachable. Concord-api
  still came up. Check `docs/bridges/discord.md` for the relevant
  filesystem layout and permissions.

### Clean up (optional)

Old admin-only files that are no longer read:

- `config/discord-bridge.env` — the relay bot's token. Safe to delete.
- `config/mautrix-discord/bot-token` — admin's pasted bot token. Safe
  to delete.

The bootstrap does NOT touch these; they're left in place so an
operator can downgrade and have their bot-mode config intact. If
you're sure you won't downgrade, `rm` them.

### Communicate to users

Example announcement template:

> We've upgraded the Discord bridge to per-user connections. Any
> Discord activity you used to see through the shared bot has
> stopped. To see Discord again (and to post as yourself instead of
> via the bot), go to **Settings → Connections → Connect with
> Discord**. Read the terms, scan the QR, done. Your guilds will
> appear as Concord rooms scoped to your Discord account.

## Known follow-ups

- The voice-bridge setup flow (`DiscordSourceBrowser` component)
  still uses admin-scoped endpoints (`/guilds`, `/channels/{id}`,
  `/login-relay`, `/bot-profile`, `/bot-invite-url`). Those endpoints
  are intentionally retained until the voice bridge is ported to
  user-mode in a follow-up PR. If you don't use the voice bridge,
  this doesn't affect you.
- Token rotation is currently bootstrap-managed. A user-triggered
  rotation ("my account was compromised, reconnect") will come as a
  follow-up once per-user session detection lands via
  mautrix-discord's provisioning API.
