# Concord on orrgate — First Deployment Runbook

This runbook walks an operator through bringing up a **production-style** Concord deployment on a single host (the orrgate VM is the canonical target) using the repo's `docker-compose.yml`, Caddy in front, and a DNS name routed through Cloudflare. Every command has been tested against the commit this document ships with. If you deviate from the defaults below, read the whole document once before starting — several steps cross-reference each other and the federation smoke-test at the end depends on all of them being correct.

> **Scope:** first install on a fresh Linux host. Not an upgrade guide. See `../federation-reachability-diagnosis.md` for troubleshooting federation after the stack is up.

---

## 1. Prerequisites

Before starting, confirm the target host has all of the following. Missing any one of them turns this into a much longer debugging session.

- **OS:** Linux (Debian 12 / Ubuntu 22.04+ / CachyOS / Arch — anything with systemd and cgroup v2). macOS + Windows work for local dev but are not a supported production target.
- **Docker Engine 24+ and Compose v2.** Run `docker --version && docker compose version` and confirm both are present. `docker-compose` (the v1 standalone) will NOT work — the `docker compose` subcommand is required.
- **Shell access** to the host as a user in the `docker` group (or root). `sudo` is fine; the guide assumes you can `docker compose up` without re-typing a password.
- **A DNS name you control** pointing at the host's public IPv4 address. Cloudflare proxied mode is supported and is what orrgate uses. Example: `concorrd.com → A → <orrgate public IP>`.
- **Ports 80 + 443 open inbound** on both the host firewall and any upstream NAT. Port 8448 (Matrix federation default) is *not* required — this deployment uses port-443 delegation via `/.well-known/matrix/server` so federation rides the same Caddy edge as the web UI.
- **At least 4 GB RAM and 20 GB free disk.** The homeserver eats most of this once real traffic starts.
- **Git** to pull the repo, and a few core utilities (`curl`, `jq`, `openssl`) for the smoke tests at the end.

If any of the above is missing, install it first. The rest of the guide assumes they're in place.

---

## 2. Environment variables

Concord reads configuration from environment variables, not an `ini` file. Put them in an `.env` next to `docker-compose.yml` (Compose reads it automatically) or export them in a systemd unit — whichever you prefer. The mandatory set is:

| Variable | Required? | Example | What it does |
|---|---|---|---|
| `CONDUWUIT_SERVER_NAME` | **yes** | `concorrd.com` | The Matrix server name this instance identifies as. Must match the DNS record from step 1. Changing this after users register breaks everything — pick it once. |
| `CONDUWUIT_REGISTRATION_TOKEN` | **yes** | `$(openssl rand -hex 24)` | Shared secret the Concord server uses to create accounts via the homeserver's registration API. Generate a fresh token per deployment. Never commit to a repo. |
| `PUBLIC_BASE_URL` | recommended | `https://concorrd.com` | Overrides the well-known `api_base` synthesis. Set this whenever Concord sits behind a reverse-proxy path or at a non-apex hostname. Trailing slashes are stripped. |
| `INSTANCE_NAME` | recommended | `Concorrd` | Human-readable instance name shown on the login page, browser tab title, and invite emails. Falls back to `CONDUWUIT_SERVER_NAME` when unset. |
| `ADMIN_USER_IDS` | **yes** | `@alice:concorrd.com,@bob:concorrd.com` | Comma-separated Matrix user IDs that are global admins (federation, instance settings, bug reports). Empty list means no admins — allowed but you can't bootstrap. Add at least one. |
| `LIVEKIT_API_KEY` | yes (if voice) | `APIxxxxxxxx` | LiveKit service key. Generate via `livekit-cli generate-token` or the LiveKit admin panel. |
| `LIVEKIT_API_SECRET` | yes (if voice) | 32+ char random | LiveKit signing secret. Treat as production credential. |
| `LIVEKIT_URL` | yes (if voice) | `ws://livekit:7880` | Internal Docker-network URL of the LiveKit container. The public URL is synthesised by the server at request time (see `services/wellknown.py`). |
| `GITHUB_BUG_REPORT_TOKEN` | optional | PAT with `issues:write` | Mirrors user bug reports to a GitHub issue. See `github_bug_report_token.md` for rotation + threat model. Leave unset to keep reports local. |
| `GITHUB_BUG_REPORT_REPO` | optional | `TruStoryHnsl/concord` | Repo target for the mirror. Defaults to `TruStoryHnsl/concord`. |
| `TURN_HOST` | optional | `turn.concorrd.com` | Hostname operators can use to surface a STUN hint in the well-known document. Enables pre-auth connectivity checks in the native client picker. |
| `SMTP_*` | optional | — | Email invites. Unset if you don't want to mail invites. |

Put them in `.env`:

```env
CONDUWUIT_SERVER_NAME=concorrd.com
CONDUWUIT_REGISTRATION_TOKEN=<paste-your-generated-token-here>
PUBLIC_BASE_URL=https://concorrd.com
INSTANCE_NAME=Concorrd
ADMIN_USER_IDS=@alice:concorrd.com
LIVEKIT_API_KEY=<from livekit-cli>
LIVEKIT_API_SECRET=<from livekit-cli>
LIVEKIT_URL=ws://livekit:7880
```

