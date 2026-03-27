use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{debug, info, warn};

use concord_core::types::VoiceSignal;
use concord_net::NodeHandle;

use crate::audio::{AudioCapture, AudioPlayback};
use crate::session::VoiceSession;
use crate::signaling::SignalingManager;

/// Commands sent from VoiceEngineHandle to VoiceEngine.
pub enum VoiceCommand {
    /// Join a voice channel.
    JoinChannel {
        server_id: String,
        channel_id: String,
        reply: oneshot::Sender<Result<()>>,
    },
    /// Leave the current voice channel.
    LeaveChannel {
        reply: oneshot::Sender<Result<()>>,
    },
    /// Toggle local mute state.
    ToggleMute {
        reply: oneshot::Sender<bool>,
    },
    /// Toggle local deafen state.
    ToggleDeafen {
        reply: oneshot::Sender<bool>,
    },
    /// Get the current voice state snapshot.
    GetState {
        reply: oneshot::Sender<VoiceStateSnapshot>,
    },
    /// Handle an incoming voice signal from the network.
    HandleSignal {
        signal: VoiceSignal,
    },
}

/// A snapshot of the current voice state, suitable for sending to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceStateSnapshot {
    pub is_in_voice: bool,
    pub channel_id: Option<String>,
    pub server_id: Option<String>,
    pub is_muted: bool,
    pub is_deafened: bool,
    pub participants: Vec<ParticipantInfo>,
}

/// Information about a participant in a voice channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParticipantInfo {
    pub peer_id: String,
    pub is_muted: bool,
    pub is_speaking: bool,
}

/// Events emitted by the voice engine for the UI layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum VoiceEvent {
    /// Successfully joined a voice channel.
    Joined {
        channel_id: String,
        server_id: String,
    },
    /// Left a voice channel.
    Left {
        channel_id: String,
    },
    /// A new participant joined the voice channel.
    ParticipantJoined {
        peer_id: String,
        channel_id: String,
    },
    /// A participant left the voice channel.
    ParticipantLeft {
        peer_id: String,
        channel_id: String,
    },
    /// Local mute state changed.
    MuteChanged {
        is_muted: bool,
    },
    /// Local deafen state changed.
    DeafenChanged {
        is_deafened: bool,
    },
    /// A remote participant's mute state changed.
    ParticipantMuteChanged {
        peer_id: String,
        is_muted: bool,
    },
    /// A remote participant is speaking or stopped speaking.
    ParticipantSpeaking {
        peer_id: String,
        is_speaking: bool,
    },
    /// Full state snapshot changed (catch-all for UI refresh).
    StateChanged {
        state: VoiceStateSnapshot,
    },
}

/// Handle to the voice engine. Clone + Send + Sync, stored in Tauri state.
#[derive(Clone)]
pub struct VoiceEngineHandle {
    command_tx: mpsc::Sender<VoiceCommand>,
}

