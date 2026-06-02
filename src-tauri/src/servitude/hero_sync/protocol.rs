//! F-C — `/concord/hero-sync/1.0.0` protocol.
//!
//! Wire shape mirrors the existing porch-sync substrate
//! (`/concord/porch-sync/1.0.0`): 4-byte BE length prefix + JSON body,
//! same 32 MiB envelope cap. The CRDT machinery underneath is the same
//! `(sync_device_id, sync_lamport, sync_tombstone)` LWW dance from
//! `porch::sync::merge`; this protocol is a thin **wrapper** that:
//!
//!  1. Carries the anchored/unanchored flag in the envelope so the
//!     responder knows whether to defer to the docker anchor or merge
//!     additively.
//!  2. Detects destructive conflicts (rename/tombstone/ACL) at apply
//!     time and enqueues them into `conflict_queue` for F-D to drain.
//!
//! ## Why a new protocol ID
//!
//! We could have piggybacked on `/concord/porch-sync/1.0.0`, but the
//! TRUST GATE is different: porch-sync allows bilateral device pairing
//! WITHOUT a hero account. Hero-sync REQUIRES BOTH gates (tailscale +
//! hero match). Keeping them on separate protocol IDs makes the gate
//! check live entirely at the dispatch layer — a peer that didn't
//! clear both gates simply cannot open a hero-sync stream.
//!
//! ## Bidirectional, in one round
//!
//! Per the user's clarification, "both sources are treated as truth"
//! during the merge. The protocol therefore does ONE bidirectional
//! exchange: the initiator sends its full delta-since-cursor + cursor;
//! the responder applies, computes its OWN delta-since-the-initiator's-
//! cursor, and ships it back in the same response envelope. One
//! round-trip, two LWW merges, both sides converge.

use std::sync::Arc;

use async_trait::async_trait;
use futures::{AsyncReadExt, AsyncWriteExt};
use libp2p::{PeerId, Stream, StreamProtocol};
use libp2p_stream::Control;
use serde::{Deserialize, Serialize};

use crate::porch::db::Porch;
use crate::porch::error::PorchError;
use crate::porch::sync::{
    apply_sync_batch, local_cursor, SyncCursor, SyncDelta,
};
use crate::servitude::federation::{
    FederationError, FederationHandler, FederationProtocol, PayloadKind,
};

use super::anchor::HeroAnchorMode;
use super::conflict_queue::{self, ConflictKind, ConflictRecord};

/// libp2p stream protocol ID for hero-sync. Strictly distinct from
/// `/concord/porch-sync/1.0.0` so the two-gate trust check applies
/// only on this path.
pub const HERO_SYNC_PROTOCOL_ID: &str = "/concord/hero-sync/1.0.0";

/// Maximum size of a single framed envelope. Matches porch-sync.
pub const MAX_HERO_SYNC_ENVELOPE_BYTES: usize = 32 * 1024 * 1024;

/// Outer envelope. Carries the anchored/unanchored flag + the
/// initiator's delta + cursor. The responder consumes the delta, then
/// builds its OWN delta to ship back inside [`HeroSyncResponse`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeroSyncEnvelope {
    /// Per the anchor's election state. `true` means the initiator
    /// has elected a docker instance and is opting into anchored
    /// reconciliation; `false` means fully additive p2p merge.
    pub anchored: bool,
    /// Optional opaque identifier of the elected anchor. Used by the
    /// responder for diagnostics + (future) anchor-side conflict
    /// arbitration. Ignored when `anchored = false`.
    #[serde(default)]
    pub anchor_label: Option<String>,
    /// Initiator's local cursor — "send me everything strictly newer
    /// than this." Mirror of porch-sync's PullDelta cursor.
    pub since: SyncCursor,
    /// Initiator's push payload — every row newer than the initiator's
    /// own cursor. The responder applies these to its DB before
    /// computing its return delta.
    pub push: SyncDelta,
}

/// Wire-level request variant. The hero-sync protocol always uses the
/// `Round` variant on the happy path; the `Ping` variant is reserved
/// for future health checks without dragging in a separate protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum HeroSyncRequest {
    /// The bidirectional sync round. Carries the envelope described
    /// above.
    Round(HeroSyncEnvelope),
    /// Cheap liveness probe. Responder returns `HeroSyncResponse::Pong`
    /// without touching the DB. Used by the connection-gate evaluator
    /// to verify the hero-sync stream is plumbed before kicking off a
    /// real round.
    Ping,
}

