//! Porch Phase E — libp2p protocol handler for encrypted backups.
//!
//! Protocol ID: `/concord/porch-backup/1.0.0`. Distinct from the Phase
//! A/B/C/D `/concord/porch/1.0.0` protocol because backups are a
//! different trust boundary: a backup peer should be able to refuse
//! content access (porch visit) while still accepting backup uploads,
//! and a content peer should be able to refuse backup uploads. Separate
//! protocol IDs let the federation layer enforce that.
//!
//! Wire shape mirrors the porch protocol (4-byte BE length + JSON body)
//! but with a larger envelope cap — a single encrypted backup blob may
//! reach tens of MB for a chat-heavy DB even after ZSTD compression.

use std::sync::Arc;

use async_trait::async_trait;
use futures::{AsyncReadExt, AsyncWriteExt};
use libp2p::{PeerId, Stream, StreamProtocol};
use libp2p_stream::Control;
use serde::{Deserialize, Serialize};

use crate::servitude::federation::{
    FederationError, FederationHandler, FederationProtocol, PayloadKind,
};

use super::backup::{
    list_received_backups, read_received_backup, read_received_backup_info,
    store_received_backup, EncryptedBackup, ReceivedBackupSummary,
};
use super::db::Porch;
use super::error::PorchError;

/// libp2p stream protocol ID for porch BACKUP traffic. Distinct
/// namespace from `/concord/porch/1.0.0` so a backup peer can accept
/// backups while denying content access (and vice versa).
pub const BACKUP_PROTOCOL_ID: &str = "/concord/porch-backup/1.0.0";

/// Maximum size of a single framed envelope on the backup protocol.
/// 64 MiB — chat-heavy SQLite databases compressed to ~6-10x ratio
/// still routinely land in the 1-10 MB range; the headroom keeps the
/// wire path future-proof against larger installs without forcing a
/// chunked-upload protocol revision.
pub const MAX_BACKUP_ENVELOPE_BYTES: usize = 64 * 1024 * 1024;

/// Inbound request envelope for the backup protocol.
///
/// The `GetMyBackup` and `GetMyBackupInfo` variants use the requester's
/// libp2p `PeerId` as the implicit uploader identifier — peer A asks,
/// the handler returns the row keyed by A's peer-id. This is the right
/// ACL: only the original uploader can fetch their own backup. Peer C
/// dialing in cannot retrieve peer A's blob.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum BackupRequest {
    /// Push a fresh encrypted backup to the backup peer. The handler
    /// stores it as the latest blob for this uploader, overwriting any
    /// prior row keyed by the same `uploader_peer_id`.
    UploadBackup { backup: EncryptedBackup },
    /// Pull the latest stored blob for the requester's peer-id. Returns
    /// `Some` if the backup peer is holding one, `None` otherwise. Used
    /// by the uploader during restore and for sanity checks.
    GetMyBackup,
    /// List the schema-version + size + sha256 + received-at for the
    /// requester's stored backup. Used to render "Last backed up at X"
    /// without a full blob download.
    GetMyBackupInfo,
}

/// Outbound response envelope. Exactly one of `result` and `error` is
/// populated in a well-formed response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BackupErrorBody>,
}

/// Structured error body — same shape as `PorchErrorBody`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupErrorBody {
    pub code: i32,
    pub message: String,
}

impl BackupResponse {
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
            error: Some(BackupErrorBody {
                code,
                message: err.to_string(),
            }),
        }
    }
}

/// Inbound handler for the backup protocol. Holds an `Arc<Porch>` so
/// multiple inbound streams can dispatch concurrently against the same
/// shared SQLite (the `Mutex` inside `Porch` serializes the writes).
pub struct BackupHandler {
    porch: Arc<Porch>,
}

impl BackupHandler {
    pub fn new(porch: Arc<Porch>) -> Self {
        Self { porch }
    }

    /// Dispatch one decoded request, attributing the requester to
    /// `requester_peer_id`. Public so tests can drive the dispatcher
    /// without spinning up a libp2p swarm.
    pub fn dispatch(
        &self,
        requester_peer_id: PeerId,
        request: BackupRequest,
    ) -> BackupResponse {
        match self.dispatch_inner(requester_peer_id, request) {
            Ok(value) => BackupResponse::from_result(value),
            Err(e) => BackupResponse::from_error(e),
        }
    }

