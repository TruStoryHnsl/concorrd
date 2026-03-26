use anyhow::Result;
use futures::StreamExt;
use libp2p::{gossipsub, kad, swarm::SwarmEvent, Multiaddr, PeerId, Swarm};
use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{debug, error, info, warn};

use concord_core::config::NodeConfig;
use concord_core::trust::TrustAttestation;
use concord_core::types::{AliasAnnouncement, DmSignal, ForumPost, FriendSignal, PresenceStatus, ServerSignal, VoiceSignal};

use crate::behaviour::{ConcordBehaviour, ConcordBehaviourEvent};
use crate::discovery::{DiscoveryState, PeerInfo};
use crate::events::NetworkEvent;
use crate::swarm::build_swarm;
use crate::tunnel::TunnelTracker;

/// Commands sent from the NodeHandle to the Node event loop.
#[derive(Debug)]
pub enum NodeCommand {
    /// Publish data to a GossipSub topic.
    Publish {
        topic: String,
        data: Vec<u8>,
    },
    /// Subscribe to a GossipSub topic.
    Subscribe {
        topic: String,
        reply: Option<oneshot::Sender<Result<(), String>>>,
    },
    /// Unsubscribe from a GossipSub topic.
    Unsubscribe {
        topic: String,
    },
    /// Get the list of known peers.
    GetPeers {
        reply: oneshot::Sender<Vec<PeerInfo>>,
    },
    /// Send a voice signaling message via GossipSub.
    SendVoiceSignal {
        server_id: String,
        channel_id: String,
        signal: VoiceSignal,
    },
    /// Initiate a Kademlia DHT bootstrap query.
    BootstrapDht,
    /// Dial a peer by PeerId and addresses.
    DialPeer {
        peer_id: String,
        addresses: Vec<String>,
    },
    /// Add a known address for a peer to the routing table.
    AddPeerAddress {
        peer_id: String,
        address: String,
    },
    /// Get all active tunnel connections.
    GetTunnels {
        reply: oneshot::Sender<Vec<crate::tunnel::TunnelInfo>>,
    },
    /// Broadcast a trust attestation to the mesh.
    BroadcastAttestation {
        attestation: TrustAttestation,
    },
    /// Send a DM signal (key exchange or encrypted message) to a peer.
    SendDmSignal {
        signal: DmSignal,
    },
    /// Broadcast an alias announcement to the mesh.
    BroadcastAliasAnnouncement {
        announcement: AliasAnnouncement,
    },
    /// Post a forum message to the mesh.
    PostToForum {
        post: ForumPost,
    },
    /// Broadcast presence status to all friends.
    BroadcastPresence {
        status: PresenceStatus,
    },
    /// Send a friend signal to a specific peer's shared topic.
    SendFriendSignal {
        peer_id: String,
        signal: FriendSignal,
    },
    /// Send a server key exchange signal.
    SendServerSignal {
        server_id: String,
        signal: ServerSignal,
    },
    /// Shut down the node.
    Shutdown,
}

/// A handle to a running Node. This is Send+Sync and can be stored in Tauri state.
#[derive(Clone)]
pub struct NodeHandle {
    command_tx: mpsc::Sender<NodeCommand>,
    peer_id: String,
}

impl NodeHandle {
    /// Get a broadcast receiver for network events.
    /// Call this before spawning if you need events from the start.
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// Publish data to a GossipSub topic.
    pub async fn publish(&self, topic: &str, data: Vec<u8>) -> Result<()> {
        self.command_tx
            .send(NodeCommand::Publish {
                topic: topic.to_string(),
                data,
            })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        Ok(())
    }