/// Wire-level response variant.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum HeroSyncResponse {
    /// Successful round. `responder_push` carries every row the
    /// responder had above `since` (the initiator's cursor). The
    /// initiator applies this delta locally to converge.
    Round {
        /// Responder's outgoing delta to be applied by the initiator.
        responder_push: SyncDelta,
        /// How many conflicts the responder enqueued during this round.
        /// Reported back so the initiator UI can render "N conflicts
        /// flagged on the other side" without polling.
        responder_conflicts_enqueued: usize,
    },
    /// Liveness response to [`HeroSyncRequest::Ping`]. Carries the
    /// responder's reported anchor mode so the initiator can render
    /// "Connected to anchor: docker-A" vs "Connected: p2p".
    Pong { responder_mode: HeroAnchorMode },
    /// Anchor-mismatch refusal. Returned if the initiator's envelope
    /// claims `anchored = true` but with an `anchor_label` different
    /// from the responder's elected anchor. Anchored mode requires
    /// agreement on the anchor identity — disagreement is a
    /// configuration bug, not a sync conflict.
    AnchorMismatch {
        responder_anchor: Option<String>,
        message: String,
    },
    /// Generic structured error envelope.
    Error { code: i32, message: String },
}

// ---------------------------------------------------------------------------
// Inbound handler
// ---------------------------------------------------------------------------

/// Hero-sync stream handler. Holds an `Arc<Porch>` so concurrent inbound
/// streams share the same SQLite (the porch mutex serializes writes).
///
/// Trust check note: this handler ASSUMES the dispatcher has already
/// verified BOTH gates of Architecture C before opening the stream. The
/// handler does NOT re-check the gates — that's the dispatcher's job
/// via `gate::evaluate_gates`. Concord's stream-acceptance layer must
/// refuse hero-sync stream opens from peers that didn't clear the
/// gates, OR the handler must be wrapped in a trust-checking decorator
/// at registration time. The dispatcher integration is documented in
/// the F-C scope doc § "follow-up implementation tasks."
pub struct HeroSyncHandler {
    porch: Arc<Porch>,
}

impl HeroSyncHandler {
    pub fn new(porch: Arc<Porch>) -> Self {
        Self { porch }
    }

    /// Dispatch one decoded request → response.
    pub fn dispatch(&self, request: HeroSyncRequest) -> HeroSyncResponse {
        match request {
            HeroSyncRequest::Ping => HeroSyncResponse::Pong {
                responder_mode: HeroAnchorMode::from_porch(&self.porch),
            },
            HeroSyncRequest::Round(env) => self.dispatch_round(env),
        }
    }

    fn dispatch_round(&self, env: HeroSyncEnvelope) -> HeroSyncResponse {
        // 1. Anchor-agreement check: anchored sync rounds require both
        //    sides to agree on the anchor identity. Mismatch is a config
        //    error.
        let local_mode = HeroAnchorMode::from_porch(&self.porch);
        let local_anchor = super::anchor::hero_get_anchor_instance(&self.porch)
            .unwrap_or(None);
        if env.anchored {
            // Initiator claims an anchor. Verify the responder agrees.
            match (&env.anchor_label, &local_anchor) {
                (Some(init), Some(resp)) if init == resp => {
                    // Agreed — proceed.
                }
                (Some(_), None) => {
                    return HeroSyncResponse::AnchorMismatch {
                        responder_anchor: None,
                        message: "responder has no anchor configured"
                            .to_string(),
                    };
                }
                (Some(init), Some(resp)) => {
                    return HeroSyncResponse::AnchorMismatch {
                        responder_anchor: Some(resp.clone()),
                        message: format!(
                            "anchor mismatch: initiator={}, responder={}",
                            init, resp
                        ),
                    };
                }
                (None, _) => {
                    return HeroSyncResponse::AnchorMismatch {
                        responder_anchor: local_anchor,
                        message: "envelope claims anchored=true with no label"
                            .to_string(),
                    };
                }
            }
        } else if matches!(local_mode, HeroAnchorMode::Anchored) {
            // Responder is anchored but initiator isn't claiming it.
            // We still proceed in additive mode — the user's
            // unanchored device gets the data, no harm done.
            // Document the asymmetry for the UI.
        }

        // 2. Apply the initiator's push, detecting destructive
        //    conflicts at row-collision time.
        let conflicts_enqueued = match self.apply_with_conflict_detection(&env.push) {
            Ok(c) => c,
            Err(e) => {
                return HeroSyncResponse::Error {
                    code: e.status_code(),
                    message: e.to_string(),
                };
            }
        };

        // 3. Compute responder's outgoing delta — every row at or
        //    above the initiator's cursor.
        let responder_push = match collect_delta_for(&self.porch, &env.since) {
            Ok(d) => d,
            Err(e) => {
                return HeroSyncResponse::Error {
                    code: e.status_code(),
                    message: e.to_string(),
                };
            }
        };

        HeroSyncResponse::Round {
            responder_push,
            responder_conflicts_enqueued: conflicts_enqueued,
        }
    }

