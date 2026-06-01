# Peer network — transport routing & connection lifecycle

## Status

Active. Supersedes the "Transport" subsection of
`docs/architecture/p2p-design.md` for the F-WG dispatch (RFC #140
CONSOLIDATED ARCHITECTURE, 2026-05-31, and Architecture E,
2026-06-01).

## Scope

This document covers the **transport-routing** rules and the
**connection-lifecycle** rules for Concord's native build:

- which traffic gets wrapped in a WireGuard tunnel,
- which traffic does not, and
- what happens to active tunnels when the user closes the app.

The web / docker builds are referenced where they differ, but the
load-bearing constraints below apply to the **native** desktop +
mobile binaries only.

## Routing — what gets WireGuard-wrapped vs not

| Surface | Transport | Wrapped? |
|---|---|---|
| Porch greet (libp2p `/concord/porch/1.0.0`) | libp2p over TCP+QUIC | **YES** (WG) |
| Home sync (libp2p `/concord/porch-sync/1.0.0`) | libp2p over TCP+QUIC | **YES** (WG) |
| Server discovery (libp2p gossipsub + identify) | libp2p over TCP+QUIC | **YES** (WG) |
| Address rotation (libp2p gossipsub `/concord/address-rotation/1.0.0`) | libp2p over TCP+QUIC | **YES** (WG) |
| History fetch (libp2p `/concord/porch-history/1.0.0`) | libp2p over TCP+QUIC | **YES** (WG) |
| Export delivery (libp2p `/concord/home-export/1.0.0`) | libp2p over TCP+QUIC | **YES** (WG) |
| Matrix federation (HTTPS via `matrix_federation.rs`) | HTTP/2 over TLS | **NO** (plain TLS) |
| Concord-via-domain HTTP (`client/src/api/concord.ts`) | HTTP/2 over TLS | **NO** (plain TLS) |
| mDNS local discovery | UDP multicast on LAN | **NO** (raw multicast) |
| Local-loopback IPC | unix-socket / loopback TCP | **NO** (never leaves host) |

The core rule: **every native peer-to-peer connection rides inside a
per-peer WireGuard tunnel; every TLS-over-domain federation hop does
not.** The mDNS exemption is structural (multicast doesn't survive a
WG tunnel) and acceptable because LAN-local traffic is not the threat
model F-WG defends against.

### Docker build

The docker stack ships the same libp2p binary, but its primary role is
to act as a **public-internet buoy** for native peers to find each
other through. Its libp2p traffic is NOT wrapped — the docker stack's
job is to be reachable from the open internet, so adding a WG tunnel
in front of it would defeat the buoy property.

## WgTunnel — userspace-only WireGuard primitive

