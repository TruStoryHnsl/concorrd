//! F1c — libp2p stream protocol for delivering an encrypted home-server
//! export to a trusted outside instance.
//!
//! Protocol ID: `/concord/home-export/1.0.0`. The path name reflects the
//! 2026-05-31 CONSOLIDATED ARCHITECTURE filing — the subject of the
//! transfer is the persistent HOME server's data, NOT the porch.
//!
//! ## Wire shape — framed bytes, NOT JSON
//!
//! The payload is a sealed encrypted blob (see `home_export.rs`). We do
//! NOT JSON-wrap it because:
//!
//!   * the blob is already opaque ciphertext — a JSON envelope around
//!     it would force a base64 round-trip, doubling the bytes on wire
//!     for no benefit;
//!   * a 4-byte length prefix per frame is enough to back-pressure the
//!     reader without re-parsing.
//!
//! Frames flow in two directions:
//!
//! ```text
//!   Sender → Receiver:
//!     [4-byte BE u32 frame_len] [frame_len bytes opaque ciphertext chunk]
//!     ... repeated until the sender writes a [0u8;4] sentinel ...
//!
//!   Receiver → Sender:
//!     One DeliveryStatus envelope (JSON, length-prefixed) — `accepted`
//!     when the bytes were received cleanly and the sender is paired,
//!     `rejected` with a reason otherwise.
//! ```
//!
//! Each frame is capped at [`MAX_FRAME_BYTES`] (1 MiB) — the receiver
//! enforces; an oversize frame closes the stream with a typed error.
//! The sender chunks at [`CHUNK_BYTES`] (64 KiB) — comfortably under
//! the cap. The receiver's max in-memory accumulation is bounded by
//! the [`MAX_PACKAGE_BYTES`] hard cap so a malicious sender can't OOM
//! the host.
//!
//! ## Receiver in this PR — log only
//!
//! The inbound handler:
//!
//!   1. Looks up the sender's peer-id in the local peer-store (via the
//!      injected [`PeerStoreSnapshot`]).
//!   2. If not paired, drains the framed payload and replies with
//!      `DeliveryStatus::rejected { reason: "sender_not_paired" }`.
//!   3. If paired, accumulates the bytes in memory, computes SHA-256,
//!      LOGS `concord::home::export: received package size=N sha256=...
//!      from peer=...`, and replies with
//!      `DeliveryStatus::accepted { sha256, bytes_received }`.
//!   4. Does NOT persist or ingest — that is a deliberate follow-up
//!      PR (see PR body).

use std::sync::Arc;

use async_trait::async_trait;
use futures::{AsyncReadExt, AsyncWriteExt};
use libp2p::{PeerId, Stream, StreamProtocol};
use libp2p_stream::Control;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::servitude::federation::{
    FederationError, FederationHandler, FederationProtocol, PayloadKind,
};

use super::error::PorchError;

/// libp2p stream protocol ID for the home-server export delivery path.
pub const HOME_EXPORT_PROTOCOL_ID: &str = "/concord/home-export/1.0.0";

/// Max bytes per length-prefixed chunk on the wire. The receiver
/// rejects any frame larger than this.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Sender's default chunk size — 64 KiB, well under the 1 MiB hard cap.
pub const CHUNK_BYTES: usize = 64 * 1024;

/// Hard upper bound on the cumulative ciphertext payload one inbound
/// stream may deliver. 512 MiB is generous for a chat-heavy home DB
/// with assets/backups. Mostly a guard against runaway senders that
/// would otherwise OOM the host before the framing layer notices.
pub const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;

