//! F-A — Concord-native user-definition protocol.
//!
//! The Concord user-definition protocol is a transport-agnostic identity
//! bridge that lets two paired Concord instances share a normalized view of
//! the same hero's profile across Matrix federation, libp2p porch, and
//! Concord-via-domain HTTP. It is the implementation of Architecture A in
//! `docs/architecture/concord-user-protocol-scope.md` (scoped) and section
//! 2.a of `docs/architecture/hero-account-rfc.md` (referenced).
//!
//! ## What this module owns
//!
//! - [`ConcordUserDescriptor`] — the canonical wire+memory representation of
//!   one hero across every transport. Has a stable Ed25519-backed identifier
//!   ([`ConcordUid`]), a vanity display name, a transport-agnostic avatar
//!   reference ([`AvatarRef`]), a set of per-server profile rows
//!   ([`ServerProfile`]), and a list of trust-edge declarations
//!   ([`TrustEdge`]).
//! - [`AvatarRef`] — protocol-agnostic avatar location: a libp2p multiaddr to
//!   a content-addressed blob, a Matrix `mxc://` URL, or a porch local-asset
//!   id. The renderer dispatches per-variant.
//! - [`TrustEdge`] — a signed declaration of "these two servers may merge
//!   this user's profile state." Trust edges are USER-EXPLICIT only — no
//!   auto-merging anywhere in this module.
//! - [`merge_view`] — given a descriptor and the set of trust edges the user
//!   has signed (some of which may be revocations), compute the user's
//!   effective profile state per server. Per-server isolation by default;
//!   merged where trust edges link two server rows.
//!
//! ## Per-server identity isolation is the DEFAULT, NOT a side-effect
//!
//! The user said: *"a user could potentially impress two completely different
//! impressions on a server full of users with ease. this is intentional."*
//!
//! That means a fresh ConcordUserDescriptor with three per-server rows and
//! NO trust edges yields three independent merged profiles — one per server.
//! Cross-server linkage happens ONLY when both endpoints opt into a trust
//! relationship by signing a [`TrustEdge`]. The default is isolation.
//!
//! ## Matrix federation bridge — the descriptor is OPAQUE to Matrix
//!
//! When a Concord instance speaks to a Matrix homeserver (see
//! `crate::servitude::federation::matrix`), the homeserver still sees a
//! NORMAL Matrix user — a `@localpart:server.tld` MXID with a Matrix
//! displayname and Matrix avatar URL. The Concord [`ConcordUserDescriptor`]
//! is invisible to Matrix: the bridge translates ONLY the per-Matrix-server
//! profile row ([`ServerProfile`] for that homeserver's `ServerId`) into the
//! Matrix profile shape. Other servers' rows do not cross the bridge.
//!
//! This means: even if a hero has 5 per-server rows in their descriptor,
//! a Matrix homeserver federated to ONE of them only ever learns about the
//! one row that corresponds to its own ServerId. Per-server identity
//! isolation extends across the bridge.
//!
//! ## Programmatic-chat interaction is an OPEN follow-up
//!
//! The scope doc (`concord-user-protocol-scope.md` §non-scope) lists the bot
//! / programmatic-chat-application interaction as deferred. This module
//! provides a placeholder via [`ServerProfile::bio`] (free-form text) but
//! does not define how a bot identity differs from a hero identity, how a
//! bot consents to a trust edge, or whether bots get their own descriptor.
//! That is a separate follow-up dispatch.

pub mod local;
pub mod protocol;
pub mod trust_store;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use ed25519_dalek::{Signature, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::servitude::identity::{PUBLIC_KEY_LEN, SECRET_SEED_LEN, SIGNATURE_LEN};

// ---------------------------------------------------------------------------
// Domain-separation tag
// ---------------------------------------------------------------------------

/// Domain-separation tag for the Concord user-definition protocol. Mixed
/// into every signature payload so a hero's same Ed25519 key cannot be
/// tricked into signing a payload from another protocol that happens to
/// share a prefix. The tag is prepended to the canonical bytes before they
/// reach `SigningKey::sign`.
///
/// Format: `concord/user-protocol/<purpose>/<version>`. Bump the version
/// suffix when the canonical encoding of any signed payload changes.
pub const DOMAIN_TAG_DESCRIPTOR_ROW: &[u8] = b"concord/user-protocol/server-row/v1";
pub const DOMAIN_TAG_TRUST_EDGE: &[u8] = b"concord/user-protocol/trust-edge/v1";
pub const DOMAIN_TAG_TRUST_REVOKE: &[u8] = b"concord/user-protocol/trust-revoke/v1";

// ---------------------------------------------------------------------------
// Stable identifier
// ---------------------------------------------------------------------------

/// The `concord_uid` from the scope doc — a 32-byte Ed25519 public key the
/// hero controls. Derived from the same seed pool as the libp2p peerid (via
/// the domain-separation tag `concord/user-protocol/server-row/v1` etc.) so
/// the user-definition protocol shares a cryptographic root with peer
/// identity but signs distinct payloads.
///
/// On a given install the seed lives in Stronghold (see
/// `crate::servitude::identity`); this type only ever carries the public
/// half.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ConcordUid(#[serde(with = "serde_byte_array_32")] pub [u8; PUBLIC_KEY_LEN]);

impl ConcordUid {
    /// Construct from the hero's raw Ed25519 public key bytes. The bytes
    /// MUST be a valid Ed25519 public key — callers passing arbitrary
    /// 32-byte blobs will hit the verifier later instead of here.
    pub const fn from_pubkey(public_key: [u8; PUBLIC_KEY_LEN]) -> Self {
        Self(public_key)
    }