impl VoiceEngineHandle {
    /// Join a voice channel.
    pub async fn join_channel(&self, server_id: &str, channel_id: &str) -> Result<()> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.command_tx
            .send(VoiceCommand::JoinChannel {
                server_id: server_id.to_string(),
                channel_id: channel_id.to_string(),
                reply: reply_tx,
            })
            .await
            .map_err(|_| anyhow::anyhow!("voice engine has shut down"))?;
        reply_rx
            .await
            .map_err(|_| anyhow::anyhow!("voice engine did not reply"))?
    }

    /// Leave the current voice channel.
    pub async fn leave_channel(&self) -> Result<()> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.command_tx
            .send(VoiceCommand::LeaveChannel { reply: reply_tx })
            .await
            .map_err(|_| anyhow::anyhow!("voice engine has shut down"))?;
        reply_rx
            .await
            .map_err(|_| anyhow::anyhow!("voice engine did not reply"))?
    }

    /// Toggle mute and return the new mute state.
    pub async fn toggle_mute(&self) -> Result<bool> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.command_tx
            .send(VoiceCommand::ToggleMute { reply: reply_tx })
            .await
            .map_err(|_| anyhow::anyhow!("voice engine has shut down"))?;
        reply_rx
            .await
            .map_err(|_| anyhow::anyhow!("voice engine did not reply"))
    }

    /// Toggle deafen and return the new deafen state.
    pub async fn toggle_deafen(&self) -> Result<bool> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.command_tx
            .send(VoiceCommand::ToggleDeafen { reply: reply_tx })
            .await
            .map_err(|_| anyhow::anyhow!("voice engine has shut down"))?;
        reply_rx
            .await
            .map_err(|_| anyhow::anyhow!("voice engine did not reply"))
    }

    /// Get the current voice state snapshot.
    pub async fn get_state(&self) -> Result<VoiceStateSnapshot> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.command_tx
            .send(VoiceCommand::GetState { reply: reply_tx })
            .await
            .map_err(|_| anyhow::anyhow!("voice engine has shut down"))?;
        reply_rx
            .await
            .map_err(|_| anyhow::anyhow!("voice engine did not reply"))
    }

    /// Send a voice signal to the engine (fire-and-forget).
    pub fn handle_signal(&self, signal: VoiceSignal) {
        let tx = self.command_tx.clone();
        // Fire and forget — don't block the caller
        tokio::spawn(async move {
            if let Err(e) = tx.send(VoiceCommand::HandleSignal { signal }).await {
                warn!("failed to send voice signal to engine: {e}");
            }
        });
    }

}
// NOTE: To subscribe to voice events, use the broadcast::Receiver
// returned from VoiceEngine::new(). There is no separate subscribe method.

/// The voice engine. Runs as an async task, processing commands and network signals.
pub struct VoiceEngine {
    session: Option<VoiceSession>,
    signaling: SignalingManager,
    command_rx: mpsc::Receiver<VoiceCommand>,
    event_tx: broadcast::Sender<VoiceEvent>,
    node_handle: NodeHandle,
    local_peer_id: String,
    /// Audio capture (microphone -> Opus frames). None if no input device available.
    audio_capture: Option<AudioCapture>,
    /// Audio playback (Opus frames -> speakers). None if no output device available.
    audio_playback: Option<AudioPlayback>,
    /// Handle to the spawned task that forwards captured audio frames to the network.
    audio_forward_task: Option<tokio::task::JoinHandle<()>>,
}

impl VoiceEngine {
    /// Create a new VoiceEngine and its associated handle.
    ///
    /// Returns `(VoiceEngine, VoiceEngineHandle, broadcast::Receiver<VoiceEvent>)`.
    /// Spawn the engine with `tokio::spawn(async move { engine.run().await })`.
    pub fn new(
        node_handle: NodeHandle,
        local_peer_id: String,
    ) -> (Self, VoiceEngineHandle, broadcast::Receiver<VoiceEvent>) {
        let (command_tx, command_rx) = mpsc::channel(256);
        let (event_tx, event_rx) = broadcast::channel(256);

        let handle = VoiceEngineHandle { command_tx };

        let engine = Self {
            session: None,
            signaling: SignalingManager::new(),
            command_rx,
            event_tx,
            node_handle,
            local_peer_id,
            audio_capture: None,
            audio_playback: None,
            audio_forward_task: None,
        };

        (engine, handle, event_rx)
    }

    /// Run the voice engine event loop.
    pub async fn run(mut self) {
        info!(peer_id = %self.local_peer_id, "voice engine starting");

        while let Some(cmd) = self.command_rx.recv().await {
            self.handle_command(cmd).await;
        }

        // Clean up audio on shutdown
        self.stop_audio();
        info!("voice engine stopped");
    }

