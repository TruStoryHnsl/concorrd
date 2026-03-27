use chrono::Utc;
use serde::Serialize;
use uuid::Uuid;

use concord_core::crypto::{generate_x25519_keypair, E2ESession};
use concord_core::types::{DirectMessage, DmSignal};

use crate::AppState;

/* ── Payloads ────────────────────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmPayload {
    pub id: String,
    pub peer_id: String,
    pub sender_id: String,
    pub content: String,
    pub timestamp: i64,
}

/* ── Commands ────────────────────────────────────────────────── */

/// Initiate a DM session with a peer by performing X25519 key exchange.
/// Sends our public key to the peer and subscribes to the DM topic.
#[tauri::command]
pub async fn initiate_dm_session(
    state: tauri::State<'_, AppState>,
    peer_id: String,
) -> Result<(), String> {
    let local_peer_id = state.peer_id.clone();

    // Generate X25519 keypair for this session
    let (secret, public) = generate_x25519_keypair();

    // Store the secret temporarily — we'll compute the shared secret when we
    // receive the peer's public key. For now, store the raw secret as a placeholder.
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.save_dm_session_encrypted(&state.device_key, &peer_id, secret.as_bytes().as_slice(), 0, 0)
            .map_err(|e| e.to_string())?;
    }

    // Subscribe to the DM topic
    let mut peers = [local_peer_id.clone(), peer_id.clone()];
    peers.sort();
    let topic = format!("concord/dm/{}/{}", peers[0], peers[1]);
    state
        .node
        .subscribe(&topic)
        .await
        .map_err(|e| e.to_string())?;

    // Send key exchange signal
    let signal = DmSignal::KeyExchange {
        from_peer: local_peer_id,
        to_peer: peer_id,
        public_key: public.as_bytes().to_vec(),
    };

    state
        .node
        .send_dm_signal(signal)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Send an encrypted DM to a peer. Requires an active DM session.
#[tauri::command]
pub async fn send_dm(
    state: tauri::State<'_, AppState>,
    peer_id: String,
    content: String,
) -> Result<DmPayload, String> {
    let local_peer_id = state.peer_id.clone();

    // Load the DM session (decrypted)
    let session_record = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_dm_session_decrypted(&state.device_key, &peer_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no DM session with this peer — initiate first".to_string())?
    };

    // Create E2E session from stored key material
    let mut shared_secret = [0u8; 32];
    if session_record.shared_secret.len() != 32 {
        return Err("invalid session key material".to_string());
    }
    shared_secret.copy_from_slice(&session_record.shared_secret);

    let mut e2e = E2ESession::from_shared_secret(shared_secret)
        .with_counters(session_record.send_count, session_record.recv_count);

    // Encrypt the message
    let (ciphertext, nonce) = e2e
        .encrypt(content.as_bytes())
        .map_err(|e| e.to_string())?;

    let now = Utc::now();
    let msg_id = Uuid::new_v4().to_string();

    let dm = DirectMessage {
        id: msg_id.clone(),
        from_peer: local_peer_id.clone(),
        to_peer: peer_id.clone(),
        ciphertext: ciphertext.clone(),
        nonce: nonce.to_vec(),
        timestamp: now,
    };

    // Store the encrypted message and updated session counters locally
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.store_dm(
            &msg_id,
            &peer_id,
            &local_peer_id,
            &ciphertext,
            &nonce,
            now.timestamp_millis(),
        )
        .map_err(|e| e.to_string())?;

        db.save_dm_session_encrypted(
            &state.device_key,
            &peer_id,
            &session_record.shared_secret,
            e2e.send_count(),
            e2e.recv_count(),
        )
        .map_err(|e| e.to_string())?;
    }

    // Send via the network
    let signal = DmSignal::EncryptedMessage(dm);
    state
        .node
        .send_dm_signal(signal)
        .await
        .map_err(|e| e.to_string())?;

    Ok(DmPayload {
        id: msg_id,
        peer_id,
        sender_id: local_peer_id,
        content,
        timestamp: now.timestamp_millis(),
    })
}

/// Get DM history with a peer. Messages are returned decrypted if a session exists.
#[tauri::command]
pub fn get_dm_history(
    state: tauri::State<'_, AppState>,
    peer_id: String,
    limit: Option<u32>,
) -> Result<Vec<DmPayload>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let records = db
        .get_dm_history(&peer_id, limit.unwrap_or(50))
        .map_err(|e| e.to_string())?;

    // Try to load the session for decryption (using device key)
    let session_opt = db.get_dm_session_decrypted(&state.device_key, &peer_id).map_err(|e| e.to_string())?;

    let payloads: Vec<DmPayload> = records
        .iter()
        .map(|r| {
            let content = if let Some(ref sess) = session_opt {
                if sess.shared_secret.len() == 32 {
                    let mut secret = [0u8; 32];
                    secret.copy_from_slice(&sess.shared_secret);
                    let mut e2e = E2ESession::from_shared_secret(secret);
                    if r.nonce.len() == 12 {
                        let mut nonce = [0u8; 12];
                        nonce.copy_from_slice(&r.nonce);
                        e2e.decrypt(&r.content_encrypted, &nonce)
                            .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
                            .unwrap_or_else(|_| "[encrypted]".to_string())
                    } else {
                        "[encrypted]".to_string()
                    }
                } else {
                    "[encrypted]".to_string()
                }
            } else {
                "[encrypted]".to_string()
            };

            DmPayload {
                id: r.id.clone(),
                peer_id: r.peer_id.clone(),
                sender_id: r.sender_id.clone(),
                content,
                timestamp: r.timestamp,
            }
        })
        .collect();

    Ok(payloads)
}