    /// Borrow the raw public-key bytes.
    pub fn as_bytes(&self) -> &[u8; PUBLIC_KEY_LEN] {
        &self.0
    }

    /// Hex-encode for human-facing surfaces (JSON, logs, etc).
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Parse from a hex string. Returns `None` on wrong length / non-hex.
    pub fn from_hex(hex_str: &str) -> Option<Self> {
        if hex_str.len() != PUBLIC_KEY_LEN * 2 {
            return None;
        }
        let bytes = hex::decode(hex_str).ok()?;
        let mut out = [0u8; PUBLIC_KEY_LEN];
        out.copy_from_slice(&bytes);
        Some(Self(out))
    }
}

impl fmt::Debug for ConcordUid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ConcordUid({})", self.to_hex())
    }
}

impl fmt::Display for ConcordUid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_hex())
    }
}

/// Opaque stable identifier for a Concord server (or Matrix-federation
/// homeserver, or any source the user is signed into). Free-form because
/// the user-definition protocol must describe Matrix homeservers, libp2p
/// porch instances, and Concord-via-domain HTTP servers under one type.
///
/// Conventions (NOT enforced by this type; the receiver normalizes):
/// - Matrix homeservers: `matrix:<server_name>` (e.g. `matrix:matrix.org`).
/// - Concord-via-domain instances: `concord:<domain>` (e.g.
///   `concord:example.com`).
/// - libp2p porch instances: `porch:<peer_id_base58>`.
///
/// The type's only invariant is "non-empty string". Anything that doesn't
/// parse as one of those forms is treated as a future / unknown source by
/// the merge view (it does NOT merge into anything else by default).
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ServerId(pub String);

impl ServerId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ServerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ServerId({:?})", self.0)
    }
}

impl fmt::Display for ServerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for ServerId {
    fn from(s: &str) -> Self {
        ServerId(s.to_string())
    }
}

impl From<String> for ServerId {
    fn from(s: String) -> Self {
        ServerId(s)
    }
}

// ---------------------------------------------------------------------------
// Avatar reference
// ---------------------------------------------------------------------------

/// Transport-agnostic avatar pointer. Per the scope doc: an avatar can live
/// in any of three places, and the descriptor must round-trip them all
/// without forcing the renderer to invent a fourth abstraction.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AvatarRef {
    /// libp2p multiaddr to a content-addressed blob — the canonical
    /// transport-native form. The receiver dials it and fetches the blob.
    Multiaddr { multiaddr: String },
    /// Matrix Content URI — used when the hero is presenting through the
    /// Matrix federation bridge. The Matrix homeserver stores the asset.
    MatrixMxc { mxc: String },
    /// Porch local-asset id — used when the asset lives in this install's
    /// own porch blob store. Resolved via `porch::theme::asset_bytes(id)`.
    PorchAsset { asset_id: String },
    /// Empty avatar — the descriptor explicitly records "no avatar set."
    /// Used by the per-server-isolation default so the absence of an
    /// avatar is distinguishable from a missing row.
    None,
}

impl AvatarRef {
    /// True when the variant represents an actual asset (not `None`).
    pub fn is_set(&self) -> bool {
        !matches!(self, AvatarRef::None)
    }
}

// ---------------------------------------------------------------------------
// Per-server profile row
// ---------------------------------------------------------------------------

/// One server's view of the hero's profile.
///
/// Per the user's intent (per-server identity isolation), each row is
/// INDEPENDENT — a hero can present a completely different display name,
/// avatar, and bio on each server, and the absence of a trust edge keeps
/// those impressions separate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerProfile {
    /// Which server this row applies to.
    pub server_id: ServerId,
    /// Per-server vanity name (what users on this server see).
    pub display_name: String,
    /// Per-server avatar pointer.
    pub avatar: AvatarRef,
    /// Optional per-server free-form bio. Placeholder for the
    /// programmatic-chat / bot-interaction follow-up — bots can write
    /// machine-readable hints here without breaking the descriptor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    /// Ed25519 signature by the hero (concord_uid) over the canonical
    /// bytes of this row PLUS the [`DOMAIN_TAG_DESCRIPTOR_ROW`] prefix.
    /// Lets a verifier confirm "this server-row was signed by the hero
    /// whose concord_uid sits at the top of the descriptor."
    #[serde(with = "serde_byte_array_64")]
    pub signature: [u8; SIGNATURE_LEN],
}

impl ServerProfile {
    /// Build the canonical bytes the signature covers. Pure function;
    /// stable across builds — bumping its definition requires bumping
    /// [`DOMAIN_TAG_DESCRIPTOR_ROW`].
    ///
    /// Layout:
    /// `[tag][concord_uid][server_id_len:u32 BE][server_id][display_name_len:u32 BE]`
    /// `[display_name][bio_present:u8][bio_len:u32 BE if present][bio]`
    /// `[avatar canonical-encoded via serde_json]`.
    ///
    /// JSON is used for the avatar variant because it round-trips the
    /// tagged enum cleanly and doesn't require us to invent a new wire
    /// format for three short variants. The rest is fixed-layout so we
    /// don't pay JSON's whitespace ambiguity on the load-bearing fields.
    pub fn signing_bytes(
        concord_uid: &ConcordUid,
        server_id: &ServerId,
        display_name: &str,
        bio: Option<&str>,
        avatar: &AvatarRef,
    ) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(DOMAIN_TAG_DESCRIPTOR_ROW);
        buf.extend_from_slice(concord_uid.as_bytes());

        let server_bytes = server_id.as_str().as_bytes();
        buf.extend_from_slice(&(server_bytes.len() as u32).to_be_bytes());
        buf.extend_from_slice(server_bytes);

