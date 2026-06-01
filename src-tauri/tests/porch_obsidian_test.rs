//! Porch Phase D — Obsidian channel integration tests.
//!
//! Each test maps to a Phase D acceptance criterion. Like its
//! Phase A/B/C siblings, every assertion is written from a cold-reader
//! perspective: the SQLite row exists; the file lands on disk; the
//! visitor receives the bytes intact over libp2p; the path-traversal
//! gate fires before any leak is possible.
//!
//! The security-boundary tests (`path_traversal_rejected` and
//! `unsupported_mime_rejected`) are deliberately framed around the
//! observable failure mode — `PorchError::InvalidInput` — rather than
//! the implementation details of canonicalize() + prefix-check, so
//! refactors to the boundary don't silently weaken it.

use std::sync::Arc;
use std::time::Duration;

use app_lib::porch::{
    AclMode, AclRole, ChannelKind, ObsidianChannelConfig, Porch, PorchHandler, PorchRequest,
    VaultEntry,
};
use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::p2p::LibP2pTransport;
use futures::StreamExt;
use iota_stronghold::Stronghold;
use libp2p::{swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId};

// ---------------------------------------------------------------------------
// (1) set_config_canonicalizes_vault_root
// ---------------------------------------------------------------------------

#[test]
fn set_config_canonicalizes_vault_root() {
    let (porch, _tmp_porch, vault) = porch_with_vault();
    // Pass a non-canonical path with a redundant `.` segment; the
    // stored canonical form must be the absolute realpath.
    let mut twisty = vault.path().to_path_buf();
    twisty.push(".");
    let cfg = porch
        .set_obsidian_config("ob-1", &twisty, None, false)
        .expect("set ok");
    assert!(cfg.vault_root.is_absolute(), "must be absolute");
    let canonical = std::fs::canonicalize(vault.path()).expect("canon");
    assert_eq!(
        cfg.vault_root, canonical,
        "stored root must equal canonicalized form (without trailing /. )"
    );
}

// ---------------------------------------------------------------------------
// (2) set_config_rejects_nonexistent_vault
// ---------------------------------------------------------------------------

#[test]
fn set_config_rejects_nonexistent_vault() {
    let (porch, _tmp_porch, _vault) = porch_with_vault();
    let bogus = std::path::PathBuf::from("/tmp/does-not-exist-xyz-12345");
    let err = porch
        .set_obsidian_config("ob-1", &bogus, None, false)
        .expect_err("must reject nonexistent");
    assert!(
        err.to_string().contains("does not exist"),
        "error message must reference the missing path: {err}"
    );
}

// ---------------------------------------------------------------------------
// (3) list_vault_returns_sorted_entries
// ---------------------------------------------------------------------------

#[test]
fn list_vault_returns_sorted_entries() {
    let (porch, _tmp_porch, vault) = porch_with_vault();
    // Lay out: top-level "zeta.md", "alpha.md", "Notes/" (dir), "bravo/" (dir).
    std::fs::write(vault.path().join("zeta.md"), "z").unwrap();
    std::fs::write(vault.path().join("alpha.md"), "a").unwrap();
    std::fs::create_dir(vault.path().join("Notes")).unwrap();
    std::fs::create_dir(vault.path().join("bravo")).unwrap();
    porch
        .set_obsidian_config("ob-1", vault.path(), None, false)
        .expect("set ok");
    let entries = porch.list_vault("ob-1", "").expect("list ok");
    // Expected: dirs first (alphabetical, case-insensitive), then files.
    let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["bravo", "Notes", "alpha.md", "zeta.md"],
        "dirs first, then files; alphabetical (case-insensitive) within group"
    );
    assert!(matches!(
        entries[0].kind,
        app_lib::porch::EntryKind::Directory
    ));
    assert!(matches!(entries[2].kind, app_lib::porch::EntryKind::File));
    assert_eq!(entries[2].size, Some(1));
}

// ---------------------------------------------------------------------------
// (4) list_vault_filters_dotfiles
// ---------------------------------------------------------------------------

#[test]
fn list_vault_filters_dotfiles() {
    let (porch, _tmp_porch, vault) = porch_with_vault();
    // Obsidian's own config dir + a VCS dir + a real note.
    std::fs::create_dir(vault.path().join(".obsidian")).unwrap();
    std::fs::create_dir(vault.path().join(".git")).unwrap();
    std::fs::write(vault.path().join("note.md"), "# Hello").unwrap();
    porch
        .set_obsidian_config("ob-1", vault.path(), None, false)
        .expect("set ok");
    let entries = porch.list_vault("ob-1", "").expect("list ok");
    let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["note.md"],
        ".obsidian/ and .git/ must be filtered; note.md must remain"
    );
}