/// Reply envelope on the same stream — short, JSON, length-prefixed.
///
/// Exactly one of `accepted` / `rejected` is populated. The sender's
/// outbound helper maps this into a [`DeliveryReceipt`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DeliveryStatus {
    /// The package was received cleanly by a paired peer. The receiver
    /// has NOT persisted or ingested it yet — that's the follow-up
    /// ingest PR.
    Accepted {
        /// Hex-encoded SHA-256 of the entire ciphertext the receiver
        /// observed on the wire (sum of all frame bodies, in order).
        sha256: String,
        /// Cumulative bytes received across every frame.
        bytes_received: u64,
        /// Unix milliseconds — receiver-side wall clock at the moment
        /// the final frame arrived.
        received_at: i64,
    },
    /// The package was rejected. Sender peer wasn't paired with the
    /// receiver, the framing layer detected a violation, etc. A
    /// rejection is always reasoned — never silent — so the sender can
    /// surface diagnostic copy to the operator.
    Rejected {
        /// Stable snake_case reason code:
        ///   * `"sender_not_paired"` — the receiver doesn't know this
        ///     peer in its peer-store.
        ///   * `"package_too_large"` — accumulated bytes exceeded
        ///     [`MAX_PACKAGE_BYTES`].
        ///   * `"frame_too_large"` — a single frame exceeded
        ///     [`MAX_FRAME_BYTES`].
        ///   * `"framing_error"` — protocol violation (truncated frame,
        ///     bogus length prefix, etc.).
        reason: String,
    },
}

/// Outbound return shape for `home_send_export`.
///
/// Exactly one of `delivered_at` and `rejected_reason` is set, mirroring
/// the receiver's `DeliveryStatus` so the renderer can render the right
/// affordance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryReceipt {
    /// Hex SHA-256 the receiver reported (matches the sender's local
    /// pre-flight hash on success). On rejection: best-effort sender-side
    /// SHA of what we sent, so the operator has a fingerprint regardless.
    pub package_sha256: String,
    /// Cumulative bytes the sender pushed onto the wire.
    pub bytes_sent: u64,
    /// `Some(unix_ms)` when accepted; `None` when rejected.
    pub delivered_at: Option<i64>,
    /// `Some(reason)` when rejected; `None` when accepted.
    pub rejected_reason: Option<String>,
}

/// Pluggable view over the local peer-store. The handler queries this
/// to determine whether the sending peer is in the paired-peer list.
///
/// Injected as a trait object so the inbound dispatch can be tested
/// without standing up a Stronghold + libp2p swarm.
pub trait PeerStoreSnapshot: Send + Sync {
    /// Return `true` when `peer_id` (base58) is known to the local
    /// peer-store. Errors collapse into `false` — the safe default is
    /// to reject.
    fn is_paired(&self, peer_id: &str) -> bool;
}

/// Production [`PeerStoreSnapshot`] backed by the live Stronghold-held
/// peer-store. Reads happen synchronously by bridging through the
/// crate's existing tokio runtime — same pattern `StrongholdSeedAccess`
/// in `backup.rs` uses for sync access from a (possibly async) caller.
pub struct StrongholdPeerStoreSnapshot {
    stronghold: Arc<crate::servitude::identity::StrongholdHandle>,
}

impl StrongholdPeerStoreSnapshot {
    /// Build a snapshot view over the per-install peer-store.
    pub fn new(stronghold: Arc<crate::servitude::identity::StrongholdHandle>) -> Self {
        Self { stronghold }
    }
}

impl PeerStoreSnapshot for StrongholdPeerStoreSnapshot {
    fn is_paired(&self, peer_id: &str) -> bool {
        // The peer-store API is async; bridge to sync the same way
        // `backup.rs::StrongholdSeedAccess::export_seed_bytes` does.
        let handle = tokio::runtime::Handle::try_current().ok();
        let peers = match handle {
            Some(_) => tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(
                    crate::servitude::peer_store::list(&self.stronghold),
                )
            }),
            None => {
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => {
                        log::warn!(
                            target: "concord::home::export",
                            "PeerStoreSnapshot: failed to build runtime: {e}"
                        );
                        return false;
                    }
                };
                rt.block_on(crate::servitude::peer_store::list(&self.stronghold))
            }
        };
        match peers {
            Ok(list) => list.iter().any(|p| p.peer_id == peer_id),
            Err(e) => {
                log::warn!(
                    target: "concord::home::export",
                    "PeerStoreSnapshot: peer-store read failed: {e}"
                );
                false
            }
        }
    }
}

/// Inbound handler for `/concord/home-export/1.0.0`. Logs receipts;
/// does NOT persist or ingest.
pub struct HomeExportHandler {
    peer_store: Arc<dyn PeerStoreSnapshot>,
}

impl HomeExportHandler {
    /// Build the handler around an injected peer-store snapshot.
    pub fn new(peer_store: Arc<dyn PeerStoreSnapshot>) -> Self {
        Self { peer_store }
    }
}

