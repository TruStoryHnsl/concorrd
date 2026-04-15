# Concord Deployment Guides

Operator runbooks for deploying Concord. Start with the target that matches your environment.

| Guide | Target | When to use |
|-------|--------|-------------|
| [orrgate.md](./orrgate.md) | Single-host Docker Compose on a Linux VM | First real deployment. Self-hosted, federation-enabled, behind Caddy + Cloudflare. |
| [github_bug_report_token.md](./github_bug_report_token.md) | GitHub PAT rotation | You set up `GITHUB_BUG_REPORT_TOKEN` and need to rotate the credential or audit its scope. |

New environments should land their own `.md` file in this directory and link into the table above.

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
