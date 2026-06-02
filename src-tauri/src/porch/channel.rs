//! Porch channel + message + ACL data types. These are the wire-stable
//! shapes carried over both the libp2p protocol and the Tauri IPC. Any
//! field rename here is a breaking change — bump the protocol ID instead.

use serde::{Deserialize, Serialize};

/// The kind of channel. Phase A only ships `Porch`; `Inner` and
/// `Obsidian` exist in the enum so Phase B/D can land without a
/// migration of the existing `kind` CHECK constraint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelKind {
    /// The user's "front door" channel. There is exactly one per
    /// install, with the well-known id `porch-default`.
    Porch,
    /// A gated channel inside the porch. Phase B introduces the UI to
    /// create these.
    Inner,
    /// Channel bound to an Obsidian vault folder. Phase D wires the
    /// indexer + `/concord/porch-obsidian/1.0.0` protocol.
    Obsidian,
}

impl ChannelKind {
    /// Wire/DB string form. Stable — do not rename without a schema
    /// migration.
    pub fn as_str(&self) -> &'static str {
        match self {
            ChannelKind::Porch => "porch",
            ChannelKind::Inner => "inner",
            ChannelKind::Obsidian => "obsidian",
        }
    }

    /// Parse from the DB / wire string form. `None` on unknown variants
    /// — the CHECK constraint should make this impossible, but the
    /// guard is here so a forward-compat client can't crash the host.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "porch" => Some(ChannelKind::Porch),
            "inner" => Some(ChannelKind::Inner),
            "obsidian" => Some(ChannelKind::Obsidian),
            _ => None,
        }
    }
}

/// How visitors gain access to a channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AclMode {
    /// Any libp2p peer that can dial this porch can read + post. Used
    /// by the default `Porch` channel.
    Open,
    /// Only peers with a row in `channel_acl` (any role) can read +
    /// post. Phase B's UI lands the grant/revoke flow.
    Allowlist,
    /// Only the local peer (the porch owner) can read + post. Used by
    /// channels the user keeps strictly private.
    OwnerOnly,
}

impl AclMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            AclMode::Open => "open",
            AclMode::Allowlist => "allowlist",
            AclMode::OwnerOnly => "owner_only",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "open" => Some(AclMode::Open),
            "allowlist" => Some(AclMode::Allowlist),
            "owner_only" => Some(AclMode::OwnerOnly),
            _ => None,
        }
    }
}

/// Role of a peer inside a channel's ACL. Phase A only writes
/// `member` / `owner` rows; `visitor` is here so Phase B can record a
/// "knock acknowledged but not yet granted full access" state without
/// a schema bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AclRole {
    Visitor,
    Member,
    Owner,
}

impl AclRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            AclRole::Visitor => "visitor",
            AclRole::Member => "member",
            AclRole::Owner => "owner",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "visitor" => Some(AclRole::Visitor),
            "member" => Some(AclRole::Member),
            "owner" => Some(AclRole::Owner),
            _ => None,
        }
    }

    /// Whether this role can read messages + post into a channel
    /// gated by `Allowlist`. Visitor is read-only by design; Member
    /// and Owner can do both. Phase B's UI can refine.
    pub fn grants_visit_access(&self) -> bool {
        matches!(self, AclRole::Member | AclRole::Owner)
    }
}

/// Public porch-channel record. Returned from
/// `Porch::list_channels` and over the libp2p protocol.
///
/// `created_at` is the host's `unix_millis()` at INSERT time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PorchChannel {
    pub id: String,
    pub name: String,
    pub kind: ChannelKind,
    pub acl_mode: AclMode,
    pub created_at: i64,
}

/// A single message in a porch channel. `author_peer_id` is the libp2p
/// PeerId in base58 form — for messages posted via the host's own
/// `porch_post_message` Tauri command, this is the local PeerId; for
/// messages posted by a visiting peer, it's the visitor's PeerId.
///
/// `id` is a ULID — lexicographically sortable + monotonic-per-process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelMessage {
    pub id: String,
    pub channel_id: String,
    pub author_peer_id: String,
    pub body: String,
    pub created_at: i64,
}