`chmod 600 .env` — this file contains the registration token and LiveKit signing secret. Don't let it be world-readable.

---

## 3. First-run command

```bash
cd /srv/concord               # or wherever you cloned the repo
docker compose pull           # pre-pull images so the first `up` isn't a 5-minute wait
docker compose up -d          # detached start
docker compose ps             # confirm every service is "running" / "healthy"
```

Expected services (exact list depends on the compose file):

- `concord-caddy` — TLS termination, reverse proxy, `.well-known` static responses
- `concord-api` — the Concord FastAPI app
- `conduwuit` — Matrix homeserver (Tuwunel)
- `concord-livekit` — LiveKit SFU
- `concord-coturn` — STUN/TURN (optional; only runs if you set `TURN_*` vars)
- `concord-postgres` or `sqlite-on-disk` — depending on compose profile
- `concord-discord-bridge` — *only* starts if you enabled the Discord bridge. Leave it disabled on first deploy.

If any service is `restarting` or `unhealthy`, run `docker compose logs <service>` and fix the error before proceeding. Common first-run failures:

- **`conduwuit` crashes with "server_name mismatch"** — the compose mounts `config/tuwunel.toml`; edit it so `server_name` matches `CONDUWUIT_SERVER_NAME`.
- **`concord-api` crashes with `RuntimeError: CONDUWUIT_REGISTRATION_TOKEN must be set`** — `.env` wasn't picked up. Confirm `docker compose config | grep REGISTRATION_TOKEN` shows a non-empty value.
- **Caddy logs `failed to obtain certificate`** — Cloudflare is intercepting the HTTP-01 challenge. Either switch to DNS-01 with a Cloudflare API token, or temporarily set the DNS record to "DNS only" (grey cloud) until Caddy finishes the initial cert.

---

## 4. Well-known verification

Before telling any user to log in, verify the discovery endpoints respond correctly **from outside the host**. "From outside" is important — a curl from `localhost` can succeed while a request from the internet fails, and the whole native-app + federation story depends on external reachability.

From any machine on the public internet (NOT from orrgate itself):

```bash
# Matrix federation discovery — MUST return JSON matching the Matrix spec
curl -sSf https://concorrd.com/.well-known/matrix/server | jq .
# Expected:
# {
#   "m.server": "concorrd.com:443"
# }

# Matrix client discovery
curl -sSf https://concorrd.com/.well-known/matrix/client | jq .
# Expected to include:
# {
#   "m.homeserver": { "base_url": "https://concorrd.com" }
# }

# Concord-specific discovery — consumed by native clients (iOS/Android/TV)
curl -sSf https://concorrd.com/.well-known/concord/client | jq .
# Expected keys:
# - api_base
# - livekit_url (nullable)
# - instance_name (nullable)
# - features (list of stable identifiers)
# - turn_servers (list)
# - node_role (one of frontend-only | hybrid | anchor)
# - tunnel_anchor_enabled (boolean)

# Matrix federation keys — lets remote servers verify identity
curl -sSfI https://concorrd.com/_matrix/key/v2/server
# Expected: HTTP/2 200
```

All four must return **200** with the expected content. If `.well-known/matrix/server` returns HTML or a Caddy 404, the static-response Caddyfile rules from the 2026-04-08 federation reachability fix are not loaded — re-check `config/Caddyfile` and restart Caddy.

You can also run the canonical Matrix federation tester:

```bash
curl -sS "https://federationtester.matrix.org/api/report?server_name=concorrd.com" | jq .FederationOK
# Expected:
# true
```

If `FederationOK` is `false`, read `../federation-reachability-diagnosis.md` — the exact failure modes are catalogued there with fixes.

---

## 5. Bootstrap the first admin user

A fresh deployment has no users. To get one, the operator temporarily acts as admin via `ADMIN_USER_IDS`, then creates an invite token through the admin API, and uses that invite to register.