        let name_bytes = display_name.as_bytes();
        buf.extend_from_slice(&(name_bytes.len() as u32).to_be_bytes());
        buf.extend_from_slice(name_bytes);

        match bio {
            Some(b) => {
                buf.push(1u8);
                let bb = b.as_bytes();
                buf.extend_from_slice(&(bb.len() as u32).to_be_bytes());
                buf.extend_from_slice(bb);
            }
            None => {
                buf.push(0u8);
            }
        }

        // Avatar: serialize as compact JSON to a Vec<u8>. The serde
        // representation of `AvatarRef` is stable (tagged enum, snake_case
        // discriminants); the JSON output is deterministic for the
        // variants we ship.
        let avatar_json = serde_json::to_vec(avatar).expect("AvatarRef serializes");
        buf.extend_from_slice(&(avatar_json.len() as u32).to_be_bytes());
        buf.extend_from_slice(&avatar_json);

        buf
    }

    /// Sign + construct a new ServerProfile. Convenience helper used by the
    /// Tauri command surface — production code building a descriptor
    /// shouldn't have to hand-roll the signing path.
    pub fn sign_new(
        signing_key: &SigningKey,
        concord_uid: &ConcordUid,
        server_id: ServerId,
        display_name: String,
        bio: Option<String>,
        avatar: AvatarRef,
    ) -> Self {
        let bytes =
            Self::signing_bytes(concord_uid, &server_id, &display_name, bio.as_deref(), &avatar);
        use ed25519_dalek::Signer;
        let sig: Signature = signing_key.sign(&bytes);
        Self {
            server_id,
            display_name,
            avatar,
            bio,
            signature: sig.to_bytes(),
        }
    }

    /// Verify the signature against the hero's verifying key. Returns
    /// `true` when the signature is valid for the canonical bytes of this
    /// row under the hero's `concord_uid`.
    pub fn verify(&self, concord_uid: &ConcordUid) -> bool {
        let Ok(verifying_key) = VerifyingKey::from_bytes(concord_uid.as_bytes()) else {
            return false;
        };
        let bytes = Self::signing_bytes(
            concord_uid,
            &self.server_id,
            &self.display_name,
            self.bio.as_deref(),
            &self.avatar,
        );
        let sig = Signature::from_bytes(&self.signature);
        verifying_key.verify(&bytes, &sig).is_ok()
    }
}

// ---------------------------------------------------------------------------
// Trust edge
// ---------------------------------------------------------------------------

/// Stable identifier for a trust edge — content-derived from the edge's
/// `(concord_uid, server_a, server_b)` triplet. Lets revocations reference
/// the original declaration without needing the hero's signing key.
pub type TrustEdgeId = String;

/// Computes a deterministic trust-edge id from its components. SHA-256 of
/// the components, base16 truncated to 16 chars (64 bits — plenty for the
/// per-hero local namespace).
pub fn compute_trust_edge_id(
    concord_uid: &ConcordUid,
    server_a: &ServerId,
    server_b: &ServerId,
) -> TrustEdgeId {
    use sha2::{Digest, Sha256};
    let (a, b) = if server_a <= server_b {
        (server_a, server_b)
    } else {
        (server_b, server_a)
    };
    let mut h = Sha256::new();
    h.update(b"concord/user-protocol/edge-id/v1");
    h.update(concord_uid.as_bytes());
    h.update((a.as_str().len() as u32).to_be_bytes());
    h.update(a.as_str().as_bytes());
    h.update((b.as_str().len() as u32).to_be_bytes());
    h.update(b.as_str().as_bytes());
    hex::encode(&h.finalize()[..8])
}

/// A signed declaration that two servers may merge this hero's per-server
/// state into a single effective profile.
///
/// Trust edges are PER-HERO — the hero's `concord_uid` is who signs. Either
/// endpoint can verify by reading the descriptor and looking up the hero's
/// public key.
///
/// Edges are SYMMETRIC: `(server_a, server_b)` and `(server_b, server_a)`
/// are the same edge. The canonical signing bytes order the two server ids
/// lexicographically so a hero who accidentally signs the same edge twice
/// in opposite orders produces the same signature both times.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustEdge {
    /// Stable id for this edge — see [`compute_trust_edge_id`].
    pub edge_id: TrustEdgeId,
    /// The hero who declared the trust.
    pub concord_uid: ConcordUid,
    /// One of the two trusted servers.
    pub server_a: ServerId,
    /// The other trusted server.
    pub server_b: ServerId,
    /// Unix epoch seconds at issue time.
    pub issued_at: u64,
    /// Ed25519 signature by the hero over `(tag, uid, sorted(a,b), issued_at)`.
    #[serde(with = "serde_byte_array_64")]
    pub signature: [u8; SIGNATURE_LEN],
}

