# Concord v2 Beta — Architecture Report

**Date:** 2026-04-05
**Codebase:** ~27,800 LOC (16,893 Rust + 10,921 TypeScript)
**Status:** PoC validated — LAN discovery + tunnel messaging proven across separate physical networks

---

## System Overview

Concord v2 is a native P2P mesh-networked communication platform. Every device is a node in a decentralized mesh providing text, voice, and video chat with no central server. Nodes discover each other locally via mDNS and connect globally through WireGuard tunnels.

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Device                             │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   Frontend   │◄──►│  Tauri IPC   │◄──►│   Rust Backend   │  │
│  │  React 19 +  │    │   Bridge     │    │                  │  │
│  │  Zustand     │    │              │    │  ┌────────────┐  │  │
│  │  Tailwind    │    │  13 command  │    │  │ concord-   │  │  │
│  │              │    │  modules     │    │  │ core       │  │  │
│  │  50+ comps   │    │  120+ RPCs   │    │  ├────────────┤  │  │
│  │  11 stores   │    │              │    │  │ concord-   │  │  │
│  └──────────────┘    └──────────────┘    │  │ net        │  │  │
│                                          │  ├────────────┤  │  │
│                                          │  │ concord-   │  │  │
│                                          │  │ store      │  │  │
│                                          │  ├────────────┤  │  │
│                                          │  │ concord-   │  │  │
│                                          │  │ media      │  │  │
│                                          │  └────────────┘  │  │
│                                          └──────────────────┘  │
│                                                 │              │
│  ┌──────────────────────────────────────────────┘              │
│  │ libp2p Swarm                                                │
│  │  mDNS · Kademlia · GossipSub · QUIC · Noise · Relay · DCUtR│
│  └─────────┬──────────────────────────────┬────────────────────┘
│            │                              │                     │
│       LAN (mDNS)                   WireGuard Tunnel             │
│    192.168.x.x:4001              100.x.x.x:4001                │
└────────────┼──────────────────────────────┼─────────────────────┘
             │                              │
        Same Network                   Different Network
        (auto-discovery)            (orrtellite mesh VPN)
```

---

## Crate Architecture

```
concord-core        ← Pure foundation: identity, types, crypto, wire format, trust, mesh map
    │
    ├─► concord-net       ← P2P engine: libp2p swarm, discovery, GossipSub, tunnels
    │       │
    │       └─► concord-media  ← Voice/video: audio capture, Opus codec, signaling
    │
    ├─► concord-store     ← Persistence: SQLite (24 tables, WAL mode)
    │
    ├─► concord-webhost   ← Browser guest access: Axum HTTP + WebSocket
    │
    ├─► concord-daemon    ← Headless server binary (servitude)
    │
    ├─► concord-poc       ← Proof-of-concept CLI (tunnel test binary)
    │
    └─► src-tauri         ← Desktop/mobile app shell (Tauri v2)
```

### External Dependencies

| Crate | Key Dependencies |
|-------|-----------------|
| **concord-core** | `ed25519-dalek`, `x25519-dalek`, `chacha20poly1305`, `rmp-serde`, `hmac`, `sha2` |
| **concord-net** | `libp2p 0.54` (mDNS, Kademlia, GossipSub, QUIC, Noise, Yamux, Relay, DCUtR, Identify) |
| **concord-store** | `rusqlite 0.32` (bundled SQLite) |
| **concord-media** | `str0m 0.7` (WebRTC), `cpal 0.17` (audio I/O), `audiopus 0.3` (Opus codec) |
| **concord-webhost** | `axum 0.8`, `rust-embed 8` |
| **src-tauri** | `tauri 2` |

---

## Identity Architecture

Every Concord node has a single Ed25519 keypair that serves as both its application identity and its network identity.

```
Ed25519 Secret Key (32 bytes)
    │
    ├─► Concord Peer ID: hex(public_key)           "729af2a2..."
    ├─► libp2p PeerId:   multihash(public_key)     "12D3KooWHXjg..."
    ├─► Signing:          Ed25519 signatures on messages, attestations
    └─► Stored:           ChaCha20-Poly1305 encrypted with device key
