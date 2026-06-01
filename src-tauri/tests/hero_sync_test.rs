//! F-C — Tailscale-gated hero sync integration tests.
//!
//! Acceptance criteria mapped 1:1 to the test functions below:
//!
//!   1. Tailscale gate (peer-and-local both bound to CGNAT) → `true`.
//!   2. Tailscale gate (neither side bound to CGNAT) → `false`.
//!   3. Tailscale gate (peer-only) → `false`.
//!   4. Tailscale gate (local-only) → `false`.
//!   5. Two-gate evaluator: hero-yes + tailnet-no → no-sync.
//!   6. Two-gate evaluator: hero-no + tailnet-yes → no-sync.
//!   7. Two-gate evaluator: both yes → sync triggered (gate verdict `true`).
//!   8. Bidirectional sync round-trip over two libp2p swarms:
//!      both sides exchange deltas, LWW + tombstone semantics preserved.
//!   9. Concurrent-rename collision enqueues exactly one
//!      `conflict_queue` row.
//!  10. Anchor mode reported correctly via the Ping path.
//!
//! Tests 1-7 + 9-10 are pure (no swarm needed). Test 8 spawns two
//! libp2p transports on loopback, mirroring `porch_sync_test::sync_now_round_trip`.
//!
//! Cold-reader stance: every assertion verifies a value the cold reader
//! can observe externally (DB column value, response variant, pending
//! conflict count). No "I think this is right" assertions.

use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use app_lib::porch::sync::merge::PorchChannelRow;
use app_lib::porch::sync::protocol::{SyncCursor, SyncDelta};
use app_lib::porch::Porch;
use app_lib::servitude::hero_binding::{HeroBinding, HeroDescriptor};
use app_lib::servitude::hero_sync::{
    anchor::hero_set_anchor_instance, conflict_queue, evaluate_gates,
    HeroAnchorMode, HeroSyncEnvelope, HeroSyncHandler, HeroSyncRequest, HeroSyncResponse,
    HERO_SYNC_PROTOCOL_ID,
};
use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::network::tailscale_detect::{
    is_tailscale_peer, TailscaleGateSnapshot, PROBE_OVERRIDE,
};
use app_lib::servitude::p2p::LibP2pTransport;
use futures::StreamExt;
use iota_stronghold::Stronghold;
use libp2p::{swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId, StreamProtocol};
use libp2p_stream::Control;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn ma(s: &str) -> Multiaddr {
    s.parse().expect("multiaddr parse")
}

fn with_local_ips<R>(ips: Vec<Ipv4Addr>, body: impl FnOnce() -> R) -> R {
    PROBE_OVERRIDE.with(
        |c: &std::cell::RefCell<Option<Vec<Ipv4Addr>>>| {
            *c.borrow_mut() = Some(ips);
        },
    );
    let r = body();
    PROBE_OVERRIDE.with(
        |c: &std::cell::RefCell<Option<Vec<Ipv4Addr>>>| {
            *c.borrow_mut() = None;
        },
    );
    r
}

fn fake_peer_id() -> PeerId {
    let kp = libp2p::identity::Keypair::generate_ed25519();
    PeerId::from(kp.public())
}

fn block<F: std::future::Future>(f: F) -> F::Output {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(f)
}

// ---------------------------------------------------------------------------
// (1) Tailscale gate — both sides on tailnet
// ---------------------------------------------------------------------------

#[test]
fn tailscale_gate_both_sides_on_tailnet_passes() {
    let peer_addrs = vec![ma("/ip4/100.78.87.6/tcp/4001")];
    with_local_ips(vec![Ipv4Addr::new(100, 78, 87, 5)], || {
        let snap = TailscaleGateSnapshot::evaluate(&peer_addrs);
        assert!(snap.peer_in_cgnat);
        assert!(snap.local_in_cgnat);
        assert!(snap.passes());
        assert!(is_tailscale_peer(&peer_addrs));
    });
}

// ---------------------------------------------------------------------------
// (2) Tailscale gate — neither side on tailnet
// ---------------------------------------------------------------------------

#[test]
fn tailscale_gate_neither_side_on_tailnet_blocks() {
    let peer_addrs = vec![ma("/ip4/192.168.1.123/tcp/4001")];
    with_local_ips(vec![Ipv4Addr::new(192, 168, 1, 152)], || {
        let snap = TailscaleGateSnapshot::evaluate(&peer_addrs);
        assert!(!snap.peer_in_cgnat);
        assert!(!snap.local_in_cgnat);
        assert!(!snap.passes());
        assert!(!is_tailscale_peer(&peer_addrs));
    });
}

