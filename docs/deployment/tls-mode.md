# TLS strategy (`TLS_MODE`)

Concord's web edge runs Caddy. Caddy can obtain certificates four different
ways: a self-signed internal CA, public Let's Encrypt via HTTP-01, public
Let's Encrypt via DNS-01 against Cloudflare, or operator-provided certs (not
yet exposed via `TLS_MODE`). The `TLS_MODE` env var picks among the first
three; both `config/Caddyfile` (prod) and `config/Caddyfile.dev` (dev) read
the same value, so the choice is a single source of truth.

Set the mode in `.env`:

```ini
TLS_MODE=letsencrypt_dns01_cloudflare
ACME_EMAIL=ops@example.com
CLOUDFLARE_API_TOKEN=cf-token-here
```

If `TLS_MODE` is unset or empty, each Caddyfile falls back to its documented
default — `letsencrypt_http01` for prod, `internal_longlived` for dev — so
existing operators see no behaviour change.

## Modes

### `internal_longlived` — Caddy self-signed CA, ~9-year leaf

Caddy issues its own root + intermediate + leaf certs entirely offline. The
leaf lifetime is overridden to ~78 000 hours (≈ 8.9 years) so the cert
exception an operator accepts on day one carries through the dev box's
operational lifetime. The root CA can also be installed in the operator's
browser trust store — the cert artifact lives at
`data/caddy/pki/authorities/local/root.crt` inside the `web` container's
data volume (`./data/caddy`).

Pick this when:

- Tailscale-only / LAN-only dev or private deployments with no public DNS.
- The host has no path to the public internet on port 80 OR 443.
- You don't mind the one-time "self-signed cert" warning per device.

Avoid when:

- You need browsers to trust the cert without installing the root manually.
- You're shipping to non-technical users who can't accept a cert exception.

### `letsencrypt_http01` — Public ACME via HTTP-01

Caddy uses the default Let's Encrypt HTTP-01 challenge: LE makes an HTTP
request to `http://<your-domain>/.well-known/acme-challenge/<token>` and
Caddy serves a one-time response. Auto-renews; no operator action after the
initial deploy.

Pick this when:

- `SITE_ADDRESS` is a public hostname.
- Port 80 on the host is reachable from the public internet (typically the
  case for cloud VMs with a public IP).

Avoid when:

- Port 80 is blocked at the router/firewall (HTTP-01 has no fallback).
- The origin lives behind a CDN that doesn't forward `:80` to your box.
- The origin is Tailscale-only or otherwise invisible to LE's validators.

### `letsencrypt_dns01_cloudflare` — Public ACME via DNS-01 against Cloudflare

Caddy proves zone control by writing a transient `_acme-challenge.<host>`
TXT record into Cloudflare's DNS via the API. LE checks the TXT record
instead of making an HTTP call. No public reachability required for the
origin itself.

Pick this when:

- The origin is behind a Cloudflare proxy / Tailscale / VPN / no port 80.
- You want a real public CA cert without exposing port 80 to LE traffic.
- The Concord domain lives on a Cloudflare-managed zone.

Avoid when:

- The domain isn't on Cloudflare. (Caddy supports other DNS providers via
  the `caddy-dns/*` plugins, but the project's `web/Dockerfile` currently
  builds only `caddy-dns/cloudflare`. Adding more providers would mean
  extending the `xcaddy build` step.)

Required token scope:

- `Zone:Read` + `DNS:Edit` scoped to the single zone hosting your
  `SITE_ADDRESS`. Anything broader is over-permissioned for the use case.
- Token-minting walkthrough lives in `.env.example` next to the
  `CLOUDFLARE_API_TOKEN=` declaration.

## How it works under the hood

Both Caddyfiles end with three named snippets (`tls_mode_<mode>`). The site
block imports one of them at parse time via:

```caddyfile
import tls_mode_{$TLS_MODE:<default>}
```

Caddy substitutes `$TLS_MODE` at parse time; the `:<default>` after the
colon is the fallback when the env var is UNSET. (Note: Caddy treats
`TLS_MODE=""` — set but empty — as a valid empty value and does NOT apply
the default. That's why `docker-compose.yml` uses
`${TLS_MODE:-letsencrypt_http01}` to convert blank-in-`.env` into a
non-empty value before passing it to the container.)

Adding a new mode is two edits:

1. Add a `(tls_mode_<your_mode>) { tls { ... } }` snippet to BOTH
   `config/Caddyfile` and `config/Caddyfile.dev`.
2. Document the value in `.env.example`'s `TLS_MODE=` comment block.

The lint at `scripts/lint_config_coherence.py` (CI's `config-lint` job)
checks all three places agree.

## Verifying a mode works

A static parse test for all three modes lives at
`scripts/lint_tls_mode_matrix.sh`. Run locally with:

```sh
bash scripts/lint_tls_mode_matrix.sh
```

It validates both Caddyfiles via vanilla `caddy:alpine` for the two LE
modes that don't need the Cloudflare plugin, and via the project's own
`concord-web:latest` image for the DNS-01 mode. The DNS-01 case is
SKIPPED if `concord-web:latest` isn't already built locally — building
just to validate config takes minutes; build it via the normal
`docker compose build web` flow first if you want to exercise the
DNS-01 path.

CI runs both lints on every PR (`.github/workflows/ci.yml`,
`config-lint` job).

## Migration notes

Operators upgrading past PR #95 see no behaviour change unless they
explicitly set `TLS_MODE`. The defaults match each Caddyfile's pre-PR
behaviour:

- Prod stayed on auto-ACME for domain `SITE_ADDRESS` values, plain HTTP
  for `:PORT` values.
- Dev kept the `tls { issuer internal { lifetime 78000h } }` block PR #91
  shipped.

The pre-existing `CLOUDFLARE_API_TOKEN=` env var in `.env.example` is now
canonically owned by this TLS_MODE block; the old free-standing block
that lived in `docker-compose.dev.yml`'s `web` env override was removed
(the base compose now passes the token through unconditionally).
