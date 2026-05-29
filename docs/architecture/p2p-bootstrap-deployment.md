# Concord Bootstrap Node Deployment

> **Status:** operational spec, captured 2026-05-28 alongside Phase 4 of the P2P-first architecture (see [`p2p-design.md`](p2p-design.md)). This document specifies how the Concord project runs its bootstrap node fleet. **Operators do not deploy these nodes.** They are project-owned infrastructure shared across every Concord install.
>
> **Source of truth for the in-binary list:** [`src-tauri/src/servitude/bootstrap.rs`](../../src-tauri/src/servitude/bootstrap.rs) — `BOOTSTRAP_NODES`. Any change here in the deployment fleet MUST be matched by a release that updates that constant; runtime configuration of bootstrap peers is intentionally not supported.

## What this is

A small fleet — 3 nominal, scalable to 5 — of long-lived libp2p nodes that participate in the Concord Kademlia DHT as stable, always-on peers with **fixed Ed25519 PeerIds**. They are the seed addresses every Concord install dials at startup. Without them, a fresh Concord install on a freshly-set-up machine cannot find any peer: it has no Matrix-room piggyback (yet), no out-of-band QR exchange (yet), and an empty Kad routing table.

Each node runs only:
- libp2p with the Kad + Identify + Ping behaviors.
- A QUIC listener on UDP/4001 with a stable DNS name and PeerId.
- Nothing else. No web server, no SSH (beyond ops access), no Matrix homeserver, no LiveKit.

The binary is a dedicated `concord-bootstrap` artifact (NOT the main Tauri app, NOT `concord-api`). See "Image" below.

## Why it's project infrastructure, not operator infrastructure

Two reasons:

1. **First-discovery is a chicken-and-egg problem.** A brand-new Concord install on a brand-new machine has no peers in its routing table and no way to learn any. It needs at least one known-good multiaddr to start asking "who else is on the DHT?". The project ships those addresses in the binary so the operator never has to type them.

2. **A misconfigured operator-provided bootstrap list silently breaks discovery.** If we made `BOOTSTRAP_NODES` an env var, an install could be wedged against unreachable addresses with no visible error path (DHT join failure is `debug!`-logged, not surfaced to the user). One single project-controlled list — replaced in lockstep with the release that depends on it — is simpler and more robust.

These nodes are shared across every Concord install. Self-hosted operators do NOT run bootstrap nodes; they only consume the published ones. Per-install custom bootstrap is explicitly out of scope.

## VPS sizing

Each bootstrap node fits on the smallest cloud VPS tier available. Recommended baseline:

| Field | Value |
|---|---|
| Provider (reference) | Hetzner CX22 — or any equivalent 1-vCPU / 2 GB / 20 GB / 20 TB tier |
| CPU | 1 vCPU |
| RAM | 2 GB |
| Disk | 20 GB |
| Bandwidth | 20 TB/mo included (more than three orders of magnitude over what Kad actually uses) |
| Cost | ~$5/mo |
| OS | Debian 12 stable, or any current systemd Linux distro |

Kad bandwidth on these nodes is **metadata-only**: small UDP/QUIC packets carrying peer routing entries, on the order of kilobytes per minute per connected peer. CPU and RAM headroom are likewise excessive for the workload — the 2 GB tier is the floor that gets us reliable QUIC stacks and headroom for libp2p's tokio runtime, not a tight fit.

Cost model for the full fleet:
- 3 nodes nominal = ~$15/mo.
- 5 nodes (scaled up for geographic diversity / redundancy headroom) = ~$25/mo.
- Funded under the donation-only model — see PLAN.md for the scope=commercial donation posture.

## Image

The bootstrap binary is a small standalone artifact, **not part of the main Tauri build**. It lives in its own crate so the bootstrap node does NOT carry the Tauri runtime, the dendrite/tuwunel federation modules, or any UI assets.

Suggested layout for the bootstrap binary (to land in a future ops commit):

```
bootstrap-node/                # new crate, sibling to src-tauri/
  Cargo.toml                   # libp2p + tokio + a tiny tracing setup, nothing else
  src/main.rs                  # parses key.pem, brings up Kad + Identify in Server mode
  Dockerfile                   # multi-stage: rust:1-slim → distroless or scratch
  systemd/concord-bootstrap.service
  README.md                    # ops-only quickstart
```

The Dockerfile is a multi-stage build:

1. **Builder stage** — `rust:1-slim` base, copies `Cargo.toml` + `src/`, runs `cargo build --release`.
2. **Runtime stage** — `gcr.io/distroless/cc-debian12` (or `scratch` with statically-linked libc if the libp2p QUIC stack permits). Copies the release binary. Sets `ENTRYPOINT ["/concord-bootstrap"]`.

The runtime image should be < 20 MB. Bootstrap nodes never need shell access via the container; SSH on the host VPS is the ops console.