impl FederationProtocol for HomeExportHandler {
    const PROTOCOL_ID: &'static str = HOME_EXPORT_PROTOCOL_ID;
}

#[async_trait]
impl FederationHandler for HomeExportHandler {
    fn protocol_id(&self) -> &'static str {
        HOME_EXPORT_PROTOCOL_ID
    }

    fn payload_kind(&self) -> PayloadKind {
        PayloadKind::Other("home-export")
    }

    async fn handle_inbound(
        &self,
        peer_id: PeerId,
        mut stream: Stream,
    ) -> Result<(), FederationError> {
        let sender_id = peer_id.to_base58();
        let paired = self.peer_store.is_paired(&sender_id);

        // Whether paired or not, we always DRAIN the framed payload to
        // EOF so the sender's writer can complete its send. This also
        // gives us a stable SHA + byte count for the rejection log
        // (useful for diagnosing partial deliveries).
        let mut hasher = Sha256::new();
        let mut bytes_received: u64 = 0;
        let mut over_cap = false;
        let mut framing_err: Option<String> = None;

        loop {
            let mut len_buf = [0u8; 4];
            match stream.read_exact(&mut len_buf).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    framing_err = Some("stream closed without sentinel".to_string());
                    break;
                }
                Err(e) => return Err(FederationError::Io(e)),
            }
            let frame_len = u32::from_be_bytes(len_buf) as usize;
            if frame_len == 0 {
                // Sentinel: end of stream.
                break;
            }
            if frame_len > MAX_FRAME_BYTES {
                framing_err = Some(format!(
                    "frame_too_large: {frame_len} > {MAX_FRAME_BYTES}"
                ));
                break;
            }
            let mut buf = vec![0u8; frame_len];
            stream
                .read_exact(&mut buf)
                .await
                .map_err(FederationError::Io)?;
            hasher.update(&buf);
            bytes_received = bytes_received.saturating_add(frame_len as u64);
            if bytes_received > MAX_PACKAGE_BYTES {
                over_cap = true;
                break;
            }
        }

        let sha256 = hex::encode(hasher.finalize());

        let status = if !paired {
            log::warn!(
                target: "concord::home::export",
                "rejected: sender_not_paired peer={sender_id} bytes_received={bytes_received}"
            );
            DeliveryStatus::Rejected {
                reason: "sender_not_paired".to_string(),
            }
        } else if over_cap {
            log::warn!(
                target: "concord::home::export",
                "rejected: package_too_large peer={sender_id} bytes_received={bytes_received}"
            );
            DeliveryStatus::Rejected {
                reason: "package_too_large".to_string(),
            }
        } else if let Some(ref msg) = framing_err {
            // Non-sentinel framing problems are recoverable in the
            // sense that the sender knows what they did; surface the
            // typed reason. Truncation (stream closed without sentinel)
            // is rejected as a framing error too.
            let reason = if msg.starts_with("frame_too_large") {
                "frame_too_large".to_string()
            } else {
                "framing_error".to_string()
            };
            log::warn!(
                target: "concord::home::export",
                "rejected: {reason} peer={sender_id} bytes_received={bytes_received} detail={msg}"
            );
            DeliveryStatus::Rejected { reason }
        } else {
            let received_at = unix_millis();
            log::info!(
                target: "concord::home::export",
                "received package size={bytes_received} sha256={sha256} from peer={sender_id}"
            );
            DeliveryStatus::Accepted {
                sha256,
                bytes_received,
                received_at,
            }
        };

        // Write the status reply back, length-prefixed JSON.
        let body = serde_json::to_vec(&status).map_err(FederationError::Serde)?;
        let len_be = (body.len() as u32).to_be_bytes();
        stream
            .write_all(&len_be)
            .await
            .map_err(FederationError::Io)?;
        stream
            .write_all(&body)
            .await
            .map_err(FederationError::Io)?;
        stream.flush().await.map_err(FederationError::Io)?;
        let _ = stream.close().await;
        Ok(())
    }
}

