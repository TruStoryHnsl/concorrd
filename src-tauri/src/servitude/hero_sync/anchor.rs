//! F-C — Hero-anchor election + mode resolution.
//!
//! Per the user's clarification, hero sync has two topologies:
//!
//! 1. **Anchored mode** — the user has elected a persistent docker
//!    instance as their identity anchor. Every device pushes its event
//!    log to the docker, pulls from it, and conflicts are reconciled
//!    at the anchor. The protocol envelope carries an `anchored`
//!    flag so the responder knows to treat the docker as authority.
//!
//! 2. **Unanchored mode** — no docker. Every instance is canonical.
//!    All sync cycles are additive p2p merges between the two
//!    instances directly. LWW with device-id tiebreak applies, but
//!    both sides keep their own copy.
//!
//! The runtime auto-picks based on whether `home_meta` carries a
//! `hero_anchor_instance` key. The Tauri command surface
//! (`hero_get_anchor_instance` / `hero_set_anchor_instance`) lets the
//! user set or revoke that election from the UI.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::porch::db::Porch;
use crate::porch::error::PorchError;

/// `home_meta` key that holds the elected anchor's identity. The value
/// is an opaque identifier the user provides — typically the docker
/// instance's libp2p PeerId or a human-readable label the user pinned
/// to it during onboarding. The value is OPAQUE to this module — only
/// the presence/absence drives the mode resolution.
pub const HERO_ANCHOR_INSTANCE_KEY: &str = "hero_anchor_instance";

/// Mode resolution result. The two-element enum maps 1:1 to the two
/// sync topologies; matches the user's clarification and the wire flag
/// the protocol carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeroAnchorMode {
    /// `home_meta.hero_anchor_instance` is set; the anchor brokers
    /// reconciliation. Devices defer to the anchor's verdict on the
    /// final ordering of conflicting events.
    Anchored,
    /// `home_meta.hero_anchor_instance` is absent; both instances are
    /// canonical. Sync exchanges are additive merges.
    Unanchored,
}

impl HeroAnchorMode {
    /// Resolve the current mode from a porch's `home_meta` table.
    /// `Unanchored` on any read error — defensive: a corrupt DB
    /// should never claim there's an anchor that doesn't actually exist.
    pub fn from_porch(porch: &Porch) -> Self {
        match hero_get_anchor_instance(porch) {
            Ok(Some(_)) => Self::Anchored,
            _ => Self::Unanchored,
        }
    }

    /// The wire flag the protocol envelope sets. `true` for anchored
    /// sync exchanges (the anchor's verdict is authoritative); `false`
    /// for additive p2p merges.
    pub fn anchored_envelope_flag(self) -> bool {
        matches!(self, Self::Anchored)
    }
}

/// Read the elected anchor's opaque identifier from `home_meta`.
/// `Ok(None)` means "no anchor elected; run unanchored mode."
pub fn hero_get_anchor_instance(porch: &Porch) -> Result<Option<String>, PorchError> {
    let conn = porch.conn.lock().expect("porch conn mutex poisoned");
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM home_meta WHERE key = ?1",
            params![HERO_ANCHOR_INSTANCE_KEY],
            |r| r.get(0),
        )
        .optional()?;
    Ok(value.filter(|s| !s.trim().is_empty()))
}

/// Set the elected anchor's identifier. Passing `None` revokes the
/// election — the row is deleted (rather than left empty) so the mode
/// resolution naturally falls back to `Unanchored`.
pub fn hero_set_anchor_instance(
    porch: &Porch,
    anchor: Option<&str>,
) -> Result<(), PorchError> {
    let conn = porch.conn.lock().expect("porch conn mutex poisoned");
    match anchor {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err(PorchError::InvalidInput(
                    "anchor identifier must not be empty".to_string(),
                ));
            }
            conn.execute(
                "INSERT INTO home_meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![HERO_ANCHOR_INSTANCE_KEY, trimmed],
            )?;
        }
        None => {
            conn.execute(
                "DELETE FROM home_meta WHERE key = ?1",
                params![HERO_ANCHOR_INSTANCE_KEY],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_porch_has_no_anchor() {
        let porch = Porch::open_in_memory().expect("open");
        assert_eq!(hero_get_anchor_instance(&porch).unwrap(), None);
        assert_eq!(HeroAnchorMode::from_porch(&porch), HeroAnchorMode::Unanchored);
    }

    #[test]
    fn setting_anchor_round_trips() {
        let porch = Porch::open_in_memory().expect("open");
        hero_set_anchor_instance(&porch, Some("docker-instance-A")).unwrap();
        assert_eq!(
            hero_get_anchor_instance(&porch).unwrap(),
            Some("docker-instance-A".to_string())
        );
        assert_eq!(HeroAnchorMode::from_porch(&porch), HeroAnchorMode::Anchored);
    }

    #[test]
    fn empty_anchor_rejected() {
        let porch = Porch::open_in_memory().expect("open");
        let err = hero_set_anchor_instance(&porch, Some("   ")).unwrap_err();
        assert!(format!("{err}").contains("empty"));
    }

    #[test]
    fn revoke_anchor_falls_back_to_unanchored() {
        let porch = Porch::open_in_memory().expect("open");
        hero_set_anchor_instance(&porch, Some("docker-instance-A")).unwrap();
        hero_set_anchor_instance(&porch, None).unwrap();
        assert_eq!(hero_get_anchor_instance(&porch).unwrap(), None);
        assert_eq!(HeroAnchorMode::from_porch(&porch), HeroAnchorMode::Unanchored);
    }

    #[test]
    fn anchored_mode_flips_envelope_flag() {
        assert!(HeroAnchorMode::Anchored.anchored_envelope_flag());
        assert!(!HeroAnchorMode::Unanchored.anchored_envelope_flag());
    }

    #[test]
    fn trimmed_anchor_persists_trimmed() {
        let porch = Porch::open_in_memory().expect("open");
        hero_set_anchor_instance(&porch, Some("  docker-A  ")).unwrap();
        assert_eq!(
            hero_get_anchor_instance(&porch).unwrap(),
            Some("docker-A".to_string())
        );
    }
}