```

**Alias System:** Each identity can have multiple display personas. Aliases are broadcast via GossipSub (`concord/mesh/aliases`) and cached by peers. Messages carry the sender's `alias_id` and `alias_name`.

**Trust System:** Web-of-trust where peers vouch for each other via signed attestations. Five tiers: Unverified → Recognized → Established → Trusted → Backbone. Attestation weight scales with the attester's own trust level (0.5× to 3.0×). Trust score is a weighted positive/negative ratio clamped to [-1.0, 1.0].

---

## Networking Layer

### libp2p Swarm Composition

The `ConcordBehaviour` bundles seven libp2p protocols:

| Protocol | Purpose |
|----------|---------|
| **mDNS** | LAN peer discovery (multicast DNS) |
| **GossipSub** | Pub/sub messaging (1s heartbeat, signed messages, content-addressed dedup) |
| **Identify** | Peer metadata exchange (protocol: `/concord/0.1.0`) |
| **Kademlia** | Global DHT peer discovery (server mode) |
| **Relay Server** | Act as relay for NAT-blocked peers |
| **Relay Client** | Connect through relays when direct fails |
| **DCUtR** | Direct Connection Upgrade through Relay (hole punching) |

Transport: **QUIC/UDP only** with Noise encryption. Idle timeout: 600 seconds.

### Node Event Loop

The `Node` struct runs a `tokio::select!` loop multiplexing three sources:

1. **Swarm events** — mDNS discoveries, GossipSub messages, connection events, identify info
2. **Commands** — from `NodeHandle` (publish, subscribe, dial, shutdown)
3. **Mesh tick** — periodic maintenance every 60 seconds (mesh map digest broadcast)

`NodeHandle` is a `Send + Sync` handle that can be cloned across tasks. It provides the public API: `publish()`, `subscribe()`, `dial_peer()`, `peers()`, `get_tunnels()`, `shutdown()`, and 15+ specialized methods for voice signals, DMs, forums, friends, etc.

### WireGuard Tunnel Integration

`detect_wireguard_mesh()` runs `tailscale status --json` to discover orrtellite/Tailscale mesh peers. Returns IPs in the 100.64.0.0/10 CGNAT range. `peer_to_multiaddr(peer, port)` converts to `/ip4/{ip}/udp/4001/quic-v1` for libp2p dialing.

Connections are automatically classified by `TunnelTracker`:
- **LocalMdns** — discovered via mDNS
- **WireGuard** — remote address in 100.64.0.0/10
- **Direct** — standard QUIC, no relay
- **Relayed** — through a p2p-circuit relay

### Transport Hierarchy (Design)

Five tiers, auto-selected by capability:

| Tier | Technology | Bandwidth | Infrastructure | Status |
|------|-----------|-----------|----------------|--------|
| BLE | Bluetooth LE | ~200 kbps | None | Trait defined, not implemented |
| WiFi Direct | WiFi P2P | ~250 Mbps | None | Trait defined, not implemented |
| WiFi AP | Device hotspot | ~100 Mbps | None | Trait defined, not implemented |
| **LAN** | **mDNS over IP** | **Full** | **Router** | **Working** |
| **Tunnel** | **QUIC over internet** | **Full** | **Internet** | **Working** |

---

## Three Communication Pathways

### 1. Forums (Mesh-scoped, Public)

Messages propagate through the mesh within a configurable hop radius.

- **Local forum**: GossipSub topic `concord/forum/local`. Messages have `hop_count` and `max_hops` (default 3). On receipt, the node increments `hop_count` and re-publishes if under the limit — a manual TTL-controlled flood.
- **Global forum**: GossipSub topic `concord/forum/global`. Unlimited propagation via native GossipSub gossip.
- **Encryption**: Forum key derived from well-known seed via HMAC-SHA256. Any Concord node can decrypt (intentional — "encrypted radio").

### 2. Servers / Places (Org-scoped)

Named organizations with channels, members, and access control.

- **Topics**: `concord/{server_id}/{channel_id}` for text, `+/voice-signal` for voice
- **Server key**: Random 32-byte secret, shared with members via X25519 key exchange
- **Channel key**: `HMAC-SHA256(server_secret, "concord-channel-key:" + channel_id)` — derived, not stored
- **Message encryption**: ChaCha20-Poly1305 with random 12-byte nonce per message
- **Key distribution**: New members send `KeyRequest` with X25519 public key, existing member responds with encrypted server key via `KeyResponse`

### 3. Direct Node-to-Node (Walkie-Talkie)

End-to-end encrypted 1:1 or group conversations.

- **Topic**: `concord/dm/{sorted_peer_pair}`
- **Key exchange**: X25519 Diffie-Hellman, initiated via `DmSignal::KeyExchange`
- **Encryption**: ChaCha20-Poly1305, nonce derived from monotonic counter
- **Storage**: Session state and encrypted messages persisted locally

---

## Encryption Layers

Six independent encryption contexts provide defense-in-depth:

| Layer | Scope | Algorithm | Key Management |
|-------|-------|-----------|----------------|
| **libp2p Transport** | Every connection | QUIC + Noise | Ephemeral per-connection |
| **WireGuard** | Tunnel connections | WireGuard (OS level) | Tailscale/Headscale managed |
| **Channel Messages** | Server channels | ChaCha20-Poly1305 | HMAC-derived from server secret |
| **Forum Messages** | Forum scope | ChaCha20-Poly1305 | Well-known seed (intentional) |
| **Direct Messages** | 1:1 conversations | X25519 + ChaCha20-Poly1305 | DH key exchange, monotonic nonce |
| **Identity Storage** | At rest | ChaCha20-Poly1305 | Device key file |

---

## Mesh Map — Distributed Database

The mesh map is the decentralized database for the entire network. Every entity (node, place, call, locale) has a deterministic 32-byte address via `HMAC-SHA256("concord-mesh-address-v1", identifier)`.

### Entry Types

| Kind | Payload | Purpose |
|------|---------|---------|
| **Node** | display_name, capabilities, engagement_score, trust_rating, location (~5mi), portal_url | Node presence and reputation |
| **Place** | name, owner, governance model, visibility, member_count, hosting_nodes, channels | Server/organization definition |
| **CallLedger** | participants, call_type, hosting_node, status, expires_at | Active call tracking |
| **Locale** | hierarchical partition | Mesh topology structure |

### Confidence Tiers

All map data has a confidence level that degrades without re-verification:

| Tier | Weight | Source |
|------|--------|--------|
| SelfVerified | 1.0 | Data about yourself |
| TunnelVerified | 0.75 | Exchanged over trusted tunnel |
| ClusterVerified | 0.5 | Verified by cluster consensus |
| Speculative | 0.25 | Received from untrusted source |

### Sync Protocol

Three-phase gossip over `concord/mesh/map-sync`:

1. **Digest** — broadcast periodically (60s) with locale summaries and latest timestamp
2. **DeltaRequest** — sent when remote has newer data, specifying locales and `since` timestamp
3. **Delta** — response with matching entries + tombstones (max 50 per batch)

Friends get a 15s sync cooldown (vs 60s for others) and automatic confidence upgrades.

---

## Storage Schema

SQLite with WAL mode and foreign keys. 24 tables across 3 schema migrations.

**Core data:** `identity`, `aliases`, `known_aliases`, `settings`, `blocked_peers`
**Messaging:** `messages`, `channels`, `servers`, `members`, `invites`, `server_keys`
**Direct:** `dm_sessions`, `direct_messages`, `conversations`
**Social:** `friends`, `forum_posts`, `attestations`, `peers`
**Mesh map:** `mesh_map_entries`, `mesh_map_tombstones`, `mesh_routes`, `peer_verification`, `compute_allocations`, `local_compute_priorities`, `engagement_counters`
**Infra:** `schema_version`, `totp_secrets`, `webhooks`

---

## Frontend Architecture

React 19 + TypeScript + Tailwind CSS + Zustand, following the "Kinetic Node" design system.

### IPC Bridge

`frontend/src/api/tauri.ts` detects the runtime environment:
- **In Tauri**: calls `@tauri-apps/api/core.invoke()` for commands, `.listen()` for events
- **In browser**: returns mock data from a static dictionary — enables standalone UI development

### State Management (11 Zustand Stores)

| Store | Purpose |
|-------|---------|
| `auth` | Identity, active alias, authentication state |
| `servers` | Server list, channels, messages, active selections |
| `mesh` | Peer list, tunnels, connected peer count |
| `voice` | Voice session state, participants, mute/deafen |
| `dm` | DM sessions and messages |
| `forum` | Local and global forum posts |
| `friends` | Friend list, presence, pending requests |
| `conversations` | Group conversation threads |
| `settings` | User preferences |
| `webhost` | Browser guest session state |
| `toast` | Notification queue |

### Component Structure (50+ components)

Layout, auth, dashboard, chat, server, voice, mesh map, profile, forum, friends, direct messages, DMs, settings, health diagnostics, and shared UI primitives (glassmorphism panels, trust badges, node chips, skeleton loaders).

---

## Voice Pipeline

Audio flows through GossipSub rather than a dedicated media plane:

```
Microphone → cpal capture → Opus encode (48kHz mono, 20ms frames)
    → GossipSub publish to voice-signal topic
    → Remote node receives → Opus decode → cpal playback