/// Outbound helper — open a `/concord/home-export/1.0.0` stream to the
/// target peer, stream the package file in 64 KiB chunks, read the
/// reply, return a [`DeliveryReceipt`].
///
/// Reads the file fresh from disk so the caller doesn't have to hold
/// the bytes in memory. The whole package IS hashed locally before
/// streaming so the receipt's `package_sha256` is always populated
/// (even on a rejection mid-stream).
pub async fn send_home_export_package(
    control: &mut Control,
    peer_id: PeerId,
    package_path: &std::path::Path,
) -> Result<DeliveryReceipt, PorchError> {
    let proto = StreamProtocol::new(HOME_EXPORT_PROTOCOL_ID);
    let mut stream = control
        .open_stream(peer_id, proto)
        .await
        .map_err(|e| PorchError::InvalidInput(format!("open_stream: {e:?}")))?;

    // Pre-hash the on-disk bytes so even a mid-stream rejection has a
    // valid sender-side fingerprint.
    let blob = std::fs::read(package_path).map_err(PorchError::Io)?;
    let local_sha = {
        let mut h = Sha256::new();
        h.update(&blob);
        hex::encode(h.finalize())
    };

    let mut bytes_sent: u64 = 0;
    for chunk in blob.chunks(CHUNK_BYTES) {
        let len_be = (chunk.len() as u32).to_be_bytes();
        stream
            .write_all(&len_be)
            .await
            .map_err(PorchError::Io)?;
        stream
            .write_all(chunk)
            .await
            .map_err(PorchError::Io)?;
        bytes_sent = bytes_sent.saturating_add(chunk.len() as u64);
    }
    // End-of-stream sentinel.
    stream
        .write_all(&[0u8; 4])
        .await
        .map_err(PorchError::Io)?;
    stream.flush().await.map_err(PorchError::Io)?;

    // Read the reply.
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .await
        .map_err(PorchError::Io)?;
    let reply_len = u32::from_be_bytes(len_buf) as usize;
    if reply_len > MAX_FRAME_BYTES {
        return Err(PorchError::MalformedEnvelope(format!(
            "home-export reply too large: {reply_len} > {MAX_FRAME_BYTES}"
        )));
    }
    let mut reply_buf = vec![0u8; reply_len];
    stream
        .read_exact(&mut reply_buf)
        .await
        .map_err(PorchError::Io)?;
    let _ = stream.close().await;
    let status: DeliveryStatus =
        serde_json::from_slice(&reply_buf).map_err(PorchError::Serde)?;

    let receipt = match status {
        DeliveryStatus::Accepted {
            sha256,
            bytes_received: _,
            received_at,
        } => DeliveryReceipt {
            package_sha256: sha256,
            bytes_sent,
            delivered_at: Some(received_at),
            rejected_reason: None,
        },
        DeliveryStatus::Rejected { reason } => DeliveryReceipt {
            package_sha256: local_sha,
            bytes_sent,
            delivered_at: None,
            rejected_reason: Some(reason),
        },
    };
    Ok(receipt)
}

fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::PeerId;

    fn fake_peer_id() -> PeerId {
        let kp = libp2p::identity::Keypair::generate_ed25519();
        PeerId::from(kp.public())
    }

    struct StaticPaired(bool);
    impl PeerStoreSnapshot for StaticPaired {
        fn is_paired(&self, _peer_id: &str) -> bool {
            self.0
        }
    }

    #[test]
    fn protocol_id_pinned() {
        assert_eq!(HOME_EXPORT_PROTOCOL_ID, "/concord/home-export/1.0.0");
        assert_eq!(
            <HomeExportHandler as FederationProtocol>::PROTOCOL_ID,
            HOME_EXPORT_PROTOCOL_ID,
        );
    }

    #[test]
    fn delivery_status_roundtrip() {
        let s = DeliveryStatus::Accepted {
            sha256: "deadbeef".to_string(),
            bytes_received: 123,
            received_at: 999,
        };
        let json = serde_json::to_string(&s).unwrap();
        let r: DeliveryStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(s, r);

        let s = DeliveryStatus::Rejected {
            reason: "sender_not_paired".to_string(),
        };
        let json = serde_json::to_string(&s).unwrap();
        let r: DeliveryStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(s, r);
    }

    #[test]
    fn handler_construction_takes_arc_dyn() {
        let snap: Arc<dyn PeerStoreSnapshot> = Arc::new(StaticPaired(false));
        let h = HomeExportHandler::new(snap);
        assert_eq!(h.protocol_id(), HOME_EXPORT_PROTOCOL_ID);
        let _ = fake_peer_id();
    }
}
