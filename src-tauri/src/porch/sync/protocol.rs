//! Porch Phase F — libp2p protocol handler for porch-state sync.
//!
//! Protocol ID: `/concord/porch-sync/1.0.0`. Distinct from
//! `/concord/porch/1.0.0` (Phase A–D content protocol) and
//! `/concord/porch-backup/1.0.0` (Phase E backup protocol). Trust
//! boundaries diverge:
//!
//! * porch — visitors with ACL grants on individual channels.
//! * porch-backup — peers with the user's explicit opt-in to hold
//!   encrypted blobs.
//! * **porch-sync** — peers the user has marked as "personal devices
//!   of mine". A sync request from a peer not in `device_links` is
//!   refused at the handler layer.
//!
//! Wire shape: 4-byte BE length prefix + JSON body, same framing as
//! the other porch protocols. Envelope cap is 32 MiB — large enough
//! for a multi-thousand-row catch-up batch on a heavily-used porch
//! but bounded so a malicious peer can't exhaust memory.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use futures::{AsyncReadExt, AsyncWriteExt};
use libp2p::{PeerId, Stream, StreamProtocol};
use libp2p_stream::Control;
use serde::{Deserialize, Serialize};

use crate::porch::db::{unix_millis, Porch};
use crate::porch::error::PorchError;
use crate::servitude::federation::{
    FederationError, FederationHandler, FederationProtocol, PayloadKind,
};

use super::clock;
use super::device::DeviceLink;
use super::merge::{
    self, ApplyCounts, ChannelAclRow, ChannelKnockRow, ChannelMessageRow,
    ChannelThemeRow, ObsidianChannelRow, PorchAssetRow, PorchChannelRow,
};

/// libp2p stream protocol ID for porch-state sync. Distinct namespace
/// so the trust check (personal device only) lives entirely on this
/// path.
pub const SYNC_PROTOCOL_ID: &str = "/concord/porch-sync/1.0.0";

/// Maximum size of a single framed envelope. 32 MiB allows a deep
/// catch-up batch (thousands of messages + ACL + theme rows) without
/// chunking; smaller writes naturally use much less.
pub const MAX_SYNC_ENVELOPE_BYTES: usize = 32 * 1024 * 1024;

/// Phase F sync request envelope.
///
/// `LinkRequest` is the bootstrap method — both peers call it during
/// pairing. Each side records the OTHER side's `(peer_id, device_id)`
/// in `device_links`. Subsequent `PullDelta` / `PushDelta` calls are
/// rejected by the handler unless the requester is already linked
/// here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum SyncRequest {
    /// Bootstrap link handshake. The local peer announces its
    /// device-id (a ULID) and an optional label. The responder learns
    /// the (peer_id, device_id) pair but does NOT auto-insert into
    /// its own `device_links` — the user on the responder side has to
    /// also call `link_personal_device` from its own UI.
    LinkRequest {
        my_device_id: String,
        label: Option<String>,
    },
    /// Ask the responder for every row newer than `since[table]` per
    /// table. Returns a SyncDelta of rows the responder authored OR
    /// has applied from any device (the cursor is a watermark over
    /// ALL devices' work, not just this pair's).
    PullDelta {
        since: SyncCursor,
    },
    /// Push deltas from the caller's local state to the responder.
    /// The responder applies via merge.rs apply_remote_* functions and
    /// returns counts of rows that actually changed (vs. lost LWW).
    PushDelta {
        delta: SyncDelta,
    },
}

/// Per-table cursor. Caller asks for rows with `sync_lamport > since[table]`.
/// Tables not present in `since` are treated as "since 0" (full pull).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncCursor {
    pub since: HashMap<String, i64>,
}

impl SyncCursor {
    pub fn since_for(&self, table: &str) -> i64 {
        self.since.get(table).copied().unwrap_or(0)
    }
}

