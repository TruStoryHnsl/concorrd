# Concord — Master Development Plan

Decentralized communication platform. The stable Matrix-based build lives at the repo root (currently `v0.1.0`, tagged, deployed on orrgate). The native Rust/Tauri + libp2p mesh rewrite lives in `beta/` as an experimental parallel track. Both share this roadmap while they converge.

## Open Conflicts

### From 2026-04-11 Feedback — All Resolved
1. ~~Phantom nodes~~ → **RESOLVED**: Phantom nodes are read-only scouts. They CANNOT cluster (no compute contribution). Disposable anonymous nodes CAN cluster and contribute compute. Phantom = observe only, anonymous = participate without identity.
2. ~~Charter immutability~~ → **RESOLVED**: Both mechanisms — (a) reject updates not signed by current owner AND (b) monotonic version counter. Belt and suspenders.
3. ~~Forum map-view rendering~~ → **RESOLVED**: WebGL / OpenGL. Enables 3D capabilities for future mesh map explorer and Game Center viewport. Game Center should also use a 3D-capable renderer.
4. ~~iOS deployment~~ → **RESOLVED**: AltStore/Sideloadly (free, re-sign every 7 days). No Apple Developer account needed for testing.

### From 2026-04-12 Feedback — Unresolved
1. **Tunnel architecture choice**: Two approaches proposed — (a) charter-minted tunnels integrated directly into mesh-map, or (b) sidekick container nodes per user that host VPN instances. Need to choose one or hybrid both.
2. **Cut-off sentence — game dev workflow**: User wrote "after we have designed the game dev workflow" and the sentence was cut off. Need clarification on what follows.
3. **Cut-off sentence — AI image gen**: Game engine elements list cut off after "AI nodes can also be used to connect to image gen." Need clarification on image gen capabilities.
4. **Visual code editor selection**: User wants an existing visual coding system that supports multi-language, text↔visual dual representation. Research needed.
5. **Geological addressing**: User suggests mesh addresses "could need to be tied to the geological location of the node." Hedged — requirement or exploration?
6. **Orrtellite subgroups justification**: User wants explanation of why personal network subgroups are worthwhile before proceeding with ACL design.
7. **Orrtellite function boundary audit**: User suspects recent changes brought orrtellite functions into concord improperly. Needs review.

### Remaining Design Work
*Mesh map mathematical framework, call ledger lifecycle, engagement profile all implemented 2026-03-27. New design work from 2026-04-11 feedback below.*

1. ~~**Mesh map mathematical framework**~~ — IMPLEMENTED. HMAC-SHA256 deterministic addressing, 4-tier confidence system, LWW merge protocol, Dijkstra path-of-least-action routing, 3-level locale partitioning (region/cluster/subnet).
2. ~~**Call ledger lifecycle**~~ — IMPLEMENTED. UUID-addressed entries: Active → Concluded → Tombstoned (5min grace). No mesh archival, local-only call history.
3. ~~**Engagement profile**~~ — IMPLEMENTED. Raw counters → posting ratio → tanh-compressed [-10,+10] score. Privacy: only score published, raw counters local-only.

## Resolved Decisions (2026-03-27)

| Topic | Decision |
|-------|----------|
| **Web portal domain** | `*.concorrd.com` (PLACEHOLDER — must be reassessed before distribution) |
| **Probe technology** | NOT containerized sandboxes. Probes are simple ping operations for node verification. See Node Verification Protocol below. |
| **"Confirmed human"** | One reputational tag among many in a merit-badge reputation system. See Reputation System below. |
| **Ledger compaction** | Zero-loss compression. Never delete server history. Media content excluded from ledger body, but filenames and transfer records are preserved. |
| **Forum hop scope** | Configurable, default 2 hops. |
| **Mobile quick actions** | Reconnect to last channel, host exchange, open profile customization, node settings. |
| **Launch games** | Chess, Checkers, Mafia, Poker (all kinds), Trivia (all kinds), Pictionary, Telestrations, Scrabble (8+). |
| **LLM models** | Flexible — any API (Claude, Gemini) or local Ollama. Game dev pipeline determines how to power LLM elements per-game. |
| **Game engine paradigm** | Flow-based visual code editor capable of making anything. Purpose-built nodes for point-and-click and text-controlled game dev. |
| **Service nodes** | Not a separate "mode" — same node representing a place instead of a user. Provides persistent infrastructure. Dynamic workload adjustment. Admin-approved via ledger appendix. Web admin UI. Managed by **servitude** app. |
| **Service node auth** | Same as any node. Admin mints appendix to whitelist service node. Service node is as trustworthy as the place. |
| **Additional performance** | User nodes can act as "support server" for another connection — separate from headless server app. |

