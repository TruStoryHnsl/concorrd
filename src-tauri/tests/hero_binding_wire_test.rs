//! F-C — integration tests for the PRODUCTION `HeroBinding` wiring.
//!
//! These tests are written cold against the user-visible contract of the
//! production constructor path (`feat/hero-binding-swarm-wire`): a
//! `HeroBinding` assembled from the install's Stronghold-derived local
//! hero descriptor + a live libp2p stream control must carry BOTH halves,
//! and the local hero pubkey it carries must be EXACTLY the install's
//! `concord_uid` bytes (the value the F-A responder advertises on the
//! wire). The pre-existing closed-gate invariant — a binding with no
//! control returns `None` for every lookup — is re-asserted here too so a
//! regression in the production path can't silently reopen the gate for
//! control-less bindings.
//!
//! Test scaffolding mirrors `peer_store_test.rs`: a fresh tmp dir + 32-byte
//! password + `StrongholdHandle::new_persistent`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use app_lib::servitude::concord_user::{build_local_descriptor, derive_signing_key};
use app_lib::servitude::hero_binding::{local_hero_descriptor, HeroBinding};
use app_lib::servitude::identity::{self, StrongholdHandle};
use iota_stronghold::Stronghold;
use libp2p::identity::Keypair;
use libp2p::PeerId;
use tokio::sync::Mutex;

fn tmp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("concord-hero-bind-test-{label}-{nanos}"));
    std::fs::create_dir_all(&dir).expect("tmp dir create");
    dir
}

async fn persistent_handle(label: &str) -> (Stronghold, StrongholdHandle, PathBuf) {
    let dir = tmp_dir(label);
    let snapshot_path = dir.join("test.stronghold");
    let password: [u8; 32] = [
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
        0xFF, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC,
        0xDD, 0xEE, 0xFF, 0x00,
    ];
    let stronghold = Stronghold::default();
    let client = stronghold
        .create_client(format!("hero-bind-test-{label}").as_bytes())
        .expect("create_client must succeed on a fresh Stronghold");
    let handle = StrongholdHandle::new_persistent(client, &snapshot_path, &password)
        .expect("new_persistent must accept a 32-byte password");
    // Materialize the per-install Ed25519 seed (and prime the cache) so
    // `peer_seed` resolves — same first-boot step `servitude_start` runs
    // via the transport's `load_or_create` before any descriptor build.
    identity::load_or_create(&handle)
        .await
        .expect("load_or_create must seed a fresh handle");
    (stronghold, handle, dir)
}

/// A real `libp2p_stream::Control` without standing up a full swarm —
/// `Behaviour::new().new_control()` is the same call the production
/// transport makes (`p2p.rs:470`).
fn live_control() -> libp2p_stream::Control {
    libp2p_stream::Behaviour::new().new_control()
}

/// The PRODUCTION constructor carries BOTH the Stronghold-derived local
/// hero descriptor AND the libp2p control, and the local hero pubkey is
/// EXACTLY the install's concord_uid bytes.
#[tokio::test]
async fn production_constructor_carries_stronghold_pubkey_and_control() {
    let (_sh, handle, dir) = persistent_handle("ctor").await;

    // Independently derive what the install's concord_uid (== hero pubkey)
    // MUST be, straight from the seed. This is the value a peer would see
    // over `/concord/user-profile/1.0.0`.
    let seed = identity::peer_seed(&handle).await.expect("peer_seed");
    let (_sk, expected_uid) = derive_signing_key(&seed);
    let expected_pubkey: [u8; 32] = *expected_uid.as_bytes();

    // Build the local hero descriptor exactly as the Tauri command +
    // transport do, then assemble the production binding.
    let local_hero = local_hero_descriptor(&handle, Some("Colton"))
        .await
        .expect("local_hero_descriptor");
    assert_eq!(
        local_hero.hero_pubkey, expected_pubkey,
        "local hero pubkey must equal the install's concord_uid bytes"
    );
    assert_eq!(local_hero.display_label, "Colton");

    let binding = HeroBinding::with_control(
        Some(local_hero),
        Arc::new(Mutex::new(live_control())),
    );

    // Production binding carries both halves.
    assert!(binding.has_control(), "production binding must wire a control");
    let carried = binding.local().expect("production binding carries local hero");
    assert_eq!(
        carried.hero_pubkey, expected_pubkey,
        "binding's local pubkey must match the Stronghold-derived concord_uid"
    );

    let _ = std::fs::remove_dir_all(dir);
}

/// The same descriptor the binding carries is the one
/// `concord_user_get_self` returns — `build_local_descriptor` is the
/// single source of truth, so the wire-advertised concord_uid equals the
/// hero pubkey the local gate compares against.
#[tokio::test]
async fn wire_descriptor_uid_equals_hero_pubkey() {
    let (_sh, handle, dir) = persistent_handle("wire").await;

    let descriptor = build_local_descriptor(&handle, Some("Colton"))
        .await
        .expect("build_local_descriptor");
    let hero = local_hero_descriptor(&handle, Some("Colton"))
        .await
        .expect("local_hero_descriptor");

    assert_eq!(
        *descriptor.concord_uid.as_bytes(),
        hero.hero_pubkey,
        "wire descriptor's concord_uid MUST equal the hero pubkey the gate compares"
    );
    assert_eq!(descriptor.display_name, hero.display_label);

    let _ = std::fs::remove_dir_all(dir);
}

/// Closed-gate invariant, re-asserted at the integration boundary: a
/// binding built WITHOUT a control returns `None` for every lookup and
/// `shares_hero_with` is `false` — even though a real local hero is set.
#[tokio::test]
async fn control_less_binding_stays_closed() {
    let (_sh, handle, dir) = persistent_handle("closed").await;
    let local_hero = local_hero_descriptor(&handle, Some("Colton"))
        .await
        .expect("local_hero_descriptor");

    let binding = HeroBinding::new(Some(local_hero));
    assert!(!binding.has_control());

    let peer = PeerId::from(Keypair::generate_ed25519().public());
    assert!(
        binding.lookup_peer_hero(&peer).await.unwrap().is_none(),
        "no control wired → lookup is None (closed gate)"
    );
    assert!(
        !binding.shares_hero_with(&peer).await.unwrap(),
        "no control wired → shares_hero_with is false (closed gate)"
    );

    let _ = std::fs::remove_dir_all(dir);
}
