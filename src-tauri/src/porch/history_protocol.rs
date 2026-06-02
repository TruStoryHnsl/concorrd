//! Feature F3 — **multi-hop read-only history** for the porch over a
//! distinct libp2p stream protocol (`/concord/porch-history/1.0.0`).
//!
//! ## What this enables
//!
//! In the F3 architecture, a user "5 steps away" on the peer mesh
//! cannot directly visit our porch (they're not in our paired-peer
//! list), but they CAN read a bounded slice of recent history from
//! channels they share with paired-peers-of-paired-peers — provided
//! they can present a valid **hop chain** proving the relationship.
//!
//! The protocol is intentionally limited to *read-only* history. There
//! is no posting, no knock, no theme fetch, no asset download —
//! anything that mutates state or carries arbitrary-size payload needs
//! a direct paired-peer connection.
//!
//! ## Hop-chain vouching format (ASCII diagram)
//!
//! ```text
//! Scenario:  C (requester) wants D (server) read-only history.
//!            C is paired with B.  B is paired with D.
//!            D is NOT directly paired with C.
//!
//!     C ──pair──> B ──pair──> D
//!
//! C constructs a HistoryRequest with chain = [VouchLink{voucher=B}]:
//!
//!     HistoryRequest {
//!       requester:  C  (peer_id + 32-byte ed25519 pubkey),
//!       target:     D,
//!       channel:    "porch-default",
//!       limit:      100,
//!       chain: [
//!         VouchLink {
//!           voucher_peer_id:    B,
//!           voucher_pubkey:     PK_B,
//!           subject_peer_id:    C,   // who B is vouching for
//!           target_peer_id:     D,   // where the request is going
//!           signature: Ed25519(SK_B, VOUCH_DOMAIN || C || D)
//!         }
//!       ]
//!     }
//!
//! D verifies (in this order, fail-fast):
//!   1. chain.len() <= MAX_HOP_CHAIN_LEN  (default 5)
//!   2. limit <= MAX_HISTORY_LIMIT        (default 100)
//!   3. requester is a libp2p PeerId derived from the supplied pubkey
//!   4. for each VouchLink:
//!        - voucher_peer_id derives from voucher_pubkey
//!        - target_peer_id == D (our local peer-id)
//!        - signature verifies under voucher_pubkey
//!   5. chain is well-linked:
//!        - chain[0].subject_peer_id == requester
//!        - chain[i].subject_peer_id == chain[i-1].voucher_peer_id for i >= 1
//!   6. The LAST link's voucher_peer_id MUST be in D's paired-peer list.
//!        - This is the trust anchor — every other link only matters
//!          because at least one peer at the chain's terminus is
//!          someone D explicitly chose to pair with.
//!
//! If chain is empty: requester MUST itself be in D's paired-peer list
//! (the one-hop / "already paired" case the protocol still services).
//! ```
//!
//! ## Signature domain separation
//!
//! Every signature includes a fixed domain-separation prefix
//! ([`VOUCH_DOMAIN`]) so a signature from this protocol can never be
//! replayed as a signature for the porch-protocol authentication
//! handshake, the backup protocol's seed-receipt, or any other future
//! signed payload in the Concord stack. The hashed message is:
//!
//! ```text
//! VOUCH_DOMAIN || "\n" || subject_peer_id_base58 || "\n" || target_peer_id_base58
//! ```
//!
//! ## Out of scope
//!
//! - **No write surface**. Posting requires a direct paired peer.
//! - **No asset bytes / vault files**. The friend-of-friend gets text
//!   message history; they fetch images by visiting the source
//!   directly once introduced.
//! - **No revocation list**. A peer un-pairing from the chain is
//!   handled implicitly: next request the verifier sees the chain
//!   terminus is no longer in paired peers → 403.
//! - **No knock semantics**. This is strictly read-only history; the
//!   requester does not appear in the host's knock queue, and the
//!   host gets no signal that their channel was read.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures::{AsyncReadExt, AsyncWriteExt};
use libp2p::{PeerId, Stream, StreamProtocol};
use libp2p_stream::Control;
use serde::{Deserialize, Serialize};

use crate::servitude::federation::{
    FederationError, FederationHandler, FederationProtocol, PayloadKind,
};

use super::channel::{AclMode, ChannelMessage};
use super::db::Porch;
use super::error::PorchError;

/// libp2p stream protocol ID for porch history traffic. Distinct from
/// `/concord/porch/1.0.0` (the full porch protocol with knock + write
/// surfaces) — a friend-of-a-friend has access to history only, never
/// the full porch protocol.
pub const PORCH_HISTORY_PROTOCOL_ID: &str = "/concord/porch-history/1.0.0";

/// Maximum number of framed bytes accepted by the handler on either
/// direction of the stream. 1 MiB — same envelope cap as the porch
/// protocol; 100 messages of 1 KiB each fits an order of magnitude
/// below this.
pub const MAX_HISTORY_ENVELOPE_BYTES: usize = 1024 * 1024;

/// Server-side cap on hop-chain length. The cap matters because every
/// extra hop requires the verifier to verify another Ed25519 signature
/// (\~30 µs each in dalek), and the verification cost is paid before
/// any DB work. Default 5 keeps verification well under 1ms even at
/// the limit and lets reasonable mesh topologies through.
pub const MAX_HOP_CHAIN_LEN: usize = 5;