```

Rate-limited at 100 frames/second per peer. Voice state (join/leave/mute/deafen) is exchanged via `VoiceSignal` messages on `concord/{server_id}/{channel_id}/voice-signal`.

**Gap:** SDP signaling uses placeholder strings — no real str0m WebRTC sessions. Audio over GossipSub works but is not bandwidth-efficient for >2 participants. SFU (selective forwarding unit) is a comment-only stub.

---

## Proof of Concept Results

### Test: LAN Discovery (orrion ↔ orrgate)
- mDNS auto-discovery in <1 second
- QUIC connection on `192.168.1.x`
- GossipSub message delivered
- Connection classified as `local_mdns`

### Test: Tunnel Communication (orrion ↔ cb17 on cellular)
- cb17 disconnected from WiFi, connected via cellular hotspot
- LAN unreachable (192.168.1.166 — 100% packet loss)
- Tunnel reachable (100.116.151.17 — ~80ms via cellular)
- QUIC connection on WireGuard mesh IPs
- GossipSub message delivered through tunnel
- Connection classified as `wireguard`

---

## What's Working vs. Stubbed

### Fully Functional
- Identity lifecycle (generation, encryption, persistence, libp2p unification)
- Alias system (create, switch, broadcast, cache)
- LAN mesh networking (mDNS discovery, QUIC connections)
- Tunnel networking (WireGuard detection, dial, message delivery)
- GossipSub messaging (subscribe, publish, receive, decrypt)
- Channel encryption (server keys, X25519 key exchange, ChaCha20)
- Server management (create, join, leave, channels, members, invites)
- Direct messages (X25519 DH, E2E encryption, history)
- Forums (local hop-limited + global, encrypted)
- Friends (request/accept, presence heartbeat, encrypted signals)
- Trust system (attestation signing/verification, weighted scoring)
- Voice audio (cpal capture → Opus → GossipSub → Opus → cpal playback)
- SQLite persistence (24 tables, migrations, WAL mode)
- Frontend (50+ components, 11 stores, Tauri IPC + browser mocks)
- Headless daemon (CLI, TOML config, admin API)
- Multi-platform scaffolds (iOS, Android, macOS, Linux, Windows)

### Partially Implemented
- Mesh map sync (protocol works in-memory, not connected to persistent storage)
- Voice signaling (state machine works, SDP is placeholder strings)
- Compute allocation (message types exist, no actual compute performed)

### Not Implemented
- Video capture/encoding/streaming
- SFU (selective forwarding for 5+ participants)
- BLE / WiFi Direct / WiFi AP transports
- Mesh map persistence (sync ↔ SQLite wiring)
- File sharing
- Content moderation
- Notifications
- Perfect forward secrecy (DMs use static shared secrets)

---

## Platform Targets

| Platform | Shell | Transport | Build Status |
|----------|-------|-----------|-------------|
| Linux | Tauri v2 | LAN + Tunnel | Compiles, runs |
| macOS | Tauri v2 | LAN + Tunnel | Scaffold ready |
| Windows | Tauri v2 | LAN + Tunnel | Scaffold ready |
| iOS | Tauri v2 | LAN + Tunnel | Xcode project generated |
| Android | Tauri v2 | LAN + Tunnel | Gradle project generated |
| Headless | concord-daemon | LAN + Tunnel | Compiles, runs |

---

## Test Infrastructure

- **275 Rust tests** across all crates (crypto, identity, trust, storage, networking, media, daemon, webhost)
- **Vitest configured** for frontend (minimal test count)
- **Integration example**: `crates/concord-net/examples/two_peers.rs` — in-process mDNS + GossipSub test
- **PoC binary**: `crates/concord-poc/` — cross-machine LAN + tunnel test (validated 2026-04-05)
