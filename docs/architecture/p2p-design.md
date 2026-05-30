# Concord P2P Architecture — Design

> **Status:** design captured 2026-05-27 from a multi-iteration conversation that refocused Concord's hosting story away from a domain-centric / TURN-on-public-IP model toward a P2P-first model for native builds. Supersedes earlier assumptions in PLAN.md that the root repo was Matrix/web-only and that the libp2p mesh lived solely in a separate repo (since renamed `conquered` and re-scoped) — native P2P now lands in this main build. This document is the spec future implementation sessions execute against.
>
> **2026-05-29 redirect:** Phase 4 was rewritten. The original design called for a project-run fleet of 3–5 Kademlia DHT bootstrap nodes on tiny VPSes (~$5/mo each). The user rejected that model on UX grounds — no project-run infrastructure, no third-party bootstrap dependency. Phase 4 now reads "**mDNS for LAN + Phase-5 peer cards for WAN.**" The DHT is gone; the bootstrap fleet was never provisioned; the placeholder PeerIds in `bootstrap.rs` will never be replaced with real ones. See the rewritten Phase 4 section below.
>
> **Audience:** orrchestrator (sequencing the implementation), agent-pm (per-PR review against the architecture), and any future contributor reading PLAN.md.

## One-line summary

Native Concord builds (Tauri desktop, iOS, Android) speak **libp2p** to each other directly, peer-to-peer, with no public-domain requirement. The Docker build keeps a persistent web-accessible presence and continues to serve browsers via the existing Caddy / LiveKit / coturn / sslh stack. The two deployment profiles share one codebase; what differs is which subset of services is enabled by default.

## Why P2P (the constraint that forced the design)

WebRTC requires a publicly-reachable endpoint somewhere in the path between two voice-chatting clients. For a Concord instance hosted on residential internet behind NAT, that endpoint historically required:

- a one-time router port-forward of 443 (or 3478/5349) to the host's LAN IP, AND
- a public DNS record (the operator's domain) pointing at the WAN IP, AND
- correct env config so the API stamps that domain into the ICE servers it returns to clients.

Every one of those preconditions has been a silent failure mode at least once in Concord's history. Mobile devices can never satisfy any of them — phones behind cellular CGNAT cannot be port-forwarded, cannot host a stable DNS A record, and cannot guarantee inbound packet delivery from random browsers.

The Phase 0 work in this branch fixes the silent-failure class for the web-compat path (auto-deriving `TURN_HOST` from `INSTANCE_DOMAIN`, refusing RFC1918 values, surfacing a hosting-health endpoint, returning 503 instead of broken ICE URLs). But fixing the web path doesn't make mobile hosting work, and mobile hosting being "feature-complete" is a stated product requirement.

The only architecturally honest answer is: **native builds connect to each other peer-to-peer via libp2p, with mDNS handling LAN-local discovery and the Phase-5 peer-card flow (QR / `concord://` deeplink / Matrix-room exchange) handling WAN pairing.** Voice rides directly over the P2P link. No external paid service. No TURN relay required for native↔native voice. No project-run infrastructure. The web path remains as the compatibility surface for browser users.

## Two deployment profiles, one codebase

| | **Docker / server build** | **Native build (Tauri desktop, iOS, Android)** |
|---|---|---|
| Primary role | Persistent web-accessible Concord instance | P2P peer in the Concord mesh |
| Default services on | Caddy + concord-api + LiveKit + coturn + sslh + conduwuit (all on) | concord-api + conduwuit + libp2p transport (Caddy / coturn / sslh / LiveKit / web listener OFF) |
| Talks to other Concords via | Web HTTPS for browser clients; P2P (libp2p) for paired native peers | P2P primarily; web compatibility only if user enables it |
| Public ingress required | YES (port-forward, see Phase 0 fix) | NO by default |
| Identity primary | Domain (DNS) — `<your>.concordchat.net` or your own domain | Peer key (Ed25519) |

The toggle on native builds — "Enable web access (your instance becomes browser-accessible)" — flips the same web stack the docker profile runs. The CODE is identical; only the set of services started at boot differs. A power user on native CAN serve the web UI on their LAN, or expose to the public after port-forward + DNS, but neither is required for the native↔native path.

## Identity, discovery, federation

**Identity** is an Ed25519 keypair generated on first launch of any Concord install, stored in `tauri-plugin-stronghold` (already in use), surfaced to UI as a short fingerprint. The keypair IS the instance's identity. Matrix user IDs become a layered concept (one identity may carry multiple Matrix accounts across federated homeservers, but the peer key is canonical).

**Peer pairing** — how two Concord instances first learn each other's keys + addresses — is layered:

- **LAN-local: mDNS.** When two native Concord instances are on the same local network (home LAN, tailnet, office Wi-Fi), libp2p's mDNS behavior discovers them silently within seconds. No user action, no peer card, no coordination service. The Settings → Profile tab surfaces discovered LAN peers in a "Peers on your LAN" section; one-click pairs any of them into the persistent Phase-5 peer store.
- **WAN: the Phase-5 peer-card flow (always intentional).** Three converging mechanisms:
    1. **QR code / `concord://` deeplink (manual exchange).** Each install can show its own peer card. Another install scans / clicks. No coordination service involved in first contact.
    2. **Existing federated network (Matrix room, ActivityPub mention).** If two users are already in the same Matrix room on a public homeserver, they can exchange peer cards via a custom `m.room.message` event type. Piggybacks discovery on protocols people already use.

There is **no DHT**, **no project-run bootstrap fleet**, and **no third-party discovery dependency**. The original design called for a 3–5 VPS fleet running libp2p Kademlia bootstrap nodes; that fleet was never provisioned, and on 2026-05-29 the user rejected the model on UX grounds. All WAN pairing is intentional — a user has to scan / click / post a peer card. This is by design (see the "Tradeoffs" section below).

**Federation payloads** ride OVER the libp2p stream layer, not under it. The transport is protocol-agnostic by design: each stream is typed by a libp2p protocol ID, and the project ships handlers for:

- **Matrix federation** (priority 1). Each Concord install bundles an embedded Matrix homeserver (conduwuit). Federation traffic between two paired Concord peers flows over a libp2p stream carrying Matrix's standard federation API, reusing the existing protocol but with a different transport beneath it.
- **ActivityPub** (priority 2). For interop with Mastodon / Mozilla.social and the broader fediverse. Concord users would be able to follow / be followed by ActivityPub identities, and vice versa.
- **(future N)** — any federated protocol that fits the "messages between peers" abstraction. Adding a new protocol is a new handler module, not a transport-layer change.

This is what "extensible to other federated networks like Matrix and ActivityPub" means concretely: the libp2p transport doesn't know or care which federation protocol it's carrying.

## Voice over libp2p

For native ↔ native voice (1-on-1 and small groups up to ~8 participants), raw WebRTC peer connections are established via libp2p's WebRTC transport. Each pair of participants has a direct media path with no SFU involved. Holepunching via libp2p's built-in NAT traversal (Circuit Relay v2 + DCUtR) succeeds for ~80–90% of consumer NAT combinations.

For cases where direct P2P fails OR where the room exceeds the mesh threshold (>8 participants), Concord falls back to an SFU. The SFU lives on a docker-deployed Concord instance (LiveKit on a publicly-reachable machine), not on every native peer. This is the same web-compat code path — when a native instance can't holepunch to a peer, the SFU on a designated docker host becomes the relay. No project-owned media relay required beyond what operators already run.

Browser clients (web profile) connect to LiveKit the way they always have. The web-compat path is unchanged.

## Browser as a real libp2p peer

js-libp2p with the WebRTC transport runs in the browser. The web client can be a first-class peer in the Concord mesh — not just a browser hitting an API. This means a browser tab can hole-punch to a native Concord peer, federate state with it, and stream voice without the docker LiveKit/coturn pipeline in the middle. The web compat surface remains for "I just want to log into someone else's instance from a random borrowed laptop," but for users who have a Concord native install of their own, the browser tab can be its own peer.

## Implementation phasing (this is the orrchestrator's roadmap)

Each phase ends with a working state; nothing is left half-finished between sessions. Tests cover every new module.

### Phase 0 — Web-compat fix (DONE in this branch, 2026-05-27)
- `INSTANCE_DOMAIN` derived from `PUBLIC_BASE_URL` (single source of truth).
- `_turn_host()` derives `turn.{INSTANCE_DOMAIN}`; explicit RFC1918 `TURN_HOST` is logged-and-ignored.
- `services/voice_health.py`: background probe (every 10 min), cached snapshot, never blocks API boot.
- `/api/hosting/status` + `/api/hosting/status/refresh` expose health to the operator UI.
- `/api/voice/token` returns 503 with actionable remediation when health is known-unhealthy; allows the never-probed boot window through.
- Bundled `sslh` service in `docker-compose.yml` under a `public-ingress` profile (so it ONLY starts for the web-first deployment, not for native builds).
- Updated `.env.example`: TURN_HOST/TURN_DOMAIN documented as auto-derived; explicit overrides supported but discouraged.
- Tests: `tests/test_voice_subsystem_health.py` covers RFC1918 rejection, derivation, hosting-status surfacing, the 503 gate, and the boot-window pass-through.

### Phase 1 — P2P architecture design doc (THIS DOCUMENT)
Captures every decision in this conversation so subsequent sessions don't re-derive them. No code, just the spec orrchestrator sequences against.

### Phase 2 — Peer identity scaffolding
> **Phase 2 implementation landed on `feat/peer-identity-ed25519`** — see `src-tauri/src/servitude/identity.rs`.
- Generate Ed25519 keypair on first launch in `src-tauri/src/servitude/`.
- Persist via `tauri-plugin-stronghold` (already in use; same encrypted store as Matrix credentials).
- Expose public key + short fingerprint via new Tauri command (`peer_identity`).
- React UI surface: show fingerprint in Settings → Account.
- Bind the peer identity to the existing Matrix user identity (the same person owns both; the Matrix user ID becomes a layer on top of the peer key, not a replacement).
- Tests: identity persists across restart, fingerprint format stable, no leakage of private key.

### Phase 3 — rust-libp2p integration in src-tauri/servitude
- Add `libp2p` crate to `src-tauri/Cargo.toml` with features for: QUIC, WebRTC, Noise, Yamux, Kademlia, Identify, Ping, Gossipsub, Circuit Relay v2, DCUtR.
- Build a `Swarm` inside the servitude module that boots concurrently with the existing transport variants.
- Wire swarm events to the Tauri app via channels so the React UI can observe peer state.
- Replace the placeholder `NoopTransport` variant in `transport/mod.rs` with `LibP2pTransport`.
- Reuse architecture lessons from the `conquered` repo (formerly `concord_beta`) libp2p prototype without inheriting its half-finished pieces.
- Tests: swarm starts cleanly, identifies its own multiaddr, accepts an incoming connection on QUIC.

### Phase 4 — Discovery: mDNS (LAN) + Phase-5 peer cards (WAN)

> **Phase 4 implementation landed** under the original DHT design, then **redirected 2026-05-29** to drop Kad + the project-run bootstrap fleet entirely. The architecture is now two-layered: mDNS handles LAN-local peer discovery silently; WAN peers require explicit pairing through Phase 5. There is no DHT, no project-run infra, and no third-party bootstrap dependency.
>
> Wiring: `src-tauri/src/servitude/p2p.rs` declares `mdns: libp2p::mdns::tokio::Behaviour` in the composed `Behaviour`; the swarm emits a new `SwarmEvent::MdnsPeerDiscovered { peer_id, multiaddrs }` whenever an mDNS announcement burst lands; the Tauri layer fans that out onto the `peer_lan_discovered` event bus; the React side maintains a session-scoped LAN-peer list via `client/src/api/lanPeers.ts` and surfaces it in Settings → Profile → "Peers on your LAN" with a one-click "Pair this peer" action that promotes a LAN peer into the persistent Phase-5 peer store. The browser swarm (`client/src/libp2p/node.ts`) has **no automatic discovery at all** — browsers can't speak mDNS portably, and there are no bootstrap nodes to dial; every browser peer dial is explicit, from the Phase-5 peer-card flow.
>
> Identity invariant unchanged: the libp2p `PeerId` still derives from the same per-install Ed25519 seed that backs Phase 2's `PeerIdentity` (`src-tauri/src/servitude/identity.rs`). The seed persistence fix from the original Phase 3/4 follow-up — ChaCha20-Poly1305-encrypted sibling file alongside the Stronghold snapshot — is unaffected by the redirect.

- libp2p `mdns::tokio::Behaviour` enabled in the swarm with default config; discovers LAN peers on `224.0.0.251:5353` like every other mDNS responder. No project-controlled rendezvous service.
- `SwarmEvent::MdnsPeerDiscovered` published on the broadcast channel for every distinct peer reported in an mDNS announcement burst; multiaddrs are stringified and unioned across repeat announcements client-side (`client/src/api/lanPeers.ts`).
- Tauri-side: `peer_lan_discovered` event channel mirrors mDNS events to the React side; the in-memory `lanPeers` cache is session-scoped (no persistence by design).
- React-side: Settings → Profile → "Peers on your LAN" section renders the LAN list alongside the existing "Paired Peers" list; "Pair this peer" button promotes a LAN peer into the persistent peer store (where it gains all the usual Phase-5 semantics — multiaddr union dedup, `first_seen` preserved, `last_seen` advanced).
- **Identity cross-restart persistence:** retained from the original Phase 4. The Ed25519 seed is persisted in a ChaCha20-Poly1305-encrypted sibling file (`<snapshot_path>.seed.enc`, chmod 0600 on Unix) alongside the Stronghold snapshot, keyed off the same 32-byte snapshot password. Signing and the libp2p `Keypair` survive restarts.
- Tests: mDNS discovers a peer on the same network (two swarms in one process see each other within 15s), swarm boots cleanly with no bootstrap config of any kind, the `peer_lan_discovered` event wrapper dedupes by peer_id and unions multiaddrs across repeat announcements.

#### Tradeoffs

Dropping Kad + bootstrap nodes is **deliberate**. The tradeoffs:

- **No random-peer discovery on the WAN.** A fresh install on a cellular hotspot can't find any other Concord instance through ambient discovery; the user has to pair intentionally via a peer card (QR / deeplink / Matrix-room exchange). This is by design — "pairing is a feature, not a limitation." Concord is not trying to be a public-discovery social network.
- **No internet-wide peer search.** If a friend rebuilds their install and gets a fresh PeerId, the user has to re-pair via the Phase-5 flow. There is no DHT lookup that finds them under their new PeerId.
- **mDNS only crosses the LAN.** Two native installs on the same home LAN / tailnet / office Wi-Fi see each other silently; two installs on different networks need an explicit pairing exchange.

In return: **zero project-run infrastructure**, zero third-party bootstrap dependency, zero ambient-trust attack surface. Every WAN peer the user talks to is one they paired with intentionally.

### Phase 5 — Peer pairing UX

> **Phase 5 implementation landed: feat/peer-pairing-p5.** The first user-facing P2P surface. Three converging input paths (QR + `concord://` deeplink + Matrix-room peer card) feed a single local peer-store; the stored `KnownPeer` records carry their `source` so downstream phases can attribute provenance. ActivityPub remains queued as a follow-up — the design doc keeps it in scope but Phase 5 ships the Matrix-federated path first.

- QR code generator + scanner (using a Tauri-compatible JS library on the React side, e.g. `qrcode` for display and `jsQR` for scan).
- `concord://` deeplink handler registered with the OS (Tauri's `deep-link` plugin).
- Matrix-room peer card: custom `m.room.message` event type `concord.peer_card` carrying the peer's libp2p public key + last-known multiaddr.
- ActivityPub mention/bookmark exchange (later within this phase; not blocking).
- React UI surfaces: "Show my peer card" (QR + copyable link + Matrix-room post button), "Add a peer" (scan QR / paste link / pick from Matrix-room mention).
- Tests: roundtrip pairing via QR, deeplink, and Matrix-room — all end with both peers having the other's key in their local peer-store.
- **Local peer-store** at `peer-store/known-peers/v1` in Stronghold, persisted via the same ChaCha20-Poly1305 sibling-file pattern Phase 4 introduced for the seed (`<snapshot_path>.peer_store.json.enc`, chmod 0600). Idempotent `add` (multiaddr-union dedup, `first_seen` preserved, `last_seen` advanced). Tauri commands `peer_store_list` / `peer_store_add` / `peer_store_remove` surfaced to the frontend; Tauri events `peer_paired` and `peer_paired_error` fire on successful and failed deeplink-driven adds.
- **Scanner is Tauri-only.** `jsQR` + `getUserMedia` need camera permissions that have different surfaces in browsers vs native; for Phase 5 the camera tab is hidden on web. Web users can still DISPLAY a QR for someone else to scan with their native build.

### Phase 6 — Protocol-agnostic federation payload layer
- Abstract `FederationProtocol` trait in `src-tauri/src/servitude/federation/`.
- Concrete `MatrixFederationHandler` (priority 1): negotiates a libp2p stream with protocol ID `/concord/matrix-federation/1.0.0`, carries Matrix's existing federation API over the stream (same protocol, different transport).
- Concrete `ActivityPubHandler` (priority 2): protocol ID `/concord/activitypub/1.0.0`, bridges to ActivityPub identities. Phase 6 ships the Matrix handler; ActivityPub follows.
- The transport layer is unaware of the payload type. New federated protocols are added by registering a new handler with a new protocol ID.
- Tests: two paired Concord peers federate Matrix events successfully over libp2p stream, without using HTTPS federation; protocol-ID dispatch routes to the correct handler.

> **Phase 6 implementation landed** (`feat/federation-payload-p6`): the `FederationHandler` trait + Matrix handler live in `src-tauri/src/servitude/federation/` (`mod.rs` + `matrix.rs`). The trait was split — `FederationProtocol` carries the compile-time `const PROTOCOL_ID` and `FederationHandler` is the dyn-safe instance trait the dispatcher holds (Rust forbids associated `const` on dyn-compatible traits; concrete handlers impl both). `LibP2pTransport` gained `register_federation_handler` + `stream_control()` + a new `SwarmEvent::FederationStreamOpened`. The swarm's `Behaviour` now includes `libp2p_stream::Behaviour` (added as a separate dep — libp2p 0.56 does not expose a `stream` feature flag). Inbound streams are routed by protocol ID via per-handler `IncomingStreams` listener tasks spawned at the top of `LibP2pTransport::run()`. `MatrixFederationHandler` wraps an injectable `MatrixFederationApi` trait so production wires the bundled conduwuit (`ConduwuitClient`, http://localhost:6167) and tests wire mocks. Wire framing is 4-byte big-endian length prefix + JSON envelope, 16 MiB cap. The handler is registered at swarm startup in `LibP2pRuntime::start()`. Phase 6 explicitly ships only Matrix; the ActivityPub handler is queued for Phase 6 follow-up — the trait abstraction is what makes it a single-module addition rather than a transport change. Integration tests: `src-tauri/tests/federation_test.rs` (3 tests covering inbound dispatch, protocol-ID routing isolation, and malformed-envelope resilience). ActivityPub handler shipped at `src-tauri/src/servitude/federation/activitypub.rs` — same trait, same framing, stub responder pending real Mastodon/Mozilla.social interop.

### Phase 7 — Native build default profile
- Native Tauri builds boot with the web stack OFF: no Caddy started, no LiveKit started, no coturn started, no sslh started.
- All those services exist in the codebase and CAN be started, but the default profile for native is `p2p-only`.
- Settings UI: "Make this instance web-accessible" toggle. Enabling it starts the web stack and walks the user through DNS + port-forward (using the Phase-0 health check + remediation surface).
- Docker builds keep the `web-first` profile defaults (everything on).
- Tests: native-build smoke test confirms no listening ports beyond libp2p ones; toggle test confirms the web stack starts cleanly when enabled.

> **Phase 7 implementation landed** (`feat/native-default-profile-p7`): the seam is a `Profile` enum (`P2pOnly` | `WebFirst`) in `src-tauri/src/servitude/config.rs` with `Default = P2pOnly`. `ServitudeConfig` gains a `#[serde(default)] profile` field; `from_store` / `from_toml_str` apply a `CONCORD_PROFILE` env override (docker-compose sets `web_first`). `ServitudeHandle::new_with_identity` gates non-libp2p transports on `Profile::WebFirst` — under `P2pOnly` every entry in `enabled_transports` is logged-and-skipped; the libp2p baseline still spawns regardless. Tauri commands `get_servitude_profile` / `set_servitude_profile` expose the value to the frontend; the persisted config is updated through to disk so the next `servitude_start` materializes the new transport set. FastAPI side gains `GET /api/hosting/profile` (reports env-derived profile + a docker-proxy heuristic for `web_stack_running`) and `POST /api/hosting/profile/enable_web_stack` (admin-gated, starts conduwuit + livekit + docker-socket-proxy via the existing `docker_control` socket-proxy plumbing; a new `start_compose_service` primitive lands in the same PR). React Settings → Profile gets a `DeploymentProfileSection` toggle: native renders an interactive switch + confirm-modal that flips the profile and triggers the enable call; web build renders the toggle read-only with the "configured via `CONCORD_PROFILE` env" note. `docker-compose.yml`'s `concord-api` block pins `CONCORD_PROFILE: web_first`. Tests: `src-tauri/tests/profile_test.rs` (3 cases — default-is-p2p-only, web_first materializes everything, p2p_only skips non-libp2p), `server/tests/test_hosting_profile.py` (7 cases covering both endpoints + admin gate + idempotency + 503-on-proxy-down), `client/src/api/__tests__/hostingProfile.test.ts` (6 cases for the dual-transport wrapper), `client/src/components/settings/__tests__/DeploymentProfileSection.test.tsx` (5 cases for the toggle UI).

### Phase 8 — Voice over libp2p
- Raw WebRTC peer connections established via libp2p WebRTC transport.
- For each voice channel with ≤8 native participants: full peer-to-peer mesh.
- For >8 participants OR any web-only participant: fall back to LiveKit on a docker-deployed Concord instance.
- The voice subsystem reads the call's participant list and decides per-call which path to use; participants don't need to know.
- Tests: 2-peer call works over libp2p with no SFU; 9-peer call automatically uses SFU; mixed-mode (some native, some web) works.

> **Phase 8 follow-up implementation landed** (`feat/voice-mesh-media-plane`): the voice **media plane** is now real on native — `webrtc-rs` PeerConnection on the Rust side, `@libp2p/webrtc` browser RTCPeerConnection on the web side. New Rust sub-modules `voice/media.rs` (per-peer `WebRtcMediaPeer` wrapping `webrtc::peer_connection::RTCPeerConnection`; sendrecv audio/opus transceiver; `on_ice_candidate`/`on_track`/`on_peer_connection_state_change` wired to mutex-protected state mirrors), `voice/call.rs` (`VoiceCall` orchestrator + `VoiceCallRegistry` Tauri-managed state + `VoiceCallSinkImpl` real signaling sink that replaces Phase 8 `NoopVoiceSink`), `voice/error.rs` (canonical `VoiceError` enum). `LibP2pRuntime` exposes `set_voice_registry` + `voice_outbound_sender`; Tauri `servitude_start` wires the registry; `LibP2pRuntime::start` spawns a drain task that forwards every outbound envelope via `send_signaling`. Three new Tauri commands: `voice_mesh_join`, `voice_mesh_leave`, `voice_mesh_status`. Frontend: `joinVoiceSession.ts` actually attempts mesh-join (calls `invoke("voice_mesh_join", …)` when selector returns `libp2p_mesh`, short-circuits LiveKit on success, falls back on failure). `client/src/stores/voice.ts` gains a `transport: "livekit" | "libp2p_mesh"` field. New `client/src/libp2p/voiceMesh.ts` (browser-side `joinMesh`/`leaveMesh` against `@libp2p/webrtc` PCs over the same `/concord/voice-signaling/1.0.0` protocol). **What works today:** 2-peer mesh signaling completes Offer/Answer over the libp2p stream; ICE drain runs without erroring; PC state transitions are mirrored into `PeerCallState`; remote audio tracks are captured. **What is deferred (`TODO(mesh-media-followup)` markers in code):** (a) mic capture wiring on native — the local opus track exists and accepts RTP via an internal `mpsc<Vec<u8>>` channel but no production code feeds it (cpal on desktop / AVAudioEngine on iOS is the follow-up PR); (b) speaker playback on both sides — remote tracks captured but not rendered; (c) opus encoder integration; (d) NACK/FEC/RTCP recovery; (e) wiring `voiceMesh.ts` as the active mesh path on the web build (today the web build calls the Tauri command path, which only works inside the native shell). Tests: 3 in `src-tauri/tests/voice_mesh_test.rs` + inline unit tests in `media.rs` and `call.rs`; 3 in `client/src/libp2p/__tests__/voiceMesh.test.ts` + 3 in `client/src/components/voice/__tests__/joinVoiceSession.test.ts`. New crate: `webrtc = "0.8"`. The track abstraction accepts an RTP source today; a follow-up PR adds cpal-based mic capture + speaker playback on native and full `getUserMedia → libp2p track` integration in browser.

> **Phase 8 implementation landed** (`feat/voice-over-libp2p-p8`): the voice subsystem lives at `src-tauri/src/servitude/voice/`. Three sub-modules: `selector.rs` (path-selection logic — pure function, ≤8 native = mesh, >8 OR any web-only = SFU; surfaces a `VoicePathReason` so the UI can render the right context — `above_cap_8` / `web_only_participant_present` / `all_native_under_cap`); `signaling.rs` (libp2p stream-protocol handler under `/concord/voice-signaling/1.0.0` — reuses the Phase 6 `FederationHandler` trait; carries `Offer`/`Answer`/`IceCandidate`/`Bye` envelopes as 4-byte BE length-prefixed JSON with a 1 MiB cap; outbound `send_signaling` helper); `webrtc_peer.rs` (per-peer `PeerCallState` scaffolding — `Offering` → `IceGathering` → `Connected` → `Closed`; stubbed signaling-response generation so the integration tests can prove the wire end-to-end without a real PeerConnection). The Phase 6 `FederationHandler::handle_inbound` trait method was refactored to accept a `PeerId` parameter so voice signaling can attribute inbound envelopes to the right remote peer; `MatrixFederationHandler` was updated to ignore the new parameter (its envelopes carry their own X-Matrix auth). `LibP2pRuntime::start` now registers a `VoiceSignalingHandler` with a `NoopVoiceSink` placeholder — the real call-orchestration sink lands in the Phase 8 media follow-up. A new Tauri command `select_voice_path` exposes the selector to the frontend; the `client/src/api/voicePath.ts` wrapper short-circuits to LiveKit on the web build (browsers can't be mesh peers until Phase 9). `joinVoiceSession.ts` calls the wrapper before fetching the LiveKit token and logs the chosen path, but the actual join flow still rides LiveKit while the audio-media layer is stubbed. Tests: 4 in `src-tauri/tests/voice_test.rs` (selector picks mesh for 3 native peers; selector picks SFU for 9 native peers; selector picks SFU when any web-only participant; voice-signaling round-trip Offer → Answer over two real libp2p swarms with PeerId attribution verified) plus 16 inline unit tests in `selector.rs` / `signaling.rs` / `webrtc_peer.rs` plus 4 vitest cases in `client/src/api/__tests__/voicePath.test.ts`. **Explicitly out of scope for Phase 8:** the audio-MEDIA layer — `webrtc-rs` integration, cpal / AVAudioEngine microphone capture, opus encoding, RTP/RTCP transport, mesh-orchestration glue (per-peer dialing + answer routing through the sink). Phase 8 is the path-selection + signaling-protocol surface; the media layer is a sizable separate piece of work queued as a Phase 8 follow-up.

### Phase 9 — js-libp2p in the browser client
- Add `@libp2p/js-libp2p` with WebRTC transport to `client/package.json`.
- Browser sessions create their own ephemeral libp2p identity (per-tab keypair).
- Browser becomes a real peer: can holepunch to a native Concord peer, federate state with it, stream voice without the docker LiveKit/coturn pipeline.
- The existing web flow (login via API, fetch ICE servers, connect to LiveKit) remains for users who don't have a native install — but for users who DO, the browser tab connects to their own native peer directly.
- Tests: browser ↔ native libp2p connection establishes; browser ↔ browser libp2p connection works (when both browsers can hole-punch).

> **Phase 9 implementation landed** (`feat/browser-libp2p-p9`): the browser-side libp2p layer lives in `client/src/libp2p/` with four modules and a React lifecycle hook. **Stack** — `libp2p@^3.3.2` driving the v3 EventTarget stream API; transports `@libp2p/webrtc` + `@libp2p/websockets`; encryption `@chainsafe/libp2p-noise`; muxer `@chainsafe/libp2p-yamux`; services `@libp2p/identify`, `@libp2p/ping`, and `@libp2p/kad-dht` (`clientMode: true`, matching the native default Kad mode on non-docker profiles). QUIC is intentionally absent — the browser stack does not speak it; bootstrap dials to the Phase 4 placeholder multiaddrs are best-effort and silently fail until those nodes advertise a `/wss` or `/webrtc-direct` address alongside the QUIC one. **Identity** — `identity.ts` generates a per-tab Ed25519 keypair via `@libp2p/crypto/keys::generateKeyPair("Ed25519")` and derives the PeerId with `@libp2p/peer-id::peerIdFromPrivateKey`. The keypair is cached for the lifetime of the tab and dropped on reload, by design (the durable identity seam is Phase 2's stronghold-backed native key). **Node factory** — `node.ts` exposes `startBrowserNode` / `stopBrowserNode` / `getNode` as a singleton + a test seam (`__setCreateLibp2pForTests`) so unit tests verify the orchestration without paying the multi-second cost of a real swarm boot inside jsdom. The factory auto-starts via `createLibp2p`'s default and dials every bootstrap multiaddr from `bootstrap.ts` (hand-mirrored from `src-tauri/src/servitude/bootstrap.rs`). **Federation client** — `federation.ts` ships both `sendMatrixRequest` (outbound) and `handleInboundMatrixRequest` (inbound) speaking `/concord/matrix-federation/1.0.0` with the Rust-symmetric **4-byte BE length prefix + JSON body + 16 MiB cap**. `lpStream` from `@libp2p/utils` is NOT used — it uses a varint prefix, while Phase 6 picked fixed 4-byte BE to match Matrix-federation envelope habits; hand-rolled framing keeps the wire symmetric without forcing the Rust side to grow a varint decoder. **Voice path selector** — `client/src/api/voicePath.ts` now replicates the native selector locally on the web build: `getNode() === null` → SFU (`browser_libp2p_not_running`); >8 participants → SFU (`above_cap_8`); any `peer_id === null` → SFU (`web_only_participant_present`); otherwise → mesh (`all_native_under_cap`). The Phase 8 reason string `browser_or_web_build` is retired; web builds now flip between `browser_libp2p_not_running` (no node yet) and a real mesh/SFU decision (node up). **Lifecycle hook** — `client/src/hooks/useBrowserLibp2p.ts` boots the swarm on mount + tears it down on unmount; native (Tauri) builds skip the start path because the Rust Phase 3 swarm IS the libp2p layer on native. Wired once at the top of `App.tsx` next to `useServitudeLifecycle`. Status (`idle`/`starting`/`running`/`error`) is intentionally unrendered for Phase 9 — a Settings → Profile badge is the natural follow-up but not in scope here. **Tests** — 3 cases in `client/src/libp2p/__tests__/identity.test.ts` (cache, reset regeneration, 64-hex Ed25519 public key); 4 cases in `client/src/libp2p/__tests__/node.test.ts` (start + bootstrap dials, singleton, stop-then-restart, swallows bootstrap failure); 4 cases in `client/src/libp2p/__tests__/federation.test.ts` (frame layout, single-chunk parse, chunk-split-mid-prefix parse, oversized-declaration rejection); 3 new cases in `client/src/api/__tests__/voicePath.test.ts` covering the browser mesh-eligible / cap / web-only branches (the existing Phase 8 case shifts to the new `browser_libp2p_not_running` reason); 3 cases in `client/src/hooks/__tests__/useBrowserLibp2p.test.tsx` (web build status transitions, native no-op, error surface). **Explicitly out of scope for Phase 9:** media-frame routing over libp2p WebRTC tracks. The path selector now lets a browser opt into `libp2p_mesh`, but the media plane stays on the existing `livekit-client` path until the coordinated Phase 8/9 media-layer follow-up lands real audio over libp2p WebRTC (the same `webrtc-rs` / opus / RTP work Phase 8 deferred — both phases will ship their full media path together).

## What's NOT in scope

- **Replacing LiveKit entirely.** LiveKit remains the SFU for large rooms (>8) and the web-compat path. Phase 8 just makes it optional for small native ↔ native calls.
- **Replacing conduwuit / Matrix.** Matrix federation is the priority-1 payload over libp2p; ActivityPub is priority 2. The protocol stays; only the transport changes.
- **Federation between Concord instances without prior pairing.** Discovery requires either out-of-band exchange (QR/deeplink), Matrix-room piggyback, or DHT lookup of a known peer key. There is NO "join random unknown Concord peers" mode.
- **Removing the docker / web deployment.** The Docker stack stays. It's the path browsers use, and it's how the project's own concordchat.net presence is hosted.
- **Carrier-grade NAT (CGNAT) mobile-to-mobile direct.** The ~10% of NAT combinations where libp2p holepunching fails fall back to SFU; for two phones both on CGNAT trying to talk to each other with no docker peer in the room, voice will route through whatever LiveKit-on-docker instance is reachable. There is no third option; this is a property of how IP routing works.

## Migration strategy from today's domain-centric model

Phase 0 already lands the web-compat fix that makes the docker path work correctly. Phases 2–9 build the P2P path alongside it without removing the web path. At each phase, the codebase stays in a shippable state — Phase 4 (DHT working) doesn't require Phase 6 (Matrix federation over libp2p) to be done; the DHT can exist and be useful for peer-address lookups before any federation payload rides on it. The native default profile flip (Phase 7) is the last gate before users actually feel the change: until Phase 7, native builds still start the web stack by default. After Phase 7, the P2P path is the default and the web path is opt-in.

## Notes for orrchestrator

- Each phase is sequenceable independently once Phase 2 lands (identity is the foundation everything builds on).
- Phase 4 (DHT) and Phase 5 (Pairing UX) can run in parallel — they share no code.
- Phase 6 (federation payload) blocks Phase 8 (voice over P2P) since voice rides on the same stream abstraction.
- Phase 9 (browser libp2p) is genuinely independent and can be parallelized at any point after Phase 3.
- agent-pm reviews each PR against this document. Deviations from the design require a PR to this document first, not a silent code drift.