impl TrustEdge {
    /// Canonical signing bytes — see the type-level note about symmetric
    /// ordering.
    pub fn signing_bytes(
        concord_uid: &ConcordUid,
        server_a: &ServerId,
        server_b: &ServerId,
        issued_at: u64,
    ) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(DOMAIN_TAG_TRUST_EDGE);
        buf.extend_from_slice(concord_uid.as_bytes());
        let (a, b) = if server_a <= server_b {
            (server_a, server_b)
        } else {
            (server_b, server_a)
        };
        let ab = a.as_str().as_bytes();
        let bb = b.as_str().as_bytes();
        buf.extend_from_slice(&(ab.len() as u32).to_be_bytes());
        buf.extend_from_slice(ab);
        buf.extend_from_slice(&(bb.len() as u32).to_be_bytes());
        buf.extend_from_slice(bb);
        buf.extend_from_slice(&issued_at.to_be_bytes());
        buf
    }

    /// Sign + construct a new TrustEdge.
    pub fn sign_new(
        signing_key: &SigningKey,
        concord_uid: ConcordUid,
        server_a: ServerId,
        server_b: ServerId,
        issued_at: u64,
    ) -> Self {
        let bytes = Self::signing_bytes(&concord_uid, &server_a, &server_b, issued_at);
        use ed25519_dalek::Signer;
        let sig: Signature = signing_key.sign(&bytes);
        let edge_id = compute_trust_edge_id(&concord_uid, &server_a, &server_b);
        Self {
            edge_id,
            concord_uid,
            server_a,
            server_b,
            issued_at,
            signature: sig.to_bytes(),
        }
    }

    /// Verify the edge's signature against its declared `concord_uid`.
    pub fn verify(&self) -> bool {
        let Ok(verifying_key) = VerifyingKey::from_bytes(self.concord_uid.as_bytes()) else {
            return false;
        };
        let bytes = Self::signing_bytes(
            &self.concord_uid,
            &self.server_a,
            &self.server_b,
            self.issued_at,
        );
        let sig = Signature::from_bytes(&self.signature);
        verifying_key.verify(&bytes, &sig).is_ok()
    }

    /// Whether this edge mentions `server_id` on either side.
    pub fn touches(&self, server_id: &ServerId) -> bool {
        &self.server_a == server_id || &self.server_b == server_id
    }
}

/// A signed revocation of a previously-declared trust edge. Append-only
/// semantics — the trust store never deletes an edge; instead, a revocation
/// supersedes the prior declaration. The merge view honors the latest
/// (edge or revocation) entry by `issued_at`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustEdgeRevocation {
    pub edge_id: TrustEdgeId,
    pub concord_uid: ConcordUid,
    pub revoked_at: u64,
    #[serde(with = "serde_byte_array_64")]
    pub signature: [u8; SIGNATURE_LEN],
}

impl TrustEdgeRevocation {
    pub fn signing_bytes(
        concord_uid: &ConcordUid,
        edge_id: &TrustEdgeId,
        revoked_at: u64,
    ) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(DOMAIN_TAG_TRUST_REVOKE);
        buf.extend_from_slice(concord_uid.as_bytes());
        let eid = edge_id.as_bytes();
        buf.extend_from_slice(&(eid.len() as u32).to_be_bytes());
        buf.extend_from_slice(eid);
        buf.extend_from_slice(&revoked_at.to_be_bytes());
        buf
    }

    pub fn sign_new(
        signing_key: &SigningKey,
        concord_uid: ConcordUid,
        edge_id: TrustEdgeId,
        revoked_at: u64,
    ) -> Self {
        let bytes = Self::signing_bytes(&concord_uid, &edge_id, revoked_at);
        use ed25519_dalek::Signer;
        let sig: Signature = signing_key.sign(&bytes);
        Self {
            edge_id,
            concord_uid,
            revoked_at,
            signature: sig.to_bytes(),
        }
    }

    pub fn verify(&self) -> bool {
        let Ok(verifying_key) = VerifyingKey::from_bytes(self.concord_uid.as_bytes()) else {
            return false;
        };
        let bytes = Self::signing_bytes(&self.concord_uid, &self.edge_id, self.revoked_at);
        let sig = Signature::from_bytes(&self.signature);
        verifying_key.verify(&bytes, &sig).is_ok()
    }
}

/// One entry in the trust-store append-only log. Either a new edge
/// declaration or a revocation. The store ([`trust_store`]) writes these
/// in `issued_at` / `revoked_at` order on disk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TrustLogEntry {
    Edge(TrustEdge),
    Revocation(TrustEdgeRevocation),
}

impl TrustLogEntry {
    pub fn timestamp(&self) -> u64 {
        match self {
            TrustLogEntry::Edge(e) => e.issued_at,
            TrustLogEntry::Revocation(r) => r.revoked_at,
        }
    }

    pub fn edge_id(&self) -> &str {
        match self {
            TrustLogEntry::Edge(e) => &e.edge_id,
            TrustLogEntry::Revocation(r) => &r.edge_id,
        }
    }

    pub fn concord_uid(&self) -> &ConcordUid {
        match self {
            TrustLogEntry::Edge(e) => &e.concord_uid,
            TrustLogEntry::Revocation(r) => &r.concord_uid,
        }
    }
}

// ---------------------------------------------------------------------------
// ConcordUserDescriptor
// ---------------------------------------------------------------------------

/// The canonical user record exchanged by the F-A protocol.
///
/// Wire format: serde JSON. The descriptor is content-addressable in the
/// sense that two installs holding the same row set + edge set produce the
/// same JSON (up to map ordering — both encoders use BTreeMap for
/// deterministic key order; `ServerProfile` rows are kept in a Vec sorted by
/// `server_id`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConcordUserDescriptor {
    /// The hero's stable cross-transport identifier.
    pub concord_uid: ConcordUid,
    /// Top-level vanity name. The user's primary display name when no
    /// server-specific row exists. Per-server rows may override this.
    pub display_name: String,
    /// Each row records one server's view of the hero. INDEPENDENT by
    /// default; merged only where a [`TrustEdge`] connects two rows. The
    /// `Vec` is kept sorted by `server_id` for deterministic serialization.
    pub server_profiles: Vec<ServerProfile>,
    /// Trust-edge declarations the hero has signed. Append-only — the
    /// merge view honors the latest entry per `edge_id`. May include both
    /// [`TrustEdge::Edge`] declarations and revocations.
    pub trust_log: Vec<TrustLogEntry>,
}

