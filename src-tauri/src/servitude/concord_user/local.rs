//! F-A — shared builder for the LOCAL install's [`ConcordUserDescriptor`].
//!
//! Before this module the descriptor-assembly logic lived ONLY inside the
//! `concord_user_get_self` Tauri command (`crate::lib`). Two other
//! production paths need the same descriptor:
//!
//! * the swarm-side [`crate::servitude::concord_user::protocol::ConcordUserHandler`]
//!   responder, so a peer's `GetSelf` request gets a real answer over
//!   `/concord/user-profile/1.0.0` (the responder MUST be live or the
//!   F-C hero binding's `lookup_peer_hero` never gets a descriptor back);
//! * F-C's [`crate::servitude::hero_binding::HeroBinding`], which maps the
//!   descriptor's `concord_uid` into the 32-byte hero pubkey.
//!
//! Extracting the logic here means all three callers share ONE definition
//! of "what this install's descriptor is" — no drift between the Tauri
//! command's answer and the peer-to-peer responder's answer.
//!
//! The Tauri-only bits (reading `ServitudeConfig` for the display name)
//! stay in the command; this builder takes the resolved display name as a
//! parameter so it has no `tauri` dependency and can run inside the
//! transport's `start()` where only the `StrongholdHandle` and the
//! operator's instance name are reachable.

use crate::servitude::identity::{self, StrongholdHandle};

use super::{
    derive_signing_key, trust_store_list_log, AvatarRef, ConcordUserDescriptor,
    ServerId, ServerProfile,
};

/// Error surface for the local-descriptor builder. Thin wrapper over the
/// underlying identity / trust-store failures, stringified so the call
/// sites (a Tauri command, a swarm handler) can render uniformly.
#[derive(Debug, thiserror::Error)]
pub enum LocalDescriptorError {
    #[error("identity: {0}")]
    Identity(String),
    #[error("trust store: {0}")]
    TrustStore(String),
}

/// Resolve the install's human-readable display name, applying the same
/// fallback the Tauri command uses: an empty name or the
/// fresh-install `"concord-node"` placeholder collapses to a stable
/// `hero-<uid8>` derived from the uid hex so the descriptor still
/// verifies and round-trips deterministically.
fn resolve_display_name(raw: Option<&str>, uid_hex: &str) -> String {
    match raw.map(str::trim) {
        Some(name) if !name.is_empty() && name != "concord-node" => name.to_string(),
        _ => format!("hero-{}", &uid_hex[..8]),
    }
}

/// Derive the porch server_id (`porch:<peerid>`) from the install seed.
/// Pure function of the seed; mirrors `porch_server_id_for` in `lib.rs`
/// (kept in sync — the peer id derives from the same Ed25519 seed).
fn porch_server_id(seed: &[u8; identity::SECRET_SEED_LEN]) -> String {
    use libp2p::identity::Keypair;
    let kp = Keypair::ed25519_from_bytes(seed.to_vec())
        .expect("ed25519 keypair from 32-byte seed must succeed");
    let peer_id = libp2p::PeerId::from(kp.public());
    format!("porch:{peer_id}")
}

/// Build the LOCAL install's [`ConcordUserDescriptor`] from persisted
/// state. `display_name` is the operator's resolved vanity name (the
/// caller reads it from `ServitudeConfig` or the transport's instance
/// name); `None`/empty/`"concord-node"` collapses to the `hero-<uid8>`
/// placeholder.
///
/// The descriptor carries:
/// * the hero `concord_uid` derived from the per-install Stronghold seed,
/// * one server row for this install's own porch, and
/// * every user-declared trust edge replayed from the trust log.
pub async fn build_local_descriptor(
    stronghold: &StrongholdHandle,
    display_name: Option<&str>,
) -> Result<ConcordUserDescriptor, LocalDescriptorError> {
    let seed = identity::peer_seed(stronghold)
        .await
        .map_err(|e| LocalDescriptorError::Identity(format!("peer_seed: {e}")))?;
    let (signing_key, uid) = derive_signing_key(&seed);

    let display_name = resolve_display_name(display_name, &uid.to_hex());

    let mut descriptor = ConcordUserDescriptor::empty(uid, display_name.clone());

    let porch_row = ServerProfile::sign_new(
        &signing_key,
        &uid,
        ServerId::new(porch_server_id(&seed)),
        display_name,
        None,
        AvatarRef::None,
    );
    descriptor.upsert_server_profile(porch_row);

    let log = trust_store_list_log(stronghold)
        .await
        .map_err(|e| LocalDescriptorError::TrustStore(format!("trust_store_list_log: {e}")))?;
    for entry in log {
        descriptor.append_trust(entry);
    }
    Ok(descriptor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_fallback_collapses_placeholders() {
        let uid_hex = "abcdef0123456789";
        assert_eq!(resolve_display_name(None, uid_hex), "hero-abcdef01");
        assert_eq!(resolve_display_name(Some(""), uid_hex), "hero-abcdef01");
        assert_eq!(
            resolve_display_name(Some("  "), uid_hex),
            "hero-abcdef01"
        );
        assert_eq!(
            resolve_display_name(Some("concord-node"), uid_hex),
            "hero-abcdef01"
        );
        assert_eq!(resolve_display_name(Some("Colton"), uid_hex), "Colton");
    }
}
