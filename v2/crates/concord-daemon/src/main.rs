mod admin;
mod config;

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use concord_core::identity::Keypair;
use concord_core::types::{Channel, ChannelType, Server, Visibility};
use concord_net::node::Node;
use concord_store::Database;
use concord_webhost::{WebhostConfig, WebhostServer};

use config::DaemonConfig;

#[derive(Parser)]
#[command(name = "concord-server", version, about = "Concord headless backbone node")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the Concord server daemon.
    Start {
        /// Path to configuration file.
        #[arg(short, long, default_value = "concord-server.toml")]
        config: String,
    },
    /// Initialize a new Concord server with default config.
    Init {
        /// Output directory.
        #[arg(short, long, default_value = ".")]
        dir: String,
    },
    /// Show server status (if running).
    Status,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Start { config: config_path } => {
            run_start(&config_path).await?;
        }
        Commands::Init { dir } => {
            run_init(&dir)?;
        }
        Commands::Status => {
            run_status();
        }
    }

    Ok(())
}

/// Start the Concord daemon: load config, init networking, serve.
async fn run_start(config_path: &str) -> anyhow::Result<()> {
    // Load configuration
    let daemon_config = DaemonConfig::load(config_path)?;

    // Initialize tracing with the configured filter
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(&daemon_config.logging.filter)),
        )
        .init();

    let display_name = daemon_config.resolved_display_name();
    tracing::info!(
        name = %display_name,
        port = daemon_config.node.listen_port,
        config = %config_path,
        "starting concord-server"
    );

    // Resolve data directory
    let data_dir = daemon_config.resolved_data_dir();
    std::fs::create_dir_all(&data_dir)?;
    tracing::info!(path = %data_dir.display(), "data directory ready");

    // Open SQLite database
    let db_path = data_dir.join("concord.db");
    let db = Database::open(&db_path)?;
    tracing::info!(path = %db_path.display(), "database opened");

    // Load or generate identity
    let keypair = match db.load_identity()? {
        Some((stored_name, kp)) => {
            tracing::info!(
                peer_id = %kp.peer_id(),
                stored_name = %stored_name,
                "loaded existing identity"
            );
            kp
        }
        None => {
            let kp = Keypair::generate();
            db.save_identity(&display_name, &kp)?;
            tracing::info!(peer_id = %kp.peer_id(), "generated new identity");
            kp
        }
    };
    let _concord_peer_id = keypair.peer_id();

    // Build NodeConfig and create the p2p node
    let node_config = daemon_config.to_node_config();
    let (node, node_handle, event_tx, _event_rx) = Node::new(&node_config).await?;

    let libp2p_peer_id = node_handle.peer_id().to_string();
    tracing::info!(libp2p_peer_id = %libp2p_peer_id, "node created");

    // Spawn the node event loop FIRST so subscribe commands can be processed
    let node_task = tokio::spawn(async move {
        node.run().await;
    });

    // Subscribe to the default mesh topic
    node_handle.subscribe("concord/mesh").await?;
    tracing::info!("subscribed to concord/mesh");

    // Subscribe to the attestations topic
    node_handle.subscribe("concord/mesh/attestations").await?;
    tracing::info!("subscribed to concord/mesh/attestations");

    // Auto-create server if configured
    let mut server_name_for_status: Option<String> = None;
    let mut server_id_for_webhost: Option<String> = None;

    if daemon_config.server.auto_create {
        let name = daemon_config
            .server
            .name
            .clone()
            .unwrap_or_else(|| format!("{} Server", display_name));

        let visibility = match daemon_config.server.visibility.as_str() {
            "public" => Visibility::Public,
            "federated" => Visibility::Federated,
            _ => Visibility::Private,
        };

        // Use a deterministic server ID based on the node's identity
        let server_id = format!("server-{}", &keypair.peer_id()[..16]);

        // Only create if it doesn't already exist
        if db.get_server(&server_id)?.is_none() {
            let server = Server {
                id: server_id.clone(),
                name: name.clone(),
                owner_id: keypair.peer_id(),
                visibility,
            };
            db.create_server(&server)?;
            tracing::info!(server_id = %server_id, name = %name, "server created");

            // Create default channels
            for ch_def in &daemon_config.server.default_channels {
                let channel_type = match ch_def.channel_type.as_str() {
                    "voice" => ChannelType::Voice,
                    "video" => ChannelType::Video,
                    _ => ChannelType::Text,
                };
                let channel_id = format!("{}-{}", server_id, ch_def.name);
                let channel = Channel {
                    id: channel_id,
                    server_id: server_id.clone(),
                    name: ch_def.name.clone(),
                    channel_type,
                };
                db.create_channel(&channel)?;
                tracing::info!(channel = %ch_def.name, "channel created");
            }
        } else {
            tracing::info!(server_id = %server_id, "server already exists, skipping creation");
        }

        // Subscribe to channel topics
        let channels = db.get_channels(&server_id)?;
        for ch in &channels {
            let topic = format!("concord/{}/{}", server_id, ch.id);
            node_handle.subscribe(&topic).await?;
            tracing::info!(topic = %topic, channel = %ch.name, "subscribed to channel topic");
        }

        server_name_for_status = Some(name);
        server_id_for_webhost = Some(server_id);
    }

    // Start webhost if enabled
    let mut webhost_url: Option<String> = None;
    let _webhost_handle = if daemon_config.webhost.enabled {
        let server_id = server_id_for_webhost
            .clone()
            .unwrap_or_else(|| format!("server-{}", &keypair.peer_id()[..16]));

        let webhost_config = WebhostConfig {
            port: daemon_config.webhost.port,
            pin: daemon_config.webhost.pin.clone(),
            server_id,
        };

        let webhost = WebhostServer::new(webhost_config, node_handle.clone(), event_tx.clone());
        let handle = webhost.start().await?;

        tracing::info!(
            url = %handle.url,
            pin = %handle.pin,
            "webhost server started"
        );

        webhost_url = Some(handle.url.clone());
        Some(handle)
    } else {
        None
    };

    // Bootstrap DHT if we have bootstrap peers
    if !daemon_config.node.bootstrap_peers.is_empty() {
        node_handle.bootstrap_dht().await?;
        tracing::info!("DHT bootstrap initiated");
    }

    let listen_addrs = vec![
        format!("/ip4/0.0.0.0/udp/{}/quic-v1", daemon_config.node.listen_port),
    ];

    // Print status banner
    admin::print_status(
        &libp2p_peer_id,
        &display_name,
        &listen_addrs,
        0,
        server_name_for_status.as_deref(),
        webhost_url.as_deref(),
    );

    println!("  Press Ctrl+C to stop the server.\n");

    // Wait for Ctrl+C
    tokio::signal::ctrl_c().await?;
    tracing::info!("received shutdown signal");

    // Graceful shutdown
    node_handle.shutdown().await?;
    node_task.await?;
    tracing::info!("concord-server stopped");

    Ok(())
}