impl ConcordUserDescriptor {
    /// Build a descriptor with no server rows and no trust edges. The
    /// starting state for a fresh hero. `display_name` is the vanity name
    /// shown when no per-server row exists.
    pub fn empty(concord_uid: ConcordUid, display_name: impl Into<String>) -> Self {
        Self {
            concord_uid,
            display_name: display_name.into(),
            server_profiles: Vec::new(),
            trust_log: Vec::new(),
        }
    }

    /// Add (or replace) a server row. The new row replaces any existing
    /// row with the same `server_id`. The Vec is re-sorted after the
    /// insertion so the wire format is deterministic.
    pub fn upsert_server_profile(&mut self, profile: ServerProfile) {
        if let Some(slot) = self
            .server_profiles
            .iter_mut()
            .find(|p| p.server_id == profile.server_id)
        {
            *slot = profile;
        } else {
            self.server_profiles.push(profile);
        }
        self.server_profiles
            .sort_by(|a, b| a.server_id.cmp(&b.server_id));
    }

    /// Append a trust-log entry (edge or revocation). The log is kept in
    /// insertion-then-timestamp order: callers should pass entries in the
    /// order they were signed, but the [`merge_view`] reducer treats the
    /// log as a multiset and always picks the highest-timestamp entry per
    /// `edge_id`.
    pub fn append_trust(&mut self, entry: TrustLogEntry) {
        self.trust_log.push(entry);
    }

    /// Verify every signature in the descriptor. Returns `Ok(())` if all
    /// server rows AND all trust-log entries are signed by the
    /// descriptor's `concord_uid`. Wrong concord_uid on any trust entry
    /// is treated as a verification failure: a hero's descriptor may only
    /// contain trust declarations they themselves signed.
    pub fn verify_all_signatures(&self) -> Result<(), DescriptorError> {
        for row in &self.server_profiles {
            if !row.verify(&self.concord_uid) {
                return Err(DescriptorError::InvalidSignature {
                    field: format!("server_profile[{}]", row.server_id),
                });
            }
        }
        for entry in &self.trust_log {
            if entry.concord_uid() != &self.concord_uid {
                return Err(DescriptorError::InvalidSignature {
                    field: format!(
                        "trust_log[{}]: wrong concord_uid",
                        entry.edge_id()
                    ),
                });
            }
            let ok = match entry {
                TrustLogEntry::Edge(e) => e.verify(),
                TrustLogEntry::Revocation(r) => r.verify(),
            };
            if !ok {
                return Err(DescriptorError::InvalidSignature {
                    field: format!("trust_log[{}]", entry.edge_id()),
                });
            }
        }
        Ok(())
    }

    /// Compute the effective merge view for this descriptor — see
    /// [`merge_view`].
    pub fn merge_view(&self) -> MergeView {
        merge_view(self)
    }
}

// ---------------------------------------------------------------------------
// Merge view
// ---------------------------------------------------------------------------

/// The effective profile state for one merged group of servers. The hero
/// presents the same identity to every server in `servers` (because the
/// user signed a trust edge between them); on servers OUTSIDE this group
/// the hero presents a separate effective profile.
///
/// The chosen display_name + avatar + bio are the FIRST server row in
/// `servers` order. (Deterministic; the user can pick which row is
/// canonical by ordering their trust-edge declarations or by adjusting
/// per-server rows.) The merge intentionally does NOT try to "smart-merge"
/// fields — that would expose the user's hidden linkage between servers,
/// which would defeat the per-server-isolation default.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectiveProfile {
    /// All servers this effective profile applies to. Sorted.
    pub servers: Vec<ServerId>,
    /// Per the merge rule: the canonical display name is the first
    /// server's row's display name.
    pub display_name: String,
    pub avatar: AvatarRef,
    pub bio: Option<String>,
}

/// Computed merge view across the hero's per-server rows + the user's
/// signed trust edges. The view is a disjoint set of effective profiles —
/// each server maps to exactly one effective profile, and two servers
/// share an effective profile iff there is a path of currently-active
/// trust edges between them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeView {
    /// One effective profile per merged group. Order is deterministic
    /// (lex-sorted by the group's smallest `server_id`).
    pub profiles: Vec<EffectiveProfile>,
}

impl MergeView {
    /// How many effective profiles the descriptor resolves to. With no
    /// trust edges this equals the number of `ServerProfile` rows; with
    /// full trust this collapses to 1.
    pub fn len(&self) -> usize {
        self.profiles.len()
    }

    pub fn is_empty(&self) -> bool {
        self.profiles.is_empty()
    }

    /// Look up the effective profile that covers `server_id`. Returns
    /// `None` when no row exists for that server (the merge view does
    /// not fabricate placeholder rows for unmentioned servers).
    pub fn for_server(&self, server_id: &ServerId) -> Option<&EffectiveProfile> {
        self.profiles
            .iter()
            .find(|p| p.servers.iter().any(|s| s == server_id))
    }
}

