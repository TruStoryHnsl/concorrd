//! Porch ACL helpers — pure decisions about whether a peer can visit a
//! channel. The DB-write side (`grant` / `revoke`) lives on
//! [`crate::porch::db::Porch`] directly; this module just wires the
//! decision logic so the libp2p handler can stay terse.

use super::channel::{AclMode, PorchChannel};
use super::db::Porch;
use super::error::PorchError;

/// Decide whether `peer_id` can read messages from + post messages to
/// `channel`. Phase A only ships the open default porch, so this is
/// mostly trivial today — but the allowlist + owner-only paths are wired
/// so Phase B can land without a code change to the protocol handler.
///
/// * `Open` — always true. The default porch is what paired peers visit
///   without needing a grant.
/// * `Allowlist` — true iff the peer has a `member` or `owner` row in
///   `channel_acl`. A `visitor` row is read-only and Phase A's wire
///   protocol doesn't yet split read vs. write — Phase B refines.
/// * `OwnerOnly` — false for any visitor. Only the local porch owner
///   (calling the host-side Tauri commands) can ever see these
///   channels; visitor peers are blocked at the wire layer.
pub fn can_visit(
    porch: &Porch,
    peer_id: &str,
    channel: &PorchChannel,
) -> Result<bool, PorchError> {
    match channel.acl_mode {
        AclMode::Open => Ok(true),
        AclMode::OwnerOnly => Ok(false),
        AclMode::Allowlist => {
            let role = porch.lookup_acl(&channel.id, peer_id)?;
            Ok(role.map(|r| r.grants_visit_access()).unwrap_or(false))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::porch::channel::{AclRole, ChannelKind};
    use crate::porch::DEFAULT_PORCH_CHANNEL_ID;

    fn channel(id: &str, mode: AclMode) -> PorchChannel {
        PorchChannel {
            id: id.to_string(),
            name: id.to_string(),
            kind: ChannelKind::Porch,
            acl_mode: mode,
            created_at: 0,
        }
    }

    #[test]
    fn open_channel_allows_any_visitor() {
        let porch = Porch::open_in_memory().expect("open ok");
        let ch = channel(DEFAULT_PORCH_CHANNEL_ID, AclMode::Open);
        assert!(can_visit(&porch, "12D3SomePeer", &ch).unwrap());
    }

    #[test]
    fn owner_only_blocks_all_visitors() {
        let porch = Porch::open_in_memory().expect("open ok");
        let ch = channel(DEFAULT_PORCH_CHANNEL_ID, AclMode::OwnerOnly);
        assert!(!can_visit(&porch, "12D3SomePeer", &ch).unwrap());
    }

    #[test]
    fn allowlist_consults_channel_acl_for_member_and_owner() {
        let porch = Porch::open_in_memory().expect("open ok");
        let ch = channel(DEFAULT_PORCH_CHANNEL_ID, AclMode::Allowlist);
        // Unknown peer → false.
        assert!(!can_visit(&porch, "12D3Unknown", &ch).unwrap());
        // Grant member → true.
        porch
            .grant_acl(DEFAULT_PORCH_CHANNEL_ID, "12D3Member", AclRole::Member)
            .unwrap();
        assert!(can_visit(&porch, "12D3Member", &ch).unwrap());
        // Visitor role → false (Phase A is read-only for the visitor
        // tier; we treat the wire-visit as needing write access).
        porch
            .grant_acl(DEFAULT_PORCH_CHANNEL_ID, "12D3Knock", AclRole::Visitor)
            .unwrap();
        assert!(!can_visit(&porch, "12D3Knock", &ch).unwrap());
    }
}
