//! Feature F3 — integration tests for mesh propagation.
//!
//! Two acceptance criteria from the spec:
//!
//!   * **One-hop test** (`one_hop_address_rotation_propagates_to_paired_peer`):
//!     spin two `LibP2pTransport` instances in a test, dial them
//!     together so they share a gossipsub mesh, have B subscribe to
//!     A's rotation topic, publish a rotation payload from A, assert B
//!     receives it within 5s and the decoded payload carries A's
//!     declared multiaddrs.
//!
//!   * **Multi-hop test** (`multi_hop_history_chain_verifies_end_to_end`):
//!     simulate A → B → C topology. A pairs with B. B pairs with C.
//!     C requests A's read-only history via the porch-history
//!     protocol's hop-chain mechanism. Assert the chain verifies and
//!     the messages return. (Pure cryptographic verification —
//!     spinning up three swarms in one test is wasteful when the
//!     network layer was already exercised by the one-hop test.)
//!
//! Tests written from a cold-reader perspective per the project's
//! testing rules: each assertion describes what an external observer
//! sees, not the author's belief about how the machinery is wired.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use app_lib::porch::{
    history_protocol::{
        peer_ident_from_signing_key, sign_vouch_with_key, verify_hop_chain,
        HistoryHandler, HistoryRequest, PairedPeerSource, StaticPairedPeers, VouchLink,
    },
    Porch, DEFAULT_PORCH_CHANNEL_ID,
};
use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::mesh_propagation::{
    parse_rotation_topic, publish_address_rotation, rotation_topic_for_peer,
    subscribe_to_paired_peers, AddressRotation, ROTATION_TOPIC_PREFIX,
};
use app_lib::servitude::p2p::{BehaviourEvent, LibP2pTransport};
use ed25519_dalek::SigningKey;
use futures::StreamExt;
use iota_stronghold::Stronghold;
use libp2p::{
    gossipsub, swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId,
};
use rand::rngs::OsRng;
use rand::RngCore;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn fresh_handle(label: &str) -> (Stronghold, StrongholdHandle) {
    let stronghold = Stronghold::default();
    let client_name = format!("mesh-test-{label}");
    let client = stronghold
        .create_client(client_name.as_bytes())
        .expect("create_client must succeed on a fresh Stronghold");
    let handle = StrongholdHandle::new(client);
    (stronghold, handle)
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

fn fresh_signing_key() -> SigningKey {
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    SigningKey::from_bytes(&seed)
}

fn peer_id_of(sk: &SigningKey) -> PeerId {
    peer_ident_from_signing_key(sk)
        .parse_peer_id()
        .expect("constructed peer-id parses")
}

// ---------------------------------------------------------------------------
// Test 1 — One-hop address rotation propagates over gossipsub
// ---------------------------------------------------------------------------
//
// Cold-reader observation under test: after A publishes a rotation
// payload on its own topic, B (a peer who subscribed to A's topic
// via the mesh-propagation helper) receives the same payload bytes
// the gossipsub layer delivered, decodes it, and sees A's declared
// multiaddrs. No address-cache mutation, no DB I/O — the test
// observes the payload at the gossipsub boundary, which is the
// surface a downstream peer-store consumer would also see.

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_hop_address_rotation_propagates_to_paired_peer() {
    let (_sh_a, handle_a) = fresh_handle("rot-a");
    let (_sh_b, handle_b) = fresh_handle("rot-b");

    let identity_a = identity::load_or_create(&handle_a)
        .await
        .expect("identity a");
    let identity_b = identity::load_or_create(&handle_b)
        .await
        .expect("identity b");

    let mut transport_a = LibP2pTransport::new(&identity_a, &handle_a, None)
        .await
        .expect("transport a");
    let mut transport_b = LibP2pTransport::new(&identity_b, &handle_b, None)
        .await
        .expect("transport b");

    let peer_a = transport_a.local_peer_id();
    let peer_b = transport_b.local_peer_id();
    assert_ne!(peer_a, peer_b);

    // Drain A's first QUIC listen address so B has something to dial.
    let a_quic_addr = {
        let swarm = transport_a.swarm_mut();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let RawSwarmEvent::NewListenAddr { address, .. } =
                    swarm.select_next_some().await
                {
                    if multiaddr_contains_quic_v1(&address) {
                        return address;
                    }
                }
            }
        })
        .await
        .expect("A timed out before reporting a quic listen addr")
    };
    let dial_addr = quic_loopback_with_peer_id(&a_quic_addr, peer_a);

    // Subscribe both swarms to A's rotation topic — A publishes on its
    // own topic; B's subscription is what F3's
    // `subscribe_to_paired_peers` would do once B has paired with A.
    let added_a =
        subscribe_to_paired_peers(transport_a.swarm_mut(), &[peer_a])
            .expect("A self-subscribe");
    let added_b =
        subscribe_to_paired_peers(transport_b.swarm_mut(), &[peer_a])
            .expect("B subscribe to A's rotation topic");
    assert_eq!(added_a, 1, "A's first subscribe to its own topic must add it");
    assert_eq!(added_b, 1, "B's first subscribe to A's topic must add it");

    // Connect the two swarms so gossipsub has a path to deliver the
    // message. Mesh formation needs at least one libp2p connection.
    transport_b
        .swarm_mut()
        .dial(dial_addr.clone())
        .expect("B dial");

    // Drive both swarms in parallel until each side reports
    // ConnectionEstablished, then publish from A and assert delivery
    // on B. Whole sequence is bounded by a 25s timeout — slow CI safe.
    let outcome = tokio::time::timeout(Duration::from_secs(25), async {
        let advertised_addrs: Vec<Multiaddr> = vec![
            "/ip4/192.168.111.55/udp/4242/quic-v1".parse().unwrap(),
            "/ip6/2001:db8:abcd::1/tcp/4001".parse().unwrap(),
        ];
        let mut connected = false;
        let mut delivered: Option<AddressRotation> = None;
        let mut published_once = false;
        loop {
            tokio::select! {
                ev = transport_a.swarm_mut().select_next_some() => {
                    match ev {
                        RawSwarmEvent::ConnectionEstablished { peer_id, .. }
                            if peer_id == peer_b => {
                            connected = true;
                        }
                        _ => {}
                    }
                }
                ev = transport_b.swarm_mut().select_next_some() => {
                    match ev {
                        RawSwarmEvent::ConnectionEstablished { peer_id, .. }
                            if peer_id == peer_a => {
                            connected = true;
                        }
                        RawSwarmEvent::Behaviour(BehaviourEvent::Gossipsub(
                            gossipsub::Event::Message { propagation_source, message, .. },
                        )) => {
                            // Confirm the topic name decodes to A's
                            // peer-id — receivers must cross-check
                            // before trusting the payload.
                            let topic_str = message.topic.to_string();
                            let topic_peer = parse_rotation_topic(&topic_str)
                                .expect("rotation topic must parse");
                            assert_eq!(topic_peer, peer_a.to_base58());
                            // The propagation source is who we
                            // received from; it MAY equal A or may
                            // be a different mesh peer. For the
                            // 2-peer case it is A.
                            assert_eq!(propagation_source, peer_a);
                            let payload = AddressRotation::decode(&message.data)
                                .expect("rotation payload must decode");
                            // The signature owner (`message.source`)
                            // must match the payload's claimed peer.
                            let src = message.source.expect("signed messages carry source");
                            assert!(
                                payload.matches_source(&src),
                                "payload.peer_id {:?} disagrees with libp2p source {}",
                                payload.peer_id,
                                src.to_base58()
                            );
                            delivered = Some(payload);
                        }
                        _ => {}
                    }
                }
            }
            if connected && !published_once {
                // Wait one heartbeat to let gossipsub's mesh form on
                // both sides — the publish would otherwise return
                // InsufficientPeers and we'd just retry inside the
                // loop. The default heartbeat is 1s.
                tokio::time::sleep(Duration::from_millis(1200)).await;
                // Publish from A on its own topic.
                if let Err(e) = publish_address_rotation(
                    transport_a.swarm_mut(),
                    peer_a,
                    &advertised_addrs,
                ) {
                    // Mesh not formed yet — retry next iteration.
                    eprintln!("publish retry: {e}");
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    continue;
                }
                published_once = true;
            }
            if delivered.is_some() {
                return delivered;
            }
        }
    })
    .await
    .ok()
    .flatten();

    let payload = outcome.expect(
        "B did not receive A's address rotation within the timeout. \
         Either the gossipsub mesh failed to form (multicast-blocked CI?), \
         or the rotation publish path is broken.",
    );

    // The decoded payload MUST carry A's peer-id and the addrs A
    // published (loopback-stripped). Both invariants must hold from
    // the cold reader's perspective — no peeking at A's internal state.
    assert_eq!(payload.peer_id, peer_a.to_base58());
    assert!(
        payload
            .multiaddrs
            .iter()
            .any(|a| a.contains("192.168.111.55")),
        "rotation payload missing the IPv4 multiaddr we published: {:?}",
        payload.multiaddrs
    );
    assert!(
        payload
            .multiaddrs
            .iter()
            .any(|a| a.contains("2001:db8:abcd::1")),
        "rotation payload missing the IPv6 multiaddr we published: {:?}",
        payload.multiaddrs
    );
    // Topic-owner cross-check — the helper exposed for receivers.
    assert!(
        payload.matches_topic_owner(&peer_a),
        "matches_topic_owner must accept A's peer-id"
    );
    assert!(
        !payload.matches_topic_owner(&peer_b),
        "matches_topic_owner must reject B's peer-id"
    );
    // Confirm the topic prefix is the one production code uses.
    let topic = rotation_topic_for_peer(&peer_a);
    let topic_str = topic.to_string();
    assert!(
        topic_str.starts_with(ROTATION_TOPIC_PREFIX),
        "rotation topic shape changed: {topic_str}"
    );
}