    async fn handle_command(&mut self, cmd: VoiceCommand) {
        match cmd {
            VoiceCommand::JoinChannel {
                server_id,
                channel_id,
                reply,
            } => {
                let result = self.do_join(&server_id, &channel_id).await;
                let _ = reply.send(result);
            }

            VoiceCommand::LeaveChannel { reply } => {
                let result = self.do_leave().await;
                let _ = reply.send(result);
            }

            VoiceCommand::ToggleMute { reply } => {
                let new_state = self.do_toggle_mute().await;
                let _ = reply.send(new_state);
            }

            VoiceCommand::ToggleDeafen { reply } => {
                let new_state = self.do_toggle_deafen().await;
                let _ = reply.send(new_state);
            }

            VoiceCommand::GetState { reply } => {
                let snapshot = self.build_snapshot();
                let _ = reply.send(snapshot);
            }

            VoiceCommand::HandleSignal { signal } => {
                self.handle_voice_signal(signal).await;
            }
        }
    }

    /// Start audio capture and playback for a voice session.
    ///
    /// Creates AudioCapture and AudioPlayback, starts both streams, and spawns
    /// a task that reads encoded Opus frames from capture and publishes them
    /// to the voice channel's GossipSub topic.
    ///
    /// If audio devices are unavailable, logs a warning and continues without audio.
    fn start_audio(&mut self, server_id: &str, channel_id: &str) {
        // Create the channel for captured audio frames (std::sync::mpsc, used from cpal callback)
        let (frame_tx, frame_rx) = std::sync::mpsc::channel();

        // --- Audio Capture (microphone) ---
        match AudioCapture::new(frame_tx) {
            Ok(capture) => {
                if let Err(e) = capture.start() {
                    warn!(%e, "failed to start audio capture — continuing without microphone");
                } else {
                    self.audio_capture = Some(capture);
                }
            }
            Err(e) => {
                warn!(%e, "audio capture unavailable — continuing without microphone");
            }
        }

        // --- Audio Playback (speakers) ---
        match AudioPlayback::new() {
            Ok(playback) => {
                if let Err(e) = playback.start() {
                    warn!(%e, "failed to start audio playback — continuing without speakers");
                } else {
                    self.audio_playback = Some(playback);
                }
            }
            Err(e) => {
                warn!(%e, "audio playback unavailable — continuing without speakers");
            }
        }

        // --- Frame forwarding task ---
        // Reads from the std::sync::mpsc receiver (fed by cpal capture callback)
        // and publishes each frame as a VoiceSignal::AudioFrame via GossipSub.
        let node_handle = self.node_handle.clone();
        let peer_id = self.local_peer_id.clone();
        let server_id = server_id.to_string();
        let channel_id = channel_id.to_string();

        let task = tokio::task::spawn(async move {
            loop {
                // Use try_recv in a yield-friendly loop to avoid blocking the async runtime
                match frame_rx.try_recv() {
                    Ok(audio_frame) => {
                        let signal = VoiceSignal::AudioFrame {
                            peer_id: peer_id.clone(),
                            data: audio_frame.data,
                        };
                        if let Err(e) = node_handle
                            .send_voice_signal(&server_id, &channel_id, signal)
                            .await
                        {
                            // Don't spam logs — this can happen if no peers are subscribed
                            debug!(%e, "failed to publish audio frame");
                        }
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                        // No frame ready — yield briefly (5ms ~ quarter of a 20ms Opus frame)
                        tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        // Capture was stopped/dropped
                        debug!("audio frame channel disconnected, stopping forward task");
                        break;
                    }
                }
            }
        });
        self.audio_forward_task = Some(task);

        info!("audio pipeline started");
    }

    /// Stop audio capture, playback, and the frame forwarding task.
    fn stop_audio(&mut self) {
        // Stop capture first (this closes the frame sender, which will terminate the forward task)
        if let Some(capture) = self.audio_capture.take() {
            if let Err(e) = capture.stop() {
                warn!(%e, "error stopping audio capture");
            }
        }

        // Stop playback
        if let Some(playback) = self.audio_playback.take() {
            if let Err(e) = playback.stop() {
                warn!(%e, "error stopping audio playback");
            }
        }

        // Abort the forward task if it's still running
        if let Some(task) = self.audio_forward_task.take() {
            task.abort();
        }

        info!("audio pipeline stopped");
    }

