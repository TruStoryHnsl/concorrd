# Concord v2 -- Development Guide

## Overview
Concord v2 is a native P2P mesh-networked communication platform. Every device is a node in a mesh network providing text, voice, and video chat. It replaces v1 entirely (v1 was a Docker-based Matrix/Element wrapper).

The codebase name is "Concord". The author's personal instance is titled "Concorrd".

## Tech Stack
- **App Shell:** Tauri v2 (Rust backend + web frontend)
- **P2P Networking:** libp2p (Rust) -- mDNS, Kademlia DHT, GossipSub, QUIC, Noise
- **Voice/Video:** str0m (sans-IO WebRTC) + cpal (audio I/O) + audiopus (Opus codec)
- **Frontend:** React 19 + TypeScript + Tailwind CSS + Zustand
- **Storage:** SQLite via rusqlite (WAL mode, foreign keys)
- **Wire Protocol:** MessagePack (rmp-serde)
- **Crypto:** Ed25519 (identity), X25519 + ChaCha20-Poly1305 (E2E encryption)

## Project Structure
```
crates/
  concord-core/     Pure library: identity, types, serialization, trust, crypto, TOTP
  concord-net/      P2P networking engine (async/tokio, libp2p swarm, mesh, tunnels, sync)
  concord-media/    Voice/video: audio capture/playback, Opus codec, engine, signaling, SFU (stub), video (stub)
  concord-store/    Local persistence (SQLite): messages, servers, peers, DMs, aliases, forums, friends, webhooks, settings, trust, TOTP, invites, conversations, server keys
  concord-webhost/  Embedded HTTP server for browser guests: auth, websockets, webhooks, static assets
  concord-daemon/   Headless server binary (concord-server): CLI with start/init/status, TOML config, admin API
src-tauri/          Tauri v2 app shell, IPC commands (13 command modules), event bridge
frontend/           React + TypeScript + Tailwind UI
scripts/            Build and dev scripts
design/             Kinetic Node design system docs and mockups
```

## Three-Pathway Architecture
Concord has three distinct communication modes:

### 1. Forums (mesh-based, public)
- **Local forum**: Messages propagate within N mesh hops (default 3, configurable)
- **Global forum**: Messages propagate through all tunnels and local connections
- Anyone with Concord can access the global mesh and post
- Implemented in `concord-core/src/types.rs` (ForumPost, ForumScope) and `concord-store/src/forum_store.rs`

### 2. Servers (organizations of nodes)
- A server exists on the shared ledger, not on any single node
- Creator is admin. Access list + ban list on the ledger.
- Any connected node can serve as processing backbone
- Public servers: open join. Private servers: visible on mesh map but invite-only
- Headless `concord-server` nodes join as members to support infrastructure
- Implemented across `concord-store/src/servers.rs`, `concord-store/src/invites.rs`, `concord-net/src/channels.rs`

### 3. Direct Node-to-Node (walkie-talkie)
- Text/voice/video between two known nodes
- Works over internet (always reachable) or local WiFi mesh (~100-200ft range)
- One-on-one conversations expandable to group
- Implemented in `concord-store/src/dm_store.rs`, `concord-store/src/conversation_store.rs`

## Alias System
Each identity (Ed25519 keypair) can have multiple aliases (personas). An alias has:
- `id`, `root_identity`, `display_name`, `avatar_seed`, `created_at`, `is_active`
- Messages carry `alias_id` and `alias_name` for display
- Alias announcements broadcast via GossipSub so peers know display names
- A default alias is auto-created on identity generation
- Stored in `concord-store/src/alias_store.rs`, types in `concord-core/src/types.rs`

## Trust System
Web-of-trust model where peers vouch for each other:
- **Trust levels**: Unverified < Recognized < Established < Trusted < Backbone
- Levels based on attestation count + identity age (e.g., Backbone = 20+ attestations, 365+ days)
- Attestations can be positive (vouch) or negative (flag)
- Attestation weight scales with the attester's own trust level (0.5x to 3.0x)
- Trust bleeds through the graph (transitive trust with decay)
- Implemented in `concord-core/src/trust.rs`, stored in `concord-store/src/trust_store.rs`

## Working Features
- **Identity**: Ed25519 keypair generation, persistence, peer ID derivation
- **Alias system**: Multiple personas per identity, announcements, switching
- **P2P networking**: libp2p swarm with mDNS discovery, Kademlia DHT, GossipSub pub/sub, QUIC transport, Noise encryption
- **Text messaging**: Send/receive in server channels via GossipSub, stored in SQLite, message signing
- **E2E encryption**: X25519 key exchange + ChaCha20-Poly1305 for channel messages and DMs
- **Server management**: Create, join (invite codes), leave, channel CRUD, member lists, ban lists
- **Server key distribution**: Encrypted key exchange for joining members
- **Voice signaling**: Join/leave voice channels, SDP offer/answer exchange, mute/deafen state sync
- **Audio pipeline**: cpal microphone capture, Opus encoding (48kHz mono, 20ms frames), cpal speaker playback, Opus decoding, audio frames transmitted via GossipSub
- **Direct messages**: X25519 key exchange, encrypted DM sessions, conversation management
- **Forums**: Local (hop-limited) and global forum posts, gossip propagation
- **Friends**: Friend requests, acceptance, presence heartbeats, ledger sync
- **Trust system**: Attestation creation/verification, trust level computation, weighted graph
- **Message history sync**: Vector clock-based sync protocol for reconnecting peers
- **TOTP 2FA**: Time-based one-time passwords for server administration
- **Webhost**: Embedded HTTP server for browser guests with WebSocket bridge, TOTP auth, webhooks with rate limiting
- **Headless daemon**: CLI server binary with TOML config, admin API
- **Frontend**: React 19 UI with dashboard, forum, servers, direct messages, friends, mesh node map, voice controls, settings, profile, health monitor, host session, guest auth
- **Mock layer**: Frontend works standalone in browser with mock data for design iteration
- **Multi-instance**: Separate data directories via CONCORD_DATA_DIR env var