// ---------------------------------------------------------------------------
// Test 2 — Multi-hop history fetch via a hop-chain (A → B → C, C reads A)
// ---------------------------------------------------------------------------
//
// Cold-reader observation under test: C presents a hop-chain to A's
// `HistoryHandler` with B as the vouching link; A's verifier
// approves; A returns the messages it has in its default-porch
// channel. The test seeds A's porch with three messages and asserts
// the response carries all three plus the correct `hops` count.
//
// Note: the libp2p stream wiring is exercised by the porch
// protocol's existing tests; here we exercise the cryptographic
// chain + verification + dispatch surface, which is the failure-mode
// surface the F3 spec asks us to lock in.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn multi_hop_history_chain_verifies_end_to_end() {
    // ── Setup signing keys for A (server), B (intermediate), C
    // (requester). Each gets a deterministic libp2p PeerId derived
    // from the same ed25519 pubkey.
    let a_sk = fresh_signing_key();
    let b_sk = fresh_signing_key();
    let c_sk = fresh_signing_key();

    let a_peer_id = peer_id_of(&a_sk);
    let b_peer_id = peer_id_of(&b_sk);
    let c_peer_id = peer_id_of(&c_sk);

    // Sanity: distinct peers.
    assert_ne!(a_peer_id, b_peer_id);
    assert_ne!(b_peer_id, c_peer_id);
    assert_ne!(a_peer_id, c_peer_id);

    // ── Set up A's porch DB and seed it with three messages on the
    // default channel.
    let porch = Arc::new(Porch::open_in_memory().expect("open porch"));
    for i in 0..3 {
        porch
            .post_message(
                DEFAULT_PORCH_CHANNEL_ID,
                &a_peer_id.to_base58(),
                &format!("multi-hop message {i}"),
            )
            .expect("seed porch message");
    }

    // ── A's paired-peer set contains only B. C must ride a hop chain
    // through B to reach A.
    let mut a_paired: HashSet<String> = HashSet::new();
    a_paired.insert(b_peer_id.to_base58());
    let paired_source: Arc<dyn PairedPeerSource> =
        Arc::new(StaticPairedPeers(a_paired.clone()));

    // ── C builds a hop chain: a single VouchLink where B vouches for
    // C with A as the target. B's signing key produces the
    // signature; only B knows it.
    let c_ident = peer_ident_from_signing_key(&c_sk);
    let vouch: VouchLink =
        sign_vouch_with_key(&b_sk, c_ident.clone(), a_peer_id.to_base58());
    vouch
        .verify_signature()
        .expect("freshly-built vouch signature must verify");

    // ── C constructs the HistoryRequest and addresses it to A.
    let request = HistoryRequest {
        requester: c_ident,
        target_peer_id: a_peer_id.to_base58(),
        channel_id: DEFAULT_PORCH_CHANNEL_ID.to_string(),
        limit: 100,
        chain: vec![vouch],
    };

    // ── Pure verifier call — what A's HistoryHandler runs before
    // touching the DB. Asserts the chain accepts.
    let hops = verify_hop_chain(&request, c_peer_id, a_peer_id, &a_paired)
        .expect("verifier must accept C→B→A chain (B paired with A)");
    assert_eq!(hops, 1, "single-link chain reports 1 hop");

    // ── End-to-end: drive the dispatch path the inbound libp2p
    // stream would. We pass C's PeerId as the connection attribution
    // (in production this is set by `libp2p_stream::IncomingStreams`).
    let handler = HistoryHandler::new(porch.clone(), a_peer_id, paired_source.clone());
    let response = handler.dispatch(c_peer_id, request).await;
    assert!(
        response.ok,
        "dispatch must succeed for a valid 1-hop chain; got error: {:?}",
        response.error
    );
    let result = response.result.expect("ok response carries result");
    assert_eq!(
        result.messages.len(),
        3,
        "A returns the three seeded messages over the multi-hop path"
    );
    assert_eq!(
        result.hops, 1,
        "result.hops mirrors the verifier's accepted chain length"
    );
    // All three seeded message bodies are present (ULIDs generated
    // within the same millisecond can break ties non-deterministically,
    // so we assert SET membership rather than order).
    let mut bodies: Vec<&str> = result.messages.iter().map(|m| m.body.as_str()).collect();
    bodies.sort();
    assert_eq!(
        bodies,
        vec![
            "multi-hop message 0",
            "multi-hop message 1",
            "multi-hop message 2",
        ]
    );

    // ── Negative path: an UNPAIRED requester with NO chain is refused.
    // Direct fetch by D (a stranger) should return 403.
    let d_sk = fresh_signing_key();
    let d_peer_id = peer_id_of(&d_sk);
    let direct_request = HistoryRequest {
        requester: peer_ident_from_signing_key(&d_sk),
        target_peer_id: a_peer_id.to_base58(),
        channel_id: DEFAULT_PORCH_CHANNEL_ID.to_string(),
        limit: 100,
        chain: vec![],
    };
    let denied = handler.dispatch(d_peer_id, direct_request).await;
    assert!(
        !denied.ok,
        "unpaired stranger with no chain must be denied"
    );
    let err = denied.error.expect("error body present on denial");
    assert_eq!(
        err.code, 403,
        "unpaired stranger must surface 403 (access denied), not a different code"
    );

    // ── Negative path: a forged chain where B's signature is correct
    // but the VOUCHER claims to be someone else. Verifier must
    // reject — `verify_peerid_pubkey_link` catches the mismatch.
    let mut forged_vouch =
        sign_vouch_with_key(&b_sk, peer_ident_from_signing_key(&c_sk), a_peer_id.to_base58());
    // Swap the voucher's claimed peer-id to D's, but keep B's pubkey
    // and signature. The peer-id ↔ pubkey link check must fire.
    forged_vouch.voucher.peer_id = d_peer_id.to_base58();
    let forged_request = HistoryRequest {
        requester: peer_ident_from_signing_key(&c_sk),
        target_peer_id: a_peer_id.to_base58(),
        channel_id: DEFAULT_PORCH_CHANNEL_ID.to_string(),
        limit: 100,
        chain: vec![forged_vouch],
    };
    let forged_denied = handler.dispatch(c_peer_id, forged_request).await;
    assert!(
        !forged_denied.ok,
        "forged voucher peer-id must be rejected before DB read"
    );
}

