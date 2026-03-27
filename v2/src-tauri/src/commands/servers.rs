use serde::Serialize;
use uuid::Uuid;

use concord_core::types::{Channel, ChannelType, Server, Visibility};

use crate::AppState;

// ── Payload structs ─────────────────────────────────────────────────

/// JSON payload for a server, sent to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPayload {
    pub id: String,
    pub name: String,
    pub owner_id: String,
    pub visibility: String,
    pub channels: Vec<ChannelPayload>,
    pub member_count: u32,
    pub invite_code: Option<String>,
}

/// JSON payload for a channel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPayload {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub channel_type: String,
}

/// JSON payload for an invite.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitePayload {
    pub code: String,
    pub server_id: String,
    pub created_by: String,
}

/// JSON payload for a member.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberPayload {
    pub peer_id: String,
    pub role: String,
    pub joined_at: i64,
}

// ── Helpers ─────────────────────────────────────────────────────────

fn visibility_from_str(s: &str) -> Visibility {
    match s {
        "public" => Visibility::Public,
        "federated" => Visibility::Federated,
        _ => Visibility::Private,
    }
}

fn visibility_to_string(v: &Visibility) -> &'static str {
    match v {
        Visibility::Public => "public",
        Visibility::Private => "private",
        Visibility::Federated => "federated",
    }
}

fn channel_type_to_string(ct: &ChannelType) -> &'static str {
    match ct {
        ChannelType::Text => "text",
        ChannelType::Voice => "voice",
        ChannelType::Video => "video",
    }
}

fn channel_to_payload(ch: &Channel) -> ChannelPayload {
    ChannelPayload {
        id: ch.id.clone(),
        server_id: ch.server_id.clone(),
        name: ch.name.clone(),
        channel_type: channel_type_to_string(&ch.channel_type).to_string(),
    }
}

fn generate_invite_code() -> String {
    // 8-char alphanumeric code from a UUID
    Uuid::new_v4().to_string().replace('-', "")[..8].to_string()
}

/// Build a full ServerPayload from the database.
fn build_server_payload(
    db: &concord_store::Database,
    server: &Server,
) -> Result<ServerPayload, String> {
    let channels = db
        .get_channels(&server.id)
        .map_err(|e| e.to_string())?;
    let member_count = db
        .get_member_count(&server.id)
        .map_err(|e| e.to_string())?;
    let invite = db
        .get_server_invite(&server.id)
        .map_err(|e| e.to_string())?;

    Ok(ServerPayload {
        id: server.id.clone(),
        name: server.name.clone(),
        owner_id: server.owner_id.clone(),
        visibility: visibility_to_string(&server.visibility).to_string(),
        channels: channels.iter().map(channel_to_payload).collect(),
        member_count,
        invite_code: invite.map(|i| i.code),
    })
}

/// Subscribe to all channel topics for a server.
async fn subscribe_to_server_channels(
    node: &concord_net::NodeHandle,
    server_id: &str,
    channels: &[Channel],
) -> Result<(), String> {
    for ch in channels {
        let topic = format!("concord/{server_id}/{}", ch.id);
        node.subscribe(&topic)
            .await
            .map_err(|e| format!("subscribe error for channel {}: {}", ch.name, e))?;
    }
    Ok(())
}

// ── Commands ────────────────────────────────────────────────────────

/// Validate a user-provided name (server or channel).
fn validate_name(name: &str, kind: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(format!("{kind} name cannot be empty"));
    }
    if trimmed.len() > 64 {
        return Err(format!("{kind} name cannot exceed 64 characters"));
    }
    // Strip control characters
    let clean: String = trimmed.chars().filter(|c| !c.is_control()).collect();
    if clean.is_empty() {
        return Err(format!("{kind} name must contain visible characters"));
    }
    Ok(clean)
}

/// Creates a new server with default channels and adds the creator as owner.
#[tauri::command]
pub async fn create_server(
    state: tauri::State<'_, AppState>,
    name: String,
    visibility: Option<String>,
) -> Result<ServerPayload, String> {
    let name = validate_name(&name, "Server")?;
    let server_id = Uuid::new_v4().to_string();
    let vis = visibility_from_str(&visibility.unwrap_or_else(|| "private".into()));

    let server = Server {
        id: server_id.clone(),
        name,
        owner_id: state.peer_id.clone(),
        visibility: vis,
    };

    // Default channels
    let general = Channel {
        id: Uuid::new_v4().to_string(),
        server_id: server_id.clone(),
        name: "general".into(),
        channel_type: ChannelType::Text,
    };
    let voice_lobby = Channel {
        id: Uuid::new_v4().to_string(),
        server_id: server_id.clone(),
        name: "voice-lobby".into(),
        channel_type: ChannelType::Voice,
    };

    let invite_code = generate_invite_code();

    // Generate a server encryption key for channel E2E encryption.
    let server_secret = concord_core::crypto::generate_random_key();

    // Persist to DB
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.create_server(&server).map_err(|e| e.to_string())?;
        db.create_channel(&general).map_err(|e| e.to_string())?;
        db.create_channel(&voice_lobby).map_err(|e| e.to_string())?;
        db.add_member(&server_id, &state.peer_id, "owner")
            .map_err(|e| e.to_string())?;
        db.create_invite(&invite_code, &server_id, &state.peer_id, None)
            .map_err(|e| e.to_string())?;
        db.store_server_key(&server_id, &server_secret)
            .map_err(|e| e.to_string())?;
    }

    // Subscribe to all channel topics
    let channels = vec![general, voice_lobby];
    subscribe_to_server_channels(&state.node, &server_id, &channels).await?;

    // Build payload
    let db = state.db.lock().map_err(|e| e.to_string())?;
    build_server_payload(&db, &server)
}