## UX Language (defined 2026-04-11)

Canonical terminology for Concord. All UI, docs, and code should use these terms consistently.

| Term | Definition |
|------|-----------|
| **Forum** | The public space around a node on the mesh map. Has a **map view** (speech bubbles from chatting nodes) and a **chatroom view** (messages within forum scope). Forum size = configurable connection layers deep. Users can customize their forum layout; others see it when viewing that section of the map. Essentially a customizably-cropped subsection of the mesh map. |
| **Place** | A cluster charter minted at a fixed mesh-map location. Nodes gather here to form clusters. Foundation of the communication UX. |
| **Charter** | An immutable record encoded into the mesh map with all config for cluster formation. Only way to transfer ownership is to mint a fresh charter with the old charter's data compressed in. Maps to `PlacePayload` but must enforce immutability. |
| **Ledger** | Section of a charter containing complete interaction history. Feeds the reputation system. Can be disabled by admin. |
| **Cluster** | 2+ nodes as hot-swappable compute modules working together per a charter's rules. |
| **Tunnel** | VPN bridge making two nodes work as if on LAN. Implemented via WireGuard (orrtellite). |
| **Service Node** | Persistent node minted to a particular place. Low overhead, pulls more than its weight. (Formerly "server" — renamed to avoid Discord UX comparison. The word "server" confuses the value proposal by drawing a direct comparison to Discord.) |
| **Servitude** | The native application that manages service nodes. Headless daemon for persistent infrastructure. |
| **Node** | Independent Concord instance that can cluster with others to form chat rooms. |

**Naming Convention**: All naming decisions inside Concord must align with the theme **"single word descriptions of various social contracts"** (e.g., charter, servitude, cluster, trust, forum, place).

## Communication Flow (from 2026-04-12 feedback)

**Strict separation between comms and tunnels:**
- **P2P handshakes** (mesh-clustered) manage ALL actual communications (text, voice, video, file exchange)
- **NET tunnels** (WireGuard/orrtellite) ONLY serve to place machines close enough together virtually that the P2P protocol can operate at long distances
- **Local mesh connections and NET tunnels work side by side** — they are complementary, NOT replacements for each other. Losing the internet just reduces range.
- This dual-protocol approach is what makes Concord "the most reliable chat platform" — it operates on multiple protocols at once.

**Tunnel architecture** (two proposed approaches — Open Question):
1. **Charter-minted tunnels**: Tunnels integrated with mesh-map as minted charters near the node's home address. Charter dictates exclusivity, destination visibility, hashed secrets, credentials. Any node with access can continue downstream (chain routing). Default: public, unrestricted, anonymized.
2. **Sidekick nodes**: Small per-user nodes hosting VPN tunnel instances per charter spec. Requests routed via chains of containerized VPN connections. Concurrent sidekick count = live traffic density indicator.

**Orrtellite integration**: Orrtellite package used as a dependency (or copied/repurposed) to power NET tunnels. End users do NOT run an external tunneling service — orrtellite protocols are baked into Concord. The user's personal orrtellite instances are separate and do NOT assist Concord.

**Design philosophy**: Charter/node/cluster architecture is a hybrid of crypto ledgers, Kubernetes compute clusters, and decentralized mesh networks → zero-trust decentralized public digital communications protocol. Given enough adoption, this provides a worldwide decentralized communications framework.

## v3 Scope Boundary (from 2026-04-12 feedback)

**Commerce features are explicitly deferred to v3.** No advertising, marketplaces, or economy-stimulating features in v2. The current featureset UX must be perfect first. Concord must be a **tool first**. If social-media-like features emerge from public decentralized communication, that is a feature, not a bug — but do not design for it.

## Pragmatic Architecture (from 2026-04-11 feedback)