The per-peer tunnel is implemented in
[`src-tauri/src/servitude/network/wg_tunnel.rs`](../../src-tauri/src/servitude/network/wg_tunnel.rs)
via the [`boringtun`](https://github.com/cloudflare/boringtun) crate.

### Why boringtun, not wireguard-control

Two crates were considered:

- **`wireguard-control`** wraps the C `libwgembed` library, requires
  `CAP_NET_ADMIN` (or root) on Linux to touch the kernel WireGuard
  interface, and pulls in a non-trivial system dep on Windows.
- **`boringtun`** is Cloudflare's pure-Rust WireGuard protocol
  engine. The default feature set exposes only the `Tunn` state
  machine (handshake + encapsulate + decapsulate) — no kernel
  interface, no privileged sockets, no platform-specific glue.

**boringtun wins on every axis that matters here.** The full
rationale lives at the top of the `wg_tunnel.rs` module docs; the
summary:

1. **Hard-disconnect simplicity.** A boringtun tunnel is *just* a
   `Tunn` value plus a UDP socket. Dropping the `WgTunnel` struct
   drops both. There is no kernel-side state — no `ip link del wg0`
   to run, no orphaned interface to clean up after a crash.
2. **Cross-platform parity.** Linux, macOS, and Windows share the
   same protocol-engine code path. No conditional compilation.
3. **No elevated privileges.** Concord's native install runs as a
   normal user. A kernel WG interface would force a UAC prompt on
   Windows and a `sudo` step on Linux/macOS — unacceptable for a
   chat client.

### Wrapped multiaddr shape

The tunnel binds a loopback UDP socket on `127.0.0.1:<ephemeral>`
and surfaces a wrapped multiaddr of the form:

```
/ip4/127.0.0.1/udp/<ephemeral>/quic-v1
```

Callers dial this multiaddr through the existing libp2p stack;
boringtun encapsulates each outbound frame and forwards it to the
remote peer's real UDP endpoint, then decapsulates the reverse
direction and loops it back. The libp2p layer sees an ordinary QUIC
endpoint — no special-case code at the dial path.

### WgRegistry

A `WgRegistry` keyed by `libp2p::PeerId` is owned by `LibP2pRuntime`.
Every native outbound dial passes through
`WgRegistry::wrap_dial(peer, local_priv, peer_pub, peer_endpoint)`,
which either reuses an existing tunnel's wrapped multiaddr or builds
a fresh `WgTunnel` for the peer.

The registry is rebuilt on each `LibP2pRuntime::start()` and torn
down on `stop()`. There is no cross-launch persistence.

## Connection lifecycle — Architecture E (hard-disconnect on close)

> The session stays alive **only while the user is actively
> interacting** with the running app. When the user closes the app,
> Concord **hard-disconnects** — no background process, no daemon, no
> warm-resume.

Source: RFC #140 §Architecture E (PR #140 open-question Q8, filed in
the inbox 2026-06-01).

### What happens on app close

1. Tauri fires `RunEvent::Exit` (and `RunEvent::ExitRequested`
   beforehand, where applicable). The handler in
   [`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs)'s `run`
   closure grabs the running `ServitudeHandle`'s `WgRegistry` and
   calls `force_disconnect_all()`.
2. `force_disconnect_all()` drains the registry's `HashMap<PeerId,
   Arc<WgTunnel>>` and, for each tunnel:
   - calls `WgTunnel::shutdown()` (synchronously aborts the
     forwarder task, releases the UDP socket),
   - drops the `Arc<WgTunnel>`.
3. The Tauri runtime returns from `run`, the tokio runtime
   shuts down, the binary exits. Nothing remains in kernel state
   because boringtun runs entirely in userspace.

### What is explicitly **not** allowed

- **No background daemon.** Concord does not launch a child process
  to keep tunnels warm.
- **No detached forwarder.** The forwarder task lives inside the
  WgTunnel and dies with it.
- **No warm-resume.** The next launch re-runs the boringtun
  handshake from scratch.

Cold-start cost on the next launch is one WireGuard handshake per
peer (≤2 UDP round trips). RFC #140 §Q8 explicitly accepts this
cost: "each device must have full control over its connectivity".

### User-driven "go offline now"

The Tauri command `wg_tunnel_force_disconnect_all` exposes the same
shutdown path to the React UI. It does NOT stop the libp2p swarm —
just the WG tunnels. Subsequent dials will lazily rebuild tunnels
through the registry, so the user can flip "go offline now" and then
re-engage by simply clicking on a peer again.

The Tauri command `wg_tunnel_status` returns the current set of
active tunnels as a `Vec<TunnelInfo>` so the Connections panel can
render rows for each one (target peer-id, established_at, bytes in/
out, loopback endpoint).

## Tests

See:

- `src-tauri/src/servitude/network/wg_tunnel.rs::tests` —
  unit tests covering tunnel start, drop releases socket, handshake
  round-trip through two `Tunn`s, registry idempotency, and
  bulk-drop releases all sockets.
- `src-tauri/tests/wg_tunnel_test.rs` —
  integration test exercising the WG-wrapped dial path end-to-end:
  two `LibP2pRuntime`s, one wraps a dial through the registry, the
  decrypted payload arrives at the receiver byte-for-byte.

## Related documents

- `docs/architecture/p2p-design.md` — broader libp2p layout
  (transports, NAT traversal, mDNS).
- `docs/architecture/porch-design.md` — porch-server lifecycle.
- `docs/architecture/hero-account-rfc.md` — RFC #140 (the source of
  the consolidated architecture + Architecture E).
