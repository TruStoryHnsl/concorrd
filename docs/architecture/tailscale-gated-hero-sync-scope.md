# Tailscale-Gated Hero Sync — Scope

**Status:** Initial implementation landed 2026-06-01 (Architecture C, F-C).
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

---

## Implementation contract (as shipped 2026-06-01)

F-C landed the following surface:

* `src-tauri/src/servitude/network/tailscale_detect.rs` — the Tailscale
  reachability probe. Single entry point `is_tailscale_peer(&[Multiaddr])
  -> bool` returning `true` iff (i) at least one peer multiaddr advertises
  a CGNAT-range IP (`100.64.0.0/10`) AND (ii) the local install has a
  CGNAT-range IP bound. Companion helpers: `local_tailscale_addrs()`,
  `local_tailscale_ips()`, `TailscaleGateSnapshot::evaluate(..)`. The
  probe overlaps with the broader `tunnel_detect.rs` (Phase G) but
  filters strictly to CGNAT presence — the load-bearing tailnet signal.

* `src-tauri/src/servitude/hero_binding.rs` — the gate (i) facade.
  Currently STUBBED: `HeroBinding::lookup_peer_hero(..)` returns
  `Ok(None)` for every peer, which means the hero gate stays CLOSED
  for every peer until Architecture A merges. The integration point
  is documented at the top of the file: swap the lookup body with a
  call to `concord_user_get_for_peer(peer_id)` when F-A lands. A
  dedicated regression test (`two_gate_with_f_a_stub_still_blocks_hero`)
  pins the stub behaviour so a future merge cannot silently open the
  gate.

* `src-tauri/src/servitude/hero_sync/` — the F-C orchestration:
    * `gate.rs` — the two-gate evaluator. `evaluate_gates(binding,
      peer_id, multiaddrs).await -> GateOutcome` returns
      `{tailscale_passes, hero_passes, snapshot}` and short-circuits on
      the first failure. `GateOutcome::diagnostic()` renders a
      human-readable failure reason.
    * `anchor.rs` — anchor-mode resolution. Reads
      `home_meta.hero_anchor_instance` to pick `HeroAnchorMode::Anchored`
      vs `HeroAnchorMode::Unanchored`. Public helpers
      `hero_get_anchor_instance` / `hero_set_anchor_instance` (also
      exposed as Tauri commands of the same name).
    * `protocol.rs` — `/concord/hero-sync/1.0.0` protocol. Bidirectional:
      ONE request carries `(anchored, anchor_label, since, push)`; the
      response carries `(responder_push, responder_conflicts_enqueued)`.
      ADDITIVE on top of the existing porch-sync substrate — same
      `(sync_device_id, sync_lamport, sync_tombstone)` LWW machinery,
      same `SyncDelta` row shapes. Anchor-mismatch produces an
      `AnchorMismatch` variant rather than silently merging.
    * `conflict_queue.rs` — hand-off contract to Architecture D
      (see below).

* SQLite schema migration **version 10** adds the `conflict_queue` table:

```sql
CREATE TABLE conflict_queue (
    conflict_id    BLOB PRIMARY KEY,    -- 16-byte ULID
    conflict_kind  TEXT NOT NULL,       -- 'concurrent_rename' | 'tombstone_vs_write' | 'acl_change'
    payload_json   BLOB NOT NULL,       -- JSON; opaque to F-C, F-D reads
    queued_at      INTEGER NOT NULL,    -- unix milliseconds
    resolved_at    INTEGER,             -- nullable; F-D stamps on verdict
    agent_verdict  BLOB                 -- nullable JSON; F-D writes
);
CREATE INDEX idx_conflict_queue_pending
    ON conflict_queue(queued_at) WHERE resolved_at IS NULL;
```

F-C **enqueues** destructive conflicts and stops. The drain belongs
to Architecture D (`resumable-conflict-agent-scope.md`), which fills
in `resolved_at` + `agent_verdict` per row. Rows are never deleted —
the queue is the audit trail.

### Two sync paths (resolved)

Per the user's clarification:

- **Anchored mode** — `home_meta.hero_anchor_instance` is set; the
  user has elected a docker instance. Envelopes carry `anchored=true`
  + `anchor_label`. Responder validates the label matches its own
  anchor (`HeroSyncResponse::AnchorMismatch` on disagreement).
  Devices defer to the anchor's verdict on conflicting events.
- **Unanchored mode** — no anchor row. Envelopes carry
  `anchored=false`. Each instance treats itself as canonical; all sync
  cycles are additive p2p merges (LWW + device-id tiebreak).

The runtime auto-picks via `HeroAnchorMode::from_porch(&porch)`. The
React layer exposes the election via the Tauri commands
`hero_get_anchor_instance` / `hero_set_anchor_instance`.

### Test surface

`src-tauri/tests/hero_sync_test.rs` covers:

1. Tailscale gate — both-on / neither / peer-only / local-only (#1-4).
2. Two-gate evaluator — hero-yes-tailnet-no, hero-no-tailnet-yes, and
   the F-A stub regression test that pins the gate closed (#5-7).
3. Bidirectional sync round-trip over two libp2p swarms — confirms
   LWW + tombstone semantics propagate intact (#8).
4. Concurrent-rename collision → exactly one `conflict_queue` row (#9).
5. Anchor mode reported via Ping (#10).

Plus 26 unit tests in `src-tauri/src/servitude/hero_sync/**` and 13 in
`tailscale_detect.rs`.

### [OPEN QUESTION] surface for the user

These were NOT pinned by the user in the implementation dispatch.
F-C ships sensible defaults; the user can refine in a follow-up
dispatch.

1. **[OPEN QUESTION] Anchor identifier format.** Currently opaque
   string (e.g. `"docker-instance-A"`). Should it be the docker's
   libp2p PeerId, a human-readable label the user pinned at
   onboarding, or both? The protocol currently treats it as an opaque
   byte-comparable token; the user can pick a stricter format later
   without a wire break.
2. **[OPEN QUESTION] Gate-failure UX.** `GateOutcome::diagnostic()`
   returns a precise human-readable string ("tailscale: peer not
   advertising a tailnet address" vs "hero: no shared hero account
   confirmed"). UI rendering of this state is TBD — should it show as
   a per-peer banner, a global toast, or a row in a "Connection
   diagnostics" panel?
3. **[OPEN QUESTION] Tailscale-equivalent meshes.** Headscale uses
   the same CGNAT allocation and works transparently. WireGuard
   meshes that pick from RFC1918 ranges (e.g. orrtellite's
   `10.42.0.0/16`) DO NOT pass the gate today. Should we extend the
   CGNAT check to also accept "any IP inside a user-configured trusted
   CIDR list" (similar to `tunnel_detect`'s extras list)? F-C
   deliberately did not bake that in — orthogonal to the user's
   "tailscale" framing.
4. **[OPEN QUESTION] Reachability re-check cadence.** F-C evaluates
   the gate on every connection-establishment event. Architecture E
   (hard-disconnect on app close) guarantees a fresh evaluation on
   every cold start. Open question: should a long-running session
   periodically RE-PROBE the local interface table to catch the
   case "user turned Tailscale off mid-session"? Today the gate uses
   the snapshot taken at connection time.
5. **[OPEN QUESTION] iOS / Windows reachability.** The probe returns
   the empty set on iOS (sandbox forbids interface enumeration) and
   Windows (`GetAdaptersAddresses` not yet wired). The gate is
   therefore CLOSED for hero-sync on those platforms today. iOS
   hero-sync probably needs a NetworkExtension; Windows needs the
   `windows-sys` wiring per `tunnel_detect.rs`'s TODO.