/// Bundle of rows from every CRDT-tracked table.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncDelta {
    pub channels: Vec<PorchChannelRow>,
    pub messages: Vec<ChannelMessageRow>,
    pub acl: Vec<ChannelAclRow>,
    pub knocks: Vec<ChannelKnockRow>,
    pub themes: Vec<ChannelThemeRow>,
    pub assets: Vec<PorchAssetRow>,
    pub obsidian: Vec<ObsidianChannelRow>,
}

impl SyncDelta {
    pub fn is_empty(&self) -> bool {
        self.channels.is_empty()
            && self.messages.is_empty()
            && self.acl.is_empty()
            && self.knocks.is_empty()
            && self.themes.is_empty()
            && self.assets.is_empty()
            && self.obsidian.is_empty()
    }
}

/// Response envelope. Exactly one of `result` / `error` is populated.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SyncErrorBody>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncErrorBody {
    pub code: i32,
    pub message: String,
}

impl SyncResponse {
    fn from_result(value: serde_json::Value) -> Self {
        Self {
            ok: true,
            result: Some(value),
            error: None,
        }
    }
    fn from_error(err: PorchError) -> Self {
        let code = err.status_code();
        Self {
            ok: false,
            result: None,
            error: Some(SyncErrorBody {
                code,
                message: err.to_string(),
            }),
        }
    }
}

/// Successful `LinkRequest` response — the responder hands back its
/// own device-id so the caller can record it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkResponse {
    pub my_device_id: String,
    pub label: Option<String>,
}

/// Per-table counts returned by `PushDelta` — rows the responder
/// actually wrote (excludes rows that lost LWW).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PushResult {
    pub applied: HashMap<String, i64>,
}

impl PushResult {
    pub fn from_counts(counts: &ApplyCounts) -> Self {
        let mut applied = HashMap::new();
        applied.insert("channels".to_string(), counts.channels);
        applied.insert("messages".to_string(), counts.messages);
        applied.insert("acl".to_string(), counts.acl);
        applied.insert("knocks".to_string(), counts.knocks);
        applied.insert("themes".to_string(), counts.themes);
        applied.insert("assets".to_string(), counts.assets);
        applied.insert("obsidian".to_string(), counts.obsidian);
        Self { applied }
    }
}

/// Inbound handler. Holds an `Arc<Porch>` so concurrent inbound streams
/// share the same SQLite (the porch mutex serializes writes).
pub struct SyncHandler {
    porch: Arc<Porch>,
}

impl SyncHandler {
    pub fn new(porch: Arc<Porch>) -> Self {
        Self { porch }
    }

    pub fn dispatch(&self, requester: PeerId, request: SyncRequest) -> SyncResponse {
        match self.dispatch_inner(requester, request) {
            Ok(v) => SyncResponse::from_result(v),
            Err(e) => SyncResponse::from_error(e),
        }
    }

    fn dispatch_inner(
        &self,
        requester: PeerId,
        request: SyncRequest,
    ) -> Result<serde_json::Value, PorchError> {
        let requester_str = requester.to_base58();
        match request {
            SyncRequest::LinkRequest {
                my_device_id,
                label,
            } => {
                // LinkRequest does NOT auto-insert into the responder's
                // device_links — the responder's user must independently
                // call `link_personal_device`. We return our own
                // device-id so the requester can record the pair on
                // their side once their UI signs off.
                let my = self.porch.device_id()?;
                // Defensive: refuse if a different peer has already
                // claimed this device_id locally (would indicate a
                // device-id collision or impersonation attempt).
                let links = self.porch.list_device_links()?;
                for existing in &links {
                    if existing.device_id == my_device_id
                        && existing.peer_id != requester_str
                    {
                        return Err(PorchError::AccessDenied {
                            channel_id: format!(
                                "device_id {} already linked to peer {}",
                                my_device_id, existing.peer_id
                            ),
                        });
                    }
                }
                let _ = label;
                Ok(serde_json::to_value(LinkResponse {
                    my_device_id: my,
                    label: None,
                })?)
            }
            SyncRequest::PullDelta { since } => {
                self.assert_linked(&requester_str)?;
                let delta = self.collect_delta(&since)?;
                Ok(serde_json::to_value(delta)?)
            }
            SyncRequest::PushDelta { delta } => {
                self.assert_linked(&requester_str)?;
                let counts = apply_sync_batch(&self.porch, &delta)?;
                Ok(serde_json::to_value(PushResult::from_counts(&counts))?)
            }
        }
    }