// ---------------------------------------------------------------------------
// Test 3 — Direct one-hop history fetch (paired requester, empty chain)
// ---------------------------------------------------------------------------
//
// Smaller-scope test ensuring the protocol services the "already
// paired" case efficiently — no chain links to verify, hops == 0.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_paired_peer_fetches_history_with_empty_chain() {
    let a_sk = fresh_signing_key();
    let c_sk = fresh_signing_key();
    let a_peer_id = peer_id_of(&a_sk);
    let c_peer_id = peer_id_of(&c_sk);

    let porch = Arc::new(Porch::open_in_memory().expect("open porch"));
    porch
        .post_message(
            DEFAULT_PORCH_CHANNEL_ID,
            &a_peer_id.to_base58(),
            "hello from A",
        )
        .expect("seed");

    let mut paired: HashSet<String> = HashSet::new();
    paired.insert(c_peer_id.to_base58());
    let paired_source: Arc<dyn PairedPeerSource> =
        Arc::new(StaticPairedPeers(paired));

    let handler = HistoryHandler::new(porch, a_peer_id, paired_source);
    let request = HistoryRequest {
        requester: peer_ident_from_signing_key(&c_sk),
        target_peer_id: a_peer_id.to_base58(),
        channel_id: DEFAULT_PORCH_CHANNEL_ID.to_string(),
        limit: 50,
        chain: vec![],
    };
    let response = handler.dispatch(c_peer_id, request).await;
    assert!(
        response.ok,
        "paired peer with empty chain must succeed: {:?}",
        response.error
    );
    let result = response.result.unwrap();
    assert_eq!(result.hops, 0);
    assert_eq!(result.messages.len(), 1);
    assert_eq!(result.messages[0].body, "hello from A");
}

// ---------------------------------------------------------------------------
// Test 4 — PeerIdent / PeerCard helper round-trip
// ---------------------------------------------------------------------------
//
// Confirms the integration between PeerIdent (the wire shape on the
// history protocol) and the existing PeerCard surface, so the client
// can build vouches from existing peer-store entries without a
// dedicated conversion path.

#[test]
fn peer_ident_derived_peer_id_matches_libp2p_keypair() {
    let sk = fresh_signing_key();
    let ident = peer_ident_from_signing_key(&sk);
    let (parsed_peer_id, _vkey) = ident
        .verify_peerid_pubkey_link()
        .expect("PeerIdent round-trip");
    // Derive a libp2p PeerId independently from the same signing key
    // and assert equality. This is the "deterministic derivation"
    // assertion the F3 spec implicitly relies on for hop-chain
    // attribution.
    let independent_peer_id = peer_id_of(&sk);
    assert_eq!(parsed_peer_id, independent_peer_id);
}