- **Internet-first, mesh-second**: Build working internet-based versions of features first. Optimize for mesh-only later. Get a working Concord up soon.
- **Mesh map is social backbone**: Even before mesh-only works, the map powers reputation, social networking, and addressing. It remains the sole source of truth.
- **Mesh map won't be useful until critical mass**: Expect the map to be sparse initially. Design for graceful degradation.
- **Locale-based addressing**: Use user locale as a coded jumping-off point for address generation. Enables node grouping and global positioning. (Aligns with our region/cluster/subnet locale partitioning.)
- **Phantom node exploration**: Experiment with nodes sending phantom scouts to different mesh coordinates for exploration and clustering. Open research question.

## Testing Protocol (7 Passing Conditions)

**"Full connection"** = stable, performant, and feature-complete with **file exchange, text chat, voice chat, and video chat**.

All must pass on real physical devices (iPhone, iPad, desktop) before distribution:

1. **WiFi Direct comms**: Full connection between two devices with NO internet — WiFi radios only.
2. **Web portal for guests**: One node hosts a phantom node with a web portal so an unregistered user can have a full connection without joining the ecosystem.
3. **2-node cluster > 1 node**: Two nodes hosting a full connection outperform a single node.
4. **3-node cluster > 1 node**: Three nodes hosting a full connection outperform one.
5. **More nodes = better**: Each additional cluster node improves speed, bandwidth, and stability of full connections.
6. **Server nodes absorb load**: Server nodes take maximum computational load off the cluster during full connections.
7. **Universal addressing**: A node can find and ping any other known node even when currently isolated from each other on the mesh.

## Architecture

### Stable — repo root (`v0.1.0`, Matrix-based, running on orrgate)
- Tuwunel (Matrix homeserver), concord-api (FastAPI), React client, LiveKit SFU, Caddy
- Tauri v2 desktop shell wraps the web client (`src-tauri/` at root)
- Federation: allowlist-only between Concord instances (shipped 2026-04 — `server/routers/admin.py`, `client/src/hooks/useFederation.ts`, `FederationBadge.tsx`)
- Deploy: `orrgate:/docker/stacks/concord/`
- Renamed from "v1" during the 2026-03-31 SemVer restructure

### Experimental — `beta/` (native Rust/Tauri + libp2p mesh)
- Tauri v2 + Rust, libp2p swarm (mDNS, Kademlia, GossipSub, QUIC, Noise, Relay, DCUtR)
- Three-pathway comms: forums (mesh-scoped), servers/places (org-scoped), direct (walkie-talkie)
- Voice currently over GossipSub raw frames; str0m WebRTC signaling placeholder
- See `beta/CLAUDE.md` and `beta/ARCHITECTURE.md` for the full technical architecture
- Renamed from "v2" during the 2026-03-31 SemVer restructure

### Mesh Network Architecture (from user feedback 2026-03-26, refined 2026-03-27)
- **Nodes**: Every concord instance. Same binary. Nodes represent either a user or a place.
- **Places**: Named servers = cluster_ledgers with dedicated mesh addresses. Mintable, transferable, governable.
- **Cluster mode**: Nodes interlock compute via cluster_ledger. Kubernetes-like resource sharing. Fluid hypervisor role.
- **Mesh map**: The decentralized database for the entire network. All reputation, routing, node existence, and state data lives here. Maintained by nodes comparing notes.
- **Connection types**: Tunnels (virtual LAN via orrtellite), LAN discovery, local P2P (WiFi/BLE). All form the map.
- **Addressing**: Group theory heuristics partition mesh into hierarchical locales with filepath-style addresses. Deterministic — once a node knows a location, it can reach it independently.
- **Tunnels**: Implemented via virtual LAN networks using WireGuard (from orrtellite project — actually production-ready, not half-complete). Orrtellite uses Headscale for coordination, but Concord needs decentralized coordination via its own mesh. WireGuard tunnel layer is directly reusable; Headscale coordination must be replaced with mesh-based peer discovery.

### Node Verification Protocol
Two trust tiers for map data exchange:
1. **Tunnel-based (high-permission)**: When nodes build a tunnel, they are presumed trusted. Initiates full map data exchange. Both nodes independently verify all new map data from the other.
2. **Non-tunnel (low-permission)**: P2P connections and cluster membership. Nodes commit only shallow speculative data to their map.

