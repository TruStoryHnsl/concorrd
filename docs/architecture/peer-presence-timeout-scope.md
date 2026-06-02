# Peer-Presence Timeout + Persistent Visibility — Scope

**Status:** Scope document. No implementation in this PR.
**Author:** Architecture B spin-out from `hero-account-rfc.md` (2026-06-01).
**Cross-refs:** `hero-account-rfc.md` §3, F-VIS queued dispatch.

## Motivation

Concord does not use fixed-duration access tokens for peer connections. A peer keeps access as long as they keep reconnecting within their per-connection expiry window. When that window lapses, the peer is **permanently removed** from the access list, but the host still **sees** that the peer exists — the peer stays in the visibility list. Re-granting access requires the host to re-affirm the relationship. This deliberate split (access ≠ visibility) lets the user prune stale connections without forgetting who their peers are, and lets different relationships expire on different schedules.

## Scope

- A per-connection expiry policy: each connection record carries its own renewal cadence (auto-renewable on reconnect, renewable only on user action, etc.). No single global TTL.
- A two-tier peer-state model: **access list** (gates the porch + any other gated server) and **visibility list** (the peer remains discoverable / displayable in the UI).
- The transition from access → visibility-only when the per-connection expiry threshold is crossed.
- A re-affirmation flow that promotes a visibility-only peer back to the access list when the host explicitly re-confirms the relationship.
- Configuration surfaces so the user can pick a per-connection policy at connect time and edit it later.

## Non-scope

- The cryptographic identity bound to each peer record — that lives in Architecture A and `hero-account-rfc.md` §3.
- The transport-layer tear-down on app close — Architecture E.
- The mesh-distance visibility property of servers (max-hop visibility) — F-VIS. Architecture B governs the access vs. visibility split for a single peer relationship; F-VIS governs which servers propagate over how many hops.
- Cryptographic revocation of issued credentials — orthogonal; this is a presence-driven access policy, not a credential-revocation policy.

## Dependencies on other Concord subsystems

- The porch's session-token + paired-peer list (`hero-account-rfc.md` §3, porch design).
- The unified add-source flow (F2 / PR #141) — newly-added sources start with a default per-connection policy that this scope defines.
- Architecture A (user-definition protocol) — the visibility list reuses the same profile record format so a permanently-removed peer is still rendered with their advertised vanity name.
- The local SQLite home-server store — both lists persist there.

## Follow-up tasks for a future implementation dispatch

1. Define the per-connection policy enum and its default at first connect (likely: auto-renew while the peer reconnects at least once per N days, configurable per record).
2. Specify the access-list and visibility-list schema (one row per peer, with a status field, last-seen field, expiry field, and policy field).
3. Build the re-affirmation UX: how the host is prompted, what evidence the host needs to re-grant access, and how the prompt distinguishes "first-time grant" from "re-affirmation."
4. Wire the porch's gate check to the access list (current state) and ensure visibility-only peers fall through with a clear status indicator.
5. Define the user-visible audit trail so a host can review when peers transitioned access → visibility-only and when they were re-affirmed.
6. Integrate with F-VIS so a permanently-removed peer who is still in the visibility list inherits the correct hop-distance treatment.