    fn assert_linked(&self, requester: &str) -> Result<(), PorchError> {
        if self.porch.is_personal_device(requester)? {
            Ok(())
        } else {
            Err(PorchError::AccessDenied {
                channel_id: format!(
                    "peer {} is not a linked personal device",
                    requester
                ),
            })
        }
    }

    fn collect_delta(&self, cursor: &SyncCursor) -> Result<SyncDelta, PorchError> {
        let conn = self.porch.conn.lock().expect("porch conn mutex poisoned");
        Ok(SyncDelta {
            channels: merge::channels_since(&conn, cursor.since_for("channels"))?,
            messages: merge::messages_since(&conn, cursor.since_for("messages"))?,
            acl: merge::acl_since(&conn, cursor.since_for("acl"))?,
            knocks: merge::knocks_since(&conn, cursor.since_for("knocks"))?,
            themes: merge::themes_since(&conn, cursor.since_for("themes"))?,
            assets: merge::assets_since(&conn, cursor.since_for("assets"))?,
            obsidian: merge::obsidian_since(&conn, cursor.since_for("obsidian"))?,
        })
    }
}

/// Apply a SyncDelta against the local porch, atomically.
///
/// Each row is run through its per-table `apply_remote_*` function
/// inside one outer transaction. If any apply fails (e.g. FK violation,
/// SQL error), the whole batch rolls back.
///
/// Returns per-table counts of rows that actually wrote (i.e. that won
/// LWW or were inserted as new). Rows that lost LWW silently drop.
pub fn apply_sync_batch(
    porch: &Porch,
    delta: &SyncDelta,
) -> Result<ApplyCounts, PorchError> {
    let mut conn = porch.conn.lock().expect("porch conn mutex poisoned");
    let tx = conn.transaction()?;
    let mut counts = ApplyCounts::default();
    for row in &delta.channels {
        if merge::apply_remote_channel(&tx, row)? {
            counts.channels += 1;
        }
    }
    // Messages and ACL reference channel rows by id. The remote may
    // have minted a new channel at a higher lamport than any local
    // row — that's why channels are applied first. Even so, FK
    // enforcement matters: if a remote pushes only a message but not
    // its channel, the INSERT would fail. The protocol-level invariant
    // is that PushDelta includes the FK-parent rows when needed; the
    // tests verify the happy path.
    for row in &delta.messages {
        if merge::apply_remote_message(&tx, row)? {
            counts.messages += 1;
        }
    }
    for row in &delta.acl {
        if merge::apply_remote_acl(&tx, row)? {
            counts.acl += 1;
        }
    }
    for row in &delta.knocks {
        if merge::apply_remote_knock(&tx, row)? {
            counts.knocks += 1;
        }
    }
    for row in &delta.themes {
        if merge::apply_remote_theme(&tx, row)? {
            counts.themes += 1;
        }
    }
    for row in &delta.assets {
        if merge::apply_remote_asset(&tx, row)? {
            counts.assets += 1;
        }
    }
    for row in &delta.obsidian {
        if merge::apply_remote_obsidian(&tx, row)? {
            counts.obsidian += 1;
        }
    }
    tx.commit()?;
    Ok(counts)
}