**Server nodes as verification workhorses**: Headless server nodes are tasked with verifying all speculative data shared non-permissively. When nodes cluster at a server's place_ledger, the server commits speculative map data from all nodes and begins verifying. Since anyone tunneled to the place exchanges trusted data with the server, the server automatically becomes a trusted map data collection point. Dedicated servers have spare resources to constantly upgrade speculative data to confirmed.

**Stale/removed node detection**: Map protocol must recognize when nodes no longer exist. "Might be done" nodes are tracked as speculative and verified like any other speculative data.

### Mesh Map Navigation (perspective-based — revised 2026-04-11)
The map is **always centered on one node**. That node's perspective is what the map displays.

1. **Home perspective**: Default view. Floating bubbles representing nearby nodes around you. This is what every user sees when they log in.
2. **Perspective shift**: Click any *known* node to center the map on it. This simulates physically moving your node to that position and scanning from there. Only works for nodes you know about.
3. **Tunnel drilling**: Each perspective shift through a tunnel goes one layer deeper. Home → friend's view → their tunnels → deeper. Creates a layered exploration model.
4. **Forum as map crop**: A forum IS a customizably-cropped subsection of the mesh map. Users customize their forum layout; others see it when viewing that section. Forum has two modes:
   - **Map view**: Visual — speech bubbles coming from chatting nodes
   - **Chatroom view**: Text — all messages within forum scope
5. **Friend data sharing**: Friends share real-time mesh data via shared private_places as exchange hubs.

### Reputation System
Merit-badge based. Stored directly in the mesh map. Three displayed metrics:
1. **real-user-confidence-score** — Backend node analysis protocols looking for signs of automation.
2. **engagement_profile** — Ratio of posting vs reading. Scale -10 to 10 derived from comparing global median engagement (calculated locally per node) to the individual node. Experimental — gathering data, may adjust.
3. **Overall trust rating** — Aggregated from: 2FA status, admin status, account age, confirmed-human tag, etc.

Only displays confirmable and current information. The system is foundational but needs trial and error to optimize.

### Anonymous Browsing
No direct anonymous mode. Instead: **private browsing via disposable user node**. A temporary node is created to interact with the mesh without exposing the personal node. Anonymous nodes MUST contribute compute to mesh maintenance — no free-riders. Place admins can ban anonymous users, limit their count, or restrict them from chat.

### Node Types
| Type | Represents | UI | Compute | Notes |
|------|-----------|-----|---------|-------|
| **User node (desktop)** | A person | Full Tauri UI | Balanced | Primary client |
| **User node (mobile)** | A person | Mobile-optimized | Battery-safe | Phone/tablet |
| **Service node (headless)** | A place | Web admin UI | Maximum, dynamic | Persistent infra for places. Admin-approved via ledger appendix. Managed by **servitude** app. |
| **Support server** | A connection | None | Variable | User node acting as support for another connection. Separate from headless server. |
| **Disposable node** | Anonymous user | Same as user | Must contribute | Private browsing mode. Temporary. Can cluster. |
| **Phantom node** | Scout | None | None (read-only) | Map exploration only. Cannot cluster. Observe-only. |

### Place Governance
- **Private places**: Authoritarian admin hierarchy. Owner has absolute control.
- **Public places**: Responsibility-based hierarchy. Communal voting can override admin.
- **Voting requirements**: 1+ month account age, confirmed human, 2FA configured.
- **Ownership**: Can be encrypted (permanent, only transferable via re-mint) or unencrypted (flexible, committee-changeable).
- **Re-minting**: Zero-loss compression of current ledger → encrypted header → new ledger. Media filenames and transfer records preserved, not media content. Rollback possible if new owner goes stale.
- **Server authorization**: Default behavior whitelists admin's friends list. Server added via admin minting a ledger appendix.

## Feature Roadmap

### PRIORITY: Mobile Testing (from 2026-04-11 feedback)
- [x] **iOS build pipeline** — Tauri v2 compiles for aarch64-apple-ios + aarch64-apple-ios-sim. Audio gated behind `native-audio` feature. Simulator .app bundle builds successfully.
- [x] **iOS entitlements + permissions** — Multicast, network client/server, microphone, camera, Bluetooth, local network, Bonjour discovery, background audio.
- [x] **MultipeerConnectivity transport scaffold** — Swift `ConcordMPCManager` (BLE+WiFi Direct) with Rust FFI bridge implementing `Transport` trait. Compiled on iOS+macOS.
- [ ] Sideload test builds to physical iOS devices (Ad Hoc / TestFlight / web install)
- [ ] iPad-specific layout (responsive or separate)
- [ ] Verify all 7 testing protocol conditions on real devices
- [ ] WiFi Direct P2P between two phones (no internet)
- [ ] Cross-platform interop: desktop ↔ mobile ↔ iPad