    async fn do_join(&mut self, server_id: &str, channel_id: &str) -> Result<()> {
        // If already in a channel, leave first
        if self.session.is_some() {
            self.do_leave().await?;
        }

        info!(%server_id, %channel_id, "joining voice channel");

        // Subscribe to the voice signaling topic
        let voice_topic = format!("concord/{server_id}/{channel_id}/voice-signal");
        self.node_handle.subscribe(&voice_topic).await?;

        // Create the session
        let mut session = VoiceSession::new(
            channel_id.to_string(),
            server_id.to_string(),
            self.local_peer_id.clone(),
        );
        session.join();
        self.session = Some(session);

        // Start audio capture and playback
        self.start_audio(server_id, channel_id);

        // Broadcast Join signal to peers
        let signal = VoiceSignal::Join {
            peer_id: self.local_peer_id.clone(),
            channel_id: channel_id.to_string(),
            server_id: server_id.to_string(),
        };
        if let Err(e) = self
            .node_handle
            .send_voice_signal(server_id, channel_id, signal)
            .await
        {
            warn!(%e, "failed to send join signal (may be only participant)");
        }

        // Emit event
        self.emit(VoiceEvent::Joined {
            channel_id: channel_id.to_string(),
            server_id: server_id.to_string(),
        });
        self.emit_state_changed();

        Ok(())
    }

    async fn do_leave(&mut self) -> Result<()> {
        let session = match self.session.take() {
            Some(s) => s,
            None => return Ok(()), // Not in a channel, nothing to do
        };

        info!(
            server_id = %session.server_id,
            channel_id = %session.channel_id,
            "leaving voice channel"
        );

        // Stop audio capture and playback
        self.stop_audio();

        // Send Leave signal to peers
        let signal = VoiceSignal::Leave {
            peer_id: self.local_peer_id.clone(),
            channel_id: session.channel_id.clone(),
            server_id: session.server_id.clone(),
        };
        if let Err(e) = self
            .node_handle
            .send_voice_signal(&session.server_id, &session.channel_id, signal)
            .await
        {
            warn!(%e, "failed to send leave signal");
        }

        // Unsubscribe from the voice signaling topic
        let voice_topic = format!(
            "concord/{}/{}/voice-signal",
            session.server_id, session.channel_id
        );
        if let Err(e) = self.node_handle.unsubscribe(&voice_topic).await {
            warn!(%e, "failed to unsubscribe from voice topic");
        }

        // Clear signaling state for all participants
        for peer_id in session.participants.keys() {
            self.signaling.clear_peer(peer_id);
        }

        let channel_id = session.channel_id.clone();

        // Emit event
        self.emit(VoiceEvent::Left { channel_id });
        self.emit_state_changed();

        Ok(())
    }

    async fn do_toggle_mute(&mut self) -> bool {
        let session = match self.session.as_mut() {
            Some(s) => s,
            None => return false,
        };

        let new_mute = !session.is_muted;
        session.set_muted(new_mute);

        // Update audio capture mute state
        if let Some(capture) = &self.audio_capture {
            capture.set_muted(new_mute);
        }

        // Broadcast mute state to peers
        let signal = VoiceSignal::MuteState {
            peer_id: self.local_peer_id.clone(),
            is_muted: new_mute,
        };
        let server_id = session.server_id.clone();
        let channel_id = session.channel_id.clone();
        if let Err(e) = self
            .node_handle
            .send_voice_signal(&server_id, &channel_id, signal)
            .await
        {
            warn!(%e, "failed to send mute state signal");
        }

        self.emit(VoiceEvent::MuteChanged { is_muted: new_mute });
        self.emit_state_changed();

        new_mute
    }

