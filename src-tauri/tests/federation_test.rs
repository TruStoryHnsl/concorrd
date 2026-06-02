//! Phase 6 (INS-019b) — integration tests for the protocol-agnostic
//! federation payload layer over libp2p streams.
//!
//! Each test maps 1:1 to a Phase 6 acceptance criterion. Written from a
//! cold-reader perspective per the project's MANDATORY testing rules:
//! every assertion is something an external observer can see (the mock
//! API received an envelope; the wire response decodes to the documented
//! heartbeat result; the swarm survives a malformed envelope on a stream
//! protocol it advertises).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_lib::servitude::federation::{
    matrix::matrix_request, FederationHandler, FederationProtocol, MatrixErrorBody,
    MatrixFederationApi, MatrixFederationHandler, MatrixRequest, MatrixResponse,
    PayloadKind, MATRIX_PROTOCOL_ID,
};
use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::p2p::{LibP2pTransport, SwarmEvent};
use async_trait::async_trait;
use futures::{AsyncReadExt, AsyncWriteExt, StreamExt};
use iota_stronghold::Stronghold;
use libp2p::{swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId, StreamProtocol};

/// Build an in-memory Stronghold + handle for tests. Mirrors the Phase 3
/// pattern in `p2p_test.rs`. Each call gets a unique client name so
/// concurrent tests don't collide.
fn fresh_handle(label: &str) -> (Stronghold, StrongholdHandle) {
    let stronghold = Stronghold::default();
    let client_name = format!("federation-test-{label}");
    let client = stronghold
        .create_client(client_name.as_bytes())
        .expect("create_client must succeed on a fresh Stronghold");
    let handle = StrongholdHandle::new(client);
    (stronghold, handle)
}

/// Records every dispatched request so tests can assert that the
/// inbound handler actually reached the API. Returns canned responses
/// keyed on `method`.
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

/// Test-only second handler with a DIFFERENT protocol ID. Records every
/// inbound stream so the routing test can assert traffic landed on the
/// right handler (and ONLY the right handler).
struct StubHandler {
    counter: Arc<Mutex<u32>>,
    protocol_id: &'static str,
}

#[async_trait]
impl FederationHandler for StubHandler {
    fn protocol_id(&self) -> &'static str {
        self.protocol_id
    }

    fn payload_kind(&self) -> PayloadKind {
        PayloadKind::Other("test-only")
    }

    async fn handle_inbound(
        &self,
        _peer_id: libp2p::PeerId,
        mut stream: libp2p::Stream,
    ) -> Result<(), app_lib::servitude::federation::FederationError> {
        *self.counter.lock().unwrap() += 1;
        // Drain the stream until EOF so the peer's `write_all` actually
        // completes. We don't care about the bytes.
        let mut sink = Vec::new();
        let _ = stream.read_to_end(&mut sink).await;
        Ok(())
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
    let mut transport = LibP2pTransport::new(&peer_identity, &handle, None)
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
// (1) Phase 6 criterion: an inbound stream on `MATRIX_PROTOCOL_ID` is
//     routed to the registered MatrixFederationHandler, dispatched into
//     the mock API, and the response round-trips back to the outbound
//     caller intact.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn federation_handler_dispatches_inbound_by_protocol_id() {
    let (mut transport_a, _peer_a, _addr_a) = spawn_transport("a-out").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-in").await;

    // Register the Matrix handler on B BEFORE run() consumes the transport.
    let mock = Arc::new(MockMatrixApi::default());
    let handler = Arc::new(MatrixFederationHandler::new(mock.clone()));
    transport_b.register_federation_handler(handler);

    // A's broadcast subscription stays attached across the run() handoff
    // — we don't actually need to observe A's events for this test, but
    // we keep B's event_tx so the FederationStreamOpened SwarmEvent can
    // be asserted.
    let b_event_rx = transport_b.subscribe();
    let mut control_a = transport_a.stream_control();

    // Make A dial B at its QUIC listen address so the swarm has a known
    // connection before we open a stream. `open_stream` will dial if
    // disconnected, but pre-dialing makes the test deterministic.
    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A::dial(B) must enqueue");

    // Spawn both run() loops. The stream-behaviour dispatch lives inside
    // them — `Control::open_stream` and `Control::accept` only make
    // progress while the swarms are being polled.
    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    // Open the outbound stream and round-trip the heartbeat envelope.
    let request = MatrixRequest {
        method: "federation.heartbeat".to_string(),
        params: serde_json::json!({}),
        request_id: 1,
    };
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        matrix_request(&mut control_a, peer_b, request.clone()),
    )
    .await
    .expect("matrix_request timed out — A could not reach B within 10s")
    .expect("matrix_request returned an error");

    assert_eq!(response.request_id, 1);
    assert_eq!(
        response.result,
        Some(serde_json::json!({ "alive": true })),
        "heartbeat response shape must be {{ alive: true }}, got: {:?}",
        response
    );
    assert!(
        response.error.is_none(),
        "heartbeat response must not carry an error field, got: {:?}",
        response.error
    );

    // Mock recorded the inbound dispatch.
    let received = mock.received();
    assert_eq!(
        received.len(),
        1,
        "mock API must have received exactly one dispatch, got: {received:?}"
    );
    assert_eq!(received[0].method, "federation.heartbeat");
    assert_eq!(received[0].request_id, 1);

    // B's swarm event surface published FederationStreamOpened.
    assert!(
        wait_for_federation_stream_event(b_event_rx, MATRIX_PROTOCOL_ID, Duration::from_secs(2))
            .await,
        "B must have emitted FederationStreamOpened for MATRIX_PROTOCOL_ID"
    );

    // Compile-time check: the trait split exposes MATRIX_PROTOCOL_ID at
    // both the const and the runtime accessor.
    assert_eq!(
        MatrixFederationHandler::PROTOCOL_ID,
        MATRIX_PROTOCOL_ID,
        "FederationProtocol::PROTOCOL_ID must match the module-level constant"
    );
}