The actual crate scaffold is **not created in this PR** — this doc is the spec for a future ops-side commit. The deployment story exists in two halves: the in-binary list (already shipped, Phase 4) and the binary that occupies those addresses (this spec, future work).

## Stable PeerId

Each bootstrap node has a **single long-lived Ed25519 keypair**, generated once at provisioning time, stored on the VPS at:

```
/var/lib/concord-bootstrap/key.pem   (chmod 0600, owner=concord-bootstrap user)
```

The public half of that keypair encodes (via libp2p's standard PeerId derivation) the `12D3KooW…` peer ID that appears in the `/p2p/<peer-id>` suffix of the hardcoded multiaddr. The private half never leaves the VPS.

Generation procedure (done once, by ops, at first provisioning):

```bash
# On the VPS, after installing the concord-bootstrap binary:
sudo concord-bootstrap keygen --out /var/lib/concord-bootstrap/key.pem
sudo chmod 0600 /var/lib/concord-bootstrap/key.pem
sudo chown concord-bootstrap:concord-bootstrap /var/lib/concord-bootstrap/key.pem
# Print the corresponding PeerId so it can be encoded into BOOTSTRAP_NODES:
sudo concord-bootstrap peerid --key /var/lib/concord-bootstrap/key.pem
```

The `keygen` and `peerid` subcommands are part of the spec for the future `concord-bootstrap` binary; they are not the main `Concord` Tauri app's CLI.

## Ports & firewall

| Direction | Port / proto | Purpose | Source |
|---|---|---|---|
| Inbound | UDP/4001 | QUIC + libp2p | `0.0.0.0/0` |
| Inbound | TCP/22 | SSH (ops only) | restricted to ops jumphost(s) |
| Inbound | (anything else) | DENY | — |
| Outbound | UDP/4001 to any | DHT dials to other peers | unrestricted |
| Outbound | TCP/443 | apt updates, package fetches | unrestricted |

No HTTP/HTTPS listener. No TURN, STUN, LiveKit, sslh, NPM. The bootstrap node's sole job is to be a stable libp2p endpoint on UDP/4001. The TCP listener that the main Concord app exposes (`/ip4/.../tcp/0`) is NOT exposed on bootstrap nodes — Kad + Identify + Ping are happy on QUIC alone, and dropping the TCP surface area shrinks the attack surface to one port.

`ufw` template:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <ops-jumphost-cidr> to any port 22 proto tcp
sudo ufw allow 4001/udp
sudo ufw enable
```

## DNS

Each bootstrap node has a stable A (and AAAA if dual-stack) record under `concordchat.net`:

| Hostname | A record | Notes |
|---|---|---|
| `bootstrap1.concordchat.net` | VPS public IP | nominal-3 fleet |
| `bootstrap2.concordchat.net` | VPS public IP | nominal-3 fleet |
| `bootstrap3.concordchat.net` | VPS public IP | nominal-3 fleet |
| `bootstrap4.concordchat.net` | VPS public IP | scaled-5 fleet (reserved) |
| `bootstrap5.concordchat.net` | VPS public IP | scaled-5 fleet (reserved) |

The hardcoded list in `BOOTSTRAP_NODES` uses `/dns4/bootstrapN.concordchat.net/udp/4001/quic-v1/p2p/<peer-id>` — `/dns4` (not `/ip4`) so the runtime resolves the A record at dial time. This lets ops repoint a name to a new VPS without cutting a Concord release, provided the PeerId is preserved (i.e. the `key.pem` migrates with the name).

DNS TTL: 300 seconds. Short enough to repoint quickly under failover, long enough that caches don't hammer the resolver on every Concord install start.

## Provisioning

Each bootstrap node is brought up with the following systemd unit (template, paths to finalize once the bootstrap binary lands):

```ini
# /etc/systemd/system/concord-bootstrap.service
[Unit]
Description=Concord Kademlia bootstrap node
Documentation=https://github.com/TruStoryHnsl/concord/blob/main/docs/architecture/p2p-bootstrap-deployment.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=concord-bootstrap
Group=concord-bootstrap
WorkingDirectory=/var/lib/concord-bootstrap
ExecStart=/usr/local/bin/concord-bootstrap \
    --key /var/lib/concord-bootstrap/key.pem \
    --listen /ip4/0.0.0.0/udp/4001/quic-v1 \
    --mode server
Restart=always
RestartSec=10
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/concord-bootstrap
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

Notes:

- `--mode server` mirrors the libp2p `kad::Mode::Server` setting — the bootstrap participates fully in the DHT (advertises itself as routable, responds to queries). This is the role mismatch versus the main native Concord app, which runs in `kad::Mode::Client` by default (see `src-tauri/src/servitude/p2p.rs::new_inner`).
- `MemoryMax=512M` is a soft upper bound; in practice Kad-only nodes sit well under 100 MB.
- `Restart=always` + `RestartSec=10` is the entire monitoring strategy. See "Monitoring" below.

Provisioning may eventually live in an `infra/bootstrap-nodes/` directory in the repo (Ansible / Terraform / shell). For now this doc is the spec; the first node will be hand-provisioned and this section will be promoted to an automated playbook in a follow-up.

## Monitoring

Two layers, both deliberately minimal:

1. **systemd `Restart=always`** is the heartbeat. If the bootstrap binary crashes, panics, OOMs, or exits cleanly for any reason, systemd restarts it within `RestartSec=10`. The Kad protocol is tolerant of brief outages — clients re-dial on the next bootstrap retry (5s → 5min exponential backoff) and the dropped node is back in the routing table within a minute.

2. **External liveness probe** (out-of-band, not on the VPS itself). A separate observability host runs a periodic `concord-bootstrap-probe` script (also future ops work) that:
   - Resolves each `bootstrapN.concordchat.net` A record.
   - Dials the published multiaddr from a temporary libp2p client.
   - Asserts the Identify protocol reports the expected agent version + PeerId.
   - Emits a metric to the project's monitoring stack (Prometheus textfile, syslog, or whatever lands first).

There is **no** `/health` HTTP endpoint on the bootstrap node itself — that would mean a second listener, which violates the "one port, one protocol" principle. Liveness is observable from a real libp2p dial; no separate health surface needed.

## Rotation procedure

If a bootstrap node's private key is compromised — host breach, disk theft, accidental commit, suspicious access pattern in audit logs — replace it with the following steps. **Do not** issue a new key while leaving the compromised one in the published list; downstream clients would still trust it.

1. **Provision a new VPS** with a freshly-generated keypair (`concord-bootstrap keygen`). Assign it the next available `bootstrapN.concordchat.net` DNS name.
2. **Update the hardcoded list** in `src-tauri/src/servitude/bootstrap.rs` (`BOOTSTRAP_NODES`): add the new multiaddr, remove the compromised one. Commit + PR + agent-pm review.
3. **Cut a new Concord release.** Until the release ships, installs running the old binary still dial the compromised node — that's why the rotation is bounded by release cadence, not zero-time.
4. **Wait 30 days** after the release lands so the install base catches up. Concord's auto-update mechanism (desktop updater, mobile store updates) covers most installs in days; the 30-day window absorbs slow-update users.
5. **Decommission the compromised node** (destroy the VPS, revoke any platform credentials it held, archive the access logs for post-incident review).

If the compromise is severe enough that the 30-day window is too long, ship an emergency release with the rotation. The Concord updater UI calls this out as a security-critical update.

## Cost model

| Item | Cost (USD / month) |
|---|---|
| 3 × $5/mo VPS | $15 |
| (Reserved capacity for scaling to 5) | +$10 (when activated) |
| DNS | $0 (within the existing `concordchat.net` Cloudflare / DNS provider plan) |
| Bandwidth overage risk | $0 (Kad traffic is metadata-only; the 20 TB/mo inclusive tier is ~10000× the worst plausible usage) |
| **Total today** | **~$15/mo** |
| **Total scaled to 5** | **~$25/mo** |

This is project-owned, donation-funded infrastructure. See PLAN.md for the donation-only model (`commercial` scope, narrow native-mobile donation IAP exception). No operator pays for or runs these nodes.

## What this doc does NOT cover

- **Operator-deployed Concord instances.** Concord operators (self-hosted homeservers, etc.) do not run bootstrap nodes. They consume the published ones, just like any native install.
- **Per-install custom bootstrap lists.** Explicitly out of scope — see "Why hardcoded" in `bootstrap.rs`. No env var, no CLI flag, no Settings UI.
- **Federated-network bootstrap fallbacks.** The Matrix-room peer-card exchange (Phase 5) and ActivityPub piggyback are separate first-discovery mechanisms that complement the DHT but don't replace it. A user with no existing Matrix room can still bootstrap via the DHT.
- **The `concord-bootstrap` binary itself.** That crate is future ops work; this doc is the spec it builds against.

## Cross-references

- [`p2p-design.md`](p2p-design.md) — overall P2P-first architecture; this doc fills in Phase 4's "spec the bootstrap node deployment" bullet.
- [`src-tauri/src/servitude/bootstrap.rs`](../../src-tauri/src/servitude/bootstrap.rs) — the in-binary hardcoded list. Must stay in lockstep with the deployed fleet.
- [`src-tauri/src/servitude/p2p.rs`](../../src-tauri/src/servitude/p2p.rs) — the wiring that consumes the list at swarm startup, including the `kad::Mode::Client` default and the bootstrap retry loop.
- PLAN.md `### TOP PRIORITY: P2P-first native architecture` — roadmap entry for Phase 4.