    async fn do_toggle_deafen(&mut self) -> bool {
        let session = match self.session.as_mut() {
            Some(s) => s,
            None => return false,
        };

        let new_deafen = !session.is_deafened;
        session.set_deafened(new_deafen);

        // If deafening also muted, broadcast that too
        if new_deafen {
            // Mute capture when deafened
            if let Some(capture) = &self.audio_capture {
                capture.set_muted(true);
            }

            let signal = VoiceSignal::MuteState {
                peer_id: self.local_peer_id.clone(),
                is_muted: true,
            };
            let server_id = session.server_id.clone();
            let channel_id = session.channel_id.clone();
            if let Err(e) = self
                .node_handle
                .send_voice_signal(&server_id, &channel_id, signal)
                .await
            {
                warn!(%e, "failed to send mute state signal after deafen");
            }
            self.emit(VoiceEvent::MuteChanged { is_muted: true });
        }

        self.emit(VoiceEvent::DeafenChanged {
            is_deafened: new_deafen,
        });
        self.emit_state_changed();

        new_deafen
    }

    async fn handle_voice_signal(&mut self, signal: VoiceSignal) {
        match signal {
            VoiceSignal::Join {
                peer_id,
                channel_id,
                server_id,
            } => {
                // Ignore our own join signals
                if peer_id == self.local_peer_id {
                    return;
                }

                let session = match self.session.as_mut() {
                    Some(s) if s.channel_id == channel_id && s.server_id == server_id => s,
                    _ => return, // Not in this channel
                };

                info!(%peer_id, %channel_id, "participant joined voice channel");
                session.add_participant(&peer_id);

                // Initiate SDP offer to the new peer
                let sdp = self.signaling.create_offer(&peer_id);
                let offer_signal = VoiceSignal::Offer {
                    from_peer: self.local_peer_id.clone(),
                    to_peer: peer_id.clone(),
                    sdp,
                };
                if let Err(e) = self
                    .node_handle
                    .send_voice_signal(&server_id, &channel_id, offer_signal)
                    .await
                {
                    warn!(%e, %peer_id, "failed to send SDP offer");
                }

                self.emit(VoiceEvent::ParticipantJoined {
                    peer_id,
                    channel_id,
                });
                self.emit_state_changed();
            }

            VoiceSignal::Leave {
                peer_id,
                channel_id,
                server_id,
            } => {
                if peer_id == self.local_peer_id {
                    return;
                }

                let session = match self.session.as_mut() {
                    Some(s) if s.channel_id == channel_id && s.server_id == server_id => s,
                    _ => return,
                };

                info!(%peer_id, %channel_id, "participant left voice channel");
                session.remove_participant(&peer_id);
                self.signaling.clear_peer(&peer_id);

                self.emit(VoiceEvent::ParticipantLeft {
                    peer_id,
                    channel_id,
                });
                self.emit_state_changed();
            }

            VoiceSignal::Offer {
                from_peer,
                to_peer,
                sdp,
            } => {
                // Only process offers addressed to us
                if to_peer != self.local_peer_id {
                    return;
                }

                let session = match self.session.as_ref() {
                    Some(s) => s,
                    None => return,
                };

                debug!(%from_peer, "received SDP offer");

                // Add the peer if not already known
                if !session.participants.contains_key(&from_peer) {
                    if let Some(s) = self.session.as_mut() {
                        s.add_participant(&from_peer);
                        let channel_id = s.channel_id.clone();
                        self.emit(VoiceEvent::ParticipantJoined {
                            peer_id: from_peer.clone(),
                            channel_id,
                        });
                    }
                }

                // Create answer
                let answer_sdp = self.signaling.handle_offer(&from_peer, &sdp);
                let session = self.session.as_ref().unwrap();
                let answer_signal = VoiceSignal::Answer {
                    from_peer: self.local_peer_id.clone(),
                    to_peer: from_peer,
                    sdp: answer_sdp,
                };
                if let Err(e) = self
                    .node_handle
                    .send_voice_signal(
                        &session.server_id,
                        &session.channel_id,
                        answer_signal,
                    )
                    .await
                {
                    warn!(%e, "failed to send SDP answer");
                }

                self.emit_state_changed();
            }

            VoiceSignal::Answer {
                from_peer,
                to_peer,
                sdp,
            } => {
                if to_peer != self.local_peer_id {
                    return;
                }

                debug!(%from_peer, "received SDP answer");
                self.signaling.handle_answer(&from_peer, &sdp);
                // Connection is now "established" (placeholder — real media starts with str0m)
            }

            VoiceSignal::IceCandidate {
                from_peer,
                to_peer,
                candidate,
                sdp_mid,
            } => {
                if to_peer != self.local_peer_id {
                    return;
                }

                debug!(%from_peer, "received ICE candidate");
                self.signaling
                    .handle_ice_candidate(&from_peer, &candidate, &sdp_mid);
            }

            VoiceSignal::MuteState { peer_id, is_muted } => {
                if peer_id == self.local_peer_id {
                    return;
                }

                if let Some(session) = self.session.as_mut() {
                    session.update_participant_mute(&peer_id, is_muted);
                    self.emit(VoiceEvent::ParticipantMuteChanged { peer_id, is_muted });
                    self.emit_state_changed();
                }
            }

            VoiceSignal::SpeakingState {
                peer_id,
                is_speaking,
            } => {
                if peer_id == self.local_peer_id {
                    return;
                }

                if let Some(session) = self.session.as_mut() {
                    session.update_participant_speaking(&peer_id, is_speaking);
                    self.emit(VoiceEvent::ParticipantSpeaking {
                        peer_id,
                        is_speaking,
                    });
                    // Don't emit full state change for speaking — it's too frequent
                }
            }

            VoiceSignal::AudioFrame { peer_id, data } => {
                // Ignore our own audio frames
                if peer_id == self.local_peer_id {
                    return;
                }

                // Only play audio if we're in a session and not deafened
                let is_deafened = self
                    .session
                    .as_ref()
                    .map(|s| s.is_deafened)
                    .unwrap_or(true);

                if is_deafened {
                    return;
                }

                // Decode and queue for playback
                if let Some(playback) = &self.audio_playback {
                    if let Err(e) = playback.queue_frame(&data) {
                        debug!(%peer_id, %e, "failed to decode audio frame from peer");
                    }
                }
            }
        }
    }

    /// Build a snapshot of the current voice state.
    fn build_snapshot(&self) -> VoiceStateSnapshot {
        match &self.session {
            Some(session) if session.is_active() => {
                let participants = session
                    .participant_list()
                    .into_iter()
                    .map(|p| ParticipantInfo {
                        peer_id: p.peer_id.clone(),
                        is_muted: p.is_muted,
                        is_speaking: p.is_speaking,
                    })
                    .collect();

                VoiceStateSnapshot {
                    is_in_voice: true,
                    channel_id: Some(session.channel_id.clone()),
                    server_id: Some(session.server_id.clone()),
                    is_muted: session.is_muted,
                    is_deafened: session.is_deafened,
                    participants,
                }
            }
            _ => VoiceStateSnapshot {
                is_in_voice: false,
                channel_id: None,
                server_id: None,
                is_muted: false,
                is_deafened: false,
                participants: Vec::new(),
            },
        }
    }

    /// Emit a voice event to all subscribers.
    fn emit(&self, event: VoiceEvent) {
        let _ = self.event_tx.send(event);
    }

    /// Emit a full state changed event.
    fn emit_state_changed(&self) {
        let state = self.build_snapshot();
        self.emit(VoiceEvent::StateChanged { state });
    }
}