// ---------------------------------------------------------------------------
// (5) read_vault_file_returns_markdown_bytes_and_mime
// ---------------------------------------------------------------------------

#[test]
fn read_vault_file_returns_markdown_bytes_and_mime() {
    let (porch, _tmp_porch, vault) = porch_with_vault();
    let body = "# Welcome\n\nThis is a markdown note.\n";
    std::fs::write(vault.path().join("welcome.md"), body).unwrap();
    porch
        .set_obsidian_config("ob-1", vault.path(), None, false)
        .expect("set ok");
    let (bytes, mime) = porch
        .read_vault_file("ob-1", "welcome.md")
        .expect("read ok");
    assert_eq!(
        std::str::from_utf8(&bytes).expect("utf8"),
        body,
        "bytes must match exactly"
    );
    assert_eq!(mime, "text/markdown");
}

// ---------------------------------------------------------------------------
// (6) path_traversal_rejected
//     This is the CVE-class regression gate. If this test starts to
//     pass `../` as a legitimate path, ship the binary as a zero-day.
// ---------------------------------------------------------------------------

#[test]
fn path_traversal_rejected() {
    let (porch, _tmp_porch, vault) = porch_with_vault();
    std::fs::write(vault.path().join("legit.md"), "hi").unwrap();
    porch
        .set_obsidian_config("ob-1", vault.path(), None, false)
        .expect("set ok");

    // list_vault("../etc") — must reject.
    let err = porch
        .list_vault("ob-1", "../etc")
        .expect_err("traversal must reject");
    assert!(
        matches!(err, app_lib::porch::PorchError::InvalidInput(_)),
        "expected InvalidInput, got {err:?}"
    );

    // list_vault("../../etc") — must reject.
    let err = porch
        .list_vault("ob-1", "../../etc")
        .expect_err("deep traversal must reject");
    assert!(matches!(
        err,
        app_lib::porch::PorchError::InvalidInput(_)
    ));

    // read_vault_file("../../etc/passwd") — must reject.
    let err = porch
        .read_vault_file("ob-1", "../../etc/passwd")
        .expect_err("read traversal must reject");
    assert!(matches!(
        err,
        app_lib::porch::PorchError::InvalidInput(_)
    ));

    // Even a single `..` followed by a legit leaf must reject.
    let err = porch
        .read_vault_file("ob-1", "../legit.md")
        .expect_err("../leaf must reject");
    assert!(matches!(
        err,
        app_lib::porch::PorchError::InvalidInput(_)
    ));
}

// ---------------------------------------------------------------------------
// (7) unsupported_mime_rejected
// ---------------------------------------------------------------------------

#[test]
fn unsupported_mime_rejected() {
    let (porch, _tmp_porch, vault) = porch_with_vault();
    std::fs::write(vault.path().join("not-safe.exe"), b"MZ\x90\x00").unwrap();
    porch
        .set_obsidian_config("ob-1", vault.path(), None, false)
        .expect("set ok");
    let err = porch
        .read_vault_file("ob-1", "not-safe.exe")
        .expect_err("unsupported mime must reject");
    let msg = err.to_string();
    assert!(
        matches!(err, app_lib::porch::PorchError::InvalidInput(_)),
        "expected InvalidInput, got {err:?}"
    );
    assert!(
        msg.contains("unsupported file type"),
        "error must reference unsupported file type: {msg}"
    );
}

