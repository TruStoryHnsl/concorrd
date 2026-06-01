//! Porch Phase C — per-channel aesthetic customization integration
//! tests.
//!
//! Mirrors the structure of `porch_test.rs` (Phase A) and
//! `porch_knock_test.rs` (Phase B): each test maps to a Phase C
//! acceptance criterion. Tests are written from a cold-reader
//! perspective — assertions reflect what an external observer can
//! verify (the SQLite row + on-disk asset file exist; the libp2p
//! visitor round-trip returns the owner's theme; the ACL check fires
//! before bytes leak).

use std::sync::Arc;
use std::time::Duration;

use app_lib::porch::{
    AclMode, AclRole, Background, ChannelKind, ChannelTheme, FontFamily, Porch, PorchHandler,
    PorchRequest, DEFAULT_PORCH_CHANNEL_ID,
};
use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::p2p::LibP2pTransport;
use futures::StreamExt;
use iota_stronghold::Stronghold;
use libp2p::{swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId};

// ---------------------------------------------------------------------------
// (1) default_theme_returned_when_unset — fresh porch has no theme row
//     for the default channel; `get_theme` returns None. The wire
//     handler is what substitutes the default (covered in test 5);
//     the DB layer faithfully reports "unset".
// ---------------------------------------------------------------------------

#[test]
fn default_theme_returned_when_unset() {
    let tmp = tempdir_for_test("default-theme");
    let porch = Porch::open(&tmp).expect("open ok");
    let theme = porch
        .get_theme(DEFAULT_PORCH_CHANNEL_ID)
        .expect("get_theme ok");
    assert!(
        theme.is_none(),
        "fresh porch must report no theme row for default channel"
    );

    // And the default-helper itself produces a usable theme.
    let default = ChannelTheme::default_for(DEFAULT_PORCH_CHANNEL_ID);
    assert_eq!(default.channel_id, DEFAULT_PORCH_CHANNEL_ID);
    assert!(default.primary_color.starts_with('#'));
    assert!(default.surface_color.starts_with('#'));
    assert_eq!(default.font_family, FontFamily::System);
    assert!(matches!(default.background, Background::None));
}

// ---------------------------------------------------------------------------
// (2) set_theme_persists_and_round_trips — set a theme on the default
//     channel, fetch it back via `get_theme`, assert structural equality.
//     `updated_at` is server-stamped so we compare every other field.
// ---------------------------------------------------------------------------

#[test]
fn set_theme_persists_and_round_trips() {
    let tmp = tempdir_for_test("round-trip");
    let porch = Porch::open(&tmp).expect("open ok");
    let original = ChannelTheme {
        channel_id: DEFAULT_PORCH_CHANNEL_ID.to_string(),
        primary_color: "#aa00ff".to_string(),
        surface_color: "#101418".to_string(),
        on_surface_color: "#f0f0f0".to_string(),
        accent_color: "#ffaa00".to_string(),
        font_family: FontFamily::Display,
        background: Background::Gradient(
            "linear-gradient(135deg, #101418, #2a1a40)".to_string(),
        ),
        updated_at: 0, // not used on write
    };
    let saved = porch.set_theme(original.clone()).expect("set_theme ok");
    assert!(
        saved.updated_at > 0,
        "set_theme must stamp updated_at server-side"
    );

    let fetched = porch
        .get_theme(DEFAULT_PORCH_CHANNEL_ID)
        .expect("get_theme ok")
        .expect("must exist after set");
    assert_eq!(fetched.channel_id, original.channel_id);
    assert_eq!(fetched.primary_color, original.primary_color);
    assert_eq!(fetched.surface_color, original.surface_color);
    assert_eq!(fetched.on_surface_color, original.on_surface_color);
    assert_eq!(fetched.accent_color, original.accent_color);
    assert_eq!(fetched.font_family, original.font_family);
    assert_eq!(fetched.background, original.background);

    // Re-setting overwrites without erroring on ON CONFLICT.
    let mut next = original.clone();
    next.primary_color = "#00ffaa".to_string();
    let saved2 = porch.set_theme(next).expect("re-set ok");
    assert_eq!(saved2.primary_color, "#00ffaa");
}

// ---------------------------------------------------------------------------
// (3) upload_asset_writes_file_and_inserts_row — uploading a small PNG
//     places the bytes on disk at <data_dir>/porch_assets/<id>.png and
//     inserts a row with matching sha256 + byte count.
// ---------------------------------------------------------------------------

