# Concord Bootstrap Node Deployment — DEPRECATED 2026-05-29

> **Status:** **DEPRECATED.** This document specified a fleet of project-run libp2p Kademlia bootstrap nodes (3–5 small VPS instances, ~$15–$25/mo total) that fresh Concord installs would dial silently at startup to seed the DHT. On 2026-05-29 the user rejected the project-run-infrastructure model, and Phase 4 was rewritten to use **mDNS for LAN-local discovery** and the **Phase-5 peer-card flow (QR / `concord://` deeplink / Matrix-room exchange)** for WAN pairing. There is no DHT, no project-run bootstrap fleet, and no third-party bootstrap dependency.
>
> The fleet specified here was never provisioned. The PeerIds in the in-binary list (formerly `src-tauri/src/servitude/bootstrap.rs::BOOTSTRAP_NODES`) were always placeholders — syntactically-valid `12D3KooW…` strings derived from fixed dev seeds — and they will never be replaced with real ones. The `bootstrap.rs` file itself was removed from the codebase in the same redirect commit.
>
> See [`p2p-design.md`](p2p-design.md) § Phase 4 for the post-redirect architecture. This file is retained as a deprecation marker so external links / search results land somewhere informative rather than a 404; the operational content below is preserved for historical reference only.

---

## Why the redirect happened

Two reasons in the user's own framing:

1. **No project-run infrastructure.** Concord's posture is "self-hostable, no third-party dependencies, no project-paid services." A 3–5 VPS bootstrap fleet — even at ~$15/mo total — is project-run infrastructure that every install depends on. Donation funding (under the commercial-scope donation-only model — see PLAN.md) could cover the cost, but the *posture* is wrong: an install that can't reach the project's bootstrap nodes silently can't find any peer.
2. **Pairing should always be intentional.** The original design treated the DHT as a silent re-discovery mechanism for known peers whose addresses changed. mDNS + Phase-5 peer cards cover both axes (LAN + WAN) without any ambient project-run trust surface. The user prefers "the user always knows when they're connecting to someone new" over "the app finds peers for you."

The tradeoffs are documented in `p2p-design.md` § Phase 4 § "Tradeoffs": no random-peer discovery on the WAN, no internet-wide peer search, all WAN pairing is intentional. These are accepted by design.

## What the post-redirect architecture replaces it with

- **LAN discovery: libp2p `mdns::tokio::Behaviour`.** Native swarms on the same local network (home LAN, tailnet, office Wi-Fi) discover each other silently within seconds. No project-controlled rendezvous service, no DNS-SD external dependency. Browsers can't speak portable mDNS from a tab, so the browser swarm has zero ambient discovery — every browser peer dial is explicit, from the Phase-5 peer-card flow.
- **WAN discovery: Phase-5 peer cards exclusively.** Three converging mechanisms: QR scan, `concord://` deeplink, Matrix-room `concord.peer_card` event. All require explicit user action.

Wiring is described in:

- `src-tauri/src/servitude/p2p.rs` — `mdns: libp2p::mdns::tokio::Behaviour` in the composed `Behaviour`; `SwarmEvent::MdnsPeerDiscovered { peer_id, multiaddrs }` published on the broadcast channel.
- `src-tauri/src/lib.rs` — `peer_lan_discovered` Tauri event channel mirrors mDNS events to React.
- `client/src/api/lanPeers.ts` — session-scoped in-memory LAN-peer list, dedupes by peer_id, unions multiaddrs.
- `client/src/components/settings/ProfileTab.tsx` — "Peers on your LAN" section with one-click "Pair this peer" action.

## What this doc previously specified (historical)

For historical reference only — none of this is provisioned, none of it will be:

- A small fleet (3 nominal, scalable to 5) of long-lived libp2p nodes participating in the Concord Kademlia DHT with fixed Ed25519 PeerIds.
- Hetzner CX22 or equivalent ($5/mo each, 1 vCPU / 2 GB / 20 GB / 20 TB).
- Distroless Docker images running only libp2p + Kad + Identify + Ping on QUIC/UDP/4001.
- DNS records `bootstrap{1,2,3,4,5}.concordchat.net` pointing at the VPS public IPs.
- systemd unit (`concord-bootstrap.service`) with `Restart=always` and basic hardening.
- An external liveness probe asserting Identify reports the expected agent version + PeerId.
- A rotation procedure for compromised keys (provision new node + DNS + binary release + 30-day wait + decommission).

If any of that is ever resurrected, it would belong in a separate document — `bootstrap-redux.md` or similar — under a new architectural decision. As of 2026-05-29 the project commitment is "no project-run infrastructure."

## Cross-references

- [`p2p-design.md`](p2p-design.md) § Phase 4 — current architecture: mDNS + peer cards, no DHT.
- [`p2p-design.md`](p2p-design.md) § Phase 4 § Tradeoffs — what we give up by dropping the DHT (and why it's worth it).
- PLAN.md `### TOP PRIORITY: P2P-first native architecture` — roadmap entry for Phase 4 (now annotated with the redirect).
