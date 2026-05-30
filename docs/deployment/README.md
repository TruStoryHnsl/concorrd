# Concord Deployment Guides

Operator runbooks for deploying Concord. Start with the target that matches your environment.

> **Before you deploy:** read [`host-allowlist.md`](./host-allowlist.md). Concord runs only on `orr1on` (production) and `orrion` (development). `install.sh` will refuse to run on `orrgate` and warn on any other host.

| Guide | Target | When to use |
|-------|--------|-------------|
| [host-allowlist.md](./host-allowlist.md) | All deploys | Pre-flight — which hosts may run concord, which may not, and why. |
| [tls-mode.md](./tls-mode.md) | All deploys | Pick a TLS strategy (`TLS_MODE`): Caddy internal CA, Let's Encrypt HTTP-01, or Let's Encrypt DNS-01 via Cloudflare. |
| [github_bug_report_token.md](./github_bug_report_token.md) | GitHub PAT rotation | You set up `GITHUB_BUG_REPORT_TOKEN` and need to rotate the credential or audit its scope. |

New environments should land their own `.md` file in this directory and link into the table above.

---

## Tailscale-only dev deployment (TLS via Cloudflare DNS-01)

A development Concord instance can be served exclusively over Tailscale — the
host's public internet ingress is never used and no router port-forward is
required. The topology: a Cloudflare DNS A record (gray-cloud, proxy OFF) for
`dev.<your-zone>` points directly at the host's Tailscale 100.x IP. Tailscale
peers route to that IP through the WireGuard mesh; non-peers can't resolve it
to anything reachable. The web container's Caddy publishes `443` on the host
(binding all interfaces, including `tailscale0`), so a peer's browser hitting
`https://dev.<your-zone>/` connects to Caddy on the Tailscale side — no public
ingress involved.

Two TLS strategies cover this topology:

- `TLS_MODE=internal_longlived` — the dev default. Caddy issues a self-signed
  cert with a ~9-year leaf; operators accept the cert exception once per
  device. This is what PR #91 shipped and what every Tailscale-only operator
  is on today by default.
- `TLS_MODE=letsencrypt_dns01_cloudflare` — public Let's Encrypt via DNS-01.
  DNS-01 proves zone control by writing a transient `_acme-challenge.<host>`
  TXT record via the Cloudflare API, which works even though the origin is
  invisible to the public internet. Set `CLOUDFLARE_API_TOKEN` in `.env`
  alongside the TLS_MODE choice (see `.env.example` for the required token
  scope and minting steps).

The base `docker-compose.yml` threads `TLS_MODE`, `ACME_EMAIL`, and
`CLOUDFLARE_API_TOKEN` into the `web` service's environment; the dev override
flips the default TLS_MODE to `internal_longlived`. The Caddy image is built
with `xcaddy` against the `caddy-dns/cloudflare` plugin (see `web/Dockerfile`);
plain `caddy:alpine` does not include this provider, so the DNS-01 mode only
works against the project-built image.

See [tls-mode.md](./tls-mode.md) for the full strategy matrix.

---

## Reticulum Transport (experimental)

> **Status:** Experimental — Wave 0 scaffold only. Do **not** enable in production.
> See `docs/reticulum/main-build-integration.md` for the full architecture rationale.

### What it is

Reticulum is a cryptography-based networking stack for resilient, low-bandwidth mesh links
(LoRa, serial, TCP, I2P). When the `reticulum` Cargo feature is enabled, Concord compiles in
a `ReticulumTransport` variant that manages an `rnsd` (Reticulum Network Stack daemon) child
process alongside the existing Matrix federation and Discord bridge transports.

The feature flag is **OFF by default**. Standard Concord builds do not include any Reticulum
code and are completely unaffected.

### Enabling at build time

```bash
# One-off build with Reticulum transport included:
cargo build --features reticulum

# Or add to Cargo.toml [features] to make it a permanent default for a custom build:
# default = ["reticulum"]
```

What gets compiled in when the flag is ON:
- `ReticulumTransport` struct and its `impl Transport` block
- `TransportRuntime::Reticulum(ReticulumTransport)` enum variant
- Lifecycle management: spawn `rnsd`, health-check via management socket, graceful SIGTERM/SIGKILL on stop

### Runtime dependency: `rnsd`

The feature flag compiles in the lifecycle wrapper but does **not** bundle `rnsd`. You must
install the Reticulum Network Stack Python package separately:

```bash
pip install rns
# rnsd is now on PATH
rnsd --version
```

### Minimal `rnsd` configuration

`rnsd` expects a configuration file at `~/.reticulum/config` (or set `RNS_CONFIG_DIR`).
A minimal config for a TCP-only interface (no physical radio required) looks like:

```ini
[reticulum]
  enable_transport = yes
  share_instance = yes
  storage_path = /var/lib/reticulum

[interface:TCPClientInterface]
  type = TCPClientInterface
  enabled = yes
  target_host = 127.0.0.1
  target_port = 4242
```

Adjust `target_host`/`target_port` for your network topology. For LoRa or serial interfaces,
refer to the [Reticulum docs](https://reticulum.network/manual/interfaces.html).

### Docker: TUN/TAP interface access

If running in the Docker Compose stack with Reticulum transport enabled, the `concord-api`
service needs additional Linux capabilities so `rnsd` can manage TUN/TAP interfaces:

```yaml
# In docker-compose.yml under the concord-api service:
cap_add:
  - NET_ADMIN
# If using a specific serial or USB device for a radio interface, also add:
# devices:
#   - /dev/ttyUSB0:/dev/ttyUSB0
```

See the comment block in `docker-compose.yml` near the `concord-api` service for the
copy-paste snippet.

### Wave sequencing

| Wave | Work | State |
|------|------|-------|
| W0 | Architecture doc + Cargo feature flag | **Done** |
| W1 | `ReticulumTransport` impl; `rnsd` binary bundling | Blocked on `rnsd` binary for target platform |
| W2 | tuwunel ↔ Reticulum interface config | Blocked on W1 |
| W3 | Mobile: bundled Python / compiled `rnsd` | Blocked on mobile SDK work |
| W4 | Announce-based peer discovery | Blocked on W2 |
