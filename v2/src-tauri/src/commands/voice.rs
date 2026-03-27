use serde::Serialize;
use tauri::State;

use crate::AppState;

/* ── Payloads ────────────────────────────────────────────────── */

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatePayload {
    pub is_in_voice: bool,
    pub channel_id: Option<String>,
    pub server_id: Option<String>,
    pub is_muted: bool,
    pub is_deafened: bool,
    pub participants: Vec<ParticipantPayload>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantPayload {
    pub peer_id: String,
    pub is_muted: bool,
    pub is_speaking: bool,
}

impl From<concord_media::VoiceStateSnapshot> for VoiceStatePayload {
    fn from(s: concord_media::VoiceStateSnapshot) -> Self {
        Self {
            is_in_voice: s.is_in_voice,
            channel_id: s.channel_id,
            server_id: s.server_id,
            is_muted: s.is_muted,
            is_deafened: s.is_deafened,
            participants: s
                .participants
                .into_iter()
                .map(|p| ParticipantPayload {
                    peer_id: p.peer_id,
                    is_muted: p.is_muted,
                    is_speaking: p.is_speaking,
                })
                .collect(),
        }
    }
}

/* ── Commands ────────────────────────────────────────────────── */

/// Join a voice channel. The media engine establishes a WebRTC session
/// with the channel's SFU host (or directly for small groups).
#[tauri::command]
pub async fn join_voice(
    state: State<'_, AppState>,
    server_id: String,
    channel_id: String,
) -> Result<VoiceStatePayload, String> {
    state
        .voice
        .join_channel(&server_id, &channel_id)
        .await
        .map_err(|e| e.to_string())?;

    let snapshot = state
        .voice
        .get_state()
        .await
        .map_err(|e| e.to_string())?;

    Ok(VoiceStatePayload::from(snapshot))
}

/// Leave the currently connected voice channel.
#[tauri::command]
pub async fn leave_voice(
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .voice
        .leave_channel()
        .await
        .map_err(|e| e.to_string())
}

/// Toggle local microphone mute. Returns the new muted state.
#[tauri::command]
pub async fn toggle_mute(
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .voice
        .toggle_mute()
        .await
        .map_err(|e| e.to_string())
}

/// Toggle deafen (mute all incoming audio). Returns the new deafened state.
#[tauri::command]
pub async fn toggle_deafen(
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .voice
        .toggle_deafen()
        .await
        .map_err(|e| e.to_string())
}

/// Query the current voice connection state.
#[tauri::command]
pub async fn get_voice_state(
    state: State<'_, AppState>,
) -> Result<VoiceStatePayload, String> {
    let snapshot = state
        .voice
        .get_state()
        .await
        .map_err(|e| e.to_string())?;

    Ok(VoiceStatePayload::from(snapshot))
}