1. Confirm your own Matrix ID is in `ADMIN_USER_IDS` in `.env`. Restart `concord-api` if you added it after `up -d`: `docker compose restart concord-api`.
2. Register the admin account via the normal sign-up flow in the web client, hitting the homeserver's `/register` endpoint with `CONDUWUIT_REGISTRATION_TOKEN`. The web client exposes this at `https://concorrd.com/`.
3. Log in with the new account and open **Settings → Admin**. If the Admin tab is absent, the server hasn't matched your Matrix ID against `ADMIN_USER_IDS` — re-check the `.env` exactly, including the full `@localpart:server_name` form, and restart.
4. Create an initial server by running the "Create server" flow from the sidebar. This is now your bootstrap server.
5. From the admin panel (`/api/admin/invites`, also reachable from the Admin tab's Overview section), create a permanent invite token and distribute it to real users. `max_uses=10, expires_in_hours=168` is a sensible starting posture.

**Why this dance?** The alternative is a standalone bootstrap script that pokes the database directly. We rejected it because it creates a second code path for user creation that inevitably drifts. The admin-user-id bootstrap reuses the normal code paths; you only have to remember to clean up the *initial* admin's creation password afterward.

---

## 6. Federation smoke test

After the well-known endpoints are green, exercise real federation end-to-end. From a different Matrix homeserver (a client logged in to `matrix.org` is fine):

1. Open any Matrix client connected to a *different* homeserver.
2. Join the room alias `#public-test:concorrd.com` (create one first from your admin account if you don't already have a public room). The join will fail fast if federation is broken, succeed if it's healthy.
3. Post a message. It should appear on both sides within ~1 second.

If the join fails with `M_UNKNOWN` or a 503, check these in order:

1. `docker compose logs conduwuit | grep -i federation` — upstream errors usually show here first.
2. `federationtester.matrix.org` result — re-run and paste the failure reason into `federation-reachability-diagnosis.md`.
3. `curl -v https://concorrd.com/_matrix/federation/v1/version` from an outside host — must return a JSON body with `server.name` matching `CONDUWUIT_SERVER_NAME`. If it returns HTML, Caddy's federation route is wrong.

---

## 7. Post-deploy checklist

Before walking away from the deployment, confirm all of the following:

- [ ] `docker compose ps` shows every expected service as `running` or `healthy`.
- [ ] All four well-known / key curls from section 4 return 200.
- [ ] The federation tester reports `FederationOK: true`.
- [ ] You can log in to the web client at `https://<server_name>/` and see the Admin tab.
- [ ] You created at least one real server and one real invite token.
- [ ] The `.env` file has been backed up to your password manager — losing it means losing the registration token and rebuilding the homeserver.
- [ ] `service_node.json` has been reviewed in Settings → Admin → **Service Node**. Default `hybrid` + caps-unlimited is fine for most deployments; if you want this box to advertise itself as a persistent tunnel anchor, flip `tunnel_anchor_enabled` and set `node_role` to `anchor`. See §8 below for the operational implications.
- [ ] A cron job or systemd timer runs `docker system prune -f --filter "until=72h"` weekly — unmanaged Docker installs balloon their disk usage over time.
- [ ] Volumes are being backed up. At minimum, copy `data/` (or whatever `CONCORD_DATA_DIR` points at in the compose file), `data/matrix/`, and `.env` somewhere off-host nightly.

---

## 8. Service-node posture (INS-023)

Every Concord instance declares its own **service-node posture** — a small set of role + contribution knobs the operator sets in the admin panel. The posture is stored in `service_node.json` next to `instance.json` inside the data directory, and the stripped public subset is advertised via `/.well-known/concord/client` so peers can see what role the node plays.

- `node_role = "frontend-only"` — this box only runs the UI. No hosting, no peer acceptance. Pick this for client-only deployments (rare on a dedicated VM, common on a laptop).
- `node_role = "hybrid"` — **default**. UI + opportunistic hosting. Accepts peers when the box has capacity.
- `node_role = "anchor"` — always-on infrastructure node. Pair with `tunnel_anchor_enabled: true` when you commit to uptime SLAs and want peers to treat this box as a durable mesh anchor.

`max_cpu_percent`, `max_bandwidth_mbps`, `max_storage_gb` are policy knobs — the runtime doesn't enforce them yet (that work lands with the embedded servitude scheduler) but persisting them today lets the admin UI surface the operator's intent and gives the scheduler something to honor later. Set `0` for "unlimited" on bandwidth / storage.

Raw caps are **never** published in the unauthenticated well-known document — only `node_role` and `tunnel_anchor_enabled` reach the wire. An attacker who curls your well-known cannot learn your hardware profile.

---

## 9. Rollback

If something goes badly wrong and you need to walk the deployment back:

```bash
# Stop everything, preserving volumes
docker compose down

# Restart with the previous known-good image tags (if you pinned them)
# -- otherwise, `git checkout <previous-commit>` then `docker compose up -d`
git checkout <previous-sha>
docker compose pull
docker compose up -d

# Nuclear option — stop and wipe volumes (DESTROYS ALL DATA)
# Do NOT run this unless you have backups and have decided this
# deployment is unsalvageable.
docker compose down -v
```

Before `down -v`, always copy the data volume to a dated backup directory on the host. `down` alone is non-destructive and is always safe.

---

## 10. Related reading

- `../federation-reachability-diagnosis.md` — what to do when external `curl`s against the well-known endpoints fail.
- `../bridges/discord.md` — enabling the Discord bridge (optional, leave off for first deploy).
- `github_bug_report_token.md` — rotating the GitHub PAT that mirrors user bug reports.
- Root `README.md` — architecture overview, not operator-focused but worth skimming before debugging.

Questions or new failure modes? File a GitHub issue with the full command you ran, the exact output, and `docker compose logs --tail=200`. Keep `.env` values OUT of the issue body.