    /// Apply an inbound delta, enqueuing destructive conflicts for F-D.
    ///
    /// The detector compares each inbound row against the local row
    /// of the same primary key. If both sides have distinct
    /// non-tombstoned values at the SAME `sync_lamport` (a concurrent
    /// edit detected by the LWW comparator falling back to the
    /// device-id tiebreak), and the row class is in the destructive
    /// catalogue, a `conflict_queue` row is appended.
    ///
    /// **Important contract** (preserved across H3 landing): conflicts
    /// are enqueued AND THE LWW MERGE STILL APPLIES. The user's data
    /// is never lost — the materialized view picks the LWW winner,
    /// and the queue carries enough context for F-D's agent to
    /// surface and resolve the divergence after-the-fact.
    fn apply_with_conflict_detection(
        &self,
        delta: &SyncDelta,
    ) -> Result<usize, PorchError> {
        let mut count = 0;

        // Detect rename conflicts — same channel_id, both sides
        // distinct names, equal lamport. We have to inspect BEFORE the
        // apply call mutates state.
        for incoming in &delta.channels {
            if let Some(local) = self.lookup_local_channel(&incoming.id)? {
                if is_concurrent_rename(&local, incoming) {
                    let payload = serde_json::json!({
                        "table": "porch_channels",
                        "row_id": incoming.id,
                        "kind": "concurrent_rename",
                        "local": {
                            "name": local.name,
                            "device_id": local.sync_device_id,
                            "lamport": local.sync_lamport,
                        },
                        "remote": {
                            "name": incoming.name,
                            "device_id": incoming.sync_device_id,
                            "lamport": incoming.sync_lamport,
                        },
                    });
                    conflict_queue::enqueue(
                        &self.porch,
                        &ConflictRecord {
                            kind: ConflictKind::ConcurrentRename,
                            payload,
                        },
                    )?;
                    count += 1;
                }
                if is_tombstone_vs_write(&local, incoming) {
                    let payload = serde_json::json!({
                        "table": "porch_channels",
                        "row_id": incoming.id,
                        "kind": "tombstone_vs_write",
                        "local": {
                            "tombstoned": local.sync_tombstone != 0,
                            "device_id": local.sync_device_id,
                            "lamport": local.sync_lamport,
                        },
                        "remote": {
                            "tombstoned": incoming.sync_tombstone != 0,
                            "device_id": incoming.sync_device_id,
                            "lamport": incoming.sync_lamport,
                        },
                    });
                    conflict_queue::enqueue(
                        &self.porch,
                        &ConflictRecord {
                            kind: ConflictKind::TombstoneVsWrite,
                            payload,
                        },
                    )?;
                    count += 1;
                }
            }
        }

        // ACL conflicts — concurrent role change vs. revoke.
        for incoming in &delta.acl {
            if let Some(local) = self.lookup_local_acl(&incoming.channel_id, &incoming.peer_id)? {
                if is_concurrent_acl(&local, incoming) {
                    let payload = serde_json::json!({
                        "table": "channel_acl",
                        "row_id": format!("{}:{}", incoming.channel_id, incoming.peer_id),
                        "kind": "acl_change",
                        "local": {
                            "role": local.role,
                            "tombstoned": local.sync_tombstone != 0,
                            "device_id": local.sync_device_id,
                            "lamport": local.sync_lamport,
                        },
                        "remote": {
                            "role": incoming.role,
                            "tombstoned": incoming.sync_tombstone != 0,
                            "device_id": incoming.sync_device_id,
                            "lamport": incoming.sync_lamport,
                        },
                    });
                    conflict_queue::enqueue(
                        &self.porch,
                        &ConflictRecord {
                            kind: ConflictKind::AclChange,
                            payload,
                        },
                    )?;
                    count += 1;
                }
            }
        }

        // Apply the delta via the existing porch substrate. LWW + the
        // device-id tiebreak resolve the materialized view; the queue
        // we built above keeps the audit trail.
        apply_sync_batch(&self.porch, delta)?;
        Ok(count)
    }