    fn dispatch_inner(
        &self,
        requester_peer_id: PeerId,
        request: BackupRequest,
    ) -> Result<serde_json::Value, PorchError> {
        let requester = requester_peer_id.to_base58();
        match request {
            BackupRequest::UploadBackup { backup } => {
                // Per-uploader ACL: the connected peer is the only one
                // allowed to write to their own slot. Reject attempts
                // to forge an upload from a different peer-id — that
                // would otherwise let peer A overwrite peer B's
                // backup with garbage.
                if backup.uploader_peer_id != requester {
                    return Err(PorchError::AccessDenied {
                        channel_id: format!(
                            "uploader peer-id mismatch: envelope claims {}, connection is {}",
                            backup.uploader_peer_id, requester
                        ),
                    });
                }
                store_received_backup(&self.porch, &backup)?;
                Ok(serde_json::json!({ "ok": true }))
            }
            BackupRequest::GetMyBackup => {
                let blob = read_received_backup(&self.porch, &requester)?;
                Ok(serde_json::to_value(blob)?)
            }
            BackupRequest::GetMyBackupInfo => {
                let info = read_received_backup_info(&self.porch, &requester)?;
                Ok(serde_json::to_value(info)?)
            }
        }
    }

    /// Owner-side helper for the management UI's "Storing backups for:"
    /// surface — doesn't pass through the libp2p wire, just dumps what
    /// the local backup-peer side is holding.
    pub fn list_received(&self) -> Result<Vec<ReceivedBackupSummary>, PorchError> {
        list_received_backups(&self.porch)
    }
}

impl FederationProtocol for BackupHandler {
    const PROTOCOL_ID: &'static str = BACKUP_PROTOCOL_ID;
}

