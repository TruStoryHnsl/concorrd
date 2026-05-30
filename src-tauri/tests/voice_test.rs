//! Phase 8 (INS-019b) — voice subsystem integration tests.
//!
//! Four tests map 1:1 to Phase 8 acceptance criteria:
//!
//!   1. Selector picks mesh for a small all-native call.
//!   2. Selector picks SFU for an oversized native call.
//!   3. Selector picks SFU when any participant is web-only.
//!   4. The voice signaling protocol round-trips an Offer →
//!      `WebRtcPeer` → Answer end-to-end over libp2p — proving the
//!      Phase 6 stream abstraction carries voice payloads correctly.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_lib::servitude::federation::FederationHandler;
use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::p2p::LibP2pTransport;
use app_lib::servitude::voice::{
    send_signaling, ParticipantKind, PeerCallState, SignalingMessage, VoiceCallSink,
    VoicePath, VoicePathSelector, VoiceSignalingHandler, WebRtcPeer, SIGNALING_PROTOCOL_ID,
};
use async_trait::async_trait;
use futures::StreamExt;
use iota_stronghold::Stronghold;
use libp2p::{swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId};

// ---------------------------------------------------------------------------
// (1) Selector picks mesh for a small all-native call.
// ---------------------------------------------------------------------------

#[test]
fn selector_picks_mesh_for_small_native_call() {
    let participants = vec![
        ParticipantKind::Native {
            peer_id: PeerId::random(),
        },
        ParticipantKind::Native {
            peer_id: PeerId::random(),
        },
        ParticipantKind::Native {
            peer_id: PeerId::random(),
        },
    ];
    let path = VoicePathSelector::select(&participants);
    assert_eq!(
        path,
        VoicePath::LibP2pMesh,
        "3 native peers with no web-only must select mesh — got {:?}",
        path
    );
}

// ---------------------------------------------------------------------------
// (2) Selector picks SFU when the participant count exceeds the cap.
// ---------------------------------------------------------------------------

#[test]
fn selector_picks_sfu_for_oversized_native_call() {
    let participants: Vec<_> = (0..9)
        .map(|_| ParticipantKind::Native {
            peer_id: PeerId::random(),
        })
        .collect();
    let path = VoicePathSelector::select(&participants);
    assert_eq!(
        path,
        VoicePath::LiveKitSfu,
        "9 native peers must select SFU (above cap of 8) — got {:?}",
        path
    );
}

// ---------------------------------------------------------------------------
// (3) Selector picks SFU when any participant is web-only.
// ---------------------------------------------------------------------------

#[test]
fn selector_picks_sfu_when_any_web_only() {
    let participants = vec![
        ParticipantKind::Native {
            peer_id: PeerId::random(),
        },
        ParticipantKind::Native {
            peer_id: PeerId::random(),
        },
        ParticipantKind::Native {
            peer_id: PeerId::random(),
        },
        ParticipantKind::WebOnly,
    ];
    let path = VoicePathSelector::select(&participants);
    assert_eq!(
        path,
        VoicePath::LiveKitSfu,
        "3 native + 1 web-only must select SFU — got {:?}",
        path
    );
}

// ---------------------------------------------------------------------------
// (4) Voice signaling round-trip over libp2p.
//
//     Peer A opens an outbound `/concord/voice-signaling/1.0.0`
//     stream and writes an Offer. Peer B's registered
//     VoiceSignalingHandler delivers the Offer into a mock
//     VoiceCallSink. The sink drives a `WebRtcPeer` instance which
//     produces an Answer; the test asserts the Answer carries the
//     original Offer's request_id and that B's PeerCallState advanced
//     to IceGathering. This pins the end-to-end signaling wire,
//     proving the Phase 6 stream abstraction carries voice payloads
//     and that the Phase 8 trait refactor threads the correct PeerId
//     to the handler.
// ---------------------------------------------------------------------------

/// Build an in-memory Stronghold + handle for tests. Mirrors the
/// Phase 6 pattern; each call gets a unique client name so parallel
/// tests don't collide.
fn fresh_handle(label: &str) -> (Stronghold, StrongholdHandle) {
    let stronghold = Stronghold::default();
    let client_name = format!("voice-test-{label}");
    let client = stronghold
        .create_client(client_name.as_bytes())
        .expect("create_client must succeed on a fresh Stronghold");
    let handle = StrongholdHandle::new(client);
    (stronghold, handle)
}

/// Mock sink that records every delivered envelope so the test can
/// assert the inbound dispatch worked AND drives a `WebRtcPeer` to
/// produce a real Answer.
#[derive(Default)]
struct RecordingVoiceSink {
    received: Mutex<Vec<(PeerId, SignalingMessage)>>,
    /// Peers keyed by remote PeerId. Tests can inspect call state
    /// after the deliveries have been processed.
    peers: Mutex<std::collections::HashMap<PeerId, WebRtcPeer>>,
    /// Queue of "responses we would send back" — populated when an
    /// Offer comes in and the WebRtcPeer produces an Answer.
    outbound: Mutex<Vec<(PeerId, SignalingMessage)>>,
}