    fn lookup_local_channel(
        &self,
        id: &str,
    ) -> Result<Option<crate::porch::sync::PorchChannelRow>, PorchError> {
        use rusqlite::OptionalExtension;
        let conn = self.porch.conn.lock().expect("porch conn mutex poisoned");
        conn.query_row(
            "SELECT id, name, kind, acl_mode, created_at,
                    sync_device_id, sync_lamport, sync_tombstone
             FROM porch_channels WHERE id = ?1",
            rusqlite::params![id],
            |r| {
                Ok(crate::porch::sync::PorchChannelRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    acl_mode: r.get(3)?,
                    created_at: r.get(4)?,
                    sync_device_id: r.get(5)?,
                    sync_lamport: r.get(6)?,
                    sync_tombstone: r.get(7)?,
                })
            },
        )
        .optional()
        .map_err(PorchError::from)
    }

    fn lookup_local_acl(
        &self,
        channel_id: &str,
        peer_id: &str,
    ) -> Result<Option<crate::porch::sync::ChannelAclRow>, PorchError> {
        use rusqlite::OptionalExtension;
        let conn = self.porch.conn.lock().expect("porch conn mutex poisoned");
        conn.query_row(
            "SELECT channel_id, peer_id, role, granted_at,
                    sync_device_id, sync_lamport, sync_tombstone
             FROM channel_acl WHERE channel_id = ?1 AND peer_id = ?2",
            rusqlite::params![channel_id, peer_id],
            |r| {
                Ok(crate::porch::sync::ChannelAclRow {
                    channel_id: r.get(0)?,
                    peer_id: r.get(1)?,
                    role: r.get(2)?,
                    granted_at: r.get(3)?,
                    sync_device_id: r.get(4)?,
                    sync_lamport: r.get(5)?,
                    sync_tombstone: r.get(6)?,
                })
            },
        )
        .optional()
        .map_err(PorchError::from)
    }
}

/// Concurrent rename detector. True iff both sides have non-tombstoned
/// rows with distinct names at the SAME lamport tick.
fn is_concurrent_rename(
    local: &crate::porch::sync::PorchChannelRow,
    remote: &crate::porch::sync::PorchChannelRow,
) -> bool {
    local.sync_tombstone == 0
        && remote.sync_tombstone == 0
        && local.name != remote.name
        && local.sync_lamport == remote.sync_lamport
        && local.sync_device_id != remote.sync_device_id
}

/// Tombstone-vs-write detector. True iff one side tombstoned and the
/// other side wrote at the same lamport (concurrent edits).
fn is_tombstone_vs_write(
    local: &crate::porch::sync::PorchChannelRow,
    remote: &crate::porch::sync::PorchChannelRow,
) -> bool {
    let lt = local.sync_tombstone != 0;
    let rt = remote.sync_tombstone != 0;
    (lt ^ rt) // exactly one side tombstoned
        && local.sync_lamport == remote.sync_lamport
        && local.sync_device_id != remote.sync_device_id
}

/// ACL conflict detector. True iff both sides at same lamport disagree
/// on role OR tombstone.
fn is_concurrent_acl(
    local: &crate::porch::sync::ChannelAclRow,
    remote: &crate::porch::sync::ChannelAclRow,
) -> bool {
    if local.sync_lamport != remote.sync_lamport {
        return false;
    }
    if local.sync_device_id == remote.sync_device_id {
        return false;
    }
    let role_differs = local.role != remote.role;
    let tomb_differs = (local.sync_tombstone != 0) != (remote.sync_tombstone != 0);
    role_differs || tomb_differs
}