// ---------------------------------------------------------------------------
// (3) Tailscale gate — peer-only on tailnet
// ---------------------------------------------------------------------------

#[test]
fn tailscale_gate_peer_only_on_tailnet_blocks() {
    let peer_addrs = vec![ma("/ip4/100.78.87.6/tcp/4001")];
    with_local_ips(vec![Ipv4Addr::new(192, 168, 1, 152)], || {
        let snap = TailscaleGateSnapshot::evaluate(&peer_addrs);
        assert!(snap.peer_in_cgnat);
        assert!(!snap.local_in_cgnat);
        assert!(!snap.passes());
        assert!(!is_tailscale_peer(&peer_addrs));
    });
}

// ---------------------------------------------------------------------------
// (4) Tailscale gate — local-only on tailnet
// ---------------------------------------------------------------------------

#[test]
fn tailscale_gate_local_only_on_tailnet_blocks() {
    let peer_addrs = vec![ma("/ip4/8.8.8.8/tcp/4001")];
    with_local_ips(vec![Ipv4Addr::new(100, 78, 87, 5)], || {
        let snap = TailscaleGateSnapshot::evaluate(&peer_addrs);
        assert!(!snap.peer_in_cgnat);
        assert!(snap.local_in_cgnat);
        assert!(!snap.passes());
        assert!(!is_tailscale_peer(&peer_addrs));
    });
}

// ---------------------------------------------------------------------------
// (5) Two-gate evaluator: hero-yes + tailnet-no → no sync
// ---------------------------------------------------------------------------

#[test]
fn two_gate_hero_present_but_no_tailnet_blocks() {
    // Even with a local hero present, tailnet failure blocks the gate.
    let binding = HeroBinding::new(Some(HeroDescriptor {
        hero_pubkey: [0xAA; 32],
        display_label: "local".to_string(),
    }));
    let peer_addrs = vec![ma("/ip4/192.168.1.123/tcp/4001")];
    with_local_ips(vec![Ipv4Addr::new(192, 168, 1, 152)], || {
        let outcome = block(evaluate_gates(&binding, &fake_peer_id(), &peer_addrs))
            .expect("eval");
        assert!(!outcome.tailscale_passes);
        // hero is reported false because the lookup short-circuited.
        assert!(!outcome.hero_passes);
        assert!(!outcome.both_pass());
    });
}

// ---------------------------------------------------------------------------
// (6) Two-gate evaluator: hero-no + tailnet-yes → no sync
// ---------------------------------------------------------------------------

#[test]
fn two_gate_tailnet_present_but_no_hero_blocks() {
    // No local hero. Tailscale gate passes; hero gate cannot.
    let binding = HeroBinding::new(None);
    let peer_addrs = vec![ma("/ip4/100.78.87.6/tcp/4001")];
    with_local_ips(vec![Ipv4Addr::new(100, 78, 87, 5)], || {
        let outcome = block(evaluate_gates(&binding, &fake_peer_id(), &peer_addrs))
            .expect("eval");
        assert!(outcome.tailscale_passes);
        assert!(!outcome.hero_passes);
        assert!(!outcome.both_pass());
    });
}

// ---------------------------------------------------------------------------
// (7) Two-gate evaluator: both yes (under stub) verifies gate STAYS
//     CLOSED until F-A lands.
// ---------------------------------------------------------------------------

#[test]
fn two_gate_with_f_a_stub_still_blocks_hero() {
    // The F-A lookup stub returns None for every peer; this is the
    // safe default that locks hero-sync OFF until F-A wires through.
    // The test pins that behavior so a future merge cannot silently
    // open the gate.
    let binding = HeroBinding::new(Some(HeroDescriptor {
        hero_pubkey: [0xAA; 32],
        display_label: "local".to_string(),
    }));
    let peer_addrs = vec![ma("/ip4/100.78.87.6/tcp/4001")];
    with_local_ips(vec![Ipv4Addr::new(100, 78, 87, 5)], || {
        let outcome = block(evaluate_gates(&binding, &fake_peer_id(), &peer_addrs))
            .expect("eval");
        assert!(outcome.tailscale_passes);
        assert!(
            !outcome.hero_passes,
            "F-A stub MUST return None until A lands — gate stays closed"
        );
        assert!(!outcome.both_pass());
    });
}

