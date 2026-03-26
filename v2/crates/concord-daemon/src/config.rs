use std::path::{Path, PathBuf};

use serde::Deserialize;

use concord_core::config::NodeConfig;
use concord_core::types::NodeType;

/// Top-level daemon configuration, loaded from a TOML file.
#[derive(Debug, Deserialize)]
pub struct DaemonConfig {
    #[serde(default)]
    pub node: NodeSection,
    #[serde(default)]
    pub server: ServerSection,
    #[serde(default)]
    pub webhost: WebhostSection,
    #[serde(default)]
    pub logging: LoggingSection,
}

/// Node-level networking configuration.
#[derive(Debug, Deserialize)]
pub struct NodeSection {
    /// Display name for this node. Defaults to the system hostname.
    #[serde(default = "default_display_name")]
    pub display_name: Option<String>,
    /// UDP port to listen on. Default: 4001.
    #[serde(default = "default_listen_port")]
    pub listen_port: u16,
    /// Path to the data directory. Default: ./concord-data.
    #[serde(default)]
    pub data_dir: Option<String>,
    /// Multiaddr strings of bootstrap peers.
    #[serde(default)]
    pub bootstrap_peers: Vec<String>,
    /// Act as a relay server for NAT traversal. Default: true (backbone).
    #[serde(default = "default_true")]
    pub enable_relay_server: bool,
    /// Use relay clients for NAT traversal. Default: false.
    #[serde(default)]
    pub enable_relay_client: bool,
    /// Enable mDNS local discovery. Default: true.
    #[serde(default = "default_true")]
    pub enable_mdns: bool,
    /// Enable Kademlia DHT. Default: true.
    #[serde(default = "default_true")]
    pub enable_dht: bool,
}

/// Server auto-creation configuration.
#[derive(Debug, Deserialize)]
pub struct ServerSection {
    /// Automatically create a server on startup. Default: true.
    #[serde(default = "default_true")]
    pub auto_create: bool,
    /// Server name. Defaults to the node display name + " Server".
    #[serde(default)]
    pub name: Option<String>,
    /// Visibility: "public", "private", or "federated". Default: "public".
    #[serde(default = "default_visibility")]
    pub visibility: String,
    /// Channels to create on the server.
    #[serde(default = "default_channels")]
    pub default_channels: Vec<ChannelDef>,
    /// Maximum number of members. None = unlimited.
    #[serde(default)]
    pub max_members: Option<u32>,
}

/// A channel definition for auto-creation.
#[derive(Debug, Deserialize, Clone)]
pub struct ChannelDef {
    pub name: String,
    /// "text", "voice", or "video". Default: "text".
    #[serde(default = "default_channel_type")]
    pub channel_type: String,
}

/// Embedded web server configuration.
#[derive(Debug, Deserialize)]
pub struct WebhostSection {
    /// Enable the embedded webhost. Default: true.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Port to bind on. Default: 8080.
    #[serde(default = "default_webhost_port")]
    pub port: u16,
    /// Static PIN for guest auth. Auto-generated if None.
    #[serde(default)]
    pub pin: Option<String>,
}

/// Logging configuration.
#[derive(Debug, Deserialize)]
pub struct LoggingSection {
    /// tracing env-filter string (e.g. "info,concord_net=debug").
    #[serde(default = "default_log_filter")]
    pub filter: String,
}

// ── Defaults ────────────────────────────────────────────────────────

fn default_true() -> bool {
    true
}

fn default_display_name() -> Option<String> {
    None
}

fn default_listen_port() -> u16 {
    4001
}

fn default_visibility() -> String {
    "public".into()
}

fn default_channel_type() -> String {
    "text".into()
}

fn default_webhost_port() -> u16 {
    8080
}

fn default_log_filter() -> String {
    "info,concord_net=info".into()
}

fn default_channels() -> Vec<ChannelDef> {
    vec![
        ChannelDef {
            name: "general".into(),
            channel_type: "text".into(),
        },
        ChannelDef {
            name: "voice-lobby".into(),
            channel_type: "voice".into(),
        },
    ]
}

// ── Default impls ───────────────────────────────────────────────────

impl Default for NodeSection {
    fn default() -> Self {
        Self {
            display_name: None,
            listen_port: 4001,
            data_dir: None,
            bootstrap_peers: Vec::new(),
            enable_relay_server: true,
            enable_relay_client: false,
            enable_mdns: true,
            enable_dht: true,
        }
    }
}

impl Default for ServerSection {
    fn default() -> Self {
        Self {
            auto_create: true,
            name: None,
            visibility: "public".into(),
            default_channels: default_channels(),
            max_members: None,
        }
    }
}

impl Default for WebhostSection {
    fn default() -> Self {
        Self {
            enabled: true,
            port: 8080,
            pin: None,
        }
    }
}

impl Default for LoggingSection {
    fn default() -> Self {
        Self {
            filter: "info,concord_net=info".into(),
        }
    }
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            node: NodeSection::default(),
            server: ServerSection::default(),
            webhost: WebhostSection::default(),
            logging: LoggingSection::default(),
        }
    }
}

