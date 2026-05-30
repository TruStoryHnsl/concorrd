//! Phase 6 follow-up (INS-019b) — integration tests for the ActivityPub
//! federation handler.
//!
//! Each test maps 1:1 to a Phase 6 acceptance criterion, restated for the
//! ActivityPub handler. Written from a cold-reader perspective per the
//! project's MANDATORY testing rules: every assertion is something an
//! external observer can see (the mock API received an envelope; the
//! wire response decodes to `accepted: true`; the swarm survives a
//! malformed envelope on a stream protocol it advertises).
//!
//! Test harness mirrors `federation_test.rs` (two real swarms wired via
//! loopback QUIC). The only delta is the typed request/response shapes
//! and the protocol ID.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_lib::servitude::federation::{
    activitypub::activitypub_request, ActivityPubApi, ActivityPubErrorBody,
    ActivityPubHandler, ActivityPubRequest, ActivityPubResponse, FederationHandler,
    FederationProtocol, MatrixErrorBody, MatrixFederationApi, MatrixFederationHandler,
    MatrixRequest, MatrixResponse, PayloadKind, ACTIVITYPUB_PROTOCOL_ID,
    MATRIX_PROTOCOL_ID,
};
use app_lib::servitude::federation::matrix::matrix_request;
use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::p2p::{LibP2pTransport, SwarmEvent};
use async_trait::async_trait;
use futures::{AsyncWriteExt, StreamExt};
use iota_stronghold::Stronghold;
use libp2p::{swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId, StreamProtocol};

/// Build an in-memory Stronghold + handle for tests. Mirrors the Phase 3
/// pattern in `p2p_test.rs`. Each call gets a unique client name so
/// concurrent tests don't collide.
fn fresh_handle(label: &str) -> (Stronghold, StrongholdHandle) {
    let stronghold = Stronghold::default();
    let client_name = format!("activitypub-test-{label}");
    let client = stronghold
        .create_client(client_name.as_bytes())
        .expect("create_client must succeed on a fresh Stronghold");
    let handle = StrongholdHandle::new(client);
    (stronghold, handle)
}

/// Records every dispatched request so tests can assert that the
/// inbound handler actually reached the API. Returns canned responses
/// keyed on `activity_type`.
#[derive(Default)]
struct MockActivityPubApi {
    received: Mutex<Vec<ActivityPubRequest>>,
}

impl MockActivityPubApi {
    fn received(&self) -> Vec<ActivityPubRequest> {
        self.received.lock().unwrap().clone()
    }
}

#[async_trait]
impl ActivityPubApi for MockActivityPubApi {
    async fn dispatch(&self, request: ActivityPubRequest) -> ActivityPubResponse {
        self.received.lock().unwrap().push(request.clone());
        if request.activity_type == "Ping" {
            ActivityPubResponse {
                request_id: request.request_id,
                accepted: Some(true),
                error: None,
            }
        } else {
            ActivityPubResponse {
                request_id: request.request_id,
                accepted: None,
                error: Some(ActivityPubErrorBody {
                    code: 501,
                    message: "mock-not-impl".into(),
                }),
            }
        }
    }
}

/// Mock Matrix API used by the routing-isolation test. Mirrors the
/// shape in `federation_test.rs::MockMatrixApi` so a coexisting Matrix
/// handler can be registered on the same swarm and the test can assert
/// no cross-routing happens.
#[derive(Default)]
struct MockMatrixApi {
    received: Mutex<Vec<MatrixRequest>>,
}

impl MockMatrixApi {
    fn received(&self) -> Vec<MatrixRequest> {
        self.received.lock().unwrap().clone()
    }
}

#[async_trait]
impl MatrixFederationApi for MockMatrixApi {
    async fn dispatch(&self, request: MatrixRequest) -> MatrixResponse {
        self.received.lock().unwrap().push(request.clone());
        if request.method == "federation.heartbeat" {
            MatrixResponse {
                request_id: request.request_id,
                result: Some(serde_json::json!({ "alive": true })),
                error: None,
            }
        } else {
            MatrixResponse {
                request_id: request.request_id,
                result: None,
                error: Some(MatrixErrorBody {
                    code: 501,
                    message: "mock-not-impl".into(),
                }),
            }
        }
    }
}

/// Build a transport without bootstrap noise, then drive its swarm until
/// it reports a QUIC listen address. Returns the transport, its peer ID,
/// and the loopback multiaddr the other test peer should dial.
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

