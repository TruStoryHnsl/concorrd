use std::path::Path;

/// Print the server status banner to stdout.
pub fn print_status(
    peer_id: &str,
    display_name: &str,
    listen_addrs: &[String],
    connected_peers: usize,
    server_name: Option<&str>,
    webhost_url: Option<&str>,
) {
    println!();
    println!("\x1b[1;36m╔══════════════════════════════════════════╗\x1b[0m");
    println!("\x1b[1;36m║     CONCORD SERVER v0.1.0                ║\x1b[0m");
    println!("\x1b[1;36m╚══════════════════════════════════════════╝\x1b[0m");
    println!();
    println!("  Node ID:    {}", peer_id);
    println!("  Name:       {}", display_name);
    for addr in listen_addrs {
        println!("  Listening:  {}", addr);
    }
    if let Some(name) = server_name {
        println!("  Server:     {}", name);
    }
    if let Some(url) = webhost_url {
        println!("  Web UI:     {}", url);
    }
    println!("  Peers:      {}", connected_peers);
    println!();
}

/// Generate a default configuration file in the given directory.
/// Returns the path to the generated file.
pub fn generate_default_config(dir: &str) -> anyhow::Result<String> {
    let dir_path = Path::new(dir);
    std::fs::create_dir_all(dir_path)?;

    let config_path = dir_path.join("concord-server.toml");
    let contents = crate::config::DaemonConfig::to_default_toml();
    std::fs::write(&config_path, &contents)?;

    Ok(config_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn print_status_does_not_panic() {
        print_status(
            "12D3KooWTestPeerId",
            "TestNode",
            &["/ip4/0.0.0.0/udp/4001/quic-v1".to_string()],
            0,
            Some("My Server"),
            Some("http://localhost:8080"),
        );
    }

    #[test]
    fn generate_default_config_creates_file() {
        let tmp = std::env::temp_dir().join("concord-admin-test");
        let _ = std::fs::remove_dir_all(&tmp);

        let path = generate_default_config(tmp.to_str().unwrap()).unwrap();
        assert!(Path::new(&path).exists());

        // Verify it's valid TOML
        let contents = std::fs::read_to_string(&path).unwrap();
        let _config: crate::config::DaemonConfig = toml::from_str(&contents).unwrap();

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