#[test]
fn upload_asset_writes_file_and_inserts_row() {
    let tmp = tempdir_for_test("upload");
    let porch = Porch::open(&tmp).expect("open ok");
    let png_bytes: &[u8] = b"\x89PNG\r\n\x1a\nfake-png-body-for-test";
    let asset = porch
        .upload_asset(DEFAULT_PORCH_CHANNEL_ID, "image/png", png_bytes)
        .expect("upload ok");
    assert_eq!(asset.channel_id, DEFAULT_PORCH_CHANNEL_ID);
    assert_eq!(asset.mime_type, "image/png");
    assert_eq!(asset.bytes, png_bytes.len() as u64);
    assert_eq!(asset.sha256.len(), 64, "sha256 hex is 64 chars");

    let on_disk = tmp.join("porch_assets").join(&asset.file_path);
    let read = std::fs::read(&on_disk).expect("file on disk");
    assert_eq!(read, png_bytes, "file content must match uploaded bytes");

    // list_assets sees exactly the one row.
    let listed = porch
        .list_assets(DEFAULT_PORCH_CHANNEL_ID)
        .expect("list ok");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, asset.id);
}

// ---------------------------------------------------------------------------
// (4) theme_with_image_background_requires_asset_to_exist — setting a
//     theme that references an Image background with a non-existent
//     `asset_id` is rejected before the row hits the DB.
// ---------------------------------------------------------------------------

#[test]
fn theme_with_image_background_requires_asset_to_exist() {
    let tmp = tempdir_for_test("image-bg-missing");
    let porch = Porch::open(&tmp).expect("open ok");
    porch
        .insert_channel(
            "campaign-room",
            "Campaign Room",
            ChannelKind::Inner,
            AclMode::Allowlist,
        )
        .expect("insert ok");
    let theme = ChannelTheme {
        channel_id: "campaign-room".to_string(),
        background: Background::Image {
            asset_id: "01NOSUCHASSET".to_string(),
        },
        ..ChannelTheme::default_for("campaign-room")
    };
    let err = porch.set_theme(theme).expect_err("must reject missing asset");
    let msg = err.to_string();
    assert!(
        msg.contains("01NOSUCHASSET"),
        "error must reference the asset id: {msg}"
    );

    // Same channel, real asset → works.
    let png = b"\x89PNG\r\n\x1a\nbody";
    let asset = porch
        .upload_asset("campaign-room", "image/png", png)
        .expect("upload ok");
    let theme_ok = ChannelTheme {
        channel_id: "campaign-room".to_string(),
        background: Background::Image {
            asset_id: asset.id.clone(),
        },
        ..ChannelTheme::default_for("campaign-room")
    };
    porch
        .set_theme(theme_ok)
        .expect("real asset id must be accepted");

    // Cross-channel binding is rejected — an asset uploaded to channel
    // X cannot back a theme on channel Y. This is the ACL coupling
    // the design doc requires.
    porch
        .insert_channel(
            "other-room",
            "Other",
            ChannelKind::Inner,
            AclMode::Allowlist,
        )
        .expect("insert ok");
    let theme_xchannel = ChannelTheme {
        channel_id: "other-room".to_string(),
        background: Background::Image {
            asset_id: asset.id.clone(),
        },
        ..ChannelTheme::default_for("other-room")
    };
    let err = porch
        .set_theme(theme_xchannel)
        .expect_err("cross-channel asset must reject");
    assert!(err.to_string().contains("different channel"));
}

// ---------------------------------------------------------------------------
// (5) theme_round_trip_over_libp2p — host sets a theme on an inner
//     channel; visitor with member ACL calls GetTheme via libp2p and
//     receives the theme intact.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn theme_round_trip_over_libp2p() {
    let (mut transport_a, peer_a, _addr_a) = spawn_transport("a-theme-out").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-theme-in").await;

    let tmp_b = tempdir_for_test("b-theme");
    let porch_b = Arc::new(Porch::open(&tmp_b).expect("porch ok"));
    porch_b
        .insert_channel(
            "campaign-room",
            "Campaign Room",
            ChannelKind::Inner,
            AclMode::Allowlist,
        )
        .expect("insert ok");
    // Grant A as a member so the ACL check on GetTheme passes.
    porch_b
        .grant_acl("campaign-room", &peer_a.to_base58(), AclRole::Member)
        .expect("grant ok");
    // Host customizes the room.
    let chosen = ChannelTheme {
        channel_id: "campaign-room".to_string(),
        primary_color: "#b89b6a".to_string(),
        surface_color: "#1a140d".to_string(),
        on_surface_color: "#f3e6cf".to_string(),
        accent_color: "#d4a35b".to_string(),
        font_family: FontFamily::Serif,
        background: Background::Solid("#241a10".to_string()),
        updated_at: 0,
    };
    porch_b.set_theme(chosen.clone()).expect("set theme ok");

    let handler = Arc::new(PorchHandler::new(porch_b.clone()));
    transport_b.register_federation_handler(handler);

    let mut control_a = transport_a.stream_control();
    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A::dial(B) must enqueue");
    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    let fetched = tokio::time::timeout(
        Duration::from_secs(10),
        app_lib::porch::visit_get_theme(&mut control_a, peer_b, "campaign-room".to_string()),
    )
    .await
    .expect("visit_get_theme timed out")
    .expect("visit_get_theme err");

    assert_eq!(fetched.channel_id, "campaign-room");
    assert_eq!(fetched.primary_color, chosen.primary_color);
    assert_eq!(fetched.font_family, chosen.font_family);
    assert!(matches!(fetched.background, Background::Solid(ref s) if s == "#241a10"));
}