/// Gets all servers the current user is a member of.
#[tauri::command]
pub fn get_servers(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ServerPayload>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let servers = db
        .get_user_servers(&state.peer_id)
        .map_err(|e| e.to_string())?;

    servers
        .iter()
        .map(|s| build_server_payload(&db, s))
        .collect()
}

/// Gets a specific server by ID with its channels.
#[tauri::command]
pub fn get_server(
    state: tauri::State<'_, AppState>,
    server_id: String,
) -> Result<ServerPayload, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let server = db
        .get_server(&server_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("server not found: {server_id}"))?;
    build_server_payload(&db, &server)
}

/// Gets all channels for a server.
#[tauri::command]
pub fn get_channels(
    state: tauri::State<'_, AppState>,
    server_id: String,
) -> Result<Vec<ChannelPayload>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let channels = db
        .get_channels(&server_id)
        .map_err(|e| e.to_string())?;
    Ok(channels.iter().map(channel_to_payload).collect())
}

/// Joins a server using an invite code.
#[tauri::command]
pub async fn join_server(
    state: tauri::State<'_, AppState>,
    invite_code: String,
) -> Result<ServerPayload, String> {
    let (server, channels) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;

        // Look up and use the invite
        let server_id = db
            .use_invite(&invite_code)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "invalid or exhausted invite code".to_string())?;

        // Check if already a member
        let already = db
            .is_member(&server_id, &state.peer_id)
            .map_err(|e| e.to_string())?;

        if !already {
            db.add_member(&server_id, &state.peer_id, "member")
                .map_err(|e| e.to_string())?;
        }

        let server = db
            .get_server(&server_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("server not found: {server_id}"))?;

        let channels = db
            .get_channels(&server_id)
            .map_err(|e| e.to_string())?;

        (server, channels)
    };

    // Subscribe to all channel topics
    subscribe_to_server_channels(&state.node, &server.id, &channels).await?;

    // Request the server encryption key from existing members.
    // We derive an X25519 public key from our Ed25519 signing key for the key exchange.
    let x_secret = x25519_dalek::StaticSecret::from(state.keypair.to_bytes());
    let x_public = x25519_dalek::PublicKey::from(&x_secret);
    let key_request = concord_core::types::ServerSignal::KeyRequest {
        peer_id: state.peer_id.clone(),
        x25519_public_key: x_public.as_bytes().to_vec(),
    };
    let _ = state.node.send_server_signal(&server.id, key_request).await;

    // Subscribe to the key-exchange topic to receive the response
    let key_topic = format!("concord/{}/key-exchange", server.id);
    let _ = state.node.subscribe(&key_topic).await;

    // Build payload
    let db = state.db.lock().map_err(|e| e.to_string())?;
    build_server_payload(&db, &server)
}

/// Creates a new invite code for a server.
#[tauri::command]
pub fn create_invite(
    state: tauri::State<'_, AppState>,
    server_id: String,
) -> Result<InvitePayload, String> {
    let code = generate_invite_code();
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.create_invite(&code, &server_id, &state.peer_id, None)
        .map_err(|e| e.to_string())?;

    Ok(InvitePayload {
        code,
        server_id,
        created_by: state.peer_id.clone(),
    })
}

/// Gets all members of a server.
#[tauri::command]
pub fn get_server_members(
    state: tauri::State<'_, AppState>,
    server_id: String,
) -> Result<Vec<MemberPayload>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let members = db
        .get_members(&server_id)
        .map_err(|e| e.to_string())?;

    Ok(members
        .into_iter()
        .map(|m| MemberPayload {
            peer_id: m.peer_id,
            role: m.role,
            joined_at: m.joined_at,
        })
        .collect())
}

/// Leaves a server (removes self from members, unsubscribes from channel topics).
#[tauri::command]
pub async fn leave_server(
    state: tauri::State<'_, AppState>,
    server_id: String,
) -> Result<(), String> {
    let channels = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.remove_member(&server_id, &state.peer_id)
            .map_err(|e| e.to_string())?;
        db.get_channels(&server_id)
            .map_err(|e| e.to_string())?
    };

    // Unsubscribe from all channel topics
    for ch in &channels {
        let topic = format!("concord/{server_id}/{}", ch.id);
        let _ = state.node.unsubscribe(&topic).await;
    }

    Ok(())
}
