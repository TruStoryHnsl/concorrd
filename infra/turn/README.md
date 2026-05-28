# Turn-stack infrastructure

This directory holds the docker-compose + sslh config for the
**edge-proxy stack** that fronts a concord deployment. The stack is
intentionally separate from the application stack (`docker-compose.yml`
at the repo root, which builds web/api/conduwuit/livekit/coturn-internal):

| Stack | What it does |
| --- | --- |
| `/docker-compose.yml` (repo root) | Application: Caddy web, FastAPI concord-api, conduwuit (Matrix), livekit, internal coturn (for clients on the same LAN), docker-socket-proxy. |
| `infra/turn/` (this dir) | Edge: `sslh` TLS-demuxes :443 by SNI to the host's NPM (HTTPS) and a public-facing `coturn` (TURN-over-TLS for voice clients that can't reach UDP). Plus `willfarrell/autoheal` so a wedged sslh restarts automatically. |

## Services

- **sslh** — protocol multiplexer on `:443`. SNI `turn.<domain>` routes to coturn TLS `:5349`; everything else routes to NPM on `:8444` which terminates HTTPS and forwards to the application stack's `web` (Caddy on `:8080`).
- **coturn** — TURN-over-TLS on `:5349` for voice clients behind restrictive networks. Host network mode.
- **autoheal** — sidecar that watches `autoheal=true` labels and restarts unhealthy containers. Needed because standalone docker-compose has no native restart-on-unhealthy policy.

## First-time install on a new host

Every deployment-specific file ships as a `.example` template — the
live copies (`sslh.conf`, `docker-compose.yml`, `turnserver.conf`,
`.env`) are gitignored. Operator copies + edits.

```bash
# 1. Clone the concord repo somewhere stable. The application stack
#    expects to live at /docker/stacks/concord/, so use that path.
sudo mkdir -p /docker/stacks
sudo git clone https://github.com/TruStoryHnsl/concord.git /docker/stacks/concord

# 2. Symlink the turn-stack subdirectory to /docker/stacks/turn/. This
#    keeps the on-host path stable while the source of truth is in git.
sudo ln -s /docker/stacks/concord/infra/turn /docker/stacks/turn

# 3. Populate the deployment-specific files (NOT in git):
cd /docker/stacks/turn
sudo cp .env.example                .env
sudo cp docker-compose.yml.example  docker-compose.yml
sudo cp sslh.conf.example           sslh.conf
sudo cp turnserver.conf.example     turnserver.conf
sudo nano .env                      # set CONCORD_PUBLIC_DOMAIN
sudo nano sslh.conf                 # fill in __SET_HOST_IP__ and __SET_TURN_SNI__
sudo nano turnserver.conf           # fill in the __SET_*__ values
sudo mkdir -p certs
# drop fullchain1.pem + privkey1.pem from Let's Encrypt into certs/

# 4. Start the stack.
sudo docker compose up -d
```

## Updates

```bash
cd /docker/stacks/concord && sudo git pull
cd /docker/stacks/turn && sudo docker compose up -d
```

`git pull` will not touch the live `sslh.conf`, `docker-compose.yml`,
`turnserver.conf`, or `.env` — they are gitignored. If the `.example`
templates picked up new fields, diff them against the live versions
and apply by hand.

If only sslh.conf changed, `sudo docker restart sslh` is sufficient
(sslh re-reads the config on start; the volume mount is `:ro`). If
`docker-compose.yml` changed (image bump, healthcheck tweak, autoheal
config), use `docker compose up -d` to recreate.

## Operating notes

### When prod looks down but containers are "healthy"

Probable: sslh wedged. Check its socket state from the host:

```bash
sudo nsenter -t $(sudo docker inspect -f '{{.State.Pid}}' sslh) -n ss -tan
```

If you see ESTAB sockets stuck with `Recv-Q` around 1500 bytes (unread
TLS ClientHellos), sslh's main loop has stopped consuming established
sockets. `sudo docker restart sslh` clears it. The autoheal sidecar
should now do this automatically — verify autoheal is running and the
sslh healthcheck has flipped to `unhealthy` for at least one cycle (it
runs every 30 s with 2 retries before marking unhealthy).

### Why sslh wedged (history)

`keepalive: true` was added on 2026-05-12 after a 25-day-uptime wedge.
Default sslh doesn't set `SO_KEEPALIVE` on its forwarded TURN
connections, so when voice clients silently vanish (NAT rebind, ISP
drop, browser crash) the half-open socket lingers indefinitely. They
eventually accumulate to the point that sslh's main loop stops
consuming established sockets and the `:443` listener goes effectively
dead even though TCP `accept()` still works. Keepalive lets the kernel
reap dead peers; ulimit bump and autoheal add belt-and-suspenders.

A 2026-05-17 attempt placed `keepalive: true` at the file's top level,
which sslh-select v2.3.1 rejects with "Unknown settings: keepalive" and
exits. Autoheal then turned that into a restart loop, tearing down
live TLS forwards mid-handshake and taking prod down a second time.
The fix is syntactic: `keepalive` is a per-`listen{}` /
per-`protocols{}` option, not a top-level key. The current
`sslh.conf.example` places it correctly on every block. The image is
also pinned to `ghcr.io/yrutschle/sslh:2.3.1` rather than `:latest` so
syntax compatibility stays stable across deploys.

### Backups left by the migration

If you see `*.bak-20260512-*` files in the on-host `/docker/stacks/turn/`
they're pre-keepalive copies of the config from when this stack was
first hardened. Safe to remove after confirming the new config has
been stable for a few days.
