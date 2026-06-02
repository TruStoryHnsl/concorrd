//! F-C — Tailscale-gated hero sync, top-level orchestration.
//!
//! Architecture C (scope doc: `docs/architecture/tailscale-gated-hero-sync-scope.md`).
//! The user's framing:
//!
//! > When a hero owns two instances they merge upon peer connection.
//! > Whatever data they both held in isolation is merged with the other
//! > in a diff managed process where both sources are treated as truth
//! > … it only propagates between instances if the machines are verified
//! > to be connected via tailscale and the instances are confirmed to
//! > share a hero-user.
//!
//! ## Module layout
//!
//! * [`gate`] — the two-gate evaluator. Cheap, callable on every
//!   connection-establishment event, returns a [`GateOutcome`] without
//!   I/O beyond the existing tailscale-probe call + the (currently
//!   stubbed) hero-binding lookup.
//! * [`anchor`] — runtime resolution of "anchored" vs "unanchored"
//!   sync mode. Reads `home_meta`'s `hero_anchor_instance` key.
//! * [`protocol`] — wire definition of the `/concord/hero-sync/1.0.0`
//!   stream protocol. ADDITIVE on top of the existing
//!   `/concord/porch-sync/1.0.0` substrate: the per-row
//!   `(sync_device_id, sync_lamport, sync_tombstone)` machinery is
//!   reused as-is.
//! * [`conflict_queue`] — the hand-off contract to Architecture D.
//!   Surfaces destructive-conflict rows; never resolves them in F-C.
//!
//! ## What this PR does NOT touch
//!
//! * The `event_log` table is Phase H3 (not landed yet). The merge here
//!   uses the existing porch CRDT row-tables. The conflict-queue
//!   payload format carries enough state to be upgraded to event-log
//!   references once H3 lands without a schema break.
//! * Architecture D (the agent dispatch that drains conflict_queue) is
//!   a separate parallel PR. F-C documents the contract; F-D
//!   implements the drain.

pub mod anchor;
pub mod conflict_queue;
pub mod gate;
pub mod protocol;

pub use anchor::{hero_get_anchor_instance, hero_set_anchor_instance, HeroAnchorMode};
pub use conflict_queue::{
    ConflictKind, ConflictQueueRow, ConflictRecord, HERO_SYNC_CONFLICT_KINDS,
};
pub use gate::{evaluate_gates, GateOutcome};
pub use protocol::{
    HeroSyncEnvelope, HeroSyncHandler, HeroSyncRequest, HeroSyncResponse,
    HERO_SYNC_PROTOCOL_ID,
};