/// Build the cursor representing "everything we've ever seen, per
/// table". Used by the local side to ask the remote for deltas since
/// our high-watermark.
pub fn local_cursor(porch: &Porch) -> Result<SyncCursor, PorchError> {
    let conn = porch.conn.lock().expect("porch conn mutex poisoned");
    let mut since = HashMap::new();
    for (key, table) in [
        ("channels", "porch_channels"),
        ("messages", "channel_messages"),
        ("acl", "channel_acl"),
        ("knocks", "channel_knocks"),
        ("themes", "channel_themes"),
        ("assets", "porch_assets"),
        ("obsidian", "obsidian_channels"),
    ] {
        let sql = format!("SELECT COALESCE(MAX(sync_lamport), 0) FROM {table}");
        let v: i64 = conn.query_row(&sql, [], |r| r.get(0))?;
        since.insert(key.to_string(), v);
    }
    Ok(SyncCursor { since })
}

impl FederationProtocol for SyncHandler {
    const PROTOCOL_ID: &'static str = SYNC_PROTOCOL_ID;
}

#[async_trait]
impl FederationHandler for SyncHandler {
    fn protocol_id(&self) -> &'static str {
        SYNC_PROTOCOL_ID
    }

    fn payload_kind(&self) -> PayloadKind {
        PayloadKind::Other("porch-sync")
    }

    async fn handle_inbound(
        &self,
        peer_id: PeerId,
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
            if len > MAX_SYNC_ENVELOPE_BYTES {
                return Err(FederationError::MalformedEnvelope(format!(
                    "sync envelope too large: {} > {}",
                    len, MAX_SYNC_ENVELOPE_BYTES
                )));
            }
            let mut buf = vec![0u8; len];
            stream
                .read_exact(&mut buf)
                .await
                .map_err(FederationError::Io)?;
            let request: SyncRequest =
                serde_json::from_slice(&buf).map_err(FederationError::Serde)?;
            let response = self.dispatch(peer_id, request);
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

/// Open a single sync stream, send a request, decode the response.
async fn send_one(
    control: &mut Control,
    peer_id: PeerId,
    request: SyncRequest,
) -> Result<SyncResponse, PorchError> {
    let proto = StreamProtocol::new(SYNC_PROTOCOL_ID);
    let mut stream = control
        .open_stream(peer_id, proto)
        .await
        .map_err(|e| PorchError::InvalidInput(format!("open_stream: {e:?}")))?;
    let bytes = serde_json::to_vec(&request).map_err(PorchError::Serde)?;
    if bytes.len() > MAX_SYNC_ENVELOPE_BYTES {
        return Err(PorchError::MalformedEnvelope(format!(
            "request envelope too large: {} > {}",
            bytes.len(),
            MAX_SYNC_ENVELOPE_BYTES
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
    if len > MAX_SYNC_ENVELOPE_BYTES {
        return Err(PorchError::MalformedEnvelope(format!(
            "response envelope too large: {} > {}",
            len, MAX_SYNC_ENVELOPE_BYTES
        )));
    }
    let mut buf = vec![0u8; len];
    stream
        .read_exact(&mut buf)
        .await
        .map_err(PorchError::Io)?;
    let _ = stream.close().await;
    let response: SyncResponse = serde_json::from_slice(&buf).map_err(PorchError::Serde)?;
    Ok(response)
}

fn decode_or_error<T: serde::de::DeserializeOwned>(
    response: SyncResponse,
) -> Result<T, PorchError> {
    if response.ok {
        let value = response.result.unwrap_or(serde_json::Value::Null);
        serde_json::from_value(value).map_err(PorchError::Serde)
    } else {
        let body = response
            .error
            .ok_or_else(|| PorchError::MalformedEnvelope("missing error".to_string()))?;
        Err(match body.code {
            403 => PorchError::AccessDenied {
                channel_id: body.message,
            },
            404 => PorchError::ChannelNotFound {
                channel_id: body.message,
            },
            _ => PorchError::InvalidInput(body.message),
        })
    }
}

/// Outbound: send a LinkRequest to the remote peer. Caller is expected
/// to be running its own UI flow that records the resulting `DeviceLink`
/// via [`Porch::link_personal_device`].
pub async fn visit_link_request(
    control: &mut Control,
    peer_id: PeerId,
    my_device_id: String,
    label: Option<String>,
) -> Result<LinkResponse, PorchError> {
    let response = send_one(
        control,
        peer_id,
        SyncRequest::LinkRequest {
            my_device_id,
            label,
        },
    )
    .await?;
    decode_or_error::<LinkResponse>(response)
}

/// Outbound: PullDelta. The caller passes the cursor that represents
/// what they've already absorbed; the responder returns rows newer
/// than that.
pub async fn visit_pull_delta(
    control: &mut Control,
    peer_id: PeerId,
    cursor: SyncCursor,
) -> Result<SyncDelta, PorchError> {
    let response = send_one(control, peer_id, SyncRequest::PullDelta { since: cursor })
        .await?;
    decode_or_error::<SyncDelta>(response)
}

/// Outbound: PushDelta. Returns per-table counts of rows the remote
/// actually wrote.
pub async fn visit_push_delta(
    control: &mut Control,
    peer_id: PeerId,
    delta: SyncDelta,
) -> Result<PushResult, PorchError> {
    let response =
        send_one(control, peer_id, SyncRequest::PushDelta { delta }).await?;
    decode_or_error::<PushResult>(response)
}

// ---------------------------------------------------------------------------
// High-level sync_now — one round of pull-then-push against `peer_id`.
// ---------------------------------------------------------------------------

/// Per-call summary returned by `sync_now`. Used by the Tauri command
/// surface to drive the "Sync now" button UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncReport {
    pub peer_id: String,
    pub pulled_count_per_table: HashMap<String, i64>,
    pub pushed_count_per_table: HashMap<String, i64>,
    pub error: Option<String>,
}

impl SyncReport {
    pub fn empty(peer_id: String) -> Self {
        Self {
            peer_id,
            pulled_count_per_table: HashMap::new(),
            pushed_count_per_table: HashMap::new(),
            error: None,
        }
    }
}

/// Drive one pull-then-push round against `peer_id`. Returns a
/// SyncReport with per-table counts. Errors are wrapped into
/// `report.error` rather than propagated so the caller can keep
/// iterating across multiple devices.
pub async fn sync_now(
    porch: &Porch,
    control: &mut Control,
    peer_id: PeerId,
) -> SyncReport {
    let peer_str = peer_id.to_base58();
    let mut report = SyncReport::empty(peer_str.clone());

    // Refuse early if the peer isn't linked. Saves a round-trip on
    // accidental sync calls.
    match porch.is_personal_device(&peer_str) {
        Ok(true) => {}
        Ok(false) => {
            report.error = Some(format!(
                "peer {} is not a linked personal device",
                peer_str
            ));
            return report;
        }
        Err(e) => {
            report.error = Some(e.to_string());
            return report;
        }
    }

    // PULL — ask remote for everything newer than our local watermark.
    let cursor = match local_cursor(porch) {
        Ok(c) => c,
        Err(e) => {
            report.error = Some(format!("local cursor: {e}"));
            return report;
        }
    };
    let pulled = match visit_pull_delta(control, peer_id, cursor).await {
        Ok(d) => d,
        Err(e) => {
            report.error = Some(format!("pull: {e}"));
            return report;
        }
    };
    let pulled_counts = match apply_sync_batch(porch, &pulled) {
        Ok(c) => c,
        Err(e) => {
            report.error = Some(format!("apply pull: {e}"));
            return report;
        }
    };
    report.pulled_count_per_table = counts_map(&pulled_counts);

    // PUSH — collect our state from above the cursor we just used
    // and send it. The remote's apply may drop some rows to LWW; that's
    // fine — they win where they have a higher (lamport, device_id).
    //
    // For the push direction, we send everything newer than our
    // PRE-pull cursor — i.e. starting from zero on the first sync,
    // or starting from `last_sync_lamport` on subsequent syncs.
    // Resending rows the remote already has is harmless: they'll
    // either be no-ops (equal lamport) or LWW-resolved.
    let push_cursor = SyncCursor::default(); // full push on every sync; could be optimized
    let to_push = match collect_local_delta(porch, &push_cursor) {
        Ok(d) => d,
        Err(e) => {
            report.error = Some(format!("collect push: {e}"));
            return report;
        }
    };
    let pushed = match visit_push_delta(control, peer_id, to_push).await {
        Ok(p) => p,
        Err(e) => {
            report.error = Some(format!("push: {e}"));
            return report;
        }
    };
    report.pushed_count_per_table = pushed.applied;

    // Record success. Advance the watermark to the max lamport we
    // observed in either direction.
    let max_lamport = match clock::observed_max(
        &porch.conn.lock().expect("porch conn mutex poisoned"),
    ) {
        Ok(m) => m,
        Err(_) => 0,
    };
    let _ = porch.record_sync_success(&peer_str, unix_millis(), max_lamport);
    report
}

fn collect_local_delta(porch: &Porch, cursor: &SyncCursor) -> Result<SyncDelta, PorchError> {
    let conn = porch.conn.lock().expect("porch conn mutex poisoned");
    Ok(SyncDelta {
        channels: merge::channels_since(&conn, cursor.since_for("channels"))?,
        messages: merge::messages_since(&conn, cursor.since_for("messages"))?,
        acl: merge::acl_since(&conn, cursor.since_for("acl"))?,
        knocks: merge::knocks_since(&conn, cursor.since_for("knocks"))?,
        themes: merge::themes_since(&conn, cursor.since_for("themes"))?,
        assets: merge::assets_since(&conn, cursor.since_for("assets"))?,
        obsidian: merge::obsidian_since(&conn, cursor.since_for("obsidian"))?,
    })
}

fn counts_map(counts: &ApplyCounts) -> HashMap<String, i64> {
    let mut m = HashMap::new();
    m.insert("channels".to_string(), counts.channels);
    m.insert("messages".to_string(), counts.messages);
    m.insert("acl".to_string(), counts.acl);
    m.insert("knocks".to_string(), counts.knocks);
    m.insert("themes".to_string(), counts.themes);
    m.insert("assets".to_string(), counts.assets);
    m.insert("obsidian".to_string(), counts.obsidian);
    m
}

#[allow(dead_code)]
fn _force_use_device_link(_l: DeviceLink) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::porch::db::Porch;

    fn fake_peer_id() -> PeerId {
        let kp = libp2p::identity::Keypair::generate_ed25519();
        PeerId::from(kp.public())
    }

    #[test]
    fn protocol_constant_pins_to_concord_porch_sync_v1() {
        assert_eq!(SYNC_PROTOCOL_ID, "/concord/porch-sync/1.0.0");
    }

    #[test]
    fn pull_delta_from_non_linked_peer_is_denied() {
        let porch = Arc::new(Porch::open_in_memory().expect("open"));
        let handler = SyncHandler::new(porch);
        let response = handler.dispatch(
            fake_peer_id(),
            SyncRequest::PullDelta {
                since: SyncCursor::default(),
            },
        );
        assert!(!response.ok, "unlinked peer must be denied");
        let err = response.error.expect("err");
        assert_eq!(err.code, 403);
    }

    #[test]
    fn link_request_returns_my_device_id() {
        let porch = Arc::new(Porch::open_in_memory().expect("open"));
        let handler = SyncHandler::new(porch.clone());
        let response = handler.dispatch(
            fake_peer_id(),
            SyncRequest::LinkRequest {
                my_device_id: "01J5OTHER".to_string(),
                label: None,
            },
        );
        assert!(response.ok, "LinkRequest must succeed");
        let body: LinkResponse =
            serde_json::from_value(response.result.unwrap()).unwrap();
        assert_eq!(body.my_device_id, porch.device_id().unwrap());
    }
}