    /// Subscribe to a GossipSub topic.
    pub async fn subscribe(&self, topic: &str) -> Result<()> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.command_tx
            .send(NodeCommand::Subscribe {
                topic: topic.to_string(),
                reply: Some(reply_tx),
            })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        reply_rx
            .await
            .map_err(|_| anyhow::anyhow!("node did not reply"))?
            .map_err(|e| anyhow::anyhow!("{e}"))
    }

    /// Unsubscribe from a GossipSub topic.
    pub async fn unsubscribe(&self, topic: &str) -> Result<()> {
        self.command_tx
            .send(NodeCommand::Unsubscribe {
                topic: topic.to_string(),
            })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        Ok(())
    }

    /// Get a snapshot of currently known peers.
    pub async fn peers(&self) -> Result<Vec<PeerInfo>> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.command_tx
            .send(NodeCommand::GetPeers { reply: reply_tx })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        reply_rx
            .await
            .map_err(|_| anyhow::anyhow!("node did not reply"))
    }

    /// Send a voice signaling message to a specific voice channel topic.
    pub async fn send_voice_signal(
        &self,
        server_id: &str,
        channel_id: &str,
        signal: VoiceSignal,
    ) -> Result<()> {
        self.command_tx
            .send(NodeCommand::SendVoiceSignal {
                server_id: server_id.to_string(),
                channel_id: channel_id.to_string(),
                signal,
            })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        Ok(())
    }

    /// Initiate a Kademlia DHT bootstrap.
    pub async fn bootstrap_dht(&self) -> Result<()> {
        self.command_tx
            .send(NodeCommand::BootstrapDht)
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        Ok(())
    }

    /// Dial a peer by PeerId and a list of multiaddr strings.
    pub async fn dial_peer(&self, peer_id: &str, addresses: &[String]) -> Result<()> {
        self.command_tx
            .send(NodeCommand::DialPeer {
                peer_id: peer_id.to_string(),
                addresses: addresses.to_vec(),
            })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        Ok(())
    }

    /// Add a known address for a peer.
    pub async fn add_peer_address(&self, peer_id: &str, address: &str) -> Result<()> {
        self.command_tx
            .send(NodeCommand::AddPeerAddress {
                peer_id: peer_id.to_string(),
                address: address.to_string(),
            })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        Ok(())
    }

    /// Get all active tunnel connections.
    pub async fn get_tunnels(&self) -> Result<Vec<crate::tunnel::TunnelInfo>> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.command_tx
            .send(NodeCommand::GetTunnels { reply: reply_tx })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        reply_rx
            .await
            .map_err(|_| anyhow::anyhow!("node did not reply"))
    }

    /// Broadcast a trust attestation to the mesh.
    pub async fn broadcast_attestation(&self, attestation: TrustAttestation) -> Result<()> {
        self.command_tx
            .send(NodeCommand::BroadcastAttestation { attestation })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        Ok(())
    }

    /// Broadcast an alias announcement to the mesh.
    pub async fn broadcast_alias_announcement(&self, announcement: AliasAnnouncement) -> Result<()> {
        self.command_tx
            .send(NodeCommand::BroadcastAliasAnnouncement { announcement })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        Ok(())
    }

    /// Send a DM signal (key exchange or encrypted message) to a peer.
    pub async fn send_dm_signal(&self, signal: DmSignal) -> Result<()> {
        self.command_tx
            .send(NodeCommand::SendDmSignal { signal })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        Ok(())
    }

    /// Post a forum message to the mesh (local or global).
    pub async fn post_to_forum(&self, post: ForumPost) -> Result<()> {
        self.command_tx
            .send(NodeCommand::PostToForum { post })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        Ok(())
    }

    /// Broadcast presence status to all friends.
    pub async fn broadcast_presence(&self, status: PresenceStatus) -> Result<()> {
        self.command_tx
            .send(NodeCommand::BroadcastPresence { status })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        Ok(())
    }

    /// Send a friend signal to a specific peer.
    pub async fn send_friend_signal(&self, peer_id: &str, signal: FriendSignal) -> Result<()> {
        self.command_tx
            .send(NodeCommand::SendFriendSignal {
                peer_id: peer_id.to_string(),
                signal,
            })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        Ok(())
    }

    /// Send a server key exchange signal.
    pub async fn send_server_signal(&self, server_id: &str, signal: ServerSignal) -> Result<()> {
        self.command_tx
            .send(NodeCommand::SendServerSignal {
                server_id: server_id.to_string(),
                signal,
            })
            .await
            .map_err(|_| anyhow::anyhow!("node event loop has shut down"))?;
        Ok(())
    }

    /// Shut down the node.
    pub async fn shutdown(&self) -> Result<()> {
        let _ = self.command_tx.send(NodeCommand::Shutdown).await;
        Ok(())
    }
}

/// The main Concord networking node.
///
/// Owns the libp2p Swarm and processes all network events.
/// Communicates with external code through channels.
pub struct Node {
    swarm: Swarm<ConcordBehaviour>,
    discovery: DiscoveryState,
    tunnel_tracker: TunnelTracker,
    command_rx: mpsc::Receiver<NodeCommand>,
    event_tx: broadcast::Sender<NetworkEvent>,
    peer_id: String,
}