// ---------------------------------------------------------------------------
// (6) get_asset_bytes_respects_acl — visitor without access to an
//     asset's owning channel cannot fetch the bytes (the dispatcher
//     surfaces 403). We exercise the dispatcher directly so the test
//     doesn't have to spin up two transports.
// ---------------------------------------------------------------------------

#[test]
fn get_asset_bytes_respects_acl() {
    let tmp = tempdir_for_test("acl-asset");
    let porch = Arc::new(Porch::open(&tmp).expect("open ok"));
    porch
        .insert_channel(
            "campaign-room",
            "Campaign Room",
            ChannelKind::Inner,
            AclMode::Allowlist,
        )
        .expect("insert ok");
    let png = b"\x89PNG\r\n\x1a\nbody";
    let asset = porch
        .upload_asset("campaign-room", "image/png", png)
        .expect("upload ok");

    let handler = PorchHandler::new(porch.clone());

    // Random unaffiliated visitor — has no ACL row on the inner
    // channel, so the asset fetch must be denied.
    let denied_visitor = fake_peer_id();
    let response = handler.dispatch(
        denied_visitor,
        PorchRequest::GetAssetBytes {
            asset_id: asset.id.clone(),
        },
    );
    assert!(!response.ok, "no-ACL visitor must be denied");
    let err = response.error.expect("error body");
    assert_eq!(err.code, 403, "ACL gate must surface 403");

    // Granting the visitor `member` flips the gate — bytes flow.
    porch
        .grant_acl("campaign-room", &denied_visitor.to_base58(), AclRole::Member)
        .expect("grant ok");
    let response = handler.dispatch(
        denied_visitor,
        PorchRequest::GetAssetBytes {
            asset_id: asset.id.clone(),
        },
    );
    assert!(response.ok, "post-grant fetch must succeed: {response:?}");
    let value = response.result.expect("result");
    // The inline-bytes shape uses base64; verify it round-trips.
    let kind = value.get("kind").and_then(|v| v.as_str()).expect("kind");
    assert_eq!(kind, "inline");
    let b64 = value
        .get("bytes_b64")
        .and_then(|v| v.as_str())
        .expect("bytes_b64");
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("decode");
    assert_eq!(decoded, png);
}

// ---------------------------------------------------------------------------
// Helpers (mirror the porch_test.rs / porch_knock_test.rs harness)
// ---------------------------------------------------------------------------

fn tempdir_for_test(label: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    p.push(format!("concord-porch-theme-test-{label}-{nanos}"));
    std::fs::create_dir_all(&p).expect("mkdir tmp");
    p
}

fn fake_peer_id() -> PeerId {
    let keypair = libp2p::identity::Keypair::generate_ed25519();
    PeerId::from(keypair.public())
}

async fn spawn_transport(label: &str) -> (LibP2pTransport, PeerId, Multiaddr) {
    let stronghold = Stronghold::default();
    let client_name = format!("porch-theme-test-{label}");
    let client = stronghold
        .create_client(client_name.as_bytes())
        .expect("create_client ok");
    let handle = StrongholdHandle::new(client);
    Box::leak(Box::new(stronghold));
    let peer_identity = identity::load_or_create(&handle)
        .await
        .expect("identity ok");
    let mut transport = LibP2pTransport::new(&peer_identity, &handle, None)
        .await
        .expect("transport ok");
    let peer_id = transport.local_peer_id();

    let raw_addr = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let RawSwarmEvent::NewListenAddr { address, .. } =
                transport.swarm_mut().select_next_some().await
            {
                if multiaddr_contains_quic_v1(&address) {
                    return address;
                }
            }
        }
    })
    .await
    .expect("transport timed out waiting for QUIC listen addr");

    Box::leak(Box::new(handle));
    (transport, peer_id, quic_loopback_with_peer_id(&raw_addr, peer_id))
}

fn multiaddr_contains_quic_v1(addr: &Multiaddr) -> bool {
    use libp2p::multiaddr::Protocol;
    addr.iter().any(|p| matches!(p, Protocol::QuicV1))
}

fn quic_loopback_with_peer_id(addr: &Multiaddr, peer: PeerId) -> Multiaddr {
    use libp2p::multiaddr::Protocol;
    let mut rebuilt = Multiaddr::empty();
    for proto in addr.iter() {
        match proto {
            Protocol::Ip4(_) => rebuilt.push(Protocol::Ip4(std::net::Ipv4Addr::LOCALHOST)),
            other => rebuilt.push(other),
        }
    }
    rebuilt.push(Protocol::P2p(peer));
    rebuilt
}
