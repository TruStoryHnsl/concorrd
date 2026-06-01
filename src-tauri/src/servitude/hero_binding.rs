//! F-C — Hero-account binding stub.
//!
//! Architecture C's hero-sync rule requires two independent gates: (i)
//! the local install and the remote peer share a hero account, AND (ii)
//! the two machines are reachable through Tailscale. This module is the
//! plumbing for gate (i).
//!
//! ## Why a stub
//!
//! Gate (i) is the consumer of Architecture A — the Concord-native
//! user-definition protocol (`docs/architecture/concord-user-protocol-scope.md`).
//! A's trust-edge mechanism defines how two installs exchange hero
//! descriptors and verify a shared identity. F-A is a PARALLEL PR; this
//! PR cannot block on it landing, so we stub the binding here and
//! document the integration point.
//!
//! When F-A merges, the implementation surface to swap in is:
//!
//! ```ignore
//! pub async fn concord_user_get_for_peer(
//!     peer_id: PeerId,
//! ) -> Result<Option<HeroDescriptor>, FederationError>;
//! ```
//!
//! …which returns the peer's hero descriptor (as advertised over the
//! Concord-native user-definition protocol with a `trust=hero` edge).
//! The comparator below already accepts an `Option<HeroDescriptor>` —
//! when F-A wires through, the only change is replacing
//! [`HeroBinding::lookup_peer_hero`] with a call to that function.
//!
//! ## Design choices captured here
//!
//! 1. **Pub key, not display name.** Two devices of the same hero
//!    share an Ed25519 pubkey (`hero_account.rfc.md` §3); the display
//!    name is fluid. The comparator is byte-equality on the pubkey, NEVER
//!    case-insensitive string match on the label.
//!
//! 2. **`None` is "no match".** If either side has no hero installed,
//!    the gate is closed (no hero-sync). The two-gate evaluator does NOT
//!    treat absence as a free pass — the porch bilateral-pairing path
//!    (Phase F's existing `device_links`) remains the only sync option
//!    for hero-less installs. That's exactly what the user said: "it
//!    only propagates between instances if … the instances are confirmed
//!    to share a hero-user." Confirmation requires both sides to have a
//!    hero AND for the pubkeys to match.
//!
//! 3. **Pubkey is opaque bytes.** We don't import `ed25519-dalek` here
//!    — that crate IS in the workspace but the comparator wants the
//!    least surface possible. Bytes are bytes; F-H1's `DeviceLinkCert`
//!    holds the canonical key.

use libp2p::PeerId;
use serde::{Deserialize, Serialize};

/// Hero descriptor as advertised by a peer over the Architecture A
/// user-definition protocol. F-A defines the wire encoding; this struct
/// is the abstract shape the gate logic needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeroDescriptor {
    /// 32-byte Ed25519 hero pubkey. The cryptographic identity of the
    /// hero account — same value on every device of the same hero.
    pub hero_pubkey: [u8; 32],
    /// Best-effort human-readable label (e.g. "Colton"). NOT used for
    /// the binding check — included so diagnostics + UI can render
    /// without a second lookup.
    pub display_label: String,
}

/// Binding-check facade. Wraps the future F-A lookup behind a stable
/// signature so the rest of F-C can be written and tested today.
#[derive(Debug, Clone, Default)]
pub struct HeroBinding {
    /// Local install's hero descriptor, if any. `None` means "this
    /// install has no hero account installed" — the gate is then closed.
    pub local: Option<HeroDescriptor>,
}

impl HeroBinding {
    /// Construct with an explicit local descriptor (test + production
    /// surface — the production caller pulls the descriptor out of
    /// Stronghold via the hero-management Tauri commands).
    pub fn new(local: Option<HeroDescriptor>) -> Self {
        Self { local }
    }

    /// Lookup hook for the remote peer's hero descriptor.
    ///
    /// CURRENT IMPLEMENTATION: returns `None` for every peer. This is
    /// the stub state until Architecture A's `concord_user_get_for_peer`
    /// lands. The gate is therefore CLOSED FOR EVERY PEER until that
    /// lookup wires through — the integration test below pins that
    /// behaviour explicitly so the merge cannot silently lose the
    /// gate's hero requirement.
    ///
    /// F-A INTEGRATION POINT: replace this method's body with a call
    /// to the F-A lookup once it lands. The remainder of the F-C
    /// pipeline does NOT change.
    pub async fn lookup_peer_hero(
        &self,
        _peer_id: &PeerId,
    ) -> Result<Option<HeroDescriptor>, HeroBindingError> {
        // STUB — F-A integration point. See module docs.
        Ok(None)
    }

    /// Evaluate gate (i) for a given peer. `true` iff BOTH sides hold a
    /// hero AND the pubkeys are byte-identical.
    pub async fn shares_hero_with(
        &self,
        peer_id: &PeerId,
    ) -> Result<bool, HeroBindingError> {
        let Some(local) = &self.local else {
            return Ok(false);
        };
        let Some(remote) = self.lookup_peer_hero(peer_id).await? else {
            return Ok(false);
        };
        Ok(local.hero_pubkey == remote.hero_pubkey)
    }

    /// Direct comparator — for tests that already have both descriptors
    /// in hand and want to skip the (currently stubbed) lookup.
    pub fn pubkeys_match(local: &HeroDescriptor, remote: &HeroDescriptor) -> bool {
        local.hero_pubkey == remote.hero_pubkey
    }
}

/// Error surface for the hero binding. Currently only `Unavailable`;
/// F-A will add concrete variants once the lookup is real.
#[derive(Debug, thiserror::Error)]
pub enum HeroBindingError {
    /// Architecture A's lookup surface is not available — should never
    /// fire while the stub is in place, but reserved so the
    /// integration-point swap doesn't break the call surface.
    #[error("hero-binding lookup unavailable: {0}")]
    Unavailable(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::identity::Keypair;

    fn peer() -> PeerId {
        let kp = Keypair::generate_ed25519();
        PeerId::from(kp.public())
    }

    fn hero(label: &str, seed: u8) -> HeroDescriptor {
        let pubkey = [seed; 32];
        HeroDescriptor {
            hero_pubkey: pubkey,
            display_label: label.to_string(),
        }
    }

    #[tokio::test]
    async fn stub_lookup_returns_none_for_every_peer() {
        // The F-A integration point is not wired yet. The stub must
        // return None unconditionally so the gate is closed for every
        // peer — that is the safe default until A lands.
        let binding = HeroBinding::new(Some(hero("local-hero", 0xAA)));
        assert!(binding.lookup_peer_hero(&peer()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn shares_hero_false_until_f_a_lookup_lands() {
        // The full gate (i) call: also returns false until A lands.
        let binding = HeroBinding::new(Some(hero("local-hero", 0xAA)));
        assert!(!binding.shares_hero_with(&peer()).await.unwrap());
    }

    #[tokio::test]
    async fn shares_hero_false_when_local_has_no_hero() {
        let binding = HeroBinding::new(None);
        assert!(!binding.shares_hero_with(&peer()).await.unwrap());
    }

    #[test]
    fn pubkey_match_is_strict_byte_equality() {
        let h_a = hero("Colton", 0xAA);
        let h_a2 = hero("colton", 0xAA); // different label, same key
        let h_b = hero("Colton", 0xBB);
        assert!(HeroBinding::pubkeys_match(&h_a, &h_a2));
        assert!(!HeroBinding::pubkeys_match(&h_a, &h_b));
    }
}
