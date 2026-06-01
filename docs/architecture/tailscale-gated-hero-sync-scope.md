# Tailscale-Gated Hero Sync — Scope

**Status:** Scope document. No implementation in this PR.
**Author:** Architecture C spin-out from `hero-account-rfc.md` (2026-06-01).
**Cross-refs:** `hero-account-rfc.md` §4, §5; orrtellite tunnel infra; F-WG queued dispatch.

## Motivation

When a hero owns two instances and both come online, they merge their data via a diff-managed, additive sync cycle. That sync is gated by two independent checks: the two machines must be reachable through Tailscale (or equivalent mesh-VPN), AND both instances must verify they share the same hero. Either gate fails, no sync. This is deliberate: hero-mediated sync should never traverse the public internet without the mesh-VPN wrapper, and shared mesh reachability without a shared hero is not a sync relationship.

When the user has elected a persistent docker instance as an anchor, the docker mediates the sync. Without an anchor, every instance treats itself as canonical and all sync cycles are additive merges.

## Scope

- The two-gate sync precondition: (i) Tailscale (or equivalent mesh-VPN) reachability verified between the two machines, AND (ii) shared hero account verified between the two instances.
- The two sync topologies: **anchor-mediated** (docker instance brokers the sync) and **fully additive p2p** (no anchor; both instances are treated as ground truth).
- The bridge between the two-gate precondition and the existing porch-sync substrate (`/concord/porch-sync/1.0.0`, Phase F CRDT, the event log in `hero-account-rfc.md` §5).
- An anchor-selection surface so the user can elect a docker instance they trust as the sync anchor and revoke that election later.

## Non-scope

- The Tailscale / mesh-VPN reachability check itself — this scope assumes such a check already exists (orrtellite + WireGuard transport, see F-WG).
- The conflict-resolution agent dispatch — Architecture D and `hero-account-rfc.md` §5.d.
- The hero account primitives (key material, device-link certs) — `hero-account-rfc.md` §3.
- Replacing Tailscale with another mesh-VPN — orthogonal; the scope is "mesh-reachability verified," not specifically Tailscale-the-product.

## Dependencies on other Concord subsystems

- F-WG (WireGuard wrapping for all native p2p egress) — provides the underlying tunnel that the reachability check confirms.
- orrtellite (Concord's self-hosted mesh-VPN) — provides the network substrate.
- The hero account primitives (`hero-account-rfc.md` §3) — provide the cryptographic identity used in the second gate.
- The porch-sync protocol and CRDT substrate (`hero-account-rfc.md` §5, porch Phase F) — provides the actual sync engine that Architecture C gates.
- Architecture E (hard-disconnect on app close) — when either side closes, the sync cycle ends with the connection; no warm-resume.

## Follow-up tasks for a future implementation dispatch

1. Specify the reachability-check surface: what does "Tailscale connectivity verified" mean in concrete terms (round-trip success, identity-pinned, idle threshold)?
2. Define the hero-shared check: how the two instances exchange a hero-identity proof without leaking it to non-shared peers on the same mesh.
3. Specify the gate-failure UX: when one gate passes and the other fails, what does the user see, and what is the suggested recovery path?
4. Define the anchor-mediated topology: how the docker anchor brokers, what state it retains, what guarantees it provides over the fully additive case.
5. Define the fully-additive p2p topology: explicit append-only semantics and the bridge to the existing event log and conflict queue.
6. Integrate with Architecture E so the gate state is re-evaluated on every cold start rather than cached across sessions.