## Known Stubs / Gaps
- **Video module** (`concord-media/src/video.rs`): Comment-only stub, no implementation
- **SFU module** (`concord-media/src/sfu.rs`): Comment-only stub, no selective forwarding
- **WebRTC via str0m**: SDP signaling is placeholder strings, not real str0m Rtc sessions
- **Transport tiers** (BLE, WiFi Direct, WiFi AP): Architecture defined in `concord-net/src/transport.rs` but platform-native implementations not started
- **Tauri voice commands**: `src-tauri/src/commands/voice.rs` returns mock data, not wired to VoiceEngineHandle
- **Mobile builds**: Build scripts exist but untested
- **Mesh map**: Distributed ledger replication architecture designed but not implemented
- **Moderation**: No content moderation system for public forums
- **File sharing**: Not implemented
- **Notifications**: Not implemented
- **Offline message queue**: Not implemented (sync covers reconnection but not offline delivery)

## Development Commands
```bash
# Install frontend dependencies
cd frontend && npm install

# Run in development mode (frontend + Rust hot reload)
cargo tauri dev

# Run a second instance for testing P2P locally
./scripts/dev-second-instance.sh

# Build for current platform
cargo tauri build

# Build headless server only
cargo build -p concord-daemon --release

# Run all Rust tests (190 tests)
cargo test --workspace

# Check Rust compilation without building
cargo check --workspace

# Check frontend TypeScript
cd frontend && npx tsc --noEmit

# Run frontend lint
cd frontend && npm run lint

# Start frontend only (design iteration without Tauri)
cd frontend && npm run dev
```

## Multi-Instance Testing Workflow
To test P2P features locally, run two instances with separate data:
1. Start the first instance: `cargo tauri dev`
2. In another terminal: `./scripts/dev-second-instance.sh`
3. Both instances share the same Vite dev server (port 1420) but have separate identities and databases
4. They discover each other via mDNS and appear in each other's peer lists

Custom data directory: `CONCORD_DATA_DIR=/path/to/data cargo tauri dev`

## Design System
The UI follows the "Kinetic Node" design system. See `design/KINETIC_NODE_DESIGN.md`.

Key rules:
- **No borders** -- use surface color shifts to define sections
- **Glassmorphism** for overlays: rgba(35,38,42,0.6) + 20px backdrop blur
- **Gradient CTAs**: linear-gradient from primary (#a4a5ff) to primary-container (#9496ff)
- **Fonts**: Space Grotesk for headlines, Manrope for body/labels
- **Icons**: Material Symbols Outlined

## Architecture Notes
- Every node is a libp2p peer with an Ed25519 identity
- **The local mesh is infrastructure-free** -- no WiFi router, no internet required
- GossipSub topics map 1:1 to chat channels (pattern: `concord/{server_id}/{channel_id}`)
- Voice signals use `concord/{server_id}/{channel_id}/voice-signal` topics
- Messages are signed and stored locally in SQLite
- The host node acts as SFU for voice/video with 5+ participants (not yet implemented)
- Non-local connections go through QUIC "tunnels" (the ONLY internet-dependent path)
- Wire format is MessagePack for efficiency over the mesh

## Transport Layer
The mesh is designed to operate over radio, not just IP networks. `concord-net/src/transport.rs` defines the abstraction.

**Transport tiers (auto-selected, best available):**
| Tier | Technology | Bandwidth | Needs Infrastructure? | Capabilities |
|------|-----------|-----------|----------------------|-------------|
| BLE | Bluetooth Low Energy | ~200 kbps | No | Discovery + text only |
| WiFi Direct | WiFi P2P | ~250 Mbps | No | Text, voice, video |
| WiFi AP | Device broadcasts hotspot | ~100 Mbps | No | Mesh extension |
| LAN | mDNS over IP | full | Yes (router) | When devices share a network |
| Tunnel | QUIC over internet | full | Yes (internet) | Non-local connections |

**Platform-native implementations (planned Tauri v2 plugins):**
- iOS: MultipeerConnectivity (BLE + WiFi seamlessly)
- Android: Nearby Connections API (BLE + WiFi Direct + WiFi Aware)
- Linux: BlueZ (D-Bus) for BLE, wpa_supplicant for WiFi Direct
- macOS: CoreBluetooth + MultipeerConnectivity
- Windows: Windows.Devices.Bluetooth + WiFi Direct APIs

**Graceful degradation:** BLE-only = text mode. WiFi Direct = full voice/video. The app automatically upgrades connections (BLE discovery -> WiFi Direct data channel).

## Key File Locations
- **Tauri IPC commands**: `src-tauri/src/commands/` (13 modules: auth, conversations, dm, forums, friends, mesh, messaging, servers, settings, trust, voice, webhost, webhooks)
- **Network events**: `crates/concord-net/src/events.rs` -- all event types emitted by the node
- **Frontend API bridge**: `frontend/src/api/tauri.ts` -- all IPC calls with browser mock fallbacks
- **Frontend stores**: `frontend/src/stores/` -- Zustand stores (auth, voice, mesh, servers, dm, forum, friends, conversations, settings, toast, webhost)
- **Database schema**: `crates/concord-store/src/db.rs` -- all CREATE TABLE statements
