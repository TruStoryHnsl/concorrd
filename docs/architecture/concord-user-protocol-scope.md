# Concord-native User-Definition Protocol — Scope

**Status:** Phase 1 implemented (2026-06-01) — descriptor, libp2p protocol,
trust store, merge view, Matrix-bridge opacity comment, Tauri command
surface, and stub Settings UI all land in `feat(identity): Concord-native
user-definition protocol`. Subsequent phases (programmatic-chat
interaction, advertising/discovery surface) remain scoped.
**Author:** Architecture A spin-out from `hero-account-rfc.md` (2026-06-01).
**Cross-refs:** `hero-account-rfc.md` §2, user-management Phase 3,
`src-tauri/src/servitude/concord_user/` (Phase 1 implementation).

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

## Phase 1 — what landed (2026-06-01)

The first implementation dispatch (`feat(identity): Concord-native
user-definition protocol — per-server isolation by default; trust-gated
merge`) implements the foundational data model + transport + persistence:

- **`ConcordUserDescriptor`** (`src-tauri/src/servitude/concord_user/mod.rs`)
  — the canonical wire+memory record. Carries a stable `concord_uid`
  (Ed25519 public key derived from the install's Stronghold seed, same
  seed pool as the libp2p peerid but signed payloads use a
  domain-separation tag), a top-level vanity display name, a Vec of
  per-server `ServerProfile` rows (display name + transport-agnostic
  `AvatarRef` + optional bio + Ed25519 signature), and an append-only
  `trust_log` of `TrustEdge` declarations and `TrustEdgeRevocation`
  entries.
- **`/concord/user-profile/1.0.0`** libp2p stream protocol
  (`src-tauri/src/servitude/concord_user/protocol.rs`) — two paired peers
  exchange descriptors via a JSON-RPC envelope (`GetSelf` / `GetByUid`)
  over the existing `libp2p_stream` substrate. Wire framing matches the
  Matrix federation handler's 4-byte length prefix + JSON body.
- **Trust store** (`src-tauri/src/servitude/concord_user/trust_store.rs`)
  — append-only, ChaCha20-Poly1305-encrypted log sibling-filed to the
  Stronghold snapshot. Adding an edge appends one record; revoking
  appends a SECOND record (never edits or deletes the original).
- **`merge_view`** — pure-function reducer that takes a descriptor +
  resolves its trust log into the SAME-uid latest-entry-per-edge_id
  semantics, then unions the descriptor's server_ids via the active
  edges. Per-server isolation is the default: a descriptor with N rows
  and zero edges yields N effective profiles. Each edge collapses two
  servers into one effective profile.
- **Matrix-bridge opacity** — a documented architecture comment in
  `src-tauri/src/servitude/federation/matrix.rs` makes explicit that the
  Matrix homeserver only ever sees the ONE per-Matrix-server row
  corresponding to its own ServerId, never the rest of the descriptor.
  Per-server isolation extends across the bridge.
- **Tauri command surface** — `concord_user_get_self`,
  `concord_user_get_for_peer`, `concord_user_add_trust_edge`,
  `concord_user_list_trust_edges`, `concord_user_revoke_trust_edge`.
  Trust edges are USER-EXPLICIT only — no code path anywhere creates
  one without the user's call.
- **`IdentityTrustSection.tsx`** — Settings surface listing trust edges
  with an "Add new" form. Stub UI, not polish — the polish iteration is
  out of scope for Phase 1.
- **Tests** — 8 `cargo test --lib` cases (descriptor serde round-trip,
  trust-edge sign/verify, merge-view two-merged-one-isolated,
  per-server-isolation default, revocation honored, tampered-row
  rejected, uid hex round-trip, edge-id symmetry) + 1 libp2p
  integration test (two peers exchange descriptors over
  `/concord/user-profile/1.0.0` and agree on merge_view output).

### Explicit gaps after Phase 1

- **Programmatic-chat / bot interaction.** The user explicitly flagged
  this as an open question. The descriptor has a placeholder
  (`ServerProfile.bio`) but no semantics for bot identity vs. hero
  identity, no consent flow for a bot signing a trust edge, no
  separate descriptor shape for non-human actors. This is the
  next-priority follow-up scope document.
- **Advertising / discovery surface.** Phase 1 ships the
  point-to-point fetch (`GetSelf` over libp2p) but not the
  vanity-name → machine-readable-address resolver. Follow-up.
- **Multi-trust-level enum.** Phase 1 is binary: an edge is either
  active or revoked. The scope's "configurable level of trust"
  (partial trust = field-by-field opt-in, full trust = full merge)
  is deferred. The descriptor's merge view is currently full-merge
  per active edge; field-level masking is a follow-up.
- **Cache for other heroes' descriptors.** `concord_user_get_for_peer`
  fetches once and returns; we don't yet persist a fetched
  descriptor so the next call goes back over the wire. The trust
  store is local-hero-only.

## Follow-up tasks for a future implementation dispatch

1. Draft the wire format for the cross-transport user record (Matrix-federation envelope + libp2p envelope + HTTP envelope) and prove they round-trip into one canonical in-memory representation.
2. Specify the trust-level enum and the merge rules at each level (no trust → per-server accumulation; partial trust → field-by-field opt-in; full trust → full merge).
3. Define the discovery surface: how a peer learns about a hero's vanity name + machine-readable address, and how that resolution survives mesh propagation.
4. Decide the bot / programmatic-chat-application interaction model and add it as a separate follow-up scope document.
5. Specify the storage shape for the per-server identity-accumulation case so that the same human's per-server impressions are durable across reboots without leaking the linkage.
6. Define the hand-off into the unified add-source flow and into Architecture C (Tailscale-gated hero sync).