impl Node {
    /// Create a new Node and its associated handle.
    ///
    /// Returns `(Node, NodeHandle, broadcast::Sender<NetworkEvent>, broadcast::Receiver<NetworkEvent>)`.
    /// The Node must be spawned via `tokio::spawn(async move { node.run().await })`.
    /// The NodeHandle is Send+Sync and can be passed to Tauri state.
    /// The broadcast::Sender can be used to create additional receivers (e.g., for the webhost).
    /// The broadcast::Receiver is for subscribing to network events.
    pub async fn new(
        config: &NodeConfig,
    ) -> Result<(
        Self,
        NodeHandle,
        broadcast::Sender<NetworkEvent>,
        broadcast::Receiver<NetworkEvent>,
    )> {
        let mut swarm = build_swarm(config)?;

        // Listen on all interfaces. Port 0 = OS picks a random available port.
        let listen_port = if config.listen_port == 0 {
            0
        } else {
            config.listen_port
        };

        let listen_addr: Multiaddr = format!("/ip4/0.0.0.0/udp/{listen_port}/quic-v1")
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid listen address: {e}"))?;

        swarm.listen_on(listen_addr)?;

        let peer_id = swarm.local_peer_id().to_string();
        info!(%peer_id, "concord node created");

        // Add bootstrap peers to Kademlia
        for addr_str in &config.bootstrap_peers {
            match addr_str.parse::<Multiaddr>() {
                Ok(addr) => {
                    // Extract peer ID from the multiaddr (last /p2p/<peer_id> component)
                    if let Some(libp2p::multiaddr::Protocol::P2p(pid)) = addr.iter().last() {
                        swarm
                            .behaviour_mut()
                            .kademlia
                            .add_address(&pid, addr.clone());
                        info!(%pid, %addr, "added bootstrap peer to kademlia");
                    } else {
                        warn!(%addr_str, "bootstrap address missing /p2p/<peer_id> component");
                    }
                }
                Err(e) => {
                    warn!(%addr_str, %e, "failed to parse bootstrap address");
                }
            }
        }

        // Start DHT bootstrap if we have bootstrap peers
        if !config.bootstrap_peers.is_empty() {
            match swarm.behaviour_mut().kademlia.bootstrap() {
                Ok(query_id) => {
                    info!(?query_id, "kademlia bootstrap query started");
                }
                Err(e) => {
                    warn!(%e, "kademlia bootstrap failed (no known peers in routing table)");
                }
            }
        }

        let (command_tx, command_rx) = mpsc::channel(256);
        let (event_tx, event_rx) = broadcast::channel(256);

        let handle = NodeHandle {
            command_tx,
            peer_id: peer_id.clone(),
        };

        let node = Self {
            swarm,
            discovery: DiscoveryState::new(),
            tunnel_tracker: TunnelTracker::new(),
            command_rx,
            event_tx,
            peer_id,
        };

        let event_tx_clone = node.event_tx.clone();
        Ok((node, handle, event_tx_clone, event_rx))
    }

    /// Subscribe the node to a new event receiver. Call this if you need
    /// additional receivers beyond the one returned from `new()`.
    pub fn subscribe_events(&self) -> broadcast::Receiver<NetworkEvent> {
        self.event_tx.subscribe()
    }

    /// The main event loop. This drives the swarm and handles commands.
    /// Runs until a Shutdown command is received or the command channel closes.
    pub async fn run(mut self) {
        info!(peer_id = %self.peer_id, "node event loop starting");

        loop {
            tokio::select! {
                // Process swarm events
                event = self.swarm.select_next_some() => {
                    self.handle_swarm_event(event);
                }
                // Process commands from the handle
                cmd = self.command_rx.recv() => {
                    match cmd {
                        Some(NodeCommand::Shutdown) | None => {
                            info!("node shutting down");
                            break;
                        }
                        Some(cmd) => self.handle_command(cmd),
                    }
                }
            }
        }

        info!(peer_id = %self.peer_id, "node event loop stopped");
    }