/// Compute the effective merge view per the rules in the type-level docs.
///
/// Algorithm:
/// 1. Replay the trust log: for each `edge_id`, the latest entry by
///    timestamp wins. If the latest entry is a `TrustEdge`, the edge is
///    ACTIVE; if it's a revocation, the edge is INACTIVE. (Ties are broken
///    by entry order — later-appended wins. With current second-precision
///    timestamps a hero can't realistically sign two same-second entries
///    without explicit effort.)
/// 2. Build a union-find over the descriptor's server_ids, unioning the
///    endpoints of every active edge.
/// 3. Collapse each connected component to one `EffectiveProfile`. The
///    canonical display_name / avatar / bio come from the row with the
///    SMALLEST `server_id` in the component (deterministic).
/// 4. Return the components sorted by the smallest `server_id` of each.
pub fn merge_view(descriptor: &ConcordUserDescriptor) -> MergeView {
    // Step 1: resolve the latest trust-log entry per edge_id.
    let mut latest: BTreeMap<TrustEdgeId, TrustLogEntry> = BTreeMap::new();
    for (idx, entry) in descriptor.trust_log.iter().enumerate() {
        let id = entry.edge_id().to_string();
        match latest.get(&id) {
            None => {
                latest.insert(id, entry.clone());
            }
            Some(existing) => {
                let existing_ts = existing.timestamp();
                let new_ts = entry.timestamp();
                // Strict newer wins; on tie, later-appended wins.
                if new_ts > existing_ts {
                    latest.insert(id, entry.clone());
                } else if new_ts == existing_ts {
                    // Find existing's index. We just inserted in append
                    // order, so a later `idx` means a later insertion.
                    // To compare we have to find the existing's index;
                    // since we replay in order and only consider entries
                    // we've seen, the "existing" is by definition earlier,
                    // so the new (idx >=) wins.
                    let _ = idx;
                    latest.insert(id, entry.clone());
                }
            }
        }
    }

    // Step 2: union-find.
    let server_ids: Vec<ServerId> = descriptor
        .server_profiles
        .iter()
        .map(|p| p.server_id.clone())
        .collect();
    let mut uf = UnionFind::new(&server_ids);
    for (_id, entry) in &latest {
        if let TrustLogEntry::Edge(edge) = entry {
            // Only union edges whose endpoints both exist in the
            // descriptor. An edge that names a server with no row is
            // tolerated but treated as inactive for the merge view —
            // there's nothing to merge.
            let has_a = server_ids.iter().any(|s| s == &edge.server_a);
            let has_b = server_ids.iter().any(|s| s == &edge.server_b);
            if has_a && has_b {
                uf.union(&edge.server_a, &edge.server_b);
            }
        }
    }

    // Step 3: group by root.
    let mut components: BTreeMap<ServerId, BTreeSet<ServerId>> = BTreeMap::new();
    for s in &server_ids {
        let root = uf.find(s);
        components.entry(root).or_default().insert(s.clone());
    }

    // Step 4: produce EffectiveProfiles, ordered by smallest server_id
    // in each component.
    let mut profiles: Vec<EffectiveProfile> = components
        .into_values()
        .map(|servers| {
            // Pick the row whose server_id is the smallest in the
            // component as the canonical source.
            let canonical_server = servers.iter().next().cloned().expect("non-empty");
            let row = descriptor
                .server_profiles
                .iter()
                .find(|p| p.server_id == canonical_server)
                .cloned()
                .expect("server_profiles must contain canonical_server");
            EffectiveProfile {
                servers: servers.into_iter().collect(),
                display_name: row.display_name,
                avatar: row.avatar,
                bio: row.bio,
            }
        })
        .collect();
    profiles.sort_by(|a, b| {
        let a_first = a.servers.iter().next().expect("non-empty");
        let b_first = b.servers.iter().next().expect("non-empty");
        a_first.cmp(b_first)
    });

    MergeView { profiles }
}

// ---------------------------------------------------------------------------
// Union-find over ServerId — tiny, no external crate needed
// ---------------------------------------------------------------------------

struct UnionFind {
    parent: BTreeMap<ServerId, ServerId>,
}

impl UnionFind {
    fn new(ids: &[ServerId]) -> Self {
        let mut parent = BTreeMap::new();
        for id in ids {
            parent.insert(id.clone(), id.clone());
        }
        Self { parent }
    }

    fn find(&self, id: &ServerId) -> ServerId {
        let mut cur = id.clone();
        loop {
            let p = self.parent.get(&cur).cloned().unwrap_or_else(|| cur.clone());
            if p == cur {
                return cur;
            }
            cur = p;
        }
    }

    fn union(&mut self, a: &ServerId, b: &ServerId) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra == rb {
            return;
        }
        // Always point larger to smaller so the canonical root is the
        // smallest server_id in each component — keeps the merge view
        // deterministic without a separate "find canonical" pass.
        let (smaller, larger) = if ra <= rb { (ra, rb) } else { (rb, ra) };
        self.parent.insert(larger, smaller);
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum DescriptorError {
    #[error("invalid signature on descriptor field: {field}")]
    InvalidSignature { field: String },
    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
}

// ---------------------------------------------------------------------------
// Helpers — keypair derivation from a stronghold seed
// ---------------------------------------------------------------------------

/// Build the [`SigningKey`] + [`ConcordUid`] pair from a raw hero seed.
///
/// The seed is the same 32 bytes that back the libp2p PeerId
/// (`crate::servitude::identity::peer_seed`). The derivation here is a
/// straight Ed25519 expansion: the resulting `SigningKey` produces
/// signatures verifiable by a `VerifyingKey` over `concord_uid`'s raw
/// bytes.
///
/// Domain separation between this key and the peerid-signing key is
/// achieved at the PAYLOAD layer — every signed message in this protocol
/// is prefixed with one of the [`DOMAIN_TAG_*`] constants — NOT at the
/// key layer. That matches the spec the user phrased: *"same seed pool as
/// the libp2p peerid, derived via a domain-separation tag."*
pub fn derive_signing_key(seed: &[u8; SECRET_SEED_LEN]) -> (SigningKey, ConcordUid) {
    let signing_key = SigningKey::from_bytes(seed);
    let pubkey = signing_key.verifying_key().to_bytes();
    (signing_key, ConcordUid(pubkey))
}

// ---------------------------------------------------------------------------
// Serde helpers for the fixed-length byte arrays
// ---------------------------------------------------------------------------

/// 32-byte fixed-length serde helper. Hex on the wire so the JSON is
/// human-readable.
mod serde_byte_array_32 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        bytes: &[u8; 32],
        s: S,
    ) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let raw = String::deserialize(d)?;
        let v = hex::decode(&raw).map_err(serde::de::Error::custom)?;
        if v.len() != 32 {
            return Err(serde::de::Error::custom(format!(
                "expected 32-byte hex string, got {} bytes",
                v.len()
            )));
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&v);
        Ok(out)
    }
}