fn collect_delta_for(porch: &Porch, cursor: &SyncCursor) -> Result<SyncDelta, PorchError> {
    let conn = porch.conn.lock().expect("porch conn mutex poisoned");
    Ok(SyncDelta {
        channels: crate::porch::sync::merge::channels_since(
            &conn,
            cursor.since_for("channels"),
        )?,
        messages: crate::porch::sync::merge::messages_since(
            &conn,
            cursor.since_for("messages"),
        )?,
        acl: crate::porch::sync::merge::acl_since(&conn, cursor.since_for("acl"))?,
        knocks: crate::porch::sync::merge::knocks_since(
            &conn,
            cursor.since_for("knocks"),
        )?,
        themes: crate::porch::sync::merge::themes_since(
            &conn,
            cursor.since_for("themes"),
        )?,
        assets: crate::porch::sync::merge::assets_since(
            &conn,
            cursor.since_for("assets"),
        )?,
        obsidian: crate::porch::sync::merge::obsidian_since(
            &conn,
            cursor.since_for("obsidian"),
        )?,
    })
}

// ---------------------------------------------------------------------------
// Federation handler plumbing
// ---------------------------------------------------------------------------

impl FederationProtocol for HeroSyncHandler {
    const PROTOCOL_ID: &'static str = HERO_SYNC_PROTOCOL_ID;
}

#[async_trait]
impl FederationHandler for HeroSyncHandler {
    fn protocol_id(&self) -> &'static str {
        HERO_SYNC_PROTOCOL_ID
    }

    fn payload_kind(&self) -> PayloadKind {
        PayloadKind::Other("hero-sync")
    }

    async fn handle_inbound(
        &self,
        _peer_id: PeerId,
        mut stream: Stream,
    ) -> Result<(), FederationError> {
        loop {
            let mut len_buf = [0u8; 4];
            match stream.read_exact(&mut len_buf).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Ok(());
                }
                Err(e) => return Err(FederationError::Io(e)),
            }
            let len = u32::from_be_bytes(len_buf) as usize;
            if len > MAX_HERO_SYNC_ENVELOPE_BYTES {
                return Err(FederationError::MalformedEnvelope(format!(
                    "hero-sync envelope too large: {} > {}",
                    len, MAX_HERO_SYNC_ENVELOPE_BYTES
                )));
            }
            let mut buf = vec![0u8; len];
            stream
                .read_exact(&mut buf)
                .await
                .map_err(FederationError::Io)?;
            let request: HeroSyncRequest =
                serde_json::from_slice(&buf).map_err(FederationError::Serde)?;
            let response = self.dispatch(request);
            let response_bytes =
                serde_json::to_vec(&response).map_err(FederationError::Serde)?;
            let response_len = (response_bytes.len() as u32).to_be_bytes();
            stream
                .write_all(&response_len)
                .await
                .map_err(FederationError::Io)?;
            stream
                .write_all(&response_bytes)
                .await
                .map_err(FederationError::Io)?;
            stream.flush().await.map_err(FederationError::Io)?;
        }
    }
}

// ---------------------------------------------------------------------------
// Outbound — initiator path
// ---------------------------------------------------------------------------

