//! Concord P2P proof-of-concept.
//!
//! Demonstrates local mDNS discovery + WireGuard tunnel connectivity
//! with interactive GossipSub chat.
//!
//! Usage:
//!   cargo run -p concord-poc
//!   cargo run -p concord-poc -- --peer 12D3KooW...

use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use tokio::io::AsyncBufReadExt;
use tracing::info;

use concord_core::config::NodeConfig;
use concord_core::identity::Keypair;
use concord_core::types::NodeType;
use concord_net::node::Node;
use concord_net::wireguard;
use concord_net::NetworkEvent;
use concord_store::Database;

#[derive(Parser)]
#[command(name = "concord-poc", about = "Concord P2P proof-of-concept")]
struct Cli {
    /// Display name for this node
    #[arg(short, long, default_value_t = hostname_or_default())]
    name: String,

    /// QUIC listen port
    #[arg(short, long, default_value_t = 4001)]
    port: u16,

    /// Data directory for persistent identity
    #[arg(short, long, default_value = "~/.local/share/concord-poc")]
    data_dir: String,

    /// GossipSub topic to join
    #[arg(short, long, default_value = "concord/poc/chat")]
    topic: String,

    /// Known remote libp2p PeerIDs for WireGuard dialing.
    /// Run once to see your PeerId, then share it with the other node.
    #[arg(long)]
    peer: Vec<String>,

    /// Disable WireGuard mesh detection
    #[arg(long)]
    no_wireguard: bool,
}

/// Derive the libp2p PeerId string from a 32-byte Ed25519 secret key.
/// This replicates the same conversion that concord-net/swarm.rs does internally.
fn derive_libp2p_peer_id(secret_bytes: &[u8; 32]) -> String {
    let mut bytes = *secret_bytes;
    let ed_secret = libp2p::identity::ed25519::SecretKey::try_from_bytes(&mut bytes)
        .expect("valid ed25519 key");
    let ed_kp = libp2p::identity::ed25519::Keypair::from(ed_secret);
    let kp = libp2p::identity::Keypair::from(ed_kp);
    libp2p::PeerId::from(kp.public()).to_string()
}

fn resolve_data_dir(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(raw)
}