// ---------------------------------------------------------------------------
// (8) obsidian_list_round_trip_over_libp2p
//     Two-swarm test: B hosts an obsidian-bound inner channel; A is a
//     member; A sends ListVault via libp2p and receives the entries.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn obsidian_list_round_trip_over_libp2p() {
    let (mut transport_a, peer_a, _addr_a) = spawn_transport("a-ob-out").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-ob-in").await;

    let tmp_b = tempdir_for_test("b-ob");
    let porch_b = Arc::new(Porch::open(&tmp_b).expect("porch open ok"));
    porch_b
        .insert_channel(
            "campaign-room",
            "Campaign Vault",
            ChannelKind::Obsidian,
            AclMode::Allowlist,
        )
        .expect("insert ok");

    // Lay out a vault on B with a couple of notes + a hidden config.
    let tmp_vault = tempdir_for_test("b-vault");
    std::fs::write(tmp_vault.join("readme.md"), "# Campaign").unwrap();
    std::fs::create_dir(tmp_vault.join("history")).unwrap();
    std::fs::write(tmp_vault.join("history/founding.md"), "ancient")
        .unwrap();
    std::fs::create_dir(tmp_vault.join(".obsidian")).unwrap();
    std::fs::write(tmp_vault.join(".obsidian/workspace.json"), "{}").unwrap();
    porch_b
        .set_obsidian_config("campaign-room", &tmp_vault, None, false)
        .expect("bind ok");

    // Grant A `member` so the ACL gate passes.
    porch_b
        .grant_acl("campaign-room", &peer_a.to_base58(), AclRole::Member)
        .expect("grant ok");

    let handler = Arc::new(PorchHandler::new(porch_b.clone()));
    transport_b.register_federation_handler(handler);

    let mut control_a = transport_a.stream_control();
    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A::dial(B) must enqueue");
    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    let entries: Vec<VaultEntry> = tokio::time::timeout(
        Duration::from_secs(10),
        app_lib::porch::visit_list_vault(
            &mut control_a,
            peer_b,
            "campaign-room".to_string(),
            "".to_string(),
        ),
    )
    .await
    .expect("visit_list_vault timed out")
    .expect("visit_list_vault err");

    let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["history", "readme.md"],
        "dotfile must stay hidden, dir before file"
    );
}

// ---------------------------------------------------------------------------
// (9) wire_handler_rejects_visitor_without_access — confirms the
//     ACL gate fires for ListVault. This belongs in the same security
//     audit as path traversal: a visitor without member ACL must get
//     403, not the entries.
// ---------------------------------------------------------------------------

#[test]
fn wire_handler_rejects_visitor_without_access() {
    let (porch, _tmp_porch, vault) = porch_with_vault();
    std::fs::write(vault.path().join("hello.md"), "hi").unwrap();
    porch
        .set_obsidian_config("ob-1", vault.path(), None, false)
        .expect("set ok");

    let handler = PorchHandler::new(Arc::new(porch));
    let denied = fake_peer_id();
    let response = handler.dispatch(
        denied,
        PorchRequest::ListVault {
            channel_id: "ob-1".to_string(),
            path: String::new(),
        },
    );
    assert!(!response.ok, "no-ACL visitor must be denied");
    let err = response.error.expect("error body");
    assert_eq!(err.code, 403, "ACL gate must surface 403");
}

// ---------------------------------------------------------------------------
// (10) get_obsidian_config_round_trip — set + fetch round trip
//      preserves the canonical form across DB persistence.
// ---------------------------------------------------------------------------

#[test]
fn get_obsidian_config_round_trip() {
    let (porch, _tmp_porch, vault) = porch_with_vault();
    let cfg = porch
        .set_obsidian_config("ob-1", vault.path(), None, false)
        .expect("set ok");
    let fetched: ObsidianChannelConfig = porch
        .get_obsidian_config("ob-1")
        .expect("get ok")
        .expect("must exist");
    assert_eq!(fetched.vault_root, cfg.vault_root);
    assert_eq!(fetched.subfolder, None);
    assert!(!fetched.follow_symlinks);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn porch_with_vault() -> (Porch, tempfile::TempDir, tempfile::TempDir) {
    let tmp_porch = tempfile::tempdir().expect("tmp porch");
    let porch = Porch::open(tmp_porch.path()).expect("porch open ok");
    porch
        .insert_channel("ob-1", "Vault", ChannelKind::Obsidian, AclMode::Allowlist)
        .expect("insert channel ok");
    let tmp_vault = tempfile::tempdir().expect("tmp vault");
    (porch, tmp_porch, tmp_vault)
}

fn tempdir_for_test(label: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    p.push(format!("concord-porch-obsidian-test-{label}-{nanos}"));
    std::fs::create_dir_all(&p).expect("mkdir tmp");
    p
}

fn fake_peer_id() -> PeerId {
    let keypair = libp2p::identity::Keypair::generate_ed25519();
    PeerId::from(keypair.public())
}

async fn spawn_transport(label: &str) -> (LibP2pTransport, PeerId, Multiaddr) {
    let stronghold = Stronghold::default();
    let client_name = format!("porch-obsidian-test-{label}");
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
