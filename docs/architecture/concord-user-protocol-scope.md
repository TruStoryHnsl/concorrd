# Concord-native User-Definition Protocol — Scope

**Status:** Scope document. No implementation in this PR.
**Author:** Architecture A spin-out from `hero-account-rfc.md` (2026-06-01).
**Cross-refs:** `hero-account-rfc.md` §2, user-management Phase 3.

## Motivation

The hero account is created locally on a virgin install and is later advertised to peers on the p2p network. The hero is NOT anchored to a master instance. To reconcile that local hero with the rest of the Concord ecosystem — which spans Matrix federation, libp2p porch, and Concord-via-domain HTTP — Concord needs a single, transport-agnostic user-definition protocol. Without it, a hero who exists on a libp2p-only client cannot be addressed by a Matrix-federated client, and vice versa, even when both sides trust each other.

## Scope

- A protocol-level definition of "a Concord user" that is meaningful over (i) Matrix federation, (ii) the libp2p porch protocol family, and (iii) Concord-via-domain HTTP.
- A trust-gated cross-instance profile-merge mechanism. Where two instances both trust each other to a configurable level, they can resolve their respective user records for the same hero into one shared profile.
- A default per-server identity-isolation mode for the no-trust case: identity records accumulate per-server, NOT per-device, so the same human can present a different impression on each server they touch without leaking that those impressions belong to one hero.
- An advertising / discovery surface so a peer can resolve a vanity name to a machine-readable address that any Concord transport can dial.

## Non-scope

- The hero key material and seed-mnemonic export — already in `hero-account-rfc.md` §3.
- The transport-layer mechanics (WireGuard, libp2p dialers, Matrix federation client) — already covered elsewhere.
- The conflict-resolution event log — covered by Architecture D and `hero-account-rfc.md` §5.
- Bot / programmatic-chat-application interaction. This is explicitly an **open question** — the user-definition protocol must define a placeholder for it but the semantics are deferred.

## Dependencies on other Concord subsystems

- The hero account primitive (`hero-account-rfc.md` §3) — provides the cryptographic identity the protocol advertises.
- The unified add-source flow (F2 / PR #141) — the user-definition protocol shows up on the receiving side of every "add a source" action and must hand back a normalized profile record.
- The mesh-distance visibility layer (F-VIS, queued) — a user's advertised profile inherits the same hop-distance rule as the servers they host.
- Architecture B (peer-presence timeout) — once a peer is permanently removed, their cached profile record becomes visibility-only until the host re-affirms the relationship.

## Follow-up tasks for a future implementation dispatch

1. Draft the wire format for the cross-transport user record (Matrix-federation envelope + libp2p envelope + HTTP envelope) and prove they round-trip into one canonical in-memory representation.
2. Specify the trust-level enum and the merge rules at each level (no trust → per-server accumulation; partial trust → field-by-field opt-in; full trust → full merge).
3. Define the discovery surface: how a peer learns about a hero's vanity name + machine-readable address, and how that resolution survives mesh propagation.
4. Decide the bot / programmatic-chat-application interaction model and add it as a separate follow-up scope document.
5. Specify the storage shape for the per-server identity-accumulation case so that the same human's per-server impressions are durable across reboots without leaking the linkage.
6. Define the hand-off into the unified add-source flow and into Architecture C (Tailscale-gated hero sync).