/// 64-byte fixed-length serde helper (for the Ed25519 signature). Hex on
/// the wire.
mod serde_byte_array_64 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        bytes: &[u8; 64],
        s: S,
    ) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 64], D::Error> {
        let raw = String::deserialize(d)?;
        let v = hex::decode(&raw).map_err(serde::de::Error::custom)?;
        if v.len() != 64 {
            return Err(serde::de::Error::custom(format!(
                "expected 64-byte hex string, got {} bytes",
                v.len()
            )));
        }
        let mut out = [0u8; 64];
        out.copy_from_slice(&v);
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// Re-exports for downstream modules
// ---------------------------------------------------------------------------

pub use local::{build_local_descriptor, LocalDescriptorError};
pub use protocol::{
    open_descriptor_stream, ConcordUserHandler, ConcordUserRequest, ConcordUserResponse,
    StrongholdDescriptorApi, CONCORD_USER_PROTOCOL_ID,
};
pub use trust_store::{
    add_edge as trust_store_add_edge, list_edges as trust_store_list_edges,
    list_log as trust_store_list_log, revoke_edge as trust_store_revoke_edge,
    TrustStoreError,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{rngs::OsRng, RngCore};

    /// Produce a fresh keypair + ConcordUid for tests.
    fn fresh_hero() -> (SigningKey, ConcordUid) {
        let mut seed = [0u8; SECRET_SEED_LEN];
        OsRng.fill_bytes(&mut seed);
        derive_signing_key(&seed)
    }

    fn fresh_row(
        signing_key: &SigningKey,
        uid: &ConcordUid,
        server: &str,
        name: &str,
    ) -> ServerProfile {
        ServerProfile::sign_new(
            signing_key,
            uid,
            ServerId::new(server),
            name.to_string(),
            None,
            AvatarRef::None,
        )
    }

    /// (1) Descriptor JSON round-trip: serialize, deserialize, equal.
    #[test]
    fn descriptor_serde_round_trip() {
        let (signing_key, uid) = fresh_hero();
        let mut desc = ConcordUserDescriptor::empty(uid, "Hero McTester");
        desc.upsert_server_profile(fresh_row(
            &signing_key,
            &uid,
            "matrix:matrix.org",
            "Hero on Matrix.org",
        ));
        desc.upsert_server_profile(fresh_row(
            &signing_key,
            &uid,
            "concord:example.com",
            "Hero on Example",
        ));
        let edge = TrustEdge::sign_new(
            &signing_key,
            uid,
            ServerId::new("matrix:matrix.org"),
            ServerId::new("concord:example.com"),
            1_700_000_000,
        );
        desc.append_trust(TrustLogEntry::Edge(edge));

        let json = serde_json::to_string(&desc).expect("serialize");
        let parsed: ConcordUserDescriptor = serde_json::from_str(&json).expect("parse");
        assert_eq!(desc, parsed, "descriptor must round-trip serde JSON");
        parsed
            .verify_all_signatures()
            .expect("round-tripped descriptor must verify");
    }

    /// (2) Trust-edge signature round-trip: sign + verify.
    #[test]
    fn trust_edge_signature_round_trip() {
        let (signing_key, uid) = fresh_hero();
        let edge = TrustEdge::sign_new(
            &signing_key,
            uid,
            ServerId::new("concord:a.example"),
            ServerId::new("matrix:b.example"),
            1_700_000_000,
        );
        assert!(edge.verify(), "freshly signed edge must verify");

        // Negative case: tamper with one byte of the signature.
        let mut tampered = edge.clone();
        tampered.signature[0] ^= 0x01;
        assert!(!tampered.verify(), "tampered edge must NOT verify");

        // Negative case: signed by a DIFFERENT hero. Build a second
        // keypair and re-sign — but stick the original uid back in. The
        // signature is now over the original's uid but produced by a
        // different key, so verification under uid must fail.
        let (other_key, _other_uid) = fresh_hero();
        let mut wrong_signer = TrustEdge::sign_new(
            &other_key,
            uid, // declared uid is still ours
            ServerId::new("concord:a.example"),
            ServerId::new("matrix:b.example"),
            1_700_000_000,
        );
        // The edge_id is content-derived, so it matches the original.
        assert_eq!(wrong_signer.edge_id, edge.edge_id);
        // But the signature was produced with a different key, so
        // verification under `uid` fails.
        assert!(
            !wrong_signer.verify(),
            "edge signed by a different key must NOT verify under declared uid"
        );
        // Belt + suspenders — overwrite the signer's signature with
        // garbage to confirm.
        wrong_signer.signature = [0u8; SIGNATURE_LEN];
        assert!(!wrong_signer.verify());
    }

    /// (3) Merge view: 3 rows + 1 trust edge between two of them → 2
    /// effective profiles (merged pair + isolated third).
    #[test]
    fn merge_view_two_merged_one_isolated() {
        let (signing_key, uid) = fresh_hero();
        let mut desc = ConcordUserDescriptor::empty(uid, "Hero");
        desc.upsert_server_profile(fresh_row(
            &signing_key,
            &uid,
            "concord:alpha.example",
            "Alpha-Persona",
        ));
        desc.upsert_server_profile(fresh_row(
            &signing_key,
            &uid,
            "concord:beta.example",
            "Beta-Persona",
        ));
        desc.upsert_server_profile(fresh_row(
            &signing_key,
            &uid,
            "matrix:gamma.example",
            "Gamma-Persona",
        ));

        // Trust edge between alpha and beta — gamma stays isolated.
        let edge = TrustEdge::sign_new(
            &signing_key,
            uid,
            ServerId::new("concord:alpha.example"),
            ServerId::new("concord:beta.example"),
            1_700_000_000,
        );
        desc.append_trust(TrustLogEntry::Edge(edge));

        let view = desc.merge_view();
        assert_eq!(
            view.len(),
            2,
            "expected 2 effective profiles (alpha+beta merged, gamma isolated)"
        );

        let alpha = view
            .for_server(&ServerId::new("concord:alpha.example"))
            .expect("alpha covered");
        let beta = view
            .for_server(&ServerId::new("concord:beta.example"))
            .expect("beta covered");
        let gamma = view
            .for_server(&ServerId::new("matrix:gamma.example"))
            .expect("gamma covered");

        assert_eq!(alpha, beta, "alpha and beta merge into one effective profile");
        assert_ne!(
            alpha, gamma,
            "gamma must NOT merge with alpha (no trust edge to it)"
        );
        // Per-server isolation by DEFAULT — gamma keeps its own
        // display name.
        assert_eq!(gamma.display_name, "Gamma-Persona");
    }

    /// (4) Per-server isolation by default — no trust edges → one
    /// effective profile per row.
    #[test]
    fn merge_view_default_is_per_server_isolation() {
        let (signing_key, uid) = fresh_hero();
        let mut desc = ConcordUserDescriptor::empty(uid, "Hero");
        desc.upsert_server_profile(fresh_row(
            &signing_key,
            &uid,
            "concord:a.example",
            "A",
        ));
        desc.upsert_server_profile(fresh_row(
            &signing_key,
            &uid,
            "concord:b.example",
            "B",
        ));
        desc.upsert_server_profile(fresh_row(
            &signing_key,
            &uid,
            "matrix:c.example",
            "C",
        ));
        let view = desc.merge_view();
        assert_eq!(view.len(), 3, "no trust edges → one profile per server");
        let names: Vec<_> = view.profiles.iter().map(|p| &p.display_name).collect();
        assert!(names.contains(&&"A".to_string()));
        assert!(names.contains(&&"B".to_string()));
        assert!(names.contains(&&"C".to_string()));
    }

    /// (5) Revocation: an edge followed by a later revocation cancels
    /// the merge.
    #[test]
    fn merge_view_honors_revocations() {
        let (signing_key, uid) = fresh_hero();
        let mut desc = ConcordUserDescriptor::empty(uid, "Hero");
        desc.upsert_server_profile(fresh_row(
            &signing_key,
            &uid,
            "concord:a.example",
            "A",
        ));
        desc.upsert_server_profile(fresh_row(
            &signing_key,
            &uid,
            "concord:b.example",
            "B",
        ));
        let edge = TrustEdge::sign_new(
            &signing_key,
            uid,
            ServerId::new("concord:a.example"),
            ServerId::new("concord:b.example"),
            1_700_000_000,
        );
        let edge_id = edge.edge_id.clone();
        desc.append_trust(TrustLogEntry::Edge(edge));
        let view = desc.merge_view();
        assert_eq!(view.len(), 1, "with edge → merged");

        let rev = TrustEdgeRevocation::sign_new(
            &signing_key,
            uid,
            edge_id,
            1_700_000_100,
        );
        desc.append_trust(TrustLogEntry::Revocation(rev));
        let view = desc.merge_view();
        assert_eq!(view.len(), 2, "after revocation → un-merged");
    }

    /// (6) Verify all signatures rejects a row tampered after signing.
    #[test]
    fn verify_all_signatures_rejects_tampered_row() {
        let (signing_key, uid) = fresh_hero();
        let mut desc = ConcordUserDescriptor::empty(uid, "Hero");
        desc.upsert_server_profile(fresh_row(
            &signing_key,
            &uid,
            "concord:a.example",
            "Original",
        ));
        desc.verify_all_signatures().expect("clean");

        // Tamper with the display name post-sign.
        desc.server_profiles[0].display_name = "Tampered".to_string();
        assert!(desc.verify_all_signatures().is_err());
    }

    /// (7) ConcordUid hex round-trip.
    #[test]
    fn concord_uid_hex_round_trip() {
        let (_signing_key, uid) = fresh_hero();
        let hex_str = uid.to_hex();
        assert_eq!(hex_str.len(), PUBLIC_KEY_LEN * 2);
        let parsed = ConcordUid::from_hex(&hex_str).expect("parse");
        assert_eq!(uid, parsed);
        assert!(ConcordUid::from_hex("too short").is_none());
        assert!(ConcordUid::from_hex(&"z".repeat(PUBLIC_KEY_LEN * 2)).is_none());
    }

    /// (8) Compute_trust_edge_id is symmetric in `(a, b)`.
    #[test]
    fn trust_edge_id_is_symmetric() {
        let (_signing_key, uid) = fresh_hero();
        let a = ServerId::new("concord:a.example");
        let b = ServerId::new("concord:b.example");
        let id1 = compute_trust_edge_id(&uid, &a, &b);
        let id2 = compute_trust_edge_id(&uid, &b, &a);
        assert_eq!(id1, id2, "edge id must be symmetric in (a, b)");
    }
}