/// Wait until the test's broadcast subscription sees a
/// `FederationStreamOpened` event for the given protocol ID, OR the
/// timeout elapses. Returns true if seen.
async fn wait_for_federation_stream_event(
    mut rx: tokio::sync::broadcast::Receiver<SwarmEvent>,
    expected_protocol: &str,
    timeout: Duration,
) -> bool {
    tokio::time::timeout(timeout, async move {
        loop {
            match rx.recv().await {
                Ok(SwarmEvent::FederationStreamOpened { protocol_id, .. })
                    if protocol_id == expected_protocol =>
                {
                    return true;
                }
                Ok(_) => continue,
                Err(_) => return false,
            }
        }
    })
    .await
    .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// (1) Phase 6 follow-up criterion: an inbound stream on
//     `ACTIVITYPUB_PROTOCOL_ID` is routed to the registered
//     ActivityPubHandler, dispatched into the mock API, and the response
//     round-trips back to the outbound caller intact.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn activitypub_handler_dispatches_inbound_by_protocol_id() {
    let (mut transport_a, _peer_a, _addr_a) = spawn_transport("a-out").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-in").await;

    // Register the ActivityPub handler on B BEFORE run() consumes the transport.
    let mock = Arc::new(MockActivityPubApi::default());
    let handler = Arc::new(ActivityPubHandler::new(mock.clone()));
    transport_b.register_federation_handler(handler);

    let b_event_rx = transport_b.subscribe();
    let mut control_a = transport_a.stream_control();

    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A::dial(B) must enqueue");

    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    // Open the outbound stream and round-trip the Ping envelope.
    let request = ActivityPubRequest {
        activity_type: "Ping".to_string(),
        actor: "https://mastodon.example/@alice".to_string(),
        object: serde_json::json!({}),
        request_id: 1,
    };
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        activitypub_request(&mut control_a, peer_b, request.clone()),
    )
    .await
    .expect("activitypub_request timed out — A could not reach B within 10s")
    .expect("activitypub_request returned an error");

    assert_eq!(response.request_id, 1);
    assert_eq!(
        response.accepted,
        Some(true),
        "Ping response must be {{ accepted: true }}, got: {:?}",
        response
    );
    assert!(
        response.error.is_none(),
        "Ping response must not carry an error field, got: {:?}",
        response.error
    );

    // Mock recorded the inbound dispatch.
    let received = mock.received();
    assert_eq!(
        received.len(),
        1,
        "mock API must have received exactly one dispatch, got: {received:?}"
    );
    assert_eq!(received[0].activity_type, "Ping");
    assert_eq!(received[0].actor, "https://mastodon.example/@alice");
    assert_eq!(received[0].request_id, 1);

    // B's swarm event surface published FederationStreamOpened for the
    // ActivityPub protocol ID specifically.
    assert!(
        wait_for_federation_stream_event(
            b_event_rx,
            ACTIVITYPUB_PROTOCOL_ID,
            Duration::from_secs(2)
        )
        .await,
        "B must have emitted FederationStreamOpened for ACTIVITYPUB_PROTOCOL_ID"
    );

    // Compile-time check: the trait split exposes ACTIVITYPUB_PROTOCOL_ID
    // at both the const and the runtime accessor.
    assert_eq!(
        ActivityPubHandler::PROTOCOL_ID,
        ACTIVITYPUB_PROTOCOL_ID,
        "FederationProtocol::PROTOCOL_ID must match the module-level constant"
    );

    // The payload kind on the dyn-safe trait reports ActivityPub —
    // confirms the variant is wired through for the diagnostics surface.
    let kind_handler: Arc<dyn FederationHandler> =
        Arc::new(ActivityPubHandler::new(Arc::new(MockActivityPubApi::default())));
    assert_eq!(kind_handler.payload_kind(), PayloadKind::ActivityPub);
}