### PRIORITY: Internet-First Feature Parity
- [x] WireGuard tunnel detection (auto-detect Tailscale/orrtellite 100.64.0.0/10, ConnectionType::WireGuard, wireguard.rs detection module, dashboard status card)
- [ ] Working text/voice/video over internet tunnels
- [ ] Web portal for guest access (phantom node hosting)
- [ ] Basic reputation system visible in UI

### Beta Mesh Core — `beta/` (in progress)
- [x] Tauri + Rust scaffold
- [x] libp2p transport layer (TCP + mDNS)
- [x] Identity system (Ed25519 keypairs)
- [x] DM encryption (X25519 Diffie-Hellman)
- [x] Audio pipeline (cpal + Opus codec)
- [x] Commercial security audit framework
- [x] **Voice commands wired to UI** (VoiceEngineHandle fully wired — Tauri commands are real, not mock. Browser-dev fallback has mock data for design iteration only.)
- [ ] **WebRTC media transport** (str0m integration — SDP is placeholder, audio currently transmitted via GossipSub raw frames instead of WebRTC channels)
- [ ] Video module (stub)
- [ ] SFU module (stub)
- [x] BLE/WiFi Direct transport tier (MPC scaffold — Swift ConcordMPCManager + Rust MpcTransport FFI bridge, compiled on iOS/macOS)
- [ ] File/media sharing
- [ ] CRDT shared state
- [ ] Moderation system
- [x] LICENSE file (MIT — `beta/LICENSE`)
- [ ] SQLCipher for at-rest encryption

### Mesh Network (from feedback — planned)
- [x] **Mesh map mathematical framework** (core data model + sync protocol + storage)
- [x] Deterministic addressing scheme (HMAC-SHA256 + Dijkstra routing)
- [x] Procedural map generation (locale partitioning: region/cluster/subnet)
- [x] Orphaned node handling (confidence degradation + route cost penalty)
- [x] Mesh map viewer — backend API (get_mesh_map_for_viewer: prominence-sorted nodes with location, portal_url, trust data)
- [x] Mesh map viewer — frontend React component (global/local toggle, GlobalNodeCard with prominence bars, location, portal URL, confidence badges)
- [x] Node verification protocol (4-tier confidence: Speculative/ClusterVerified/TunnelVerified/SelfVerified)
- [x] Server node verification workhorse (confidence upgrade via probe broadcasts)
- [x] Stale/removed node detection (TTL degradation + tombstone threshold)
- [x] Forum as mesh-scoped live channel (existing: ForumPost with hop_count/max_hops, local/global scope)
- [x] Node prominence heuristics (compute_prominence() — trust/engagement/routes/confidence/server weighted)
- [x] Reputation system data model (real-user-confidence, engagement_profile, overall trust in NodePayload)
- [x] Cooperative compute pipeline (distribute_compute() — capacity-weighted load distribution across cluster)
- [x] Cluster mode + cluster_ledger protocol (PlacePayload as cluster_ledger, PlaceRole, PlaceMembership types)
- [x] Fluid hypervisor role transfer (hypervisor_score(), select_hypervisor(), transfer hysteresis)
- [x] Invisible cluster voting (tally_invisibility() — simple majority of all members)
- [x] Group theory mesh addressing (hierarchical locale partitioning — region/cluster/subnet)
- [x] Tunnel detection via orrtellite (WireGuard CGNAT range auto-detection, `wireguard.rs` module, `get_wireguard_status` Tauri command, dashboard integration)
- [ ] Tunnel coordination via orrtellite (auto-enroll nodes, use mesh IPs for dial targets, replace Headscale with mesh-based key exchange long-term)
- [ ] Disposable anonymous nodes (private browsing mode)
- [x] **Perspective-based map navigation** (get_perspective_view API + NodeMapPage rewrite — center on any known node, breadcrumb tunnel drilling, relation-based layout)
- [x] **Forum map-view** (speech bubbles from chatting nodes overlaid on perspective map, 3-mode toggle: hidden/map/chatroom)
- [x] **Forum as customizable map crop** (forum scope IS the perspective view — chatroom panel shows posts within hop range of centered node)
- [x] **Friend mesh-data sharing** (MeshMapManager friend-aware sync: 15s cooldown, confidence upgrade Speculative→ClusterVerified→TunnelVerified, syncMeshFriends wired to app startup)
- [x] **Charter immutability** (owner-signed updates + monotonic version counter in merge_entry, remint_place() with compressed history — 5 tests)
- [x] **Phantom node type** (NodeType::Phantom — read-only, cannot cluster, can_join_cluster() rejects them — 4 tests)