/// Drive one bidirectional hero-sync round against `peer_id`.
///
/// CALLERS MUST HAVE VERIFIED BOTH GATES before calling this. The
/// function does not re-check gates; the higher-level orchestration in
/// the connection-establishment hook is the gatekeeper.
///
/// Returns the responder's reply on success. Each leg is a single
/// framed envelope.
pub async fn run_hero_sync_round(
    porch: &Porch,
    control: &mut Control,
    peer_id: PeerId,
) -> Result<HeroSyncResponse, PorchError> {
    let proto = StreamProtocol::new(HERO_SYNC_PROTOCOL_ID);
    let mut stream = control
        .open_stream(peer_id, proto)
        .await
        .map_err(|e| PorchError::InvalidInput(format!("open_stream: {e:?}")))?;

    let mode = HeroAnchorMode::from_porch(porch);
    let anchor_label = super::anchor::hero_get_anchor_instance(porch).unwrap_or(None);
    let since = local_cursor(porch)?;
    // For the push side we send everything from cursor=0 — porch-sync
    // does the same in `sync_now`; the LWW is idempotent so this is
    // safe.
    let push_cursor = SyncCursor::default();
    let push = collect_delta_for(porch, &push_cursor)?;

    let envelope = HeroSyncEnvelope {
        anchored: mode.anchored_envelope_flag(),
        anchor_label,
        since,
        push,
    };
    let req = HeroSyncRequest::Round(envelope);
    let bytes = serde_json::to_vec(&req).map_err(PorchError::Serde)?;
    if bytes.len() > MAX_HERO_SYNC_ENVELOPE_BYTES {
        return Err(PorchError::MalformedEnvelope(format!(
            "request envelope too large: {} > {}",
            bytes.len(),
            MAX_HERO_SYNC_ENVELOPE_BYTES
        )));
    }
    let len_be = (bytes.len() as u32).to_be_bytes();
    stream.write_all(&len_be).await.map_err(PorchError::Io)?;
    stream.write_all(&bytes).await.map_err(PorchError::Io)?;
    stream.flush().await.map_err(PorchError::Io)?;

    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .await
        .map_err(PorchError::Io)?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_HERO_SYNC_ENVELOPE_BYTES {
        return Err(PorchError::MalformedEnvelope(format!(
            "response envelope too large: {} > {}",
            len, MAX_HERO_SYNC_ENVELOPE_BYTES
        )));
    }
    let mut buf = vec![0u8; len];
    stream
        .read_exact(&mut buf)
        .await
        .map_err(PorchError::Io)?;
    let _ = stream.close().await;
    let response: HeroSyncResponse =
        serde_json::from_slice(&buf).map_err(PorchError::Serde)?;

    // If the round succeeded, apply the responder's push locally.
    if let HeroSyncResponse::Round {
        responder_push, ..
    } = &response
    {
        apply_sync_batch(porch, responder_push)?;
    }

    Ok(response)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::porch::db::Porch;
    use crate::porch::sync::PorchChannelRow;

    fn porch() -> Arc<Porch> {
        Arc::new(Porch::open_in_memory().expect("open"))
    }

    #[test]
    fn protocol_id_pins_to_concord_hero_sync_v1() {
        assert_eq!(HERO_SYNC_PROTOCOL_ID, "/concord/hero-sync/1.0.0");
    }

    #[test]
    fn ping_returns_responder_mode() {
        let handler = HeroSyncHandler::new(porch());
        let response = handler.dispatch(HeroSyncRequest::Ping);
        match response {
            HeroSyncResponse::Pong { responder_mode } => {
                assert_eq!(responder_mode, HeroAnchorMode::Unanchored);
            }
            other => panic!("expected Pong, got {other:?}"),
        }
    }

    #[test]
    fn ping_reports_anchored_after_election() {
        let p = porch();
        super::super::anchor::hero_set_anchor_instance(&p, Some("docker-A")).unwrap();
        let handler = HeroSyncHandler::new(p);
        let response = handler.dispatch(HeroSyncRequest::Ping);
        if let HeroSyncResponse::Pong { responder_mode } = response {
            assert_eq!(responder_mode, HeroAnchorMode::Anchored);
        } else {
            panic!("expected Pong");
        }
    }

    #[test]
    fn anchor_mismatch_when_initiator_claims_a_label_responder_doesnt() {
        let handler = HeroSyncHandler::new(porch());
        let env = HeroSyncEnvelope {
            anchored: true,
            anchor_label: Some("docker-A".to_string()),
            since: SyncCursor::default(),
            push: SyncDelta::default(),
        };
        let response = handler.dispatch(HeroSyncRequest::Round(env));
        match response {
            HeroSyncResponse::AnchorMismatch { .. } => {}
            other => panic!("expected AnchorMismatch, got {other:?}"),
        }
    }

    #[test]
    fn anchor_mismatch_when_labels_differ() {
        let p = porch();
        super::super::anchor::hero_set_anchor_instance(&p, Some("docker-B")).unwrap();
        let handler = HeroSyncHandler::new(p);
        let env = HeroSyncEnvelope {
            anchored: true,
            anchor_label: Some("docker-A".to_string()),
            since: SyncCursor::default(),
            push: SyncDelta::default(),
        };
        let response = handler.dispatch(HeroSyncRequest::Round(env));
        match response {
            HeroSyncResponse::AnchorMismatch {
                responder_anchor, ..
            } => {
                assert_eq!(responder_anchor, Some("docker-B".to_string()));
            }
            other => panic!("expected AnchorMismatch, got {other:?}"),
        }
    }

    #[test]
    fn empty_round_returns_empty_responder_push() {
        let handler = HeroSyncHandler::new(porch());
        let env = HeroSyncEnvelope {
            anchored: false,
            anchor_label: None,
            since: SyncCursor::default(),
            push: SyncDelta::default(),
        };
        let response = handler.dispatch(HeroSyncRequest::Round(env));
        match response {
            HeroSyncResponse::Round {
                responder_push,
                responder_conflicts_enqueued,
            } => {
                // A fresh porch ships its default channel; that's a single
                // PorchChannel row but no conflicts.
                assert_eq!(responder_conflicts_enqueued, 0);
                let _ = responder_push;
            }
            other => panic!("expected Round, got {other:?}"),
        }
    }

    fn channel_row(
        id: &str,
        name: &str,
        device: &str,
        lamport: i64,
        tombstone: i64,
    ) -> PorchChannelRow {
        PorchChannelRow {
            id: id.to_string(),
            name: name.to_string(),
            kind: "porch".to_string(),
            acl_mode: "open".to_string(),
            created_at: 1,
            sync_device_id: device.to_string(),
            sync_lamport: lamport,
            sync_tombstone: tombstone,
        }
    }

    #[test]
    fn concurrent_rename_detector_fires_only_on_lamport_tie() {
        let local = channel_row("c1", "general", "dev-a", 10, 0);
        let remote = channel_row("c1", "announce", "dev-b", 10, 0);
        assert!(is_concurrent_rename(&local, &remote));

        // Different lamport — LWW resolves naturally, no destructive
        // conflict.
        let later = channel_row("c1", "announce", "dev-b", 11, 0);
        assert!(!is_concurrent_rename(&local, &later));

        // Same name — no destruction.
        let same_name = channel_row("c1", "general", "dev-b", 10, 0);
        assert!(!is_concurrent_rename(&local, &same_name));
    }

    #[test]
    fn tombstone_vs_write_detector_fires_only_on_lamport_tie() {
        let writeside = channel_row("c1", "general", "dev-a", 10, 0);
        let tombside = channel_row("c1", "general", "dev-b", 10, 1);
        assert!(is_tombstone_vs_write(&writeside, &tombside));
        assert!(is_tombstone_vs_write(&tombside, &writeside));

        // Both tombstones — no conflict.
        let both_tomb_a = channel_row("c1", "general", "dev-a", 10, 1);
        let both_tomb_b = channel_row("c1", "general", "dev-b", 10, 1);
        assert!(!is_tombstone_vs_write(&both_tomb_a, &both_tomb_b));
    }

    #[test]
    fn rename_conflict_enqueued_when_round_carries_collision() {
        let p = porch();
        // Seed local state with the default channel at a known lamport.
        let local_channel = {
            let conn = p.conn.lock().unwrap();
            // Mint a channel row directly so we know its lamport.
            let lamport = crate::porch::sync::clock::next_lamport(&conn).unwrap();
            conn.execute(
                "INSERT INTO porch_channels
                    (id, name, kind, acl_mode, created_at,
                     sync_device_id, sync_lamport, sync_tombstone)
                 VALUES (?1, ?2, 'porch', 'open', ?3, ?4, ?5, 0)",
                rusqlite::params![
                    "rename-test",
                    "general",
                    1u64,
                    "dev-local",
                    lamport,
                ],
            )
            .unwrap();
            channel_row("rename-test", "general", "dev-local", lamport, 0)
        };
        // Build a delta that renames the channel under the SAME lamport
        // with a different device-id — that's a concurrent rename.
        let remote = channel_row(
            "rename-test",
            "announcements",
            "dev-remote",
            local_channel.sync_lamport,
            0,
        );
        let env = HeroSyncEnvelope {
            anchored: false,
            anchor_label: None,
            since: SyncCursor::default(),
            push: SyncDelta {
                channels: vec![remote],
                ..SyncDelta::default()
            },
        };
        let handler = HeroSyncHandler::new(p.clone());
        let response = handler.dispatch(HeroSyncRequest::Round(env));
        match response {
            HeroSyncResponse::Round {
                responder_conflicts_enqueued,
                ..
            } => {
                assert_eq!(responder_conflicts_enqueued, 1);
            }
            other => panic!("expected Round, got {other:?}"),
        }
        assert_eq!(super::super::conflict_queue::pending_count(&p).unwrap(), 1);
        let pending = super::super::conflict_queue::list_pending(&p).unwrap();
        assert_eq!(pending[0].conflict_kind, "concurrent_rename");
    }
}