// ── Methods ─────────────────────────────────────────────────────────

impl DaemonConfig {
    /// Load configuration from a TOML file. Returns the default config if the
    /// file does not exist.
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self, anyhow::Error> {
        let path = path.as_ref();
        if !path.exists() {
            tracing::warn!(?path, "config file not found, using defaults");
            return Ok(Self::default());
        }
        let contents = std::fs::read_to_string(path)?;
        let config: DaemonConfig = toml::from_str(&contents)?;
        Ok(config)
    }

    /// Resolve the display name: explicit config > hostname > fallback.
    pub fn resolved_display_name(&self) -> String {
        if let Some(ref name) = self.node.display_name {
            return name.clone();
        }
        hostname().unwrap_or_else(|| "Concord Server".into())
    }

    /// Resolve the data directory path.
    pub fn resolved_data_dir(&self) -> PathBuf {
        if let Some(ref dir) = self.node.data_dir {
            PathBuf::from(dir)
        } else {
            PathBuf::from("./concord-data")
        }
    }

    /// Convert this daemon config into a `NodeConfig` for concord-net.
    pub fn to_node_config(&self) -> NodeConfig {
        NodeConfig {
            display_name: self.resolved_display_name(),
            node_type: NodeType::Backbone,
            listen_port: self.node.listen_port,
            enable_mdns: self.node.enable_mdns,
            enable_dht: self.node.enable_dht,
            data_dir: self.resolved_data_dir(),
            bootstrap_peers: self.node.bootstrap_peers.clone(),
            enable_relay_server: self.node.enable_relay_server,
            enable_relay_client: self.node.enable_relay_client,
        }
    }

    /// Serialize this config to a TOML string suitable for a default config file.
    pub fn to_default_toml() -> String {
        let mut s = String::new();
        s.push_str("# Concord Server Configuration\n");
        s.push_str("# See https://github.com/concord-chat/concord for documentation.\n\n");

        s.push_str("[node]\n");
        s.push_str("# display_name = \"My Server\"   # defaults to hostname\n");
        s.push_str("listen_port = 4001\n");
        s.push_str("# data_dir = \"./concord-data\"  # defaults to ./concord-data\n");
        s.push_str("bootstrap_peers = []\n");
        s.push_str("enable_relay_server = true\n");
        s.push_str("enable_relay_client = false\n");
        s.push_str("enable_mdns = true\n");
        s.push_str("enable_dht = true\n");
        s.push('\n');

        s.push_str("[server]\n");
        s.push_str("auto_create = true\n");
        s.push_str("# name = \"My Concord Server\"   # defaults to display_name + \" Server\"\n");
        s.push_str("visibility = \"public\"           # public | private | federated\n");
        s.push_str("# max_members = 100             # omit for unlimited\n");
        s.push('\n');

        s.push_str("[[server.default_channels]]\n");
        s.push_str("name = \"general\"\n");
        s.push_str("channel_type = \"text\"\n");
        s.push('\n');

        s.push_str("[[server.default_channels]]\n");
        s.push_str("name = \"voice-lobby\"\n");
        s.push_str("channel_type = \"voice\"\n");
        s.push('\n');

        s.push_str("[webhost]\n");
        s.push_str("enabled = true\n");
        s.push_str("port = 8080\n");
        s.push_str("# pin = \"1234\"                  # omit to auto-generate\n");
        s.push('\n');

        s.push_str("[logging]\n");
        s.push_str("filter = \"info,concord_net=info\"\n");

        s
    }
}

/// Get the system hostname.
fn hostname() -> Option<String> {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_roundtrip() {
        let config = DaemonConfig::default();
        assert_eq!(config.node.listen_port, 4001);
        assert!(config.node.enable_relay_server);
        assert!(!config.node.enable_relay_client);
        assert!(config.server.auto_create);
        assert_eq!(config.server.default_channels.len(), 2);
        assert!(config.webhost.enabled);
        assert_eq!(config.webhost.port, 8080);
    }

    #[test]
    fn to_node_config_conversion() {
        let config = DaemonConfig::default();
        let node_config = config.to_node_config();
        assert_eq!(node_config.listen_port, 4001);
        assert_eq!(node_config.node_type, NodeType::Backbone);
        assert!(node_config.enable_relay_server);
        assert!(!node_config.enable_relay_client);
    }

    #[test]
    fn parse_minimal_toml() {
        let toml_str = r#"
[node]
listen_port = 5000

[server]
name = "Test Server"
"#;
        let config: DaemonConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.node.listen_port, 5000);
        assert_eq!(config.server.name.as_deref(), Some("Test Server"));
        // Defaults should fill in the rest
        assert!(config.node.enable_mdns);
        assert!(config.webhost.enabled);
    }

    #[test]
    fn generate_default_toml_is_parseable() {
        let toml_str = DaemonConfig::to_default_toml();
        let config: DaemonConfig = toml::from_str(&toml_str).unwrap();
        assert_eq!(config.node.listen_port, 4001);
        assert!(config.server.auto_create);
    }
}
