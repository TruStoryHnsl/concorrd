use serde::{Deserialize, Serialize};

use concord_core::trust::TrustAttestation;
use concord_core::types::{AliasAnnouncement, DmSignal, ForumPost, FriendSignal, Message, PresenceStatus, ServerSignal, VoiceSignal};

/// Events emitted by the network layer to the application.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetworkEvent {
    /// A new peer was discovered (mDNS or DHT).
    PeerDiscovered {
        peer_id: String,
        addresses: Vec<String>,
        display_name: Option<String>,
    },

    /// A previously known peer went offline or became unreachable.
    PeerDeparted { peer_id: String },

    /// A message was received on a subscribed GossipSub topic.
    MessageReceived {
        topic: String,
        source: String,
        data: Vec<u8>,
    },

    /// A typed Concord message was received and successfully decoded.
    ConcordMessageReceived { message: Message },

    /// Successfully joined (subscribed to) a channel topic.
    ChannelJoined {
        server_id: String,
        channel_id: String,
    },

    /// Left (unsubscribed from) a channel topic.
    ChannelLeft {
        server_id: String,
        channel_id: String,
    },

    /// A direct (private) message was received from a peer.
    DirectMessage {
        sender_id: String,
        content: Vec<u8>,
    },

    /// Connection status changed.
    ConnectionStatusChanged { connected_peers: usize },

    /// Voice signaling message received.
    VoiceSignalReceived { signal: VoiceSignal },

    /// A tunnel (connection) to a peer was established.
    TunnelEstablished {
        peer_id: String,
        connection_type: String,
        address: String,
    },

    /// A tunnel (connection) to a peer was closed.
    TunnelClosed { peer_id: String },

    /// A trust attestation was received via GossipSub.
    AttestationReceived {
        attestation: TrustAttestation,
    },

    /// A DM signal (key exchange or encrypted message) was received.
    DmSignalReceived {
        signal: DmSignal,
    },

    /// An alias announcement was received via GossipSub.
    AliasAnnouncementReceived {
        announcement: AliasAnnouncement,
    },

    /// A forum post was received via GossipSub.
    ForumPostReceived {
        post: ForumPost,
    },

    /// A friend signal was received via GossipSub.
    FriendSignalReceived {
        signal: FriendSignal,
    },

    /// A presence update was received from a friend.
    PresenceUpdate {
        peer_id: String,
        status: PresenceStatus,
    },

    /// A server key exchange signal was received.
    ServerSignalReceived {
        server_id: String,
        signal: ServerSignal,
    },
}