#[async_trait]
impl FederationHandler for BackupHandler {
    fn protocol_id(&self) -> &'static str {
        BACKUP_PROTOCOL_ID
    }

    fn payload_kind(&self) -> PayloadKind {
        PayloadKind::Other("porch-backup")
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
            if len > MAX_BACKUP_ENVELOPE_BYTES {
                return Err(FederationError::MalformedEnvelope(format!(
                    "backup envelope too large: {} > {}",
                    len, MAX_BACKUP_ENVELOPE_BYTES
                )));
            }
            let mut buf = vec![0u8; len];
            stream
                .read_exact(&mut buf)
                .await
                .map_err(FederationError::Io)?;
            let request: BackupRequest =
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

/// Open a single backup stream to `peer_id`, send `request`, return the
/// decoded response, close the stream.
async fn send_one(
    control: &mut Control,
    peer_id: PeerId,
    request: BackupRequest,
) -> Result<BackupResponse, PorchError> {
    let proto = StreamProtocol::new(BACKUP_PROTOCOL_ID);
    let mut stream = control
        .open_stream(peer_id, proto)
        .await
        .map_err(|e| PorchError::InvalidInput(format!("open_stream: {e:?}")))?;
    let request_bytes = serde_json::to_vec(&request).map_err(PorchError::Serde)?;
    if request_bytes.len() > MAX_BACKUP_ENVELOPE_BYTES {
        return Err(PorchError::MalformedEnvelope(format!(
            "backup request envelope too large: {} > {}",
            request_bytes.len(),
            MAX_BACKUP_ENVELOPE_BYTES
        )));
    }
    let len_be = (request_bytes.len() as u32).to_be_bytes();
    stream
        .write_all(&len_be)
        .await
        .map_err(PorchError::Io)?;
    stream
        .write_all(&request_bytes)
        .await
        .map_err(PorchError::Io)?;
    stream.flush().await.map_err(PorchError::Io)?;

    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .await
        .map_err(PorchError::Io)?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_BACKUP_ENVELOPE_BYTES {
        return Err(PorchError::MalformedEnvelope(format!(
            "backup response envelope too large: {} > {}",
            len, MAX_BACKUP_ENVELOPE_BYTES
        )));
    }
    let mut buf = vec![0u8; len];
    stream
        .read_exact(&mut buf)
        .await
        .map_err(PorchError::Io)?;
    let _ = stream.close().await;
    let response: BackupResponse =
        serde_json::from_slice(&buf).map_err(PorchError::Serde)?;
    Ok(response)
}

/// Outbound helper — push an encrypted blob to a backup peer.
pub async fn visit_backup_upload(
    control: &mut Control,
    peer_id: PeerId,
    backup: EncryptedBackup,
) -> Result<(), PorchError> {
    let response = send_one(control, peer_id, BackupRequest::UploadBackup { backup }).await?;
    if response.ok {
        Ok(())
    } else {
        let body = response
            .error
            .ok_or_else(|| PorchError::MalformedEnvelope("missing error".to_string()))?;
        Err(map_backup_error(body))
    }
}

/// Outbound helper — pull the requester's own stored backup off a
/// backup peer. Returns `None` if no blob is on file for this peer.
pub async fn visit_backup_get_my_backup(
    control: &mut Control,
    peer_id: PeerId,
) -> Result<Option<EncryptedBackup>, PorchError> {
    let response = send_one(control, peer_id, BackupRequest::GetMyBackup).await?;
    decode_or_error::<Option<EncryptedBackup>>(response)
}

/// Outbound helper — read the summary of the requester's stored
/// backup. Lightweight; no blob transferred.
pub async fn visit_backup_get_my_backup_info(
    control: &mut Control,
    peer_id: PeerId,
) -> Result<Option<ReceivedBackupSummary>, PorchError> {
    let response = send_one(control, peer_id, BackupRequest::GetMyBackupInfo).await?;
    decode_or_error::<Option<ReceivedBackupSummary>>(response)
}

fn decode_or_error<T: serde::de::DeserializeOwned>(
    response: BackupResponse,
) -> Result<T, PorchError> {
    if response.ok {
        // The wire JSON loses the distinction between `result: null`
        // and `result: missing` — both deserialize to `None`. When
        // the response is an `Option<T>`, treating absence as
        // `Value::Null` is the correct round-trip, so we substitute
        // `Null` here and let the target type's deserializer reject
        // any non-Option type that can't accept null.
        let value = response.result.unwrap_or(serde_json::Value::Null);
        serde_json::from_value(value).map_err(PorchError::Serde)
    } else {
        let body = response
            .error
            .ok_or_else(|| PorchError::MalformedEnvelope("missing error".to_string()))?;
        Err(map_backup_error(body))
    }
}

fn map_backup_error(body: BackupErrorBody) -> PorchError {
    match body.code {
        403 => PorchError::AccessDenied {
            channel_id: body.message,
        },
        404 => PorchError::ChannelNotFound {
            channel_id: body.message,
        },
        _ => PorchError::InvalidInput(body.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::porch::db::Porch;

    fn fake_peer_id() -> PeerId {
        let keypair = libp2p::identity::Keypair::generate_ed25519();
        PeerId::from(keypair.public())
    }

    #[test]
    fn protocol_constant_pins_to_concord_porch_backup_v1() {
        assert_eq!(BACKUP_PROTOCOL_ID, "/concord/porch-backup/1.0.0");
        assert_eq!(
            <BackupHandler as crate::servitude::federation::FederationProtocol>::PROTOCOL_ID,
            BACKUP_PROTOCOL_ID,
        );
    }

    #[test]
    fn get_my_backup_with_no_stored_blob_returns_none_not_404() {
        let dir = tempfile::tempdir().unwrap();
        let porch = Arc::new(Porch::open(dir.path()).unwrap());
        let handler = BackupHandler::new(porch);
        let response = handler.dispatch(fake_peer_id(), BackupRequest::GetMyBackup);
        assert!(response.ok, "GetMyBackup must always succeed (None is a valid result)");
        let blob: Option<EncryptedBackup> =
            serde_json::from_value(response.result.unwrap()).unwrap();
        assert!(blob.is_none(), "no blob stored → None");
    }

    #[test]
    fn upload_with_wrong_uploader_peer_id_is_denied() {
        let dir = tempfile::tempdir().unwrap();
        let porch = Arc::new(Porch::open(dir.path()).unwrap());
        let handler = BackupHandler::new(porch);
        let connection_peer = fake_peer_id();
        // Craft an envelope that claims a different uploader. The
        // dispatcher must refuse it — otherwise peer A could overwrite
        // peer B's backup with garbage.
        let other_peer = fake_peer_id();
        assert_ne!(connection_peer, other_peer);
        let forged = EncryptedBackup {
            uploader_peer_id: other_peer.to_base58(),
            ciphertext: vec![0u8; 16],
            nonce: [0u8; 12],
            schema_version: 5,
            taken_at: 0,
        };
        let response =
            handler.dispatch(connection_peer, BackupRequest::UploadBackup { backup: forged });
        assert!(!response.ok, "forged uploader must be rejected");
        assert_eq!(response.error.unwrap().code, 403);
    }
}