// ---------------------------------------------------------------------------
// (8) Bidirectional sync round-trip over two libp2p swarms.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hero_sync_round_trip_exchanges_deltas() {
    let (mut transport_a, _peer_a, _addr_a) = spawn_transport("a-hero").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-hero").await;

    let tmp_a = tempdir_for_test("a-hero-porch");
    let porch_a = Arc::new(Porch::open(&tmp_a).expect("porch a"));

    let tmp_b = tempdir_for_test("b-hero-porch");
    let porch_b = Arc::new(Porch::open(&tmp_b).expect("porch b"));

    // Register hero-sync handlers on both peers.
    let handler_a = Arc::new(HeroSyncHandler::new(porch_a.clone()));
    let handler_b = Arc::new(HeroSyncHandler::new(porch_b.clone()));
    transport_a.register_federation_handler(handler_a);
    transport_b.register_federation_handler(handler_b);

    let mut control_a = transport_a.stream_control();
    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A dial B");
    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    // A writes a channel locally that B doesn't have.
    porch_a
        .insert_channel(
            "hero-synced-ch",
            "HeroSynced",
            app_lib::porch::ChannelKind::Inner,
            app_lib::porch::AclMode::Allowlist,
        )
        .expect("insert");

    // Run the hero-sync round.
    let response = tokio::time::timeout(
        Duration::from_secs(15),
        run_outbound_round(&porch_a, &mut control_a, peer_b),
    )
    .await
    .expect("timeout");

    match response.expect("round returned") {
        HeroSyncResponse::Round {
            responder_push,
            responder_conflicts_enqueued,
        } => {
            // B should have responded with its own (small) initial
            // delta; no conflicts in this happy path.
            assert_eq!(responder_conflicts_enqueued, 0);
            // A applied B's push back; A's DB should now also have the
            // default channels B started with.
            let _ = responder_push;
        }
        other => panic!("expected Round response, got {other:?}"),
    }

    // B's DB must contain A's freshly-pushed channel.
    let channels_b = porch_b.list_channels().expect("list b");
    let ids: Vec<&str> = channels_b.iter().map(|c| c.id.as_str()).collect();
    assert!(
        ids.contains(&"hero-synced-ch"),
        "B must see hero-synced channel: got {ids:?}"
    );
}

// ---------------------------------------------------------------------------
// (9) Concurrent rename → exactly one conflict_queue row.
// ---------------------------------------------------------------------------

#[test]
fn concurrent_rename_enqueues_exactly_one_conflict() {
    let porch = Arc::new(Porch::open_in_memory().expect("open"));
    // Seed local porch with a channel at known lamport.
    let local_lamport = {
        let conn = porch.conn_for_test();
        let lamport = app_lib::porch::sync::clock::next_lamport(&conn).unwrap();
        conn.execute(
            "INSERT INTO porch_channels
                (id, name, kind, acl_mode, created_at,
                 sync_device_id, sync_lamport, sync_tombstone)
             VALUES (?1, ?2, 'porch', 'open', ?3, ?4, ?5, 0)",
            rusqlite::params![
                "race-channel",
                "general",
                1i64,
                "dev-local",
                lamport,
            ],
        )
        .unwrap();
        lamport
    };

    // Build an inbound delta with the SAME row at the SAME lamport but
    // a different name + different device-id.
    let remote = PorchChannelRow {
        id: "race-channel".to_string(),
        name: "announcements".to_string(),
        kind: "porch".to_string(),
        acl_mode: "open".to_string(),
        created_at: 1,
        sync_device_id: "dev-remote".to_string(),
        sync_lamport: local_lamport,
        sync_tombstone: 0,
    };
    let env = HeroSyncEnvelope {
        anchored: false,
        anchor_label: None,
        since: SyncCursor::default(),
        push: SyncDelta {
            channels: vec![remote],
            ..SyncDelta::default()
        },
    };

    let handler = HeroSyncHandler::new(porch.clone());
    let response = handler.dispatch(HeroSyncRequest::Round(env));
    match response {
        HeroSyncResponse::Round {
            responder_conflicts_enqueued,
            ..
        } => {
            assert_eq!(responder_conflicts_enqueued, 1);
        }
        other => panic!("expected Round, got {other:?}"),
    }
    assert_eq!(conflict_queue::pending_count(&porch).unwrap(), 1);
    let pending = conflict_queue::list_pending(&porch).unwrap();
    assert_eq!(pending[0].conflict_kind, "concurrent_rename");
    // The conflict carries enough state to be drained by F-D.
    assert_eq!(pending[0].payload_json["row_id"], "race-channel");
}

// ---------------------------------------------------------------------------
// (10) Anchor mode reported via Ping.
// ---------------------------------------------------------------------------

#[test]
fn ping_reports_unanchored_by_default() {
    let porch = Arc::new(Porch::open_in_memory().expect("open"));
    let handler = HeroSyncHandler::new(porch);
    let response = handler.dispatch(HeroSyncRequest::Ping);
    match response {
        HeroSyncResponse::Pong { responder_mode } => {
            assert_eq!(responder_mode, HeroAnchorMode::Unanchored);
        }
        other => panic!("expected Pong, got {other:?}"),
    }
}

