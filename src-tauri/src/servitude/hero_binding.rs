//! F-C — Hero-account binding stub.
//!
//! Architecture C's hero-sync rule requires two independent gates: (i)
//! the local install and the remote peer share a hero account, AND (ii)
//! the two machines are reachable through Tailscale. This module is the
//! plumbing for gate (i).
//!
//! ## F-A is wired (2026-06-01)
//!
//! Gate (i) is the consumer of Architecture A — the Concord-native
//! user-definition protocol (`docs/architecture/concord-user-protocol-scope.md`).
//! F-A Phase 1 landed (#151) and ships the point-to-point descriptor
//! fetch: `concord_user::protocol::open_descriptor_stream(control,
//! peer_id, GetSelf)` opens the `/concord/user-profile/1.0.0` libp2p
//! stream and returns the peer's [`ConcordUserDescriptor`], whose
//! `concord_uid` is the 32-byte Ed25519 hero pubkey.
//!
//! [`HeroBinding`] now carries an OPTIONAL libp2p
//! [`libp2p_stream::Control`] handle. When present,
//! [`HeroBinding::lookup_peer_hero`] performs the real F-A fetch and
//! maps `ConcordUserDescriptor { concord_uid, display_name }` into the
//! local [`HeroDescriptor`]. When ABSENT (the `Default`/`new`
//! constructors), the lookup returns `None` — the safe closed-gate
//! state used by unit tests and by any install that has not yet
//! initialized its libp2p stream control. The gate's two-gate
//! semantics are unchanged.
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

use std::sync::Arc;

use libp2p::PeerId;
use libp2p_stream::Control;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::servitude::concord_user::protocol::{open_descriptor_stream, ConcordUserRequest};

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

/// Binding-check facade. Wraps F-A's descriptor fetch behind a stable
/// signature for the rest of F-C.
#[derive(Clone, Default)]
pub struct HeroBinding {
    /// Local install's hero descriptor, if any. `None` means "this
    /// install has no hero account installed" — the gate is then closed.
    pub local: Option<HeroDescriptor>,
    /// libp2p stream control used to reach F-A's
    /// `/concord/user-profile/1.0.0` protocol. `None` until the swarm
    /// initializes it; while `None`, [`lookup_peer_hero`] returns `None`
    /// (closed gate) — the same safe default the pre-F-A stub used.
    control: Option<Arc<Mutex<Control>>>,
}

impl std::fmt::Debug for HeroBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HeroBinding")
            .field("local", &self.local)
            .field("control_wired", &self.control.is_some())
            .finish()
    }
}

impl HeroBinding {
    /// Construct with an explicit local descriptor and NO libp2p control.
    /// In this state the remote lookup returns `None` (closed gate) — the
    /// constructor used by unit tests and by callers that evaluate the
    /// gate before the swarm's stream control exists.
    pub fn new(local: Option<HeroDescriptor>) -> Self {
        Self {
            local,
            control: None,
        }
    }

    /// Construct with the local descriptor AND F-A's libp2p stream
    /// control. This is the production wiring: `lookup_peer_hero` will
    /// open the `/concord/user-profile/1.0.0` stream and fetch the peer's
    /// real hero descriptor.
    pub fn with_control(local: Option<HeroDescriptor>, control: Arc<Mutex<Control>>) -> Self {
        Self {
            local,
            control: Some(control),
        }
    }

    /// Lookup the remote peer's hero descriptor via F-A's
    /// user-definition protocol.
    ///
    /// When a libp2p [`Control`] is wired (via [`with_control`]), opens a
    /// `/concord/user-profile/1.0.0` stream to `peer_id`, issues a
    /// `GetSelf` request, and maps the returned
    /// [`ConcordUserDescriptor`] into a [`HeroDescriptor`]
    /// (`concord_uid` → `hero_pubkey`, `display_name` → `display_label`).
    /// A response carrying an `error` (e.g. the peer has no hero) or no
    /// descriptor yields `None` — closed gate, never a false pass.
    ///
    /// When NO control is wired, returns `None` unconditionally — the
    /// safe closed-gate default for pre-swarm / test contexts.
    pub async fn lookup_peer_hero(
        &self,
        peer_id: &PeerId,
    ) -> Result<Option<HeroDescriptor>, HeroBindingError> {
        let Some(control) = &self.control else {
            // No libp2p control wired yet — closed gate.
            return Ok(None);
        };
        let request = ConcordUserRequest::GetSelf { request_id: 1 };
        let response = {
            let mut ctrl = control.lock().await;
            open_descriptor_stream(&mut ctrl, *peer_id, request)
                .await
                .map_err(|e| HeroBindingError::Unavailable(e.to_string()))?
        };
        // An error body or an absent descriptor both mean "no usable
        // hero from this peer" — closed gate.
        let Some(descriptor) = response.descriptor else {
            return Ok(None);
        };
        Ok(Some(HeroDescriptor {
            hero_pubkey: *descriptor.concord_uid.as_bytes(),
            display_label: descriptor.display_name,
        }))
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
    async fn lookup_returns_none_when_no_control_wired() {
        // F-A is wired, but a HeroBinding built WITHOUT a libp2p control
        // (the `new` constructor) must still return None — the safe
        // closed-gate default for pre-swarm / test contexts. The gate is
        // closed for every peer in that state.
        let binding = HeroBinding::new(Some(hero("local-hero", 0xAA)));
        assert!(binding.control.is_none());
        assert!(binding.lookup_peer_hero(&peer()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn shares_hero_false_when_no_control_wired() {
        // The full gate (i) call: returns false with no control wired,
        // because the F-A descriptor fetch cannot run without a stream
        // control.
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