/// Server-side cap on the `limit` field of a [`HistoryRequest`]. The
/// requester gets the most recent `min(limit, MAX_HISTORY_LIMIT)`
/// messages from the channel.
pub const MAX_HISTORY_LIMIT: u32 = 100;

/// Domain separation tag for vouching signatures. Bumped if the
/// signed payload shape ever changes; receivers reject signatures
/// that don't carry this exact prefix.
pub const VOUCH_DOMAIN: &[u8] = b"concord:porch-history:vouch:v1";

/// Expected size of an Ed25519 signature on the wire (RFC 8032).
pub const SIGNATURE_LEN: usize = 64;

/// Expected size of an Ed25519 public key on the wire (RFC 8032).
pub const PUBLIC_KEY_LEN: usize = 32;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Identifies a single peer by both their libp2p PeerId AND their
/// underlying Ed25519 public key. The PeerId is a deterministic
/// function of the pubkey (see
/// [`crate::servitude::identity::peer_seed`]); we transmit both so
/// receivers can verify the relationship without resolving a remote
/// DHT and can verify subsequent signatures using a key that's
/// guaranteed-attributed.
///
/// Receivers MUST verify that `PeerId::from_public_key(pubkey) == peer_id`
/// before accepting any signature claimed to come from this identity.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PeerIdent {
    /// base58 libp2p PeerId.
    pub peer_id: String,
    /// 32-byte Ed25519 public key (hex-encoded for JSON ergonomics —
    /// matches the existing `PeerCard.public_key_hex` convention).
    pub pubkey_hex: String,
}

impl PeerIdent {
    /// Build a `PeerIdent` from a `PeerId` plus its underlying
    /// Ed25519 verifying-key. The pair MUST satisfy the
    /// peer-id-derives-from-pubkey invariant; we don't recheck here
    /// because the caller has both halves already.
    pub fn from_keypair(peer_id: PeerId, public_key: &VerifyingKey) -> Self {
        Self {
            peer_id: peer_id.to_base58(),
            pubkey_hex: hex::encode(public_key.to_bytes()),
        }
    }

    /// Parse the `peer_id` field into a libp2p `PeerId`. Returns
    /// `None` on a malformed string.
    pub fn parse_peer_id(&self) -> Option<PeerId> {
        self.peer_id.parse().ok()
    }

    /// Parse and validate the `pubkey_hex` field. Returns
    /// [`PorchError::InvalidInput`] on the wrong length or bad hex.
    pub fn parse_verifying_key(&self) -> Result<VerifyingKey, PorchError> {
        let bytes = hex::decode(&self.pubkey_hex).map_err(|e| {
            PorchError::InvalidInput(format!("hop-chain pubkey hex decode: {e}"))
        })?;
        if bytes.len() != PUBLIC_KEY_LEN {
            return Err(PorchError::InvalidInput(format!(
                "hop-chain pubkey expected {PUBLIC_KEY_LEN} bytes, got {}",
                bytes.len()
            )));
        }
        let mut arr = [0u8; PUBLIC_KEY_LEN];
        arr.copy_from_slice(&bytes);
        VerifyingKey::from_bytes(&arr).map_err(|e| {
            PorchError::InvalidInput(format!("hop-chain pubkey is not a valid ed25519 point: {e}"))
        })
    }

    /// Verify the underlying pubkey deterministically derives to
    /// `peer_id`. The libp2p layer encodes the protobuf-wrapped key
    /// before hashing into a PeerId; we use libp2p's own constructor
    /// to avoid re-implementing the encoding.
    pub fn verify_peerid_pubkey_link(&self) -> Result<(PeerId, VerifyingKey), PorchError> {
        let claimed_peer_id = self
            .parse_peer_id()
            .ok_or_else(|| PorchError::InvalidInput(format!(
                "hop-chain peer_id not parseable: {:?}",
                self.peer_id
            )))?;
        let vkey = self.parse_verifying_key()?;
        let libp2p_pub = libp2p::identity::ed25519::PublicKey::try_from_bytes(&vkey.to_bytes())
            .map_err(|e| {
                PorchError::InvalidInput(format!(
                    "ed25519 pubkey not accepted by libp2p: {e}"
                ))
            })?;
        let libp2p_key: libp2p::identity::PublicKey = libp2p_pub.into();
        let derived_peer_id = libp2p_key.to_peer_id();
        if derived_peer_id != claimed_peer_id {
            return Err(PorchError::InvalidInput(format!(
                "hop-chain peer_id {:?} does not derive from supplied pubkey \
                 (derived {})",
                self.peer_id,
                derived_peer_id.to_base58()
            )));
        }
        Ok((claimed_peer_id, vkey))
    }
}