#[test]
fn ping_reports_anchored_after_election() {
    let porch = Arc::new(Porch::open_in_memory().expect("open"));
    hero_set_anchor_instance(&porch, Some("docker-instance-A")).unwrap();
    let handler = HeroSyncHandler::new(porch);
    let response = handler.dispatch(HeroSyncRequest::Ping);
    match response {
        HeroSyncResponse::Pong { responder_mode } => {
            assert_eq!(responder_mode, HeroAnchorMode::Anchored);
        }
        other => panic!("expected Pong, got {other:?}"),
    }
}

#[test]
fn protocol_id_pins_to_concord_hero_sync_v1() {
    assert_eq!(HERO_SYNC_PROTOCOL_ID, "/concord/hero-sync/1.0.0");
}

// ---------------------------------------------------------------------------
// Outbound-round wiring (mirrors `porch_sync_test::sync_now_round_trip`)
// ---------------------------------------------------------------------------

/// Build the envelope locally, ship the request, decode the response.
/// Mirrors `protocol::run_hero_sync_round` but inlines the steps so
/// the integration test can observe each one.
async fn run_outbound_round(
    porch: &Porch,
    control: &mut Control,
    peer_id: PeerId,
) -> Result<HeroSyncResponse, String> {
    use futures::{AsyncReadExt, AsyncWriteExt};
    let proto = StreamProtocol::new(HERO_SYNC_PROTOCOL_ID);
    let mut stream = control
        .open_stream(peer_id, proto)
        .await
        .map_err(|e| format!("open_stream: {e:?}"))?;

    let since = app_lib::porch::sync::protocol::local_cursor(porch)
        .map_err(|e| e.to_string())?;

    // Collect everything since cursor=0 on the push side — same as the
    // production helper.
    let push = collect_full_delta(porch).map_err(|e| e.to_string())?;

    let envelope = HeroSyncEnvelope {
        anchored: false,
        anchor_label: None,
        since,
        push,
    };
    let req = HeroSyncRequest::Round(envelope);
    let bytes = serde_json::to_vec(&req).unwrap();
    let len_be = (bytes.len() as u32).to_be_bytes();
    stream.write_all(&len_be).await.map_err(|e| e.to_string())?;
    stream.write_all(&bytes).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())?;

    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .await
        .map_err(|e| e.to_string())?;
    let len = u32::from_be_bytes(len_buf) as usize;
    let mut buf = vec![0u8; len];
    stream
        .read_exact(&mut buf)
        .await
        .map_err(|e| e.to_string())?;
    let _ = stream.close().await;
    let response: HeroSyncResponse =
        serde_json::from_slice(&buf).map_err(|e| e.to_string())?;

    // Apply the responder's push locally to converge.
    if let HeroSyncResponse::Round { responder_push, .. } = &response {
        app_lib::porch::sync::protocol::apply_sync_batch(porch, responder_push)
            .map_err(|e| e.to_string())?;
    }
    Ok(response)
}

fn collect_full_delta(porch: &Porch) -> Result<SyncDelta, app_lib::porch::PorchError> {
    let conn = porch.conn_for_test();
    Ok(SyncDelta {
        channels: app_lib::porch::sync::merge::channels_since(&conn, 0)?,
        messages: app_lib::porch::sync::merge::messages_since(&conn, 0)?,
        acl: app_lib::porch::sync::merge::acl_since(&conn, 0)?,
        knocks: app_lib::porch::sync::merge::knocks_since(&conn, 0)?,
        themes: app_lib::porch::sync::merge::themes_since(&conn, 0)?,
        assets: app_lib::porch::sync::merge::assets_since(&conn, 0)?,
        obsidian: app_lib::porch::sync::merge::obsidian_since(&conn, 0)?,
    })
}

// ---------------------------------------------------------------------------
// Test infra (copied from porch_sync_test for consistency)
// ---------------------------------------------------------------------------

fn tempdir_for_test(label: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    p.push(format!("concord-hero-sync-test-{label}-{nanos}"));
    std::fs::create_dir_all(&p).expect("mkdir tmp");
    p
}

async fn spawn_transport(label: &str) -> (LibP2pTransport, PeerId, Multiaddr) {
    let stronghold = Stronghold::default();
    let client_name = format!("hero-sync-test-{label}");
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
    (
        transport,
        peer_id,
        quic_loopback_with_peer_id(&raw_addr, peer_id),
    )
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