    fn handle_swarm_event(&mut self, event: SwarmEvent<ConcordBehaviourEvent>) {
        match event {
            // ----- mDNS events -----
            SwarmEvent::Behaviour(ConcordBehaviourEvent::Mdns(
                libp2p::mdns::Event::Discovered(peers),
            )) => {
                let peers_vec: Vec<(libp2p::PeerId, Multiaddr)> = peers;

                // Add newly discovered peers to the swarm's address book and dial them.
                // Dialing is required for GossipSub mesh formation — add_peer_address alone
                // only populates the address book without establishing a connection.
                for (peer_id, addr) in &peers_vec {
                    self.swarm.add_peer_address(*peer_id, addr.clone());
                    // Also add to Kademlia routing table
                    self.swarm
                        .behaviour_mut()
                        .kademlia
                        .add_address(peer_id, addr.clone());
                    // Only dial if we don't already have a connection
                    if !self.swarm.is_connected(peer_id) {
                        if let Err(e) = self.swarm.dial(*peer_id) {
                            debug!(%peer_id, %e, "failed to dial mDNS peer (may already be dialing)");
                        }
                    }
                    // Mark this peer as mDNS-local in the tunnel tracker
                    self.tunnel_tracker
                        .mark_as_local_mdns(&peer_id.to_string());
                }

                let new_peers = self.discovery.on_mdns_discovered(peers_vec);

                for (peer_id, addrs) in new_peers {
                    let event = NetworkEvent::PeerDiscovered {
                        peer_id: peer_id.to_string(),
                        addresses: addrs.iter().map(|a| a.to_string()).collect(),
                        display_name: None,
                    };
                    self.emit(event);
                }

                self.emit_connection_status();
            }

            SwarmEvent::Behaviour(ConcordBehaviourEvent::Mdns(
                libp2p::mdns::Event::Expired(peers),
            )) => {
                let peers_vec: Vec<(libp2p::PeerId, Multiaddr)> = peers;
                let departed = self.discovery.on_mdns_expired(peers_vec);

                for peer_id in departed {
                    let event = NetworkEvent::PeerDeparted {
                        peer_id: peer_id.to_string(),
                    };
                    self.emit(event);
                }

                self.emit_connection_status();
            }

            // ----- GossipSub events -----
            SwarmEvent::Behaviour(ConcordBehaviourEvent::Gossipsub(
                gossipsub::Event::Message {
                    propagation_source,
                    message,
                    ..
                },
            )) => {
                let source = message
                    .source
                    .map(|p| p.to_string())
                    .unwrap_or_else(|| propagation_source.to_string());

                let topic = message.topic.to_string();

                debug!(
                    %source,
                    %topic,
                    bytes = message.data.len(),
                    "gossipsub message received"
                );

                // Emit raw message event
                let event = NetworkEvent::MessageReceived {
                    topic: topic.clone(),
                    source,
                    data: message.data.clone(),
                };
                self.emit(event);

                // Check if this is a voice signaling topic
                if topic.ends_with("/voice-signal") {
                    // Voice signals may be encrypted: first 12 bytes = nonce, rest = ciphertext.
                    // Try to decrypt by deriving the voice key from the topic path.
                    let decrypted_data = if message.data.len() > 12 {
                        // Parse server_id and channel_id from topic:
                        // concord/{server_id}/{channel_id}/voice-signal
                        let parts: Vec<&str> = topic.split('/').collect();
                        if parts.len() >= 4 {
                            let sid = parts[1];
                            let cid = parts[2];
                            let voice_key = concord_core::crypto::derive_channel_key(
                                &concord_core::crypto::derive_forum_key(sid),
                                cid,
                            );
                            let (nonce_bytes, ct) = message.data.split_at(12);
                            if nonce_bytes.len() == 12 {
                                let mut nonce_arr = [0u8; 12];
                                nonce_arr.copy_from_slice(nonce_bytes);
                                concord_core::crypto::decrypt_channel_message(
                                    &voice_key,
                                    ct,
                                    &nonce_arr,
                                )
                                .ok()
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    let data_to_decode = decrypted_data.as_deref().unwrap_or(&message.data);

                    if let Ok(signal) = concord_core::wire::decode::<VoiceSignal>(data_to_decode) {
                        self.emit(NetworkEvent::VoiceSignalReceived { signal });
                    } else {
                        warn!(%topic, "failed to decode voice signal from gossipsub message");
                    }
                } else if topic == "concord/mesh/attestations" {
                    if let Ok(attestation) = concord_core::wire::decode::<TrustAttestation>(&message.data) {
                        self.emit(NetworkEvent::AttestationReceived { attestation });
                    } else {
                        warn!(%topic, "failed to decode attestation from gossipsub message");
                    }
                } else if topic.starts_with("concord/dm/") {
                    if let Ok(signal) = concord_core::wire::decode::<DmSignal>(&message.data) {
                        self.emit(NetworkEvent::DmSignalReceived { signal });
                    } else {
                        warn!(%topic, "failed to decode DM signal from gossipsub message");
                    }
                } else if topic == "concord/forum/local" || topic == "concord/forum/global" {
                    if let Ok(mut post) = concord_core::wire::decode::<ForumPost>(&message.data) {
                        if topic == "concord/forum/local" {
                            // For local forum: check TTL, increment hop_count, re-broadcast
                            if post.hop_count < post.max_hops {
                                post.hop_count += 1;
                                // Re-broadcast with incremented hop count
                                if let Ok(data) = concord_core::wire::encode(&post) {
                                    let ident_topic = gossipsub::IdentTopic::new(&topic);
                                    let _ = self.swarm.behaviour_mut().gossipsub.publish(ident_topic, data);
                                }
                            }
                        }
                        // Global forum: standard GossipSub handles propagation
                        self.emit(NetworkEvent::ForumPostReceived { post });
                    } else {
                        warn!(%topic, "failed to decode forum post from gossipsub message");
                    }
                } else if topic.starts_with("concord/friends/") {
                    // Friend signals may be encrypted: first 12 bytes = nonce, rest = ciphertext.
                    let friend_key = concord_core::crypto::derive_forum_key(&topic);
                    let decrypted_data = if message.data.len() > 12 {
                        let (nonce_bytes, ct) = message.data.split_at(12);
                        if nonce_bytes.len() == 12 {
                            let mut nonce_arr = [0u8; 12];
                            nonce_arr.copy_from_slice(nonce_bytes);
                            concord_core::crypto::decrypt_channel_message(
                                &friend_key,
                                ct,
                                &nonce_arr,
                            )
                            .ok()
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    let data_to_decode = decrypted_data.as_deref().unwrap_or(&message.data);

                    if let Ok(signal) = concord_core::wire::decode::<FriendSignal>(data_to_decode) {
                        // If this is a presence signal, also emit a dedicated presence event
                        if let FriendSignal::Presence { ref peer_id, ref status } = signal {
                            self.emit(NetworkEvent::PresenceUpdate {
                                peer_id: peer_id.clone(),
                                status: status.clone(),
                            });
                        }
                        self.emit(NetworkEvent::FriendSignalReceived { signal });
                    } else {
                        warn!(%topic, "failed to decode friend signal from gossipsub message");
                    }
                } else if topic.contains("/key-exchange") {
                    // Server key exchange signals
                    if let Ok(signal) = concord_core::wire::decode::<ServerSignal>(&message.data) {
                        // Extract server_id from topic: "concord/{server_id}/key-exchange"
                        let server_id = topic
                            .strip_prefix("concord/")
                            .and_then(|s| s.strip_suffix("/key-exchange"))
                            .unwrap_or("unknown")
                            .to_string();
                        self.emit(NetworkEvent::ServerSignalReceived {
                            server_id,
                            signal,
                        });
                    } else {
                        warn!(%topic, "failed to decode server signal");
                    }
                } else {
                    // Try to decode as a Concord Message
                    if let Ok(msg) = concord_core::wire::decode::<concord_core::types::Message>(&message.data) {
                        self.emit(NetworkEvent::ConcordMessageReceived { message: msg });
                    }
                }
            }

            SwarmEvent::Behaviour(ConcordBehaviourEvent::Gossipsub(
                gossipsub::Event::Subscribed { peer_id, topic },
            )) => {
                debug!(%peer_id, %topic, "peer subscribed to topic");
            }

            SwarmEvent::Behaviour(ConcordBehaviourEvent::Gossipsub(
                gossipsub::Event::Unsubscribed { peer_id, topic },
            )) => {
                debug!(%peer_id, %topic, "peer unsubscribed from topic");
            }

            SwarmEvent::Behaviour(ConcordBehaviourEvent::Gossipsub(_)) => {
                // Other gossipsub events (GossipsubNotSupported, etc.) — ignore for now
            }

            // ----- Identify events -----
            SwarmEvent::Behaviour(ConcordBehaviourEvent::Identify(
                libp2p::identify::Event::Received { peer_id, info, .. },
            )) => {
                info!(
                    %peer_id,
                    protocol = %info.protocol_version,
                    agent = %info.agent_version,
                    "identify: peer info received"
                );

                // Add the peer's external addresses to the swarm and Kademlia
                for addr in &info.listen_addrs {
                    self.swarm.add_peer_address(peer_id, addr.clone());
                    self.swarm
                        .behaviour_mut()
                        .kademlia
                        .add_address(&peer_id, addr.clone());
                }
            }

            SwarmEvent::Behaviour(ConcordBehaviourEvent::Identify(
                libp2p::identify::Event::Sent { peer_id, .. },
            )) => {
                debug!(%peer_id, "identify: info sent");
            }

            SwarmEvent::Behaviour(ConcordBehaviourEvent::Identify(_)) => {}

            // ----- Kademlia events -----
            SwarmEvent::Behaviour(ConcordBehaviourEvent::Kademlia(
                kad::Event::RoutingUpdated {
                    peer, is_new_peer, ..
                },
            )) => {
                debug!(%peer, is_new_peer, "kademlia: peer added to routing table");
                if is_new_peer {
                    // Add to global discovery
                    self.discovery
                        .global_peers
                        .entry(peer)
                        .or_default();
                }
            }

            SwarmEvent::Behaviour(ConcordBehaviourEvent::Kademlia(
                kad::Event::OutboundQueryProgressed { result, .. },
            )) => {
                match result {
                    kad::QueryResult::GetClosestPeers(Ok(ok)) => {
                        debug!(
                            peers_found = ok.peers.len(),
                            "kademlia: GetClosestPeers completed"
                        );
                        for peer_info in &ok.peers {
                            let addrs: Vec<Multiaddr> = peer_info.addrs.clone();
                            for addr in &addrs {
                                self.swarm
                                    .add_peer_address(peer_info.peer_id, addr.clone());
                            }
                            self.discovery
                                .global_peers
                                .entry(peer_info.peer_id)
                                .or_default()
                                .extend(addrs.clone());

                            self.emit(NetworkEvent::PeerDiscovered {
                                peer_id: peer_info.peer_id.to_string(),
                                addresses: addrs.iter().map(|a| a.to_string()).collect(),
                                display_name: None,
                            });
                        }
                    }
                    kad::QueryResult::GetClosestPeers(Err(e)) => {
                        debug!(%e, "kademlia: GetClosestPeers error");
                    }
                    kad::QueryResult::Bootstrap(Ok(ok)) => {
                        debug!(peer = %ok.peer, num_remaining = ?ok.num_remaining, "kademlia: bootstrap progress");
                    }
                    kad::QueryResult::Bootstrap(Err(e)) => {
                        warn!(%e, "kademlia: bootstrap error");
                    }
                    _ => {
                        debug!("kademlia: other query result");
                    }
                }
            }

            SwarmEvent::Behaviour(ConcordBehaviourEvent::Kademlia(event)) => {
                debug!(?event, "kademlia: other event");
            }

            // ----- Relay server events -----
            SwarmEvent::Behaviour(ConcordBehaviourEvent::RelayServer(event)) => {
                debug!(?event, "relay server event");
            }

            // ----- Relay client events -----
            SwarmEvent::Behaviour(ConcordBehaviourEvent::RelayClient(
                libp2p::relay::client::Event::ReservationReqAccepted {
                    relay_peer_id, ..
                },
            )) => {
                info!(%relay_peer_id, "relay reservation accepted");
            }

            SwarmEvent::Behaviour(ConcordBehaviourEvent::RelayClient(event)) => {
                debug!(?event, "relay client event");
            }

            // ----- DCUtR events -----
            SwarmEvent::Behaviour(ConcordBehaviourEvent::Dcutr(dcutr_event)) => {
                match &dcutr_event.result {
                    Ok(_) => {
                        info!(
                            remote_peer_id = %dcutr_event.remote_peer_id,
                            "DCUtR: direct connection established (hole-punch succeeded)"
                        );
                    }
                    Err(e) => {
                        warn!(
                            remote_peer_id = %dcutr_event.remote_peer_id,
                            error = %e,
                            "DCUtR: hole-punch failed"
                        );
                    }
                }
            }

            // ----- Connection events -----
            SwarmEvent::NewListenAddr { address, .. } => {
                info!(%address, "listening on new address");
            }

            SwarmEvent::ConnectionEstablished {
                peer_id, endpoint, ..
            } => {
                let addr_str = endpoint.get_remote_address().to_string();
                let is_relayed = addr_str.contains("/p2p-circuit/");
                info!(%peer_id, %addr_str, is_relayed, "connection established");

                self.tunnel_tracker
                    .on_connection_established(&peer_id.to_string(), &addr_str, is_relayed);

                // If the peer was known via mDNS, mark it as local
                if self.discovery.local_peers.contains_key(&peer_id) {
                    self.tunnel_tracker
                        .mark_as_local_mdns(&peer_id.to_string());
                }

                if let Some(tunnel) = self.tunnel_tracker.get_tunnel(&peer_id.to_string()) {
                    self.emit(NetworkEvent::TunnelEstablished {
                        peer_id: peer_id.to_string(),
                        connection_type: tunnel.connection_type.to_string(),
                        address: addr_str,
                    });
                }

                self.emit_connection_status();
            }

            SwarmEvent::ConnectionClosed { peer_id, cause, .. } => {
                info!(%peer_id, ?cause, "connection closed");
                self.tunnel_tracker
                    .on_connection_closed(&peer_id.to_string());

                self.emit(NetworkEvent::TunnelClosed {
                    peer_id: peer_id.to_string(),
                });

                self.emit_connection_status();
            }

            SwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
                warn!(?peer_id, %error, "outgoing connection error");
            }

            SwarmEvent::IncomingConnectionError { error, .. } => {
                warn!(%error, "incoming connection error");
            }

            _ => {
                // Catch-all for other swarm events
            }
        }
    }

    fn handle_command(&mut self, cmd: NodeCommand) {
        match cmd {
            NodeCommand::Publish { topic, data } => {
                let ident_topic = gossipsub::IdentTopic::new(&topic);
                match self
                    .swarm
                    .behaviour_mut()
                    .gossipsub
                    .publish(ident_topic, data)
                {
                    Ok(msg_id) => {
                        debug!(%topic, %msg_id, "published message");
                    }
                    Err(e) => {
                        error!(%topic, %e, "failed to publish message");
                    }
                }
            }

            NodeCommand::Subscribe { topic, reply } => {
                let ident_topic = gossipsub::IdentTopic::new(&topic);
                let result = self
                    .swarm
                    .behaviour_mut()
                    .gossipsub
                    .subscribe(&ident_topic);

                let reply_result = match result {
                    Ok(_) => {
                        info!(%topic, "subscribed to topic");
                        Ok(())
                    }
                    Err(e) => {
                        error!(%topic, %e, "failed to subscribe to topic");
                        Err(e.to_string())
                    }
                };

                if let Some(reply) = reply {
                    let _ = reply.send(reply_result);
                }
            }

            NodeCommand::Unsubscribe { topic } => {
                let ident_topic = gossipsub::IdentTopic::new(&topic);
                match self
                    .swarm
                    .behaviour_mut()
                    .gossipsub
                    .unsubscribe(&ident_topic)
                {
                    Ok(_) => {
                        info!(%topic, "unsubscribed from topic");
                    }
                    Err(e) => {
                        error!(%topic, %e, "failed to unsubscribe from topic");
                    }
                }
            }

            NodeCommand::GetPeers { reply } => {
                let peers = self.discovery.all_peer_info();
                let _ = reply.send(peers);
            }

            NodeCommand::SendVoiceSignal {
                server_id,
                channel_id,
                signal,
            } => {
                let topic_str = format!("concord/{server_id}/{channel_id}/voice-signal");
                match concord_core::wire::encode(&signal) {
                    Ok(data) => {
                        // Encrypt voice signal with channel key derived from server_id + channel_id.
                        // Uses HMAC-SHA256 of server_id as the key source (since the node layer
                        // doesn't have access to the DB server_key, we use the server_id as a
                        // shared secret for voice signals — peers in the same server know the server_id).
                        let voice_key = concord_core::crypto::derive_channel_key(
                            &concord_core::crypto::derive_forum_key(&server_id),
                            &channel_id,
                        );
                        let encrypted_data =
                            match concord_core::crypto::encrypt_channel_message(&voice_key, &data)
                            {
                                Ok((ct, nonce)) => {
                                    let mut envelope = Vec::with_capacity(12 + ct.len());
                                    envelope.extend_from_slice(&nonce);
                                    envelope.extend_from_slice(&ct);
                                    envelope
                                }
                                Err(_) => data, // fallback to plaintext on encryption failure
                            };

                        let ident_topic = gossipsub::IdentTopic::new(&topic_str);
                        match self
                            .swarm
                            .behaviour_mut()
                            .gossipsub
                            .publish(ident_topic, encrypted_data)
                        {
                            Ok(msg_id) => {
                                debug!(%topic_str, %msg_id, "published encrypted voice signal");
                            }
                            Err(e) => {
                                error!(%topic_str, %e, "failed to publish voice signal");
                            }
                        }
                    }
                    Err(e) => {
                        error!(%e, "failed to encode voice signal");
                    }
                }
            }

            NodeCommand::BootstrapDht => {
                match self.swarm.behaviour_mut().kademlia.bootstrap() {
                    Ok(query_id) => {
                        info!(?query_id, "kademlia bootstrap query started");
                    }
                    Err(e) => {
                        warn!(%e, "kademlia bootstrap failed (no known peers)");
                    }
                }
            }

            NodeCommand::DialPeer {
                peer_id,
                addresses,
            } => {
                match peer_id.parse::<PeerId>() {
                    Ok(pid) => {
                        for addr_str in &addresses {
                            if let Ok(addr) = addr_str.parse::<Multiaddr>() {
                                self.swarm.add_peer_address(pid, addr.clone());
                                self.swarm
                                    .behaviour_mut()
                                    .kademlia
                                    .add_address(&pid, addr);
                            } else {
                                warn!(%addr_str, "failed to parse multiaddr for dial");
                            }
                        }
                        if let Err(e) = self.swarm.dial(pid) {
                            warn!(%peer_id, %e, "failed to dial peer");
                        } else {
                            info!(%peer_id, "dialing peer");
                        }
                    }
                    Err(e) => {
                        error!(%peer_id, %e, "invalid peer ID");
                    }
                }
            }

            NodeCommand::AddPeerAddress { peer_id, address } => {
                match (
                    peer_id.parse::<PeerId>(),
                    address.parse::<Multiaddr>(),
                ) {
                    (Ok(pid), Ok(addr)) => {
                        self.swarm.add_peer_address(pid, addr.clone());
                        self.swarm
                            .behaviour_mut()
                            .kademlia
                            .add_address(&pid, addr);
                        debug!(%peer_id, %address, "added peer address");
                    }
                    (Err(e), _) => {
                        error!(%peer_id, %e, "invalid peer ID for add_peer_address");
                    }
                    (_, Err(e)) => {
                        error!(%address, %e, "invalid multiaddr for add_peer_address");
                    }
                }
            }

            NodeCommand::GetTunnels { reply } => {
                let tunnels = self.tunnel_tracker.all_tunnels();
                let _ = reply.send(tunnels);
            }

            NodeCommand::BroadcastAttestation { attestation } => {
                let topic_str = "concord/mesh/attestations";
                match concord_core::wire::encode(&attestation) {
                    Ok(data) => {
                        let ident_topic = gossipsub::IdentTopic::new(topic_str);
                        match self
                            .swarm
                            .behaviour_mut()
                            .gossipsub
                            .publish(ident_topic, data)
                        {
                            Ok(msg_id) => {
                                debug!(%topic_str, %msg_id, "published attestation");
                            }
                            Err(e) => {
                                error!(%topic_str, %e, "failed to publish attestation");
                            }
                        }
                    }
                    Err(e) => {
                        error!(%e, "failed to encode attestation");
                    }
                }
            }

            NodeCommand::SendDmSignal { signal } => {
                // Determine the topic from the signal peers
                let (peer_a, peer_b) = match &signal {
                    DmSignal::KeyExchange {
                        from_peer, to_peer, ..
                    } => (from_peer.clone(), to_peer.clone()),
                    DmSignal::EncryptedMessage(dm) => {
                        (dm.from_peer.clone(), dm.to_peer.clone())
                    }
                };

                // Sort alphabetically so both peers compute the same topic
                let mut peers = [peer_a, peer_b];
                peers.sort();
                let topic_str = format!("concord/dm/{}/{}", peers[0], peers[1]);

                match concord_core::wire::encode(&signal) {
                    Ok(data) => {
                        let ident_topic = gossipsub::IdentTopic::new(&topic_str);
                        match self
                            .swarm
                            .behaviour_mut()
                            .gossipsub
                            .publish(ident_topic, data)
                        {
                            Ok(msg_id) => {
                                debug!(%topic_str, %msg_id, "published DM signal");
                            }
                            Err(e) => {
                                error!(%topic_str, %e, "failed to publish DM signal");
                            }
                        }
                    }
                    Err(e) => {
                        error!(%e, "failed to encode DM signal");
                    }
                }
            }

            NodeCommand::BroadcastAliasAnnouncement { announcement } => {
                let topic_str = "concord/mesh/aliases";
                match concord_core::wire::encode(&announcement) {
                    Ok(data) => {
                        let ident_topic = gossipsub::IdentTopic::new(topic_str);
                        match self
                            .swarm
                            .behaviour_mut()
                            .gossipsub
                            .publish(ident_topic, data)
                        {
                            Ok(msg_id) => {
                                debug!(%topic_str, %msg_id, "published alias announcement");
                            }
                            Err(e) => {
                                error!(%topic_str, %e, "failed to publish alias announcement");
                            }
                        }
                    }
                    Err(e) => {
                        error!(%e, "failed to encode alias announcement");
                    }
                }
            }

            NodeCommand::PostToForum { post } => {
                let topic_str = match post.forum_scope {
                    concord_core::types::ForumScope::Local => "concord/forum/local",
                    concord_core::types::ForumScope::Global => "concord/forum/global",
                };
                match concord_core::wire::encode(&post) {
                    Ok(data) => {
                        let ident_topic = gossipsub::IdentTopic::new(topic_str);
                        match self
                            .swarm
                            .behaviour_mut()
                            .gossipsub
                            .publish(ident_topic, data)
                        {
                            Ok(msg_id) => {
                                debug!(%topic_str, %msg_id, "published forum post");
                            }
                            Err(e) => {
                                error!(%topic_str, %e, "failed to publish forum post");
                            }
                        }
                    }
                    Err(e) => {
                        error!(%e, "failed to encode forum post");
                    }
                }
            }

            NodeCommand::BroadcastPresence { status } => {
                // The presence is broadcast by the Tauri layer to per-friend topics.
                // This is a fire-and-forget signal; the Tauri layer constructs the
                // FriendSignal::Presence and sends it via SendFriendSignal per-friend.
                // This command is a convenience that just logs.
                debug!(?status, "broadcast_presence command received (handled by app layer)");
            }

            NodeCommand::SendFriendSignal { peer_id, signal } => {
                // Friend topic: concord/friends/{sorted_peer_ids}
                let my_peer = self.peer_id.clone();
                let mut peers = [my_peer, peer_id.clone()];
                peers.sort();
                let topic_str = format!("concord/friends/{}_{}", peers[0], peers[1]);

                match concord_core::wire::encode(&signal) {
                    Ok(data) => {
                        // Encrypt friend signals with a key derived from the shared topic.
                        // Both peers can derive the same key since they know each other's peer IDs.
                        let friend_key = concord_core::crypto::derive_forum_key(&topic_str);
                        let encrypted_data =
                            match concord_core::crypto::encrypt_channel_message(&friend_key, &data)
                            {
                                Ok((ct, nonce)) => {
                                    let mut envelope = Vec::with_capacity(12 + ct.len());
                                    envelope.extend_from_slice(&nonce);
                                    envelope.extend_from_slice(&ct);
                                    envelope
                                }
                                Err(_) => data, // fallback to plaintext
                            };

                        let ident_topic = gossipsub::IdentTopic::new(&topic_str);
                        match self
                            .swarm
                            .behaviour_mut()
                            .gossipsub
                            .publish(ident_topic, encrypted_data)
                        {
                            Ok(msg_id) => {
                                debug!(%topic_str, %msg_id, "published encrypted friend signal");
                            }
                            Err(e) => {
                                error!(%topic_str, %e, "failed to publish friend signal");
                            }
                        }
                    }
                    Err(e) => {
                        error!(%e, "failed to encode friend signal");
                    }
                }
            }

            NodeCommand::SendServerSignal { server_id, signal } => {
                let topic_str = format!("concord/{}/key-exchange", server_id);
                match concord_core::wire::encode(&signal) {
                    Ok(data) => {
                        // Subscribe, publish, then we leave subscribed for responses
                        let topic = gossipsub::IdentTopic::new(&topic_str);
                        let _ = self.swarm.behaviour_mut().gossipsub.subscribe(&topic);
                        match self
                            .swarm
                            .behaviour_mut()
                            .gossipsub
                            .publish(topic, data)
                        {
                            Ok(msg_id) => {
                                info!(%topic_str, %msg_id, "published server signal");
                            }
                            Err(e) => {
                                error!(%topic_str, %e, "failed to publish server signal");
                            }
                        }
                    }
                    Err(e) => {
                        error!(%e, "failed to encode server signal");
                    }
                }
            }

            NodeCommand::Shutdown => {
                // Handled in the main loop
            }
        }
    }

    /// Emit a network event to all subscribers.
    fn emit(&self, event: NetworkEvent) {
        // broadcast::Sender::send returns Err only if there are no receivers,
        // which is fine — events are fire-and-forget.
        let _ = self.event_tx.send(event);
    }

    /// Emit a ConnectionStatusChanged event with the current peer count.
    fn emit_connection_status(&self) {
        let connected = self.discovery.peer_count();
        self.emit(NetworkEvent::ConnectionStatusChanged {
            connected_peers: connected,
        });
    }
}