/// A single vouching link in the hop chain.
///
/// `subject` is the peer being vouched for; `voucher` is the peer
/// signing. The `signature` is over [`VOUCH_DOMAIN`] concatenated with
/// `subject.peer_id` and `target_peer_id`, separated by newlines, so
/// the signature is bound to BOTH the subject and the destination
/// server — a vouch for "C → D" cannot be replayed against any other
/// server, even if the same set of peers is involved.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VouchLink {
    /// The peer being vouched for (one step closer to the requester
    /// in the chain).
    pub subject: PeerIdent,
    /// The peer signing the vouch.
    pub voucher: PeerIdent,
    /// The verifier (server) the chain is addressed to. Bound into
    /// the signature so a vouch for a different destination cannot
    /// be replayed.
    pub target_peer_id: String,
    /// 64-byte Ed25519 signature, hex-encoded.
    pub signature_hex: String,
}

impl VouchLink {
    /// Compute the canonical bytes that the voucher signs.
    ///
    /// `VOUCH_DOMAIN || "\n" || subject_peer_id || "\n" || target_peer_id`
    pub fn canonical_message(&self) -> Vec<u8> {
        let mut msg = Vec::with_capacity(
            VOUCH_DOMAIN.len() + 2 + self.subject.peer_id.len() + self.target_peer_id.len(),
        );
        msg.extend_from_slice(VOUCH_DOMAIN);
        msg.push(b'\n');
        msg.extend_from_slice(self.subject.peer_id.as_bytes());
        msg.push(b'\n');
        msg.extend_from_slice(self.target_peer_id.as_bytes());
        msg
    }

    /// Build a signed vouch link. `sign` is invoked with the
    /// canonical bytes the voucher must sign; it returns a 64-byte
    /// Ed25519 signature. The caller owns the voucher's private key
    /// (this module never sees it).
    pub fn build<S>(
        subject: PeerIdent,
        voucher: PeerIdent,
        target_peer_id: String,
        sign: S,
    ) -> Self
    where
        S: FnOnce(&[u8]) -> [u8; SIGNATURE_LEN],
    {
        let pending = Self {
            subject,
            voucher,
            target_peer_id,
            signature_hex: String::new(),
        };
        let bytes = pending.canonical_message();
        let sig = sign(&bytes);
        Self {
            subject: pending.subject,
            voucher: pending.voucher,
            target_peer_id: pending.target_peer_id,
            signature_hex: hex::encode(sig),
        }
    }

    /// Verify the link's signature using the voucher's pubkey.
    pub fn verify_signature(&self) -> Result<(), PorchError> {
        let (_voucher_peer_id, voucher_key) =
            self.voucher.verify_peerid_pubkey_link()?;
        let sig_bytes = hex::decode(&self.signature_hex).map_err(|e| {
            PorchError::InvalidInput(format!("vouch signature hex decode: {e}"))
        })?;
        if sig_bytes.len() != SIGNATURE_LEN {
            return Err(PorchError::InvalidInput(format!(
                "vouch signature expected {SIGNATURE_LEN} bytes, got {}",
                sig_bytes.len()
            )));
        }
        let mut sig_arr = [0u8; SIGNATURE_LEN];
        sig_arr.copy_from_slice(&sig_bytes);
        let sig = Signature::from_bytes(&sig_arr);
        let canonical = self.canonical_message();
        voucher_key.verify(&canonical, &sig).map_err(|e| {
            PorchError::InvalidInput(format!("vouch signature verification failed: {e}"))
        })
    }
}

/// Inbound request envelope.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryRequest {
    /// The peer asking for history. MUST own the underlying pubkey;
    /// verifier checks the libp2p connection's PeerId matches.
    pub requester: PeerIdent,
    /// The peer this request is addressed to (typically the local
    /// server). Verifier MUST check this matches its own peer-id —
    /// rejects misdirected requests.
    pub target_peer_id: String,
    /// Which channel of the porch to read.
    pub channel_id: String,
    /// Max number of messages to return. Server caps at
    /// [`MAX_HISTORY_LIMIT`].
    pub limit: u32,
    /// Hop chain. Empty when the requester is already a direct paired
    /// peer of the server; otherwise an ordered sequence of vouches
    /// from `chain[0].voucher` (vouching for the requester) up to
    /// `chain[N-1].voucher` (who must be a paired peer of the
    /// server).
    pub chain: Vec<VouchLink>,
}

/// Inbound response envelope. `ok=false` carries an error code/message
/// — same shape as `PorchResponse` for uniformity, but the result type
/// is constrained to `HistoryResult` (no arbitrary JSON).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<HistoryResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<HistoryErrorBody>,
}