// ---------------------------------------------------------------------------
// (2) Phase 6 criterion: streams are routed by `protocol_id()`, not by
//     handler-registration order or by payload sniffing. A handler
//     registered under `/concord/test-only/...` must NOT see Matrix
//     traffic, and vice versa.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn federation_routes_by_protocol_id_not_by_default() {
    const TEST_PROTOCOL_ID: &str = "/concord/test-only/1.0.0";

    let (mut transport_a, _peer_a, _addr_a) = spawn_transport("a-route").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-route").await;

    // Register BOTH handlers on B. Counters are kept alongside each
    // handler so the test can assert which one was invoked.
    let mock_matrix = Arc::new(MockMatrixApi::default());
    let matrix_handler = Arc::new(MatrixFederationHandler::new(mock_matrix.clone()));
    transport_b.register_federation_handler(matrix_handler);

    let stub_counter = Arc::new(Mutex::new(0u32));
    let stub_handler = Arc::new(StubHandler {
        counter: stub_counter.clone(),
        protocol_id: TEST_PROTOCOL_ID,
    });
    transport_b.register_federation_handler(stub_handler);

    let mut control_a = transport_a.stream_control();
    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A::dial(B) must enqueue");

    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    // (a) Send a Matrix envelope — must land on the Matrix handler ONLY.
    let response = tokio::time::timeout(
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
    assert_eq!(response.request_id, 11);

    // (b) Open a separate stream on TEST_PROTOCOL_ID — must land on the
    // stub handler ONLY.
    let proto = StreamProtocol::new(TEST_PROTOCOL_ID);
    let stub_stream = tokio::time::timeout(
        Duration::from_secs(10),
        control_a.open_stream(peer_b, proto),
    )
    .await
    .expect("stub stream open timed out")
    .expect("stub stream open errored");
    // Close the stream so the stub's read_to_end returns.
    drop(stub_stream);

    // Give the dispatcher a moment to deliver the stub stream.
    for _ in 0..50 {
        if *stub_counter.lock().unwrap() >= 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    assert_eq!(
        mock_matrix.received().len(),
        1,
        "Matrix handler must have seen exactly its one heartbeat, got: {:?}",
        mock_matrix.received()
    );
    assert_eq!(
        mock_matrix.received()[0].method,
        "federation.heartbeat",
        "Matrix handler must have received Matrix traffic only"
    );
    assert_eq!(
        *stub_counter.lock().unwrap(),
        1,
        "Stub handler must have seen exactly the one stream opened on \
         its protocol ID — got {:?} stream(s)",
        *stub_counter.lock().unwrap()
    );
}

// ---------------------------------------------------------------------------
// (3) Phase 6 criterion: a malformed envelope on the Matrix protocol
//     stream does not panic the dispatcher, does not poison the swarm,
//     and does not break subsequent well-formed requests. The handler's
//     loop drops the bad stream cleanly.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn federation_rejects_malformed_envelope() {
    let (mut transport_a, _peer_a, _addr_a) = spawn_transport("a-mal").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-mal").await;

    let mock = Arc::new(MockMatrixApi::default());
    let handler = Arc::new(MatrixFederationHandler::new(mock.clone()));
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
    let proto = StreamProtocol::new(MATRIX_PROTOCOL_ID);
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

    // Now open a SECOND stream and send a well-formed heartbeat. The
    // dispatcher must still be alive — the malformed envelope cannot
    // be allowed to poison the protocol-ID listener task.
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        matrix_request(
            &mut control_a,
            peer_b,
            MatrixRequest {
                method: "federation.heartbeat".to_string(),
                params: serde_json::json!({}),
                request_id: 99,
            },
        ),
    )
    .await
    .expect("second matrix round-trip timed out — handler may have died on malformed envelope")
    .expect("second matrix round-trip errored");
    assert_eq!(response.request_id, 99);
    assert_eq!(
        response.result,
        Some(serde_json::json!({ "alive": true })),
        "post-malformed heartbeat response must be intact: {:?}",
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
}