fn hostname_or_default() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "concord-poc".into())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "concord_poc=info,concord_net=info".into()),
        )
        .init();

    // ── Identity ──────────────────────────────────────────────────
    let data_dir = resolve_data_dir(&cli.data_dir);
    std::fs::create_dir_all(&data_dir)?;

    let db = Database::open(data_dir.join("poc.db"))?;
    let keypair = match db.load_identity()? {
        Some((_name, kp)) => {
            info!("loaded existing identity");
            kp
        }
        None => {
            let kp = Keypair::generate();
            db.save_identity(&cli.name, &kp)?;
            info!("generated new identity");
            kp
        }
    };
    let secret_bytes = keypair.to_bytes();
    let libp2p_id = derive_libp2p_peer_id(&secret_bytes);

    // ── WireGuard detection ───────────────────────────────────────
    let wg = if cli.no_wireguard {
        None
    } else {
        let status = wireguard::detect_wireguard_mesh();
        if status.is_active {
            Some(status)
        } else {
            None
        }
    };

    // ── Banner ────────────────────────────────────────────────────
    println!();
    println!("  Concord PoC — {}", cli.name);
    println!("  ─────────────────────────────────────");
    println!("  PeerId: {libp2p_id}");
    println!("  QUIC:   0.0.0.0:{}", cli.port);
    if let Some(ref wg) = wg {
        let ip = wg.mesh_ip.map(|ip| ip.to_string()).unwrap_or("?".into());
        let host = wg.mesh_hostname.as_deref().unwrap_or("?");
        let online = wg.mesh_peers.iter().filter(|p| p.online).count();
        println!("  WG:     {host} / {ip} ({online} peers online)");
    } else {
        println!("  WG:     inactive");
    }
    println!("  Topic:  {}", cli.topic);
    println!("  ─────────────────────────────────────");
    println!();

    // ── Start node ────────────────────────────────────────────────
    let config = NodeConfig {
        display_name: cli.name.clone(),
        node_type: NodeType::User,
        listen_port: cli.port,
        enable_mdns: true,
        enable_dht: true,
        data_dir: data_dir.clone(),
        bootstrap_peers: Vec::new(),
        enable_relay_server: false,
        enable_relay_client: true,
        identity_keypair: Some(secret_bytes),
    };

    let (node, handle, _event_tx, events) = Node::new(&config).await?;
    let node_task = tokio::spawn(async move { node.run().await });

    // Let swarm start listening before subscribing
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    handle.subscribe(&cli.topic).await?;
    println!("[info] subscribed to {}", cli.topic);

    // ── Dial WireGuard peers ──────────────────────────────────────
    if let Some(ref wg) = wg {
        let online: Vec<_> = wg.mesh_peers.iter().filter(|p| p.online).collect();
        if online.is_empty() {
            println!("[wg] no online mesh peers");
        } else if cli.peer.is_empty() {
            println!("[wg] {} online peers (pass --peer <PeerId> to dial):", online.len());
            for p in &online {
                println!("[wg]   {} ({}) → /ip4/{}/udp/{}/quic-v1", p.hostname, p.ip, p.ip, cli.port);
            }
        } else {
            let addrs: Vec<String> = online
                .iter()
                .map(|p| wireguard::peer_to_multiaddr(p, cli.port))
                .collect();
            for peer_id in &cli.peer {
                let short = if peer_id.len() > 16 { &peer_id[..16] } else { peer_id };
                println!("[wg] dialing {short}... ({} addrs)", addrs.len());
                if let Err(e) = handle.dial_peer(peer_id, &addrs).await {
                    eprintln!("[wg] dial failed: {e}");
                }
            }
        }
    }

    // ── Event display task ────────────────────────────────────────
    let chat_topic = cli.topic.clone();
    let display_name = cli.name.clone();
    let event_chat_topic = chat_topic.clone();
    let event_display_name = display_name.clone();
    let event_task = tokio::spawn(async move {
        let mut events = events;
        loop {
            match events.recv().await {
                Ok(event) => print_event(&event, &event_chat_topic, &event_display_name),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("[warn] dropped {n} events");
                }
                Err(_) => break,
            }
        }
    });

    // ── Interactive chat ──────────────────────────────────────────
    let stdin = tokio::io::BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    println!("[chat] type a message and press Enter (Ctrl+C to quit)\n");

    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(text)) if !text.is_empty() => {
                        // Prefix with our name so recipients know who sent it
                        let payload = format!("{}: {}", display_name, text);
                        if let Err(e) = handle.publish(&chat_topic, payload.into_bytes()).await {
                            eprintln!("[error] publish: {e}");
                        }
                    }
                    Ok(None) => break,
                    _ => {}
                }
            }
            _ = tokio::signal::ctrl_c() => {
                println!("\n[info] shutting down...");
                break;
            }
        }
    }

    // ── Shutdown ──────────────────────────────────────────────────
    handle.shutdown().await?;
    event_task.abort();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), node_task).await;
    Ok(())
}

fn print_event(event: &NetworkEvent, chat_topic: &str, _our_name: &str) {
    match event {
        NetworkEvent::PeerDiscovered {
            peer_id, addresses, ..
        } => {
            let short = if peer_id.len() > 16 { &peer_id[..16] } else { peer_id };
            let addr = addresses.first().map(|a| a.as_str()).unwrap_or("?");
            println!("[peer+] {short}... at {addr}");
        }
        NetworkEvent::PeerDeparted { peer_id } => {
            let short = if peer_id.len() > 16 { &peer_id[..16] } else { peer_id };
            println!("[peer-] {short}...");
        }
        NetworkEvent::TunnelEstablished {
            peer_id,
            connection_type,
            address,
        } => {
            let short = if peer_id.len() > 16 { &peer_id[..16] } else { peer_id };
            println!("[tunnel+] {short}... via {connection_type} ({address})");
        }
        NetworkEvent::TunnelClosed { peer_id } => {
            let short = if peer_id.len() > 16 { &peer_id[..16] } else { peer_id };
            println!("[tunnel-] {short}...");
        }
        NetworkEvent::MessageReceived {
            topic, data, ..
        } if topic == chat_topic => {
            let text = String::from_utf8_lossy(data);
            println!("{text}");
        }
        NetworkEvent::ConnectionStatusChanged { connected_peers } => {
            println!("[net] {connected_peers} peers connected");
        }
        _ => {}
    }
}
