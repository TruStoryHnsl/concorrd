# Concord P2P Architecture — Design

> **Status:** design captured 2026-05-27 from a multi-iteration conversation that refocused Concord's hosting story away from a domain-centric / TURN-on-public-IP model toward a P2P-first model for native builds. Supersedes earlier assumptions in PLAN.md that the root repo was Matrix/web-only and that the libp2p mesh lived solely in a separate repo (since renamed `conquered` and re-scoped) — native P2P now lands in this main build. This document is the spec future implementation sessions execute against.
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

The only architecturally honest answer is: **native builds connect to each other peer-to-peer via libp2p, with the help of project-run DHT bootstrap nodes for first-discovery only.** Voice rides directly over the P2P link. No external paid service. No TURN relay required for native↔native voice. The web path remains as the compatibility surface for browser users.

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

**Peer pairing** — how two Concord instances first learn each other's keys + addresses — uses three layered mechanisms, all of which are user-visible and chosen at pairing time:

1. **QR code / `concord://` deeplink (manual exchange).** Each install can show its own peer card. Another install scans / clicks. No coordination service involved in first contact.
2. **Existing federated network (Matrix room, ActivityPub mention).** If two users are already in the same Matrix room on a public homeserver, they can exchange peer cards via a custom `m.room.message` event type. Piggybacks discovery on protocols people already use.
3. **Silent Kademlia DHT (project-run bootstrap nodes).** Once two peers know each other's keys but the address has changed, either side can query the DHT for the other's current libp2p multiaddr. This runs as a libp2p behavior inside the existing process — the operator does NOT install or configure a separate service. The DHT requires 3–5 project-run bootstrap nodes to seed; those are deployed on tiny VPS instances (~$5/mo total, bandwidth is metadata-only). Bootstrap list ships in the binary.

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

### Phase 4 — Silent Kademlia DHT + project bootstrap nodes
> **Phase 4 implementation landed** — see `src-tauri/src/servitude/bootstrap.rs` for the hardcoded multiaddr list and `src-tauri/src/servitude/p2p.rs::new_inner` + `seed_kad_bootstrap` + the retry loop in `LibP2pTransport::run` for the wiring. Operational spec for the project-run nodes lives at [`p2p-bootstrap-deployment.md`](p2p-bootstrap-deployment.md).
>
> Pattern: hardcoded `&[&str]` multiaddrs parsed at startup; Kad defaults to `Mode::Client` on native (the docker / always-on profile flips it to `Mode::Server` in a follow-up commit — no per-profile config flag exists yet); failed bootstrap queries retry with exponential backoff starting at 5s and doubling until capped at 5 min, logged at `debug!` so a transient network drop never surfaces as a red banner in the UI; the swarm emits a new lightweight `SwarmEvent::DhtRoutingUpdated { peer_count }` whenever the routing table picks up a new peer, so the React UI can render a passive "DHT is alive, N peers known" indicator without subscribing to the full Kad event firehose.
>
> Cross-restart: the libp2p `PeerId` derives from the same per-install Ed25519 seed that backs Phase 2's `PeerIdentity`. Cluster A's parallel commit completes the seed-persistence fix from Phase 3 — see `identity.rs` for the encrypted-sibling-file pattern.
- Enable libp2p Kad behavior inside the swarm.
- Hard-code 3–5 bootstrap node multiaddrs in the binary (`src-tauri/src/servitude/bootstrap.rs`).
- Concord-api startup connects to bootstrap nodes silently; no operator setup, no per-user dialog.
- Spec the bootstrap node deployment: tiny VPS (~$5/mo each), runs ONLY a libp2p node with Kad and Identify. Deployed and operated by the project, not by self-hosters.
- Operator-facing docs explain that the DHT runs silently and uses negligible bandwidth (metadata-only lookups).
- **Identity cross-restart persistence (Phase 3 follow-up):** the Ed25519 seed is now persisted in a ChaCha20-Poly1305-encrypted sibling file (`<snapshot_path>.seed.enc`, chmod 0600 on Unix) alongside the Stronghold snapshot, keyed off the same 32-byte snapshot password. This closes the Phase 3 known issue where `peer_seed()` and `sign()` returned `SeedUnavailable` after a process restart — Stronghold has no `ReadVault` procedure, so the seed bytes had no path back into memory. The sibling file decrypts on startup and rehydrates the in-handle cache, so signing and the libp2p `Keypair` survive restarts. The backward-compat path (Stronghold record present, sibling file missing) leaves the fingerprint working but signing unavailable until the next `load_or_create` rewrites both stores.
- Tests: DHT joins the network, peer-key lookups round-trip via bootstrap, survives a bootstrap node going offline.

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

### Phase 7 — Native build default profile
- Native Tauri builds boot with the web stack OFF: no Caddy started, no LiveKit started, no coturn started, no sslh started.
- All those services exist in the codebase and CAN be started, but the default profile for native is `p2p-only`.
- Settings UI: "Make this instance web-accessible" toggle. Enabling it starts the web stack and walks the user through DNS + port-forward (using the Phase-0 health check + remediation surface).
- Docker builds keep the `web-first` profile defaults (everything on).
- Tests: native-build smoke test confirms no listening ports beyond libp2p ones; toggle test confirms the web stack starts cleanly when enabled.

### Phase 8 — Voice over libp2p
- Raw WebRTC peer connections established via libp2p WebRTC transport.
- For each voice channel with ≤8 native participants: full peer-to-peer mesh.
- For >8 participants OR any web-only participant: fall back to LiveKit on a docker-deployed Concord instance.
- The voice subsystem reads the call's participant list and decides per-call which path to use; participants don't need to know.
- Tests: 2-peer call works over libp2p with no SFU; 9-peer call automatically uses SFU; mixed-mode (some native, some web) works.

### Phase 9 — js-libp2p in the browser client
- Add `@libp2p/js-libp2p` with WebRTC transport to `client/package.json`.
- Browser sessions create their own ephemeral libp2p identity (per-tab keypair).
- Browser becomes a real peer: can holepunch to a native Concord peer, federate state with it, stream voice without the docker LiveKit/coturn pipeline.
- The existing web flow (login via API, fetch ICE servers, connect to LiveKit) remains for users who don't have a native install — but for users who DO, the browser tab connects to their own native peer directly.
- Tests: browser ↔ native libp2p connection establishes; browser ↔ browser libp2p connection works (when both browsers can hole-punch).

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