// ---------------------------------------------------------------------------
// (2) Phase 6 follow-up criterion: streams are routed by `protocol_id()`,
//     not by handler-registration order or by payload sniffing. B
//     registers BOTH Matrix and ActivityPub; A opens streams on each
//     protocol ID; traffic must land on the right handler.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn activitypub_routes_by_protocol_id_not_by_default() {
    let (mut transport_a, _peer_a, _addr_a) = spawn_transport("a-route").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-route").await;

    // Register BOTH handlers on B. Each has its own mock so the test can
    // assert which one was invoked for which envelope.
    let mock_matrix = Arc::new(MockMatrixApi::default());
    let matrix_handler = Arc::new(MatrixFederationHandler::new(mock_matrix.clone()));
    transport_b.register_federation_handler(matrix_handler);

    let mock_ap = Arc::new(MockActivityPubApi::default());
    let ap_handler = Arc::new(ActivityPubHandler::new(mock_ap.clone()));
    transport_b.register_federation_handler(ap_handler);

    let mut control_a = transport_a.stream_control();
    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A::dial(B) must enqueue");

    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    // (a) Send a Matrix envelope — must land on the Matrix handler ONLY.
    let matrix_resp = tokio::time::timeout(
        Duration::from_secs(10),
        matrix_request(
            &mut control_a,
            peer_b,
            MatrixRequest {
                method: "federation.heartbeat".into(),
                params: serde_json::json!({}),
                request_id: 11,
            },
        ),
    )
    .await
    .expect("matrix round-trip timed out")
    .expect("matrix round-trip errored");
    assert_eq!(matrix_resp.request_id, 11);
    assert_eq!(
        matrix_resp.result,
        Some(serde_json::json!({ "alive": true })),
        "Matrix heartbeat response must be intact"
    );

    // (b) Send an ActivityPub envelope — must land on the ActivityPub
    // handler ONLY.
    let ap_resp = tokio::time::timeout(
        Duration::from_secs(10),
        activitypub_request(
            &mut control_a,
            peer_b,
            ActivityPubRequest {
                activity_type: "Ping".into(),
                actor: "https://mastodon.example/@bob".into(),
                object: serde_json::json!({}),
                request_id: 22,
            },
        ),
    )
    .await
    .expect("activitypub round-trip timed out")
    .expect("activitypub round-trip errored");
    assert_eq!(ap_resp.request_id, 22);
    assert_eq!(ap_resp.accepted, Some(true));

    // Cross-routing assertions: each mock saw EXACTLY its own envelope,
    // never the other's. This is the property protocol-ID routing
    // exists to guarantee.
    let matrix_received = mock_matrix.received();
    assert_eq!(
        matrix_received.len(),
        1,
        "Matrix handler must have seen exactly its heartbeat, got: {:?}",
        matrix_received
    );
    assert_eq!(matrix_received[0].method, "federation.heartbeat");
    assert_eq!(matrix_received[0].request_id, 11);

    let ap_received = mock_ap.received();
    assert_eq!(
        ap_received.len(),
        1,
        "ActivityPub handler must have seen exactly its Ping, got: {:?}",
        ap_received
    );
    assert_eq!(ap_received[0].activity_type, "Ping");
    assert_eq!(ap_received[0].request_id, 22);

    // Sanity: protocol IDs are distinct.
    assert_ne!(
        MATRIX_PROTOCOL_ID, ACTIVITYPUB_PROTOCOL_ID,
        "Matrix and ActivityPub must NOT share a protocol ID — \
         routing depends on the dispatcher keying on distinct strings"
    );
}

// ---------------------------------------------------------------------------
// (3) Phase 6 follow-up criterion: a malformed envelope on the
//     ActivityPub protocol stream does not panic the dispatcher, does
//     not poison the swarm, and does not break subsequent well-formed
//     requests. The handler's loop drops the bad stream cleanly.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn activitypub_rejects_malformed_envelope() {
    let (mut transport_a, _peer_a, _addr_a) = spawn_transport("a-mal").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-mal").await;

    let mock = Arc::new(MockActivityPubApi::default());
    let handler = Arc::new(ActivityPubHandler::new(mock.clone()));
    transport_b.register_federation_handler(handler);

    let mut control_a = transport_a.stream_control();
    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A::dial(B) must enqueue");

    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    // Open a stream and write 4 bytes that decode to u32::MAX — the
    // handler must reject the envelope as "too large" (the
    // MalformedEnvelope error variant) and close the stream WITHOUT
    // taking the dispatcher down.
    let proto = StreamProtocol::new(ACTIVITYPUB_PROTOCOL_ID);
    let mut bad_stream = tokio::time::timeout(
        Duration::from_secs(10),
        control_a.open_stream(peer_b, proto.clone()),
    )
    .await
    .expect("bad stream open timed out")
    .expect("bad stream open errored");
    let bad_prefix = u32::MAX.to_be_bytes();
    bad_stream
        .write_all(&bad_prefix)
        .await
        .expect("write malformed length prefix");
    // Follow with some junk that the handler will never read (it bails
    // on the length-prefix sanity check before allocating).
    let junk = vec![0xAAu8; 100];
    let _ = bad_stream.write_all(&junk).await;
    let _ = bad_stream.flush().await;
    let _ = bad_stream.close().await;
    drop(bad_stream);

    // Now open a SECOND stream and send a well-formed Ping. The
    // dispatcher must still be alive — the malformed envelope cannot
    // be allowed to poison the protocol-ID listener task.
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        activitypub_request(
            &mut control_a,
            peer_b,
            ActivityPubRequest {
                activity_type: "Ping".to_string(),
                actor: "https://mastodon.example/@charlie".to_string(),
                object: serde_json::json!({}),
                request_id: 99,
            },
        ),
    )
    .await
    .expect("second activitypub round-trip timed out — handler may have died on malformed envelope")
    .expect("second activitypub round-trip errored");
    assert_eq!(response.request_id, 99);
    assert_eq!(
        response.accepted,
        Some(true),
        "post-malformed Ping response must be intact: {:?}",
        response
    );

    // Mock saw the well-formed dispatch exactly once. The malformed
    // envelope never reached `dispatch()` because the framing check
    // rejects it before we deserialize.
    let received = mock.received();
    assert_eq!(
        received.len(),
        1,
        "mock API must have received exactly the well-formed dispatch, got: {received:?}"
    );
    assert_eq!(received[0].request_id, 99);
    assert_eq!(received[0].activity_type, "Ping");
}