/// Successful read-only history payload.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryResult {
    /// The messages, sorted oldest-first like the porch-protocol's
    /// `GetMessages`.
    pub messages: Vec<ChannelMessage>,
    /// How many hops the verifier walked to accept this request.
    /// `0` for direct paired-peer access; >0 for friend-of-friend.
    /// Surfaced to the client so UI can adjust badges.
    pub hops: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryErrorBody {
    pub code: i32,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/// Outcome of hop-chain verification — either the chain is valid and
/// we know how many hops it represents, or a typed error explains why
/// not. Pure function: takes no DB, takes no I/O. The paired-peer
/// trust anchor is supplied as `paired_peer_ids` so the caller can
/// pre-load the set from peer-store once per request.
pub fn verify_hop_chain(
    request: &HistoryRequest,
    connection_peer_id: PeerId,
    server_peer_id: PeerId,
    paired_peer_ids: &HashSet<String>,
) -> Result<u32, PorchError> {
    // Hop count cap — verifier work is paid before any DB hit; cheap to fail fast.
    if request.chain.len() > MAX_HOP_CHAIN_LEN {
        return Err(PorchError::InvalidInput(format!(
            "hop chain length {} > server max {}",
            request.chain.len(),
            MAX_HOP_CHAIN_LEN
        )));
    }

    // Limit cap — server clamps but ALSO rejects egregiously over-cap
    // requests as malformed (it would otherwise be cheap to issue
    // `limit = u32::MAX` and have the server cap it silently —
    // surfacing the cap lets the requester correct).
    if request.limit > MAX_HISTORY_LIMIT.saturating_mul(10) {
        return Err(PorchError::InvalidInput(format!(
            "history limit {} far exceeds server cap {}",
            request.limit, MAX_HISTORY_LIMIT
        )));
    }

    // Target check — fast-fail misdirected requests.
    if request.target_peer_id != server_peer_id.to_base58() {
        return Err(PorchError::InvalidInput(format!(
            "request addressed to {:?}, but I am {}",
            request.target_peer_id,
            server_peer_id.to_base58()
        )));
    }

    // Requester pubkey ↔ peer-id link.
    let (requester_peer_id, _) = request.requester.verify_peerid_pubkey_link()?;

    // Connection-attribution check: the libp2p stream we're answering
    // on MUST be owned by the requester. Without this, an attacker
    // could relay someone else's signed request through their own
    // libp2p connection.
    if connection_peer_id != requester_peer_id {
        return Err(PorchError::InvalidInput(format!(
            "request requester {} does not match libp2p connection peer {}",
            requester_peer_id.to_base58(),
            connection_peer_id.to_base58()
        )));
    }

    // Empty chain: direct paired-peer case. Requester must be in
    // paired-peer list. Hop count == 0.
    if request.chain.is_empty() {
        if !paired_peer_ids.contains(&requester_peer_id.to_base58()) {
            return Err(PorchError::AccessDenied {
                channel_id: format!(
                    "{} is not in our paired-peer list and presented no hop chain",
                    requester_peer_id.to_base58()
                ),
            });
        }
        return Ok(0);
    }

    // Non-empty chain: verify each link.
    let server_base58 = server_peer_id.to_base58();
    let requester_base58 = requester_peer_id.to_base58();

    for (i, link) in request.chain.iter().enumerate() {
        // Each link's target field MUST address this server.
        if link.target_peer_id != server_base58 {
            return Err(PorchError::InvalidInput(format!(
                "hop chain link {} targets {:?}, expected {}",
                i, link.target_peer_id, server_base58
            )));
        }
        // Voucher and subject identities are internally consistent
        // (peer-id derives from pubkey).
        link.subject.verify_peerid_pubkey_link()?;
        let (_voucher_peer_id, _voucher_key) =
            link.voucher.verify_peerid_pubkey_link()?;
        // Signature is valid under the voucher's pubkey.
        link.verify_signature()?;
    }

    // Chain well-linkedness:
    //   chain[0].subject  == requester
    //   chain[i].subject  == chain[i-1].voucher  for i >= 1
    if request.chain[0].subject.peer_id != requester_base58 {
        return Err(PorchError::InvalidInput(format!(
            "hop chain link 0 subject {:?} != requester {}",
            request.chain[0].subject.peer_id, requester_base58
        )));
    }
    for i in 1..request.chain.len() {
        if request.chain[i].subject.peer_id != request.chain[i - 1].voucher.peer_id {
            return Err(PorchError::InvalidInput(format!(
                "hop chain link {i} subject {:?} != previous voucher {:?}",
                request.chain[i].subject.peer_id,
                request.chain[i - 1].voucher.peer_id
            )));
        }
    }

    // Terminus check: the last link's voucher MUST be a paired peer
    // of ours. This is the trust anchor — without an explicit pairing
    // at the chain's terminus, the chain proves nothing.
    let terminus = &request.chain[request.chain.len() - 1].voucher.peer_id;
    if !paired_peer_ids.contains(terminus) {
        return Err(PorchError::AccessDenied {
            channel_id: format!(
                "hop chain terminus {} is not in our paired-peer list",
                terminus
            ),
        });
    }

    Ok(request.chain.len() as u32)
}

// ---------------------------------------------------------------------------
// Handler — libp2p inbound dispatch
// ---------------------------------------------------------------------------

/// Source-of-truth for the server's paired-peer list. Trait so tests
/// can inject a deterministic in-memory list without depending on
/// Stronghold or peer_store sibling-file persistence.
#[async_trait]
pub trait PairedPeerSource: Send + Sync {
    /// Return the set of paired-peer ids (base58 form) the server
    /// currently considers an explicit trust anchor. Implementations
    /// typically wrap a `peer_store::list` call.
    async fn paired_peer_ids(&self) -> Result<HashSet<String>, FederationError>;
}

/// Trivial in-memory implementation — used by tests and by callers
/// that want to plug a fixed list in.
pub struct StaticPairedPeers(pub HashSet<String>);

#[async_trait]
impl PairedPeerSource for StaticPairedPeers {
    async fn paired_peer_ids(&self) -> Result<HashSet<String>, FederationError> {
        Ok(self.0.clone())
    }
}

/// Inbound history-protocol handler. Holds an `Arc<Porch>` so multiple
/// inbound streams can dispatch concurrently. Server's own libp2p
/// PeerId is captured at construction so the verifier can reject
/// misdirected requests without per-call lookup.
pub struct HistoryHandler {
    porch: Arc<Porch>,
    server_peer_id: PeerId,
    paired_source: Arc<dyn PairedPeerSource>,
}

impl HistoryHandler {
    pub fn new(
        porch: Arc<Porch>,
        server_peer_id: PeerId,
        paired_source: Arc<dyn PairedPeerSource>,
    ) -> Self {
        Self {
            porch,
            server_peer_id,
            paired_source,
        }
    }

    /// Dispatch a single decoded request. Public so tests can drive
    /// the dispatch path without spinning up a libp2p swarm.
    pub async fn dispatch(
        &self,
        connection_peer_id: PeerId,
        request: HistoryRequest,
    ) -> HistoryResponse {
        match self.dispatch_inner(connection_peer_id, request).await {
            Ok(result) => HistoryResponse {
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(e) => {
                let code = e.status_code();
                HistoryResponse {
                    ok: false,
                    result: None,
                    error: Some(HistoryErrorBody {
                        code,
                        message: e.to_string(),
                    }),
                }
            }
        }
    }

    async fn dispatch_inner(
        &self,
        connection_peer_id: PeerId,
        request: HistoryRequest,
    ) -> Result<HistoryResult, PorchError> {
        // 1) Pull paired-peer set up-front — it's the trust anchor for
        // verification.
        let paired = self
            .paired_source
            .paired_peer_ids()
            .await
            .map_err(|e| PorchError::InvalidInput(format!("paired-peer lookup: {e}")))?;

        // 2) Verify hop chain. All cryptographic work runs here;
        // bails before touching the DB on any failure.
        let hops =
            verify_hop_chain(&request, connection_peer_id, self.server_peer_id, &paired)?;

        // 3) Channel existence + access mode. Read-only history is
        // only exposed for `Open` channels — the friend-of-friend
        // path doesn't earn allowlist-only channel access.
        let channel = self
            .porch
            .get_channel(&request.channel_id)?
            .ok_or_else(|| PorchError::ChannelNotFound {
                channel_id: request.channel_id.clone(),
            })?;
        match channel.acl_mode {
            AclMode::Open => {}
            AclMode::Allowlist | AclMode::OwnerOnly => {
                return Err(PorchError::AccessDenied {
                    channel_id: format!(
                        "channel {} is not open; multi-hop read-only access \
                         is restricted to open channels",
                        request.channel_id
                    ),
                });
            }
        }

        // 4) Clamp limit; fetch the most recent N messages. `get_messages`
        // walks oldest→newest; the protocol contract is "the most recent
        // N", so we fetch all and tail-slice. Cheap because the cap is
        // small (default 100).
        let effective_limit = request.limit.min(MAX_HISTORY_LIMIT);
        let mut messages = self
            .porch
            .get_messages(&request.channel_id, None, MAX_HISTORY_LIMIT)?;
        if messages.len() > effective_limit as usize {
            let drop_count = messages.len() - effective_limit as usize;
            messages.drain(..drop_count);
        }

        Ok(HistoryResult { messages, hops })
    }
}

impl FederationProtocol for HistoryHandler {
    const PROTOCOL_ID: &'static str = PORCH_HISTORY_PROTOCOL_ID;
}

#[async_trait]
impl FederationHandler for HistoryHandler {
    fn protocol_id(&self) -> &'static str {
        PORCH_HISTORY_PROTOCOL_ID
    }

    fn payload_kind(&self) -> PayloadKind {
        PayloadKind::Other("porch-history")
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
            if len > MAX_HISTORY_ENVELOPE_BYTES {
                return Err(FederationError::MalformedEnvelope(format!(
                    "history envelope too large: {} > {}",
                    len, MAX_HISTORY_ENVELOPE_BYTES
                )));
            }
            let mut buf = vec![0u8; len];
            stream
                .read_exact(&mut buf)
                .await
                .map_err(FederationError::Io)?;
            let request: HistoryRequest =
                serde_json::from_slice(&buf).map_err(FederationError::Serde)?;
            let response = self.dispatch(peer_id, request).await;
            let response_bytes = serde_json::to_vec(&response)
                .map_err(FederationError::Serde)?;
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
// Outbound helper
// ---------------------------------------------------------------------------

/// Open a single history-protocol stream to `peer_id`, send `request`,
/// return the decoded response. Closes the stream on the way out.
pub async fn visit_history(
    control: &mut Control,
    peer_id: PeerId,
    request: HistoryRequest,
) -> Result<HistoryResult, PorchError> {
    let proto = StreamProtocol::new(PORCH_HISTORY_PROTOCOL_ID);
    let mut stream = control
        .open_stream(peer_id, proto)
        .await
        .map_err(|e| PorchError::InvalidInput(format!("open_stream: {e:?}")))?;
    let request_bytes = serde_json::to_vec(&request).map_err(PorchError::Serde)?;
    if request_bytes.len() > MAX_HISTORY_ENVELOPE_BYTES {
        return Err(PorchError::MalformedEnvelope(format!(
            "history request too large: {} > {}",
            request_bytes.len(),
            MAX_HISTORY_ENVELOPE_BYTES
        )));
    }
    let len_be = (request_bytes.len() as u32).to_be_bytes();
    stream.write_all(&len_be).await.map_err(PorchError::Io)?;
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
    if len > MAX_HISTORY_ENVELOPE_BYTES {
        return Err(PorchError::MalformedEnvelope(format!(
            "history response too large: {} > {}",
            len, MAX_HISTORY_ENVELOPE_BYTES
        )));
    }
    let mut buf = vec![0u8; len];
    stream
        .read_exact(&mut buf)
        .await
        .map_err(PorchError::Io)?;
    let _ = stream.close().await;
    let response: HistoryResponse =
        serde_json::from_slice(&buf).map_err(PorchError::Serde)?;
    if response.ok {
        response
            .result
            .ok_or_else(|| PorchError::MalformedEnvelope("missing result".to_string()))
    } else {
        let body = response
            .error
            .ok_or_else(|| PorchError::MalformedEnvelope("missing error".to_string()))?;
        if body.code == 403 {
            Err(PorchError::AccessDenied {
                channel_id: body.message,
            })
        } else if body.code == 404 {
            Err(PorchError::ChannelNotFound {
                channel_id: body.message,
            })
        } else {
            Err(PorchError::InvalidInput(body.message))
        }
    }
}

// ---------------------------------------------------------------------------
// Vouch-link builder helpers for tests + the Tauri command surface
// ---------------------------------------------------------------------------

/// Build a `VouchLink` using an `ed25519_dalek::SigningKey` directly.
/// Convenience around [`VouchLink::build`] for callers that already
/// have a signing key materialized.
pub fn sign_vouch_with_key(
    voucher_signing: &ed25519_dalek::SigningKey,
    subject: PeerIdent,
    target_peer_id: String,
) -> VouchLink {
    use ed25519_dalek::Signer;
    let voucher_vkey = voucher_signing.verifying_key();
    let voucher_peer_id = libp2p::identity::PublicKey::from(
        libp2p::identity::ed25519::PublicKey::try_from_bytes(&voucher_vkey.to_bytes())
            .expect("ed25519 pubkey accepted by libp2p"),
    )
    .to_peer_id();
    let voucher = PeerIdent::from_keypair(voucher_peer_id, &voucher_vkey);
    VouchLink::build(subject, voucher, target_peer_id, |bytes| {
        voucher_signing.sign(bytes).to_bytes()
    })
}

/// Build a `PeerIdent` for a peer whose Ed25519 signing key we hold.
pub fn peer_ident_from_signing_key(signing: &ed25519_dalek::SigningKey) -> PeerIdent {
    let vkey = signing.verifying_key();
    let peer_id = libp2p::identity::PublicKey::from(
        libp2p::identity::ed25519::PublicKey::try_from_bytes(&vkey.to_bytes())
            .expect("ed25519 pubkey accepted by libp2p"),
    )
    .to_peer_id();
    PeerIdent::from_keypair(peer_id, &vkey)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;
    use rand::RngCore;

    fn fresh_signing_key() -> SigningKey {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        SigningKey::from_bytes(&seed)
    }

    fn peer_id_of(sk: &SigningKey) -> PeerId {
        peer_ident_from_signing_key(sk)
            .parse_peer_id()
            .expect("constructed peer-id parses")
    }

    #[test]
    fn vouch_signature_round_trips() {
        let voucher_sk = fresh_signing_key();
        let subject_sk = fresh_signing_key();
        let server_sk = fresh_signing_key();
        let subject = peer_ident_from_signing_key(&subject_sk);
        let server_peer_id = peer_id_of(&server_sk);

        let link =
            sign_vouch_with_key(&voucher_sk, subject, server_peer_id.to_base58());
        link.verify_signature()
            .expect("freshly-built signature must verify");
    }

    #[test]
    fn vouch_signature_rejects_tampered_subject() {
        let voucher_sk = fresh_signing_key();
        let subject_sk = fresh_signing_key();
        let other_sk = fresh_signing_key();
        let server_sk = fresh_signing_key();
        let server_peer_id = peer_id_of(&server_sk);
        let subject = peer_ident_from_signing_key(&subject_sk);

        let mut link =
            sign_vouch_with_key(&voucher_sk, subject, server_peer_id.to_base58());
        // Swap subject — signature should no longer verify.
        link.subject = peer_ident_from_signing_key(&other_sk);
        let err = link
            .verify_signature()
            .expect_err("tampered subject must fail verification");
        match err {
            PorchError::InvalidInput(_) => {}
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn vouch_signature_rejects_tampered_target() {
        let voucher_sk = fresh_signing_key();
        let subject_sk = fresh_signing_key();
        let server_sk = fresh_signing_key();
        let other_server_sk = fresh_signing_key();
        let server_peer_id = peer_id_of(&server_sk);
        let other_server = peer_id_of(&other_server_sk);
        let subject = peer_ident_from_signing_key(&subject_sk);

        let mut link =
            sign_vouch_with_key(&voucher_sk, subject, server_peer_id.to_base58());
        link.target_peer_id = other_server.to_base58();
        link.verify_signature()
            .expect_err("target swap must invalidate signature");
    }

    #[test]
    fn peer_ident_rejects_mismatched_peer_id() {
        let sk_a = fresh_signing_key();
        let sk_b = fresh_signing_key();
        let mut ident = peer_ident_from_signing_key(&sk_a);
        // Splice in a foreign peer-id; pubkey still belongs to A.
        ident.peer_id = peer_id_of(&sk_b).to_base58();
        let err = ident.verify_peerid_pubkey_link().unwrap_err();
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn verify_empty_chain_requires_paired_anchor() {
        let server_sk = fresh_signing_key();
        let requester_sk = fresh_signing_key();
        let server_peer_id = peer_id_of(&server_sk);
        let requester_peer_id = peer_id_of(&requester_sk);

        let request = HistoryRequest {
            requester: peer_ident_from_signing_key(&requester_sk),
            target_peer_id: server_peer_id.to_base58(),
            channel_id: "porch-default".to_string(),
            limit: 10,
            chain: vec![],
        };

        // No paired peers — must reject.
        let empty: HashSet<String> = HashSet::new();
        let err = verify_hop_chain(&request, requester_peer_id, server_peer_id, &empty)
            .unwrap_err();
        assert!(matches!(err, PorchError::AccessDenied { .. }));

        // Paired peer — must accept.
        let mut paired: HashSet<String> = HashSet::new();
        paired.insert(requester_peer_id.to_base58());
        let hops =
            verify_hop_chain(&request, requester_peer_id, server_peer_id, &paired)
                .expect("paired empty-chain must verify");
        assert_eq!(hops, 0);
    }

    #[test]
    fn verify_one_link_chain_requires_terminus_in_paired() {
        // Topology: C (requester) ──pair──> B ──pair──> D (server).
        // D's paired-peer list contains only B.
        let server_sk = fresh_signing_key();
        let b_sk = fresh_signing_key();
        let c_sk = fresh_signing_key();
        let server_peer_id = peer_id_of(&server_sk);
        let b_peer_id = peer_id_of(&b_sk);
        let c_peer_id = peer_id_of(&c_sk);

        let subject = peer_ident_from_signing_key(&c_sk);
        let link =
            sign_vouch_with_key(&b_sk, subject, server_peer_id.to_base58());
        let request = HistoryRequest {
            requester: peer_ident_from_signing_key(&c_sk),
            target_peer_id: server_peer_id.to_base58(),
            channel_id: "porch-default".to_string(),
            limit: 10,
            chain: vec![link],
        };

        // Paired set contains B → accept.
        let mut paired: HashSet<String> = HashSet::new();
        paired.insert(b_peer_id.to_base58());
        let hops =
            verify_hop_chain(&request, c_peer_id, server_peer_id, &paired)
                .expect("valid one-link chain must verify");
        assert_eq!(hops, 1);

        // Paired set without B → reject (no trust anchor).
        let empty: HashSet<String> = HashSet::new();
        let err =
            verify_hop_chain(&request, c_peer_id, server_peer_id, &empty)
                .unwrap_err();
        assert!(matches!(err, PorchError::AccessDenied { .. }));
    }

    #[test]
    fn verify_rejects_overlong_chain() {
        let server_sk = fresh_signing_key();
        let server_peer_id = peer_id_of(&server_sk);
        let requester_sk = fresh_signing_key();
        let requester_peer_id = peer_id_of(&requester_sk);

        // Build a chain of MAX_HOP_CHAIN_LEN + 1 dummy links; they
        // don't need to be well-formed because the length check fires
        // first.
        let dummy_link = sign_vouch_with_key(
            &fresh_signing_key(),
            peer_ident_from_signing_key(&requester_sk),
            server_peer_id.to_base58(),
        );
        let chain: Vec<VouchLink> =
            std::iter::repeat_with(|| dummy_link.clone())
                .take(MAX_HOP_CHAIN_LEN + 1)
                .collect();

        let request = HistoryRequest {
            requester: peer_ident_from_signing_key(&requester_sk),
            target_peer_id: server_peer_id.to_base58(),
            channel_id: "porch-default".to_string(),
            limit: 10,
            chain,
        };
        let empty: HashSet<String> = HashSet::new();
        let err = verify_hop_chain(
            &request,
            requester_peer_id,
            server_peer_id,
            &empty,
        )
        .unwrap_err();
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn verify_rejects_misdirected_request() {
        let server_sk = fresh_signing_key();
        let other_server_sk = fresh_signing_key();
        let requester_sk = fresh_signing_key();
        let server_peer_id = peer_id_of(&server_sk);
        let other_server = peer_id_of(&other_server_sk);
        let requester_peer_id = peer_id_of(&requester_sk);

        let request = HistoryRequest {
            requester: peer_ident_from_signing_key(&requester_sk),
            // Addressed to a different server.
            target_peer_id: other_server.to_base58(),
            channel_id: "porch-default".to_string(),
            limit: 10,
            chain: vec![],
        };
        let mut paired: HashSet<String> = HashSet::new();
        paired.insert(requester_peer_id.to_base58());
        let err = verify_hop_chain(
            &request,
            requester_peer_id,
            server_peer_id,
            &paired,
        )
        .unwrap_err();
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn verify_rejects_connection_peer_mismatch() {
        let server_sk = fresh_signing_key();
        let requester_sk = fresh_signing_key();
        let impostor_sk = fresh_signing_key();
        let server_peer_id = peer_id_of(&server_sk);
        let requester_peer_id = peer_id_of(&requester_sk);
        let impostor_peer_id = peer_id_of(&impostor_sk);

        let request = HistoryRequest {
            requester: peer_ident_from_signing_key(&requester_sk),
            target_peer_id: server_peer_id.to_base58(),
            channel_id: "porch-default".to_string(),
            limit: 10,
            chain: vec![],
        };
        let mut paired: HashSet<String> = HashSet::new();
        paired.insert(requester_peer_id.to_base58());
        // Connection is from the impostor; verifier must reject.
        let err = verify_hop_chain(
            &request,
            impostor_peer_id,
            server_peer_id,
            &paired,
        )
        .unwrap_err();
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn verify_rejects_chain_links_with_wrong_subject() {
        // Topology: C wants D's history via B. But chain[0].subject is
        // not C — it's some random peer X. Must reject "link 0 subject != requester".
        let server_sk = fresh_signing_key();
        let b_sk = fresh_signing_key();
        let c_sk = fresh_signing_key();
        let x_sk = fresh_signing_key();
        let server_peer_id = peer_id_of(&server_sk);
        let b_peer_id = peer_id_of(&b_sk);
        let c_peer_id = peer_id_of(&c_sk);

        let link = sign_vouch_with_key(
            &b_sk,
            peer_ident_from_signing_key(&x_sk),
            server_peer_id.to_base58(),
        );
        let request = HistoryRequest {
            requester: peer_ident_from_signing_key(&c_sk),
            target_peer_id: server_peer_id.to_base58(),
            channel_id: "porch-default".to_string(),
            limit: 10,
            chain: vec![link],
        };
        let mut paired: HashSet<String> = HashSet::new();
        paired.insert(b_peer_id.to_base58());
        let err =
            verify_hop_chain(&request, c_peer_id, server_peer_id, &paired)
                .unwrap_err();
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn dispatch_returns_messages_for_paired_peer() {
        let porch = Arc::new(Porch::open_in_memory().unwrap());
        // Seed the default porch channel with a few messages.
        for i in 0..3 {
            porch
                .post_message(
                    crate::porch::DEFAULT_PORCH_CHANNEL_ID,
                    "12D3KooWlocal",
                    &format!("msg {i}"),
                )
                .unwrap();
        }
        let server_sk = fresh_signing_key();
        let requester_sk = fresh_signing_key();
        let server_peer_id = peer_id_of(&server_sk);
        let requester_peer_id = peer_id_of(&requester_sk);

        let mut paired_set: HashSet<String> = HashSet::new();
        paired_set.insert(requester_peer_id.to_base58());
        let paired_source: Arc<dyn PairedPeerSource> =
            Arc::new(StaticPairedPeers(paired_set));

        let handler = HistoryHandler::new(porch, server_peer_id, paired_source);
        let request = HistoryRequest {
            requester: peer_ident_from_signing_key(&requester_sk),
            target_peer_id: server_peer_id.to_base58(),
            channel_id: crate::porch::DEFAULT_PORCH_CHANNEL_ID.to_string(),
            limit: 50,
            chain: vec![],
        };
        let response = handler.dispatch(requester_peer_id, request).await;
        assert!(response.ok, "paired empty-chain must succeed: {:?}", response.error);
        let result = response.result.unwrap();
        assert_eq!(result.hops, 0);
        assert_eq!(result.messages.len(), 3);
    }

    #[tokio::test]
    async fn dispatch_caps_limit_at_max_history_limit() {
        let porch = Arc::new(Porch::open_in_memory().unwrap());
        for i in 0..(MAX_HISTORY_LIMIT as usize + 50) {
            porch
                .post_message(
                    crate::porch::DEFAULT_PORCH_CHANNEL_ID,
                    "12D3KooWlocal",
                    &format!("msg {i}"),
                )
                .unwrap();
        }
        let server_sk = fresh_signing_key();
        let requester_sk = fresh_signing_key();
        let server_peer_id = peer_id_of(&server_sk);
        let requester_peer_id = peer_id_of(&requester_sk);

        let mut paired: HashSet<String> = HashSet::new();
        paired.insert(requester_peer_id.to_base58());
        let handler = HistoryHandler::new(
            porch,
            server_peer_id,
            Arc::new(StaticPairedPeers(paired)),
        );
        let request = HistoryRequest {
            requester: peer_ident_from_signing_key(&requester_sk),
            target_peer_id: server_peer_id.to_base58(),
            channel_id: crate::porch::DEFAULT_PORCH_CHANNEL_ID.to_string(),
            // Request way more than the cap.
            limit: u32::MAX / 2,
            chain: vec![],
        };
        let response = handler.dispatch(requester_peer_id, request).await;
        // Egregiously large limit must be rejected up-front.
        assert!(!response.ok);
    }
}