/// Initialize a new Concord server directory with default config and identity.
fn run_init(dir: &str) -> anyhow::Result<()> {
    // Initialize minimal tracing for init
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new("info"))
        .init();

    println!();
    println!("\x1b[1;36mConcord Server — Initialization\x1b[0m");
    println!();

    // Generate config
    let config_path = admin::generate_default_config(dir)?;
    println!("  Config:   {}", config_path);

    // Create data directory and generate identity
    let data_dir = PathBuf::from(dir).join("concord-data");
    std::fs::create_dir_all(&data_dir)?;

    let db_path = data_dir.join("concord.db");
    let db = Database::open(&db_path)?;

    let keypair = Keypair::generate();
    let display_name = hostname_or_default();
    db.save_identity(&display_name, &keypair)?;

    println!("  Data dir: {}", data_dir.display());
    println!("  Peer ID:  {}", keypair.peer_id());
    println!();
    println!("  Edit {} to configure your server.", config_path);
    println!("  Then run: concord-server start --config {}", config_path);
    println!();

    Ok(())
}

/// Show server status (placeholder).
fn run_status() {
    println!();
    println!("\x1b[1;36mConcord Server — Status\x1b[0m");
    println!();
    println!("  Status check not yet implemented.");
    println!("  (Would query a running daemon via admin socket.)");
    println!();
}

/// Get the system hostname or a fallback.
fn hostname_or_default() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Concord Server".into())
}