### Places System (from feedback — planned)
- [x] Place minting + dedicated mesh addresses (mint_place(), PlacePayload with governance/ownership)
- [ ] Ownership transfer via re-minting
- [ ] Encrypted vs unencrypted ownership
- [x] Communal governance protocol (VoteProposal, tally_votes(), can_perform(), eligibility checks — 14 tests)
- [x] Anti-stalking tools — block list (blocked_peers table, block/unblock/is_blocked CRUD, Tauri commands)
- [ ] Default rules/regulations landing screen

### Service Node Mode (formerly "Server Mode" — renamed 2026-04-12)
- [x] Headless service node binary — **servitude** (concord-daemon: CLI start/init/status, TOML config, auto-creation, webhost)
- [x] Mesh map integration (self-registration as Backbone, TOPIC_MAP_SYNC subscription, periodic confidence degradation, auto_join_places config)
- [ ] Rename concord-daemon → servitude across codebase (binary name, docs, config)
- [ ] Web admin UI for service node configuration (admin API stubbed — needs socket/RPC)
- [ ] Resource contribution controls (CPU, bandwidth, storage — per-node, dynamic)
- [ ] Speculative data verification pipeline (service node as verification workhorse)
- [ ] Tunnel anchor role (persistent mesh point for user tunnels)
- [ ] First deployment: orrgate
- [ ] Support mode (user node as temporary infra for a connection — separate from headless service node)

### Game Center (from feedback — planned, refined 2026-04-12 as standalone sub-apps)

**concord-game-maker** — standalone companion app, 100% dedicated dev environment for concord-compatible games:
- [ ] Feature-complete visual code editor base (must support: multi-language workflow, text↔visual dual representation, edit existing code visually without breaking compatibility)
- [ ] Purpose-built nodes for point-and-click game dev
- [ ] Purpose-built nodes for text-controlled game dev
- [ ] LLM integration layer (Claude API, Gemini API, local Ollama — flexible per-game)
- [ ] LLM-powered interactive role-play nodes with archetype system
- [ ] Integrated generative AI nodes (connect to model APIs + image gen)
- [ ] Open source game development environment

**concord-game-center** — game console designed to play game-maker games natively:
- [ ] **WebGL/3D renderer for game viewport** (OpenGL, shared with mesh map — same rendering engine)
- [ ] Game engine elements: 3D-capable viewport, chat text input, viewport click input, hotkey keyboard input
- [ ] Native support for concord-game-maker games + extensions for other compatible simple games
- [ ] Launch games: Chess, Checkers, Mafia, Poker, Trivia, Pictionary, Telestrations, Scrabble
- [ ] In-game markets, towns, wallet management via interactive chatroom

**Shared:**
- [ ] Launch animation (display buffer on all boot/reload, all platforms)

### Mobile Dashboard (from feedback — planned)
- [ ] 1-2 tap reconnect to last channel
- [ ] 1-2 tap host text/voice/video exchange
- [ ] 1-2 tap open user profile customization
- [ ] 1-2 tap node settings