#[async_trait]
impl VoiceCallSink for RecordingVoiceSink {
    async fn deliver(&self, from: PeerId, message: SignalingMessage) {
        self.received
            .lock()
            .unwrap()
            .push((from, message.clone()));
        let mut peers = self.peers.lock().unwrap();
        let peer = peers
            .entry(from)
            .or_insert_with(|| WebRtcPeer::new(from));
        // Phase 8 invariant: signaling envelopes on a non-terminal
        // peer always succeed. The terminal-state guard is exercised
        // in the WebRtcPeer unit tests; this sink is only driven with
        // mid-call envelopes, so we unwrap.
        if let Some(response) = peer
            .handle_signaling(message)
            .expect("non-terminal peer must accept signaling")
        {
            self.outbound.lock().unwrap().push((from, response));
        }
    }
}

async fn spawn_transport(label: &str) -> (LibP2pTransport, PeerId, Multiaddr) {
    let (sh, handle) = fresh_handle(label);
    Box::leak(Box::new(sh));
    let peer_identity = identity::load_or_create(&handle)
        .await
        .expect("phase 2 load_or_create must succeed");
    let mut transport = LibP2pTransport::new(&peer_identity, &handle)
        .await
        .expect("transport must construct");
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
    .expect("transport timed out waiting for its QUIC listen addr");

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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn voice_signaling_round_trip_over_libp2p() {
    let (mut transport_a, peer_a, _addr_a) = spawn_transport("a-voice").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-voice").await;

    // Sanity: distinct peers — the round-trip would be meaningless if
    // A and B accidentally derived the same PeerId.
    assert_ne!(peer_a, peer_b, "test peers must be distinct");

    // Register the voice signaling handler on B BEFORE run() consumes
    // the transport. The mock sink records every delivery AND drives
    // a `WebRtcPeer` per inbound peer.
    let sink = Arc::new(RecordingVoiceSink::default());
    let handler = Arc::new(VoiceSignalingHandler::new(sink.clone()));
    transport_b.register_federation_handler(handler);

    let mut control_a = transport_a.stream_control();

    // Pre-dial A → B so the swarm has the connection in hand before
    // open_stream is invoked. `open_stream` will dial if needed, but
    // pre-dialing keeps the test deterministic.
    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A::dial(B) must enqueue");

    // Spawn both run() loops. Stream-behaviour dispatch only makes
    // progress while the swarms are polled.
    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    // Send an Offer over the signaling wire.
    let offer = SignalingMessage::Offer {
        sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 0 RTP/AVP 0\r\n"
            .to_string(),
        request_id: 7,
    };
    tokio::time::timeout(
        Duration::from_secs(10),
        send_signaling(&mut control_a, peer_b, offer.clone()),
    )
    .await
    .expect("send_signaling timed out — A could not reach B within 10s")
    .expect("send_signaling returned an error");

    // Wait for the sink to record the inbound delivery. The dispatch
    // is async — the test polls with a short timeout.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if !sink.received.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // (a) Sink received exactly the one Offer envelope.
    let received = sink.received.lock().unwrap().clone();
    assert_eq!(
        received.len(),
        1,
        "sink must have received exactly one delivery, got: {received:?}"
    );
    let (from_peer, msg) = &received[0];
    assert_eq!(
        *from_peer, peer_a,
        "delivery's `from` must equal peer_a — Phase 8 trait refactor must thread the correct PeerId through"
    );
    match msg {
        SignalingMessage::Offer { sdp, request_id } => {
            assert_eq!(*request_id, 7, "request_id must round-trip");
            assert!(sdp.contains("v=0"), "SDP body must round-trip");
        }
        other => panic!("expected Offer, got: {:?}", other),
    }

    // (b) WebRtcPeer driven by the sink produced an Answer.
    let outbound = sink.outbound.lock().unwrap().clone();
    assert_eq!(
        outbound.len(),
        1,
        "WebRtcPeer must have produced exactly one Answer, got: {outbound:?}"
    );
    let (to_peer, response) = &outbound[0];
    assert_eq!(
        *to_peer, peer_a,
        "answer would be routed back to peer_a (the offer's origin)"
    );
    match response {
        SignalingMessage::Answer { sdp, request_id } => {
            assert_eq!(
                *request_id, 7,
                "answer request_id must echo offer request_id"
            );
            assert!(!sdp.is_empty(), "answer SDP must be non-empty");
        }
        other => panic!("expected Answer, got: {:?}", other),
    }

    // (c) Peer state advanced to IceGathering.
    let peers = sink.peers.lock().unwrap();
    let peer_state = peers
        .get(&peer_a)
        .map(|p| p.state().clone())
        .expect("sink must have created a WebRtcPeer for peer_a");
    assert_eq!(
        peer_state,
        PeerCallState::IceGathering,
        "WebRtcPeer state must advance to IceGathering after handling an Offer"
    );

    // (d) Compile-time check: the protocol ID accessors agree.
    assert_eq!(
        <VoiceSignalingHandler as app_lib::servitude::federation::FederationProtocol>::PROTOCOL_ID,
        SIGNALING_PROTOCOL_ID,
        "FederationProtocol::PROTOCOL_ID must match the module-level constant"
    );
    // And the runtime accessor agrees too — pin both halves of the
    // trait split.
    let runtime_handler: Arc<dyn FederationHandler> = Arc::new(VoiceSignalingHandler::new(
        Arc::new(RecordingVoiceSink::default()),
    ));
    assert_eq!(runtime_handler.protocol_id(), SIGNALING_PROTOCOL_ID);
}