## Recent Changes
- 2026-04-12: **Major feedback processed** from `2026-04-12 05:33.md`. Changes: (1) Tunnel architecture: two design approaches documented (charter-minted tunnels vs sidekick nodes) — open question on which to implement. (2) Comms flow clarified: P2P handshakes for actual communication, tunnels only for virtual proximity. Local mesh + NET tunnels are complementary, not replacements. (3) Terminology overhaul: "servers" → "service nodes", management app → "servitude", naming theme = "single word descriptions of various social contracts". (4) Commerce deferred to v3 — tool-first design, UX must be perfect before economy features. (5) Game Center split into standalone sub-apps: concord-game-maker (dev environment) + concord-game-center (game console). Game-maker gets visual code editor + AI nodes. (6) Orrtellite integration: used as dependency for NET tunnels, baked into concord, end users don't need external tunneling. (7) 7 new open questions raised. (8) mbp15 corrected to always-on server, not daily driver.
- 2026-04-11 (evening): **Testing protocol refined** — added "full connection" formal definition (file exchange + text + voice + video). All 7 passing conditions now reference the full connection definition. File exchange was previously implicit; now explicit in every test condition. No new implementation work — definitional update only.
- 2026-03-28 (late night, orrion): **Orrtellite tunnel integration + reputation UI + daemon mesh wiring.** (1) WireGuard tunnel detection: new `wireguard.rs` module detects Tailscale/orrtellite mesh by running `tailscale status --json`. Auto-detects 100.64.0.0/10 CGNAT addresses in tunnel tracker → `ConnectionType::WireGuard`. `is_wireguard_address()` checks address range. `get_wireguard_status` Tauri command + dashboard status card showing mesh hostname/online peers. 5 new tests. (2) Reputation UI: TrustBadge + engagement scores in mesh map tooltips, server member trust badges, forum post author trust. (3) concord-daemon: mesh map self-registration as Backbone, sync topic subscriptions, confidence degradation task, `auto_join_places` config. (4) LICENSE confirmed present. 281 tests, 0 failures. TS clean.
- 2026-03-28 (late night, orrpheus): **iOS build pipeline + MultipeerConnectivity transport.** (1) iOS build working: `cargo tauri ios build --debug --target aarch64-sim` produces .app bundle. Both `aarch64-apple-ios` and `aarch64-apple-ios-sim` Rust targets compile. (2) Audio platform-gating: cpal + audiopus moved behind `native-audio` Cargo feature (default on, disabled on iOS/Android via target-conditional deps). Stub implementations return NoInputDevice/NoOutputDevice; VoiceEngine already handles this gracefully. (3) iOS entitlements: multicast networking, Bonjour service types (`_concord._udp`, `_concord._tcp`), microphone/camera/Bluetooth/local network usage descriptions, background audio mode. (4) MultipeerConnectivity transport: Swift `ConcordMPCManager` (250 lines) wraps MCSession + MCNearbyServiceBrowser + MCNearbyServiceAdvertiser with auto-accept, auto-invite. Rust `MpcTransport` (200 lines) implements `Transport` trait via C FFI bridge (LazyLock event buffer, extern "C" callbacks). Compiled on `cfg(any(target_os = "ios", target_os = "macos"))`. (5) Xcode deps: MultipeerConnectivity.framework, CoreBluetooth.framework, Network.framework linked. 276 tests, 0 failures.
- 2026-03-28 (night): **Reputation UI + concord-daemon mesh integration.** (1) Reputation visible everywhere: TrustBadge added to mesh map tooltips (with engagement score display), server member list (trust badges per member), forum post cards (author trust). Added `trustLevelFromRating()` and `engagementLabel()` utilities for score-to-display conversion. (2) concord-daemon wired to mesh: self-registration as Backbone node on mesh map, TOPIC_MAP_SYNC + calls topic subscriptions, periodic confidence degradation task (60s), `auto_join_places` config for auto-subscribing to place topics. (3) LICENSE file confirmed present. 276 tests, 0 failures.
- 2026-03-28 (evening): **Entry 4 Track B complete — UX revision + mobile prep.** (1) Perspective-based map navigation: new `get_perspective_view` Tauri command computes node neighborhood from any peer's viewpoint (home=live connections, remote=inferred from routes/locale). Frontend NodeMapPage rewritten: floating bubble layout centered on perspective node, breadcrumb trail for tunnel drilling, click-to-shift perspective on known nodes. Replaces old global/local toggle. (2) Forum map-view: speech bubbles overlay on mesh map showing recent posts at author positions, 3-mode toggle (hidden/map/chatroom), slide-in chatroom panel with compose. (3) Friend mesh-data sharing: MeshMapManager enhanced with friend-aware sync — 15s cooldown (vs 60s), confidence auto-upgrade on friend-sourced entries (Speculative→ClusterVerified, ClusterVerified→TunnelVerified). `syncMeshFriends` wired to dashboard startup. (4) Mobile prep: responsive initial map size, 44px touch targets on map nodes, responsive chatroom panel (full-width on mobile), fade-in animation for speech bubbles. (5) Corrected PLAN.md: voice commands are NOT mocked — fully wired to VoiceEngineHandle. Actual blocker is str0m WebRTC integration. 276 tests, 0 failures. TS + Vite clean.
- 2026-04-11: **Major feedback processed** from orrchestrator pipeline. Added: UX Language definitions (forum/place/charter/ledger/cluster/tunnel/server/node), Pragmatic Architecture (internet-first, mesh-second), 7-point Testing Protocol, perspective-based map navigation model (replaces global/local toggle), forum-as-map-crop concept, charter immutability requirement, phantom node exploration (experimental), mobile testing as top priority (iOS sideloading needed). 4 new open questions raised. Priorities shifted: mobile device testing now gates all further work.
- 2026-03-27 (late evening): **Unified identity system + wired mesh map sync into event loop.** Fixed the dual-identity problem: swarm now uses `SwarmBuilder::with_existing_identity()` with the Concord Ed25519 keypair (previously generated a random ephemeral key each startup). `NodeHandle.peer_id()` now returns the Concord hex peer_id, unifying DB/network boundary. Added `identity_keypair` field to `NodeConfig`. MeshMapManager wired into `Node.run()` event loop with 60s periodic tick, GossipSub topics `concord/mesh/map-sync` and `concord/mesh/calls` subscribed on startup. New NetworkEvent variants: `MeshMapDeltaReceived`, `CallLedgerUpdate`, `CallLedgerTombstone`. 228 tests passing, 0 failures.
- 2026-03-28: **Entry 1 all backend requirements complete (18/20).** Phase C added: location broadcasting (GeoLocation with 5-mile rounding), web portal URL generation (portal_url_for_node → *.concorrd.com), mesh map viewer API (get_mesh_map_for_viewer — prominence-sorted), mobile dashboard API (get_dashboard — peers, places, calls, last channel, portal URL). New cluster.rs module: cooperative compute (distribute_compute — capacity-weighted), fluid hypervisor (select_hypervisor + transfer hysteresis), invisible cluster voting (tally_invisibility). 267 total tests, 0 failures. Remaining 2/20 are frontend React components.
- 2026-03-27 (night): **Entry 1 Phase A+B complete.** Phase A: Extended PlacePayload with governance/ownership/whitelist, added PlaceRole/PlaceMembership types, mint_place() + build_self_registration(), blocked_peers table (schema v3), block/unblock CRUD + Tauri commands, mint_place/get_places Tauri commands. Phase B: New `governance.rs` module with VoteProposal, VoterEligibility, tally_votes(), can_perform() permission checks (14 tests). Added compute_prominence() for node ranking (2 tests). 251 total tests, 0 failures. 12 of 20 Entry 1 requirements now implemented.
- 2026-03-27 (evening): **Implemented mesh map mathematical framework** across 4 phases. New files: `concord-core/src/mesh_map.rs` (core types, address derivation, merge logic, routing, engagement, locale assignment — 16 unit tests), `concord-store/src/mesh_map_store.rs` (CRUD, tombstones, route cache, engagement counters — 6 tests), expanded `concord-net/src/mesh.rs` (MeshMapManager, sync protocol, call signals — 5 tests). Schema v2 migration adds 4 new SQLite tables. Tauri commands: `get_mesh_map_entries`, `get_engagement_profile`, `get_active_calls`. 228 total tests passing, 0 failures. All 3 design blockers resolved.
- 2026-03-27 (afternoon): Resolved all 12 open questions with user input. Added: node verification protocol (two trust tiers), reputation system (3 metrics), mesh map as decentralized database, deterministic addressing requirement, disposable anonymous nodes, call ledger lifecycle question, orrtellite for tunnels, server nodes as verification workhorses. Domain set to *.concorrd.com (placeholder). Game list finalized (8+ games). Flow-based game engine confirmed.
- 2026-03-27: Created PLAN.md. Processed `0326feedback.md` (14KB mesh architecture), `0326feedback2.md` (game center + launch animation), and concord-server concept into fb2p.md (3 queued entries).
