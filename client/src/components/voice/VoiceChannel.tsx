import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  useParticipants,
  useLocalParticipant,
  useConnectionState,
  useTracks,
  VideoTrack,
} from "@livekit/components-react";
import { Track, ConnectionState } from "livekit-client";
import "@livekit/components-styles";
import { useAuthStore } from "../../stores/auth";
import { useSettingsStore } from "../../stores/settings";
import { useVoiceStore } from "../../stores/voice";
import { useServerStore } from "../../stores/server";
import { useDisplayName } from "../../hooks/useDisplayName";
import { useVoiceNotifications } from "../../hooks/useVoiceNotifications";
import { useMutedSpeaking } from "../../hooks/useMutedSpeaking";
import { useToastStore } from "../../stores/toast";
import { updateDisplayName, getVoiceParticipants, getChannelLockStatus, verifyChannelPin, startVoteKick, getActiveVoteKicks, lockChannel, unlockChannel, getMyKickCount } from "../../api/concord";
import { SoundboardPanel } from "./SoundboardPanel";
import { Avatar } from "../ui/Avatar";
import { PinDialog } from "../moderation/PinDialog";
import { VoteKickBanner } from "../moderation/VoteKickBanner";
import { BanOverlay } from "../moderation/BanOverlay";
import { joinVoiceSession } from "./joinVoiceSession";
import {
  buildLiveKitAudioCaptureOptions,
  buildMicTrackConstraints,
  getVoiceInputProcessor,
} from "../../voice/noiseGate";

interface VoiceChannelProps {
  roomId: string;
  channelName: string;
  serverId: string;
}

export function VoiceChannel({ roomId, channelName, serverId }: VoiceChannelProps) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const voiceConnected = useVoiceStore((s) => s.connected);
  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const activeServer = useServerStore((s) => s.servers.find((sv) => sv.id === serverId));
  const activeChannelId = useServerStore((s) => s.activeChannelId);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDiag, setErrorDiag] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [pinVerified, setPinVerified] = useState(false);

  // Check lock status
  const activeChannel = activeServer?.channels.find((c) => c.matrix_room_id === roomId);

  useEffect(() => {
    if (!accessToken || !activeChannel) return;
    getChannelLockStatus(activeChannel.id, accessToken)
      .then((res) => setIsLocked(res.locked))
      .catch(() => {});
  }, [accessToken, activeChannel]);

  // Fetch participants for preview (before joining)
  const [previewParticipants, setPreviewParticipants] = useState<{ identity: string; name: string }[]>([]);
  useEffect(() => {
    if (!accessToken || !roomId) return;
    if (voiceConnected && voiceChannelId === roomId) return; // already connected
    const fetchParticipants = () => {
      getVoiceParticipants([roomId], accessToken)
        .then((data) => setPreviewParticipants(data[roomId] || []))
        .catch(() => {});
    };
    fetchParticipants();
    const interval = setInterval(fetchParticipants, 5000);
    return () => clearInterval(interval);
  }, [accessToken, roomId, voiceConnected, voiceChannelId]);
  const visiblePreviewParticipants = previewParticipants;

  const handleJoin = useCallback(async () => {
    if (!accessToken) return;
    setConnecting(true);
    setError(null);
    try {
      await joinVoiceSession({
        roomId,
        channelName,
        serverId,
        accessToken,
        activeServer,
        activeChannelId,
        channelType: activeChannel?.channel_type === "place" ? "place" : "voice",
      });
    } catch (err) {
      console.error("Failed to join voice:", err);
      const msg = err instanceof Error ? err.message : "Failed to connect";

      // Classify the error for actionable diagnostics
      let diag: string | null = null;
      if (msg.includes("Failed to get voice token") || msg.includes("401") || msg.includes("403")) {
        diag = "Authentication failed. Try logging out and back in.";
      } else if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("net::ERR")) {
        diag = "Cannot reach the voice server. Check your internet connection.";
      } else if (msg.includes("404")) {
        diag = "Voice service not found. The server may not have LiveKit configured.";
      } else if (msg.includes("500") || msg.includes("Internal")) {
        diag = "Voice server error. An admin should check the server logs.";
      } else if (msg.includes("WebSocket") || msg.includes("signaling")) {
        diag = "WebSocket signaling failed. This may be a firewall or proxy issue blocking wss:// connections.";
      } else if (msg.includes("ICE") || msg.includes("TURN") || msg.includes("STUN")) {
        diag = "NAT traversal failed. The TURN relay may be unreachable — this deployment expects the configured TURN edge and relay ports to be reachable.";
      }

      setError(msg);
      setErrorDiag(diag);
      setRetryCount((c) => c + 1);
    } finally {
      setConnecting(false);
    }
  }, [
    roomId,
    accessToken,
    serverId,
    channelName,
    activeServer,
    activeChannelId,
  ]);

  // Show join screen if not connected to THIS channel
  if (!voiceConnected || voiceChannelId !== roomId) {
    const needsPin = isLocked && !pinVerified;
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <p className="text-on-surface-variant flex items-center gap-2">
          {isLocked && (
            <svg className="w-4 h-4 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          )}
          Voice Channel: #{channelName}
        </p>

        {/* Participant preview */}
        {visiblePreviewParticipants.length > 0 && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs text-on-surface-variant">{visiblePreviewParticipants.length} in channel</p>
            <div className={`flex gap-3 ${needsPin ? "opacity-40 blur-[2px]" : ""}`}>
              {visiblePreviewParticipants.map((p) => (
                <div key={p.identity} className="flex flex-col items-center gap-1">
                  <Avatar userId={p.identity} size="lg" />
                  <span className="text-xs text-on-surface-variant max-w-[80px] truncate">
                    {p.name || p.identity.split(":")[0].replace("@", "")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {visiblePreviewParticipants.length === 0 && (
          <p className="text-on-surface-variant/50 text-sm">No one in this channel yet</p>
        )}

        {voiceConnected && voiceChannelId !== roomId && (
          <p className="text-yellow-400 text-sm">
            Already connected to another voice channel. Leave first.
          </p>
        )}

        {needsPin ? (
          <button
            onClick={() => setShowPinDialog(true)}
            disabled={voiceConnected && voiceChannelId !== roomId}
            className="px-6 py-3 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface font-medium rounded-lg transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Enter PIN to Join
          </button>
        ) : (
          <button
            onClick={handleJoin}
            disabled={connecting || (voiceConnected && voiceChannelId !== roomId)}
            className="px-6 py-3 bg-secondary-container hover:bg-secondary-container disabled:opacity-40 text-on-surface font-medium rounded-lg transition-colors"
          >
            {connecting ? "Connecting..." : "Join Voice"}
          </button>
        )}
        {error && (
          <div className="flex flex-col items-center gap-2 max-w-md text-center">
            <p className="text-error text-sm">{error}</p>
            {errorDiag && (
              <p className="text-on-surface-variant/70 text-xs">{errorDiag}</p>
            )}
            {retryCount > 0 && retryCount < 5 && (
              <button
                onClick={() => { setError(null); setErrorDiag(null); handleJoin(); }}
                disabled={connecting}
                className="px-4 py-1.5 bg-surface-container hover:bg-surface-container-highest text-on-surface text-sm rounded-md transition-colors"
              >
                {connecting ? "Retrying..." : `Retry (attempt ${retryCount + 1})`}
              </button>
            )}
            {retryCount >= 5 && (
              <p className="text-on-surface-variant/50 text-xs">
                Multiple connection attempts failed. Check your network or contact an admin.
              </p>
            )}
          </div>
        )}

        {showPinDialog && activeChannel && (
          <PinDialog
            title="Locked Channel"
            description="Enter the 4-digit PIN to access this channel."
            submitLabel="Unlock"
            onCancel={() => setShowPinDialog(false)}
            onSubmit={async (pin) => {
              if (!accessToken) return;
              await verifyChannelPin(activeChannel.id, pin, accessToken);
              setPinVerified(true);
              setShowPinDialog(false);
            }}
          />
        )}
      </div>
    );
  }

  // Connected to this channel — show the room UI
  // LiveKitRoom is provided by App.tsx, so we can use LiveKit hooks directly
  return <VoiceRoomUI channelName={channelName} serverId={serverId} />;
}

function VoiceRoomUI({
  channelName,
  serverId,
}: {
  channelName: string;
  serverId: string;
}) {
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const connectionState = useConnectionState();
  const tracks = useTracks([Track.Source.Microphone]);
  const allCameraTracks = useTracks([Track.Source.Camera]);
  // Filter to only active (unmuted, subscribed) camera tracks — setCameraEnabled(false)
  // mutes the publication but useTracks still returns it.
  const cameraTracks = allCameraTracks.filter(
    (t) => t.publication && !t.publication.isMuted && t.publication.track,
  );
  const allScreenTracks = useTracks([Track.Source.ScreenShare]);
  const screenTracks = allScreenTracks.filter(
    (t) => t.publication && !t.publication.isMuted && t.publication.track,
  );
  const disconnect = useVoiceStore((s) => s.disconnect);
  const [micError, setMicError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const echoCancellation = useSettingsStore((s) => s.echoCancellation);
  const noiseSuppression = useSettingsStore((s) => s.noiseSuppression);
  const autoGainControl = useSettingsStore((s) => s.autoGainControl);
  const masterInputVolume = useSettingsStore((s) => s.masterInputVolume);
  const inputNoiseGateEnabled = useSettingsStore((s) => s.inputNoiseGateEnabled);
  const inputNoiseGateThresholdDb = useSettingsStore((s) => s.inputNoiseGateThresholdDb);
  const userVolumes = useSettingsStore((s) => s.userVolumes);
  const setUserVolume = useSettingsStore((s) => s.setUserVolume);
  const masterOutputVolume = useSettingsStore((s) => s.masterOutputVolume);
  const userMuted = useSettingsStore((s) => s.userMuted);
  const toggleUserMuted = useSettingsStore((s) => s.toggleUserMuted);
  const accessToken = useAuthStore((s) => s.accessToken);
  const addToast = useToastStore((s) => s.addToast);
  const activeServer = useServerStore((s) => s.servers.find((sv) => sv.id === serverId));
  const visibleParticipants = participants;

  // Vote kick state
  const [activeVotes, setActiveVotes] = useState<{ id: number; channel_id: string; target_user_id: string; initiated_by: string; yes_count: number; no_count: number; total_eligible: number }[]>([]);

  // Ban overlay state
  const [banOverlay, setBanOverlay] = useState<{ banMode: "soft" | "harsh"; kickCount: number; kickLimit: number } | null>(null);
  const lastKickCountRef = useRef<number | null>(null);

  // Poll for active vote kicks
  useEffect(() => {
    if (!accessToken) return;
    const poll = () => {
      getActiveVoteKicks(serverId, accessToken)
        .then(setActiveVotes)
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [serverId, accessToken]);

  // Poll for kicks against the current user (to detect being vote-kicked)
  useEffect(() => {
    if (!accessToken) return;
    const poll = () => {
      getMyKickCount(serverId, accessToken)
        .then((data) => {
          if (lastKickCountRef.current === null) {
            lastKickCountRef.current = data.kick_count;
            return;
          }
          if (data.kick_count > lastKickCountRef.current) {
            lastKickCountRef.current = data.kick_count;
            // User was kicked — show overlay and disconnect
            setBanOverlay({
              banMode: data.ban_mode as "soft" | "harsh",
              kickCount: data.kick_count,
              kickLimit: data.kick_limit,
            });
            disconnect();
          }
        })
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [serverId, accessToken, disconnect]);

  const handleStartVoteKick = async (targetUserId: string) => {
    if (!accessToken) return;
    const channelId = useVoiceStore.getState().channelId;
    if (!channelId) return;
    try {
      // total_eligible = everyone except the target
      const eligible = visibleParticipants.length - 1;
      await startVoteKick(serverId, channelId, targetUserId, eligible, accessToken);
      addToast("Vote kick started");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to start vote kick");
    }
  };

  // Channel lock state for toggle button
  const [channelLocked, setChannelLocked] = useState(false);
  const [isLockOwner, setIsLockOwner] = useState(false);
  const [showLockPinDialog, setShowLockPinDialog] = useState(false);
  const [lockAction, setLockAction] = useState<"lock" | "unlock">("lock");
  const activeChannel = useServerStore((s) => {
    const server = s.servers.find((sv) => sv.id === serverId);
    return server?.channels.find((c) => c.matrix_room_id === useVoiceStore.getState().channelId);
  });

  useEffect(() => {
    if (!accessToken || !activeChannel) return;
    getChannelLockStatus(activeChannel.id, accessToken)
      .then((res) => {
        setChannelLocked(res.locked);
        setIsLockOwner(res.is_owner);
      })
      .catch(() => {});
  }, [accessToken, activeChannel]);

  // Play join/leave sounds
  useVoiceNotifications(visibleParticipants, localParticipant.identity, masterOutputVolume);

  const isMicEnabled = localParticipant.isMicrophoneEnabled;
  const isCameraEnabled = localParticipant.isCameraEnabled;
  const isScreenShareEnabled = localParticipant.isScreenShareEnabled;

  // INS-048: Propagate mic/camera state to the voice store so ChatLayout
  // top bar can show the hardware state indicator without needing LiveKit
  // context (which is only available inside VoiceRoomUI).
  const setMicActive = useVoiceStore((s) => s.setMicActive);
  const setCameraActive = useVoiceStore((s) => s.setCameraActive);
  useEffect(() => { setMicActive(isMicEnabled); }, [isMicEnabled, setMicActive]);
  useEffect(() => { setCameraActive(isCameraEnabled); }, [isCameraEnabled, setCameraActive]);
  const preferredInputDeviceId = useSettingsStore((s) => s.preferredInputDeviceId);
  const voiceInputSettings = {
    masterInputVolume,
    preferredInputDeviceId,
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    inputNoiseGateEnabled,
    inputNoiseGateThresholdDb,
  } as const;
  const mutedSpeakingConstraints = useMemo(
    () => buildMicTrackConstraints(voiceInputSettings),
    [
      masterInputVolume,
      preferredInputDeviceId,
      echoCancellation,
      noiseSuppression,
      autoGainControl,
      inputNoiseGateEnabled,
      inputNoiseGateThresholdDb,
    ],
  );

  // Detect speaking while self-muted (local-only reminder)
  const isMutedSpeaking = useMutedSpeaking(
    isMicEnabled,
    mutedSpeakingConstraints,
    inputNoiseGateThresholdDb,
  );

  useEffect(() => {
    const processor = getVoiceInputProcessor(voiceInputSettings);
    const micTrack = localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
    if (!micTrack) return;
    // LiveKit throws "Audio context needs to be set on LocalAudioTrack in
    // order to enable processors" if the track has no audioContext. That
    // used to surface to the user as a "Voice failed" toast and cascade
    // into a disconnect. The room-level webAudioMix=true option normally
    // attaches an AudioContext at track creation, but there's a short
    // window during reconnects / track swaps where it's still undefined
    // — skip silently there and let the next effect run pick it up once
    // the track is fully set up.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(micTrack as any).audioContext) return;
    const currentProcessor = micTrack.getProcessor();
    if (!currentProcessor || currentProcessor.name !== processor.name) {
      micTrack.setProcessor(processor).catch((error) => {
        console.warn("Failed to enable local mic noise gate", error);
      });
    }
  }, [
    localParticipant,
    masterInputVolume,
    preferredInputDeviceId,
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    inputNoiseGateEnabled,
    inputNoiseGateThresholdDb,
  ]);

  const [cameraLoading, setCameraLoading] = useState(false);
  const [quickSettingsOpen, setQuickSettingsOpen] = useState(false);

  const toggleCamera = useCallback(async () => {
    setCameraError(null);
    const enabling = !isCameraEnabled;
    if (enabling) setCameraLoading(true);
    try {
      await localParticipant.setCameraEnabled(enabling);
    } catch (err) {
      console.error("Camera toggle failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Permission") || msg.includes("NotAllowed")) {
        setCameraError(
          window.isSecureContext
            ? "Camera permission denied. Check browser settings."
            : "Camera requires HTTPS.",
        );
      } else {
        setCameraError(msg);
      }
    } finally {
      setCameraLoading(false);
    }
  }, [localParticipant, isCameraEnabled]);

  const [screenShareError, setScreenShareError] = useState<string | null>(null);

  const toggleScreenShare = useCallback(async () => {
    setScreenShareError(null);
    try {
      await localParticipant.setScreenShareEnabled(!isScreenShareEnabled);
    } catch (err) {
      console.error("Screen share toggle failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Permission") || msg.includes("NotAllowed")) {
        setScreenShareError("Screen share was cancelled or denied.");
      } else {
        setScreenShareError(msg);
      }
    }
  }, [localParticipant, isScreenShareEnabled]);

  const toggleMic = useCallback(async () => {
    setMicError(null);
    try {
      if (!isMicEnabled) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: buildMicTrackConstraints(voiceInputSettings),
          });
          stream.getTracks().forEach((t) => t.stop());
        } catch {
          // Permission already granted or will be handled by LiveKit
        }
      }
      await localParticipant.setMicrophoneEnabled(
        !isMicEnabled,
        !isMicEnabled ? buildLiveKitAudioCaptureOptions(voiceInputSettings) : undefined,
      );
    } catch (err) {
      console.error("Mic toggle failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Permission") || msg.includes("NotAllowed")) {
        setMicError(
          window.isSecureContext
            ? "Microphone permission denied. Check browser settings."
            : "Microphone requires HTTPS. Access via localhost or enable SSL.",
        );
      } else {
        setMicError(msg);
      }
    }
  }, [localParticipant, isMicEnabled, masterInputVolume, preferredInputDeviceId, echoCancellation, noiseSuppression, autoGainControl, inputNoiseGateEnabled, inputNoiseGateThresholdDb]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Desktop header — hidden on mobile (controls move to bottom) */}
      <div className="hidden md:block p-4 border-b border-outline-variant/15 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ConnectionIndicator state={connectionState} />
            <span className="text-on-surface-variant text-sm">#{channelName}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={toggleMic} className={`btn-press px-3 py-1.5 text-sm rounded-md transition-colors ${isMicEnabled ? "bg-surface-container hover:bg-surface-container-highest text-on-surface" : "bg-error/20 hover:bg-error-container/30 text-error"}`}>
              {isMicEnabled ? "Mute" : "Unmute"}
            </button>
            <button onClick={toggleCamera} disabled={cameraLoading} className={`btn-press px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 ${cameraLoading ? "bg-primary/10 text-primary opacity-75 cursor-wait" : isCameraEnabled ? "bg-primary/10 hover:bg-primary/15 text-primary" : "bg-surface-container hover:bg-surface-container-highest text-on-surface"}`}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {isCameraEnabled ? (<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />) : (<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z M3 3l18 18" />)}
              </svg>
              {cameraLoading ? "Starting…" : isCameraEnabled ? "Camera On" : "Camera"}
            </button>
            <button onClick={toggleScreenShare} className={`btn-press px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 ${isScreenShareEnabled ? "bg-secondary/10 hover:bg-secondary/15 text-secondary" : "bg-surface-container hover:bg-surface-container-highest text-on-surface"}`}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
              {isScreenShareEnabled ? "Sharing" : "Screen"}
            </button>
            {isLockOwner && activeChannel && (
              <button onClick={() => { setLockAction(channelLocked ? "unlock" : "lock"); setShowLockPinDialog(true); }} className={`btn-press px-3 py-1.5 text-sm rounded-md transition-colors ${channelLocked ? "bg-primary/10 hover:bg-primary/15 text-primary" : "bg-surface-container hover:bg-surface-container-highest text-on-surface"}`}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">{channelLocked ? (<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />) : (<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />)}</svg>
              </button>
            )}
            <button onClick={() => setQuickSettingsOpen(true)} className="btn-press px-3 py-1.5 text-sm rounded-md transition-colors bg-surface-container hover:bg-surface-container-highest text-on-surface flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">tune</span>
              Quick
            </button>
            <button onClick={() => openSettings("audio")} className="btn-press px-3 py-1.5 text-sm rounded-md transition-colors bg-surface-container hover:bg-surface-container-highest text-on-surface">Settings</button>
            <button onClick={disconnect} className="btn-press px-3 py-1.5 bg-error/20 hover:bg-error/30 text-error text-sm rounded-md transition-colors">Leave</button>
          </div>
        </div>
        {micError && <p className="text-error text-xs mt-2">{micError}</p>}
        {cameraError && <p className="text-error text-xs mt-2">{cameraError}</p>}
        {screenShareError && <p className="text-error text-xs mt-2">{screenShareError}</p>}
        {!window.isSecureContext && <p className="text-yellow-500 text-xs mt-2">Not a secure context — microphone access may be blocked.</p>}
      </div>

      {/* Mobile header — compact, just channel name + connection */}
      <div className="md:hidden px-3 py-2 border-b border-outline-variant/15 flex-shrink-0 flex items-center gap-2">
        <ConnectionIndicator state={connectionState} />
        <span className="text-on-surface-variant text-sm font-medium flex-1 truncate">#{channelName}</span>
        {(micError || cameraError || screenShareError) && (
          <span className="text-error text-[10px] truncate max-w-[30%]">{micError || cameraError || screenShareError}</span>
        )}
        <button
          onClick={() => setQuickSettingsOpen(true)}
          aria-label="Voice settings"
          className="btn-press flex items-center justify-center w-8 h-8 rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors flex-shrink-0"
        >
          <span className="material-symbols-outlined text-base">tune</span>
        </button>
      </div>

      {/* Ban overlay */}
      {banOverlay && (
        <BanOverlay
          banMode={banOverlay.banMode}
          kickCount={banOverlay.kickCount}
          kickLimit={banOverlay.kickLimit}
          onDismiss={() => setBanOverlay(null)}
        />
      )}

      {/* Active vote kick banners */}
      {activeVotes.length > 0 && (
        <div className="flex-shrink-0">
          {activeVotes.map((vote) => (
            <VoteKickBanner
              key={vote.id}
              voteId={vote.id}
              targetUserId={vote.target_user_id}
              initiatedBy={vote.initiated_by}
              yesCount={vote.yes_count}
              totalEligible={vote.total_eligible}
              onVoted={() => {
                // Re-poll immediately after voting
                if (accessToken) {
                  getActiveVoteKicks(serverId, accessToken)
                    .then(setActiveVotes)
                    .catch(() => {});
                }
              }}
              onKickExecuted={(result) => {
                if (result.show_harsh_message) {
                  addToast(`${vote.target_user_id.split(":")[0].replace("@", "")} has been banned`);
                }
              }}
            />
          ))}
        </div>
      )}

      {/* Screen share — prominent display above participant grid */}
      {screenTracks.length > 0 && (
        <div className="flex-shrink-0 p-2 border-b border-outline-variant/15">
          {screenTracks.map((track) => (
            <div key={track.participant.identity + "-screen"} className="relative rounded-lg overflow-hidden bg-black">
              <VideoTrack
                trackRef={track}
                className="w-full max-h-[60vh] object-contain"
              />
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                <span className="text-xs text-on-surface flex items-center gap-1.5">
                  <svg className="w-3 h-3 text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  {track.participant.identity.split(":")[0].replace("@", "")}'s screen
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Participant list — split into video and audio-only groups */}
      {(() => {
        const videoParticipants = visibleParticipants.filter((p) =>
          cameraTracks.some((t) => t.participant.identity === p.identity),
        );
        const audioOnlyParticipants = visibleParticipants.filter(
          (p) => !cameraTracks.some((t) => t.participant.identity === p.identity),
        );
        const videoCount = videoParticipants.length;
        const cols = videoCount <= 1 ? 1 : videoCount <= 4 ? 2 : videoCount <= 9 ? 3 : 4;
        const rows = Math.ceil(videoCount / cols);

        // Helper to compute per-participant derived state
        const getParticipantState = (p: (typeof visibleParticipants)[number]) => {
          const isSelf = p.identity === localParticipant.identity;
          const isMuted = !p.isMicrophoneEnabled;
          const hasAudioTrack = tracks.some(
            (t) =>
              t.participant.identity === p.identity &&
              t.source === Track.Source.Microphone,
          );
          const cameraTrack = cameraTracks.find(
            (t) => t.participant.identity === p.identity,
          );
          const isUserMuted = !isSelf && !!userMuted[p.identity];
          const showMutedSpeaking = isSelf && isMutedSpeaking;

          const tileBg = showMutedSpeaking
            ? "bg-error/10"
            : p.isSpeaking && !isUserMuted
              ? "bg-secondary/10"
              : isUserMuted
                ? "bg-error/10"
                : "bg-surface-container";

          const ringClass = showMutedSpeaking
            ? "ring-2 ring-error/60"
            : p.isSpeaking && !isUserMuted
              ? "ring-2 ring-secondary/50"
              : "";

          return { isSelf, isMuted, hasAudioTrack, cameraTrack, isUserMuted, showMutedSpeaking, tileBg, ringClass };
        };

        // Reusable volume slider + vote kick controls
        const renderExpandedControls = (p: (typeof visibleParticipants)[number], isSelf: boolean) =>
          !isSelf && expandedUser === p.identity && (
            <div className="w-full mt-1 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <svg className="w-3 h-3 text-on-surface-variant flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                </svg>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={userVolumes[p.identity] ?? 1.0}
                  onChange={(e) => setUserVolume(p.identity, parseFloat(e.target.value))}
                  className="w-full h-1 rounded-full appearance-none cursor-pointer bg-surface-container-highest
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5
                    [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full
                    [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-sm
                    [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:h-2.5
                    [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white
                    [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:shadow-sm"
                  style={{
                    background: `linear-gradient(to right, #6366f1 0%, #6366f1 ${((userVolumes[p.identity] ?? 1.0) / 2) * 100}%, #3f3f46 ${((userVolumes[p.identity] ?? 1.0) / 2) * 100}%, #3f3f46 100%)`,
                  }}
                  title={`${Math.round((userVolumes[p.identity] ?? 1.0) * 100)}%`}
                />
                <span className="text-[10px] text-on-surface-variant tabular-nums w-7 text-right flex-shrink-0">
                  {Math.round((userVolumes[p.identity] ?? 1.0) * 100)}%
                </span>
              </div>
              {visibleParticipants.length >= 3 && (
                <button
                  onClick={() => handleStartVoteKick(p.identity)}
                  className="w-full text-xs py-1 bg-error/20 hover:bg-error-container/30 text-error rounded transition-colors"
                >
                  Vote Kick
                </button>
              )}
            </div>
          );

        return (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Video grid — takes remaining space when videos exist */}
            {videoParticipants.length > 0 && (
              <div className="flex-1 p-2 min-h-0">
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${cols}, 1fr)`,
                    gridTemplateRows: `repeat(${rows}, 1fr)`,
                    gap: "0.5rem",
                    height: "100%",
                  }}
                >
                  {videoParticipants.map((p) => {
                    const { isSelf, isMuted, cameraTrack, isUserMuted, showMutedSpeaking } = getParticipantState(p);

                    const borderClass = showMutedSpeaking
                      ? "border-2 border-error/60"
                      : p.isSpeaking && !isUserMuted
                        ? "border-2 border-secondary/50"
                        : "border-2 border-transparent";

                    return (
                      <div
                        key={p.identity}
                        className={`relative rounded-lg overflow-hidden ${borderClass} ${isUserMuted ? "opacity-60" : ""}`}
                      >
                        {/* Red overlay stripe for user-muted */}
                        {isUserMuted && (
                          <div className="absolute inset-0 rounded-lg border border-error/30 pointer-events-none z-10" />
                        )}
                        {/* Video feed filling the cell, with loading state */}
                        {cameraTrack ? (
                          <VideoTrack
                            trackRef={cameraTrack}
                            className="w-full h-full object-cover"
                          />
                        ) : isSelf && isCameraEnabled ? (
                          <div className="absolute inset-0 flex items-center justify-center bg-surface/80 z-[5]">
                            <svg className="w-8 h-8 text-primary animate-[spin_0.8s_linear_infinite]" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                          </div>
                        ) : null}
                        {/* Bottom overlay bar: name + mute dot + controls */}
                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 z-10">
                          <div className="flex items-center gap-1.5">
                            <div
                              className={`w-3 h-3 rounded-full flex-shrink-0 ${
                                isMuted ? "bg-error" : "bg-secondary"
                              }`}
                            />
                            <ParticipantNameLabel
                              userId={p.identity}
                              isSelf={isSelf}
                              serverId={serverId}
                              onClick={() =>
                                !isSelf &&
                                setExpandedUser(expandedUser === p.identity ? null : p.identity)
                              }
                            />
                            {!isSelf && (
                              <button
                                onClick={() => toggleUserMuted(p.identity)}
                                className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${
                                  userMuted[p.identity]
                                    ? "text-error hover:text-on-error-container"
                                    : "text-on-surface-variant hover:text-on-surface"
                                }`}
                                title={userMuted[p.identity] ? "Unmute user" : "Mute user"}
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  {userMuted[p.identity] ? (
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                                  ) : (
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M12 6v12m-3.536-2.536a5 5 0 010-7.072M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                                  )}
                                </svg>
                              </button>
                            )}
                          </div>
                          {/* Expanded controls overlay */}
                          {renderExpandedControls(p, isSelf)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Audio-only participants — compact strip when videos exist, full grid otherwise */}
            {videoParticipants.length > 0 ? (
              audioOnlyParticipants.length > 0 && (
                <div className="flex-shrink-0 px-4 py-2 border-t border-outline-variant/15 overflow-x-auto">
                  <div className="flex gap-2">
                    {audioOnlyParticipants.map((p) => {
                      const { isSelf, isMuted, hasAudioTrack, isUserMuted, showMutedSpeaking, ringClass } = getParticipantState(p);

                      return (
                        <div
                          key={p.identity}
                          className={`relative flex flex-col items-center gap-1 p-2 rounded-lg transition-all flex-shrink-0 ${
                            showMutedSpeaking
                              ? "bg-error/10"
                              : p.isSpeaking && !isUserMuted
                                ? "bg-secondary/10"
                                : isUserMuted
                                  ? "bg-error/10"
                                  : "bg-surface-container"
                          } ${isUserMuted ? "opacity-60" : ""}`}
                        >
                          {isUserMuted && (
                            <div className="absolute inset-0 rounded-lg border border-error/30 pointer-events-none" />
                          )}
                          <div className={`relative rounded-full transition-all ${ringClass}`}>
                            <Avatar userId={p.identity} size="md" />
                            <div
                              className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-surface ${
                                isMuted
                                  ? "bg-error"
                                  : hasAudioTrack
                                    ? "bg-secondary"
                                    : "bg-yellow-500"
                              }`}
                              title={
                                isMuted
                                  ? "Muted"
                                  : hasAudioTrack
                                    ? "Audio active"
                                    : "No audio track"
                              }
                            />
                          </div>
                          <div className="text-center min-w-[60px] max-w-[80px]">
                            <div className="flex items-center justify-center gap-0.5">
                              <ParticipantNameLabel
                                userId={p.identity}
                                isSelf={isSelf}
                                serverId={serverId}
                                onClick={() =>
                                  !isSelf &&
                                  setExpandedUser(expandedUser === p.identity ? null : p.identity)
                                }
                              />
                              {!isSelf && (
                                <button
                                  onClick={() => toggleUserMuted(p.identity)}
                                  className={`w-4 h-4 flex items-center justify-center rounded transition-colors ${
                                    userMuted[p.identity]
                                      ? "text-error hover:text-on-error-container"
                                      : "text-on-surface-variant hover:text-on-surface"
                                  }`}
                                  title={userMuted[p.identity] ? "Unmute user" : "Mute user"}
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    {userMuted[p.identity] ? (
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                                    ) : (
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M12 6v12m-3.536-2.536a5 5 0 010-7.072M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                                    )}
                                  </svg>
                                </button>
                              )}
                            </div>
                          </div>
                          {/* Expanded controls for audio-only in strip */}
                          {renderExpandedControls(p, isSelf)}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )
            ) : (
              /* Original full grid when no one has camera on */
              <div className="flex-1 p-4 overflow-y-auto min-h-0">
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {visibleParticipants.map((p) => {
                    const { isSelf, isMuted, hasAudioTrack, cameraTrack, isUserMuted, showMutedSpeaking, tileBg, ringClass } = getParticipantState(p);

                    return (
                      <div
                        key={p.identity}
                        className={`relative flex flex-col items-center gap-2 p-4 rounded-xl transition-all ${tileBg} ${
                          isUserMuted ? "opacity-60" : ""
                        }`}
                      >
                        {/* Red overlay stripe for user-muted */}
                        {isUserMuted && (
                          <div className="absolute inset-0 rounded-xl border border-error/30 pointer-events-none" />
                        )}
                        {/* Camera video (if active), loading spinner, or avatar */}
                        {cameraTrack ? (
                          <div className={`relative w-full rounded-lg overflow-hidden aspect-video transition-all ${ringClass}`}>
                            <VideoTrack
                              trackRef={cameraTrack}
                              className="w-full h-full object-cover"
                            />
                            <div
                              className={`absolute bottom-1 right-1 w-3 h-3 rounded-full border border-surface ${
                                isMuted ? "bg-error" : "bg-secondary"
                              }`}
                            />
                          </div>
                        ) : isSelf && isCameraEnabled ? (
                          <div className={`relative w-full rounded-lg overflow-hidden aspect-video transition-all ${ringClass} bg-surface flex items-center justify-center`}>
                            <svg className="w-8 h-8 text-primary animate-[spin_0.8s_linear_infinite]" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                          </div>
                        ) : (
                          <div className={`relative rounded-full transition-all ${ringClass}`}>
                            <Avatar userId={p.identity} size="lg" />
                            <div
                              className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full border-2 border-surface ${
                                isMuted
                                  ? "bg-error"
                                  : hasAudioTrack
                                    ? "bg-secondary"
                                    : "bg-yellow-500"
                              }`}
                              title={
                                isMuted
                                  ? "Muted"
                                  : hasAudioTrack
                                    ? "Audio active"
                                    : "No audio track"
                              }
                            />
                          </div>
                        )}
                        {/* Name + status */}
                        <div className="text-center">
                          <div className="flex items-center justify-center gap-1">
                            <ParticipantNameLabel
                              userId={p.identity}
                              isSelf={isSelf}
                              serverId={serverId}
                              onClick={() =>
                                !isSelf &&
                                setExpandedUser(expandedUser === p.identity ? null : p.identity)
                              }
                            />
                            {!isSelf && (
                              <button
                                onClick={() => toggleUserMuted(p.identity)}
                                className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${
                                  userMuted[p.identity]
                                    ? "text-error hover:text-on-error-container"
                                    : "text-on-surface-variant hover:text-on-surface"
                                }`}
                                title={userMuted[p.identity] ? "Unmute user" : "Mute user"}
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  {userMuted[p.identity] ? (
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                                  ) : (
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M12 6v12m-3.536-2.536a5 5 0 010-7.072M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                                  )}
                                </svg>
                              </button>
                            )}
                          </div>
                          <p className="text-xs text-on-surface-variant">
                            {isUserMuted
                              ? "Muted by you"
                              : showMutedSpeaking
                                ? "Muted"
                                : isMuted
                                  ? "Muted"
                                  : p.isSpeaking
                                    ? "Speaking"
                                    : "Listening"}
                          </p>
                        </div>
                        {/* Per-user volume slider + vote kick */}
                        {renderExpandedControls(p, isSelf)}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Soundboard */}
      <SoundboardPanel
        serverId={serverId}
        localParticipant={localParticipant}
      />

      {/* Mobile voice controls — bottom toolbar with large touch targets */}
      <div className="md:hidden flex-shrink-0 border-t border-outline-variant/15 bg-surface/95 backdrop-blur-sm voice-controls-mobile">
        <div className="flex items-stretch justify-around px-2 py-2 gap-1">
          {/* Mute */}
          <button
            onClick={toggleMic}
            className={`btn-press flex-1 flex flex-col items-center justify-center gap-1 py-2.5 rounded-xl min-h-[56px] transition-colors ${
              isMicEnabled ? "bg-surface-container text-on-surface" : "bg-error/25 text-error"
            }`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isMicEnabled ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M12 15a3 3 0 003-3V5a3 3 0 00-6 0v7a3 3 0 003 3z" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M12 15a3 3 0 003-3V5a3 3 0 00-6 0v7a3 3 0 003 3z M3 3l18 18" />
              )}
            </svg>
            <span className="text-[10px] font-medium">{isMicEnabled ? "Mute" : "Unmute"}</span>
          </button>

          {/* Camera */}
          <button
            onClick={toggleCamera}
            disabled={cameraLoading}
            className={`btn-press flex-1 flex flex-col items-center justify-center gap-1 py-2.5 rounded-xl min-h-[56px] transition-colors ${
              cameraLoading ? "bg-primary/15 text-primary opacity-75" : isCameraEnabled ? "bg-primary/10 text-primary" : "bg-surface-container text-on-surface"
            }`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isCameraEnabled ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z M3 3l18 18" />
              )}
            </svg>
            <span className="text-[10px] font-medium">{cameraLoading ? "Starting" : isCameraEnabled ? "Cam On" : "Camera"}</span>
          </button>

          {/* Screen (hidden on phones — no screen share on mobile) */}
          <button
            onClick={toggleScreenShare}
            className={`btn-press hidden sm:flex flex-1 flex-col items-center justify-center gap-1 py-2.5 rounded-xl min-h-[56px] transition-colors ${
              isScreenShareEnabled ? "bg-secondary/10 text-secondary" : "bg-surface-container text-on-surface"
            }`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
            <span className="text-[10px] font-medium">{isScreenShareEnabled ? "Stop" : "Screen"}</span>
          </button>

          {/* Settings */}
          <button
            onClick={() => openSettings("audio")}
            className="btn-press flex-1 flex flex-col items-center justify-center gap-1 py-2.5 rounded-xl min-h-[56px] bg-surface-container text-on-surface transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            <span className="text-[10px] font-medium">Settings</span>
          </button>

          {/* Leave — visually distinct */}
          <button
            onClick={disconnect}
            className="btn-press flex-1 flex flex-col items-center justify-center gap-1 py-2.5 rounded-xl min-h-[56px] bg-error/25 text-error transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
            <span className="text-[10px] font-medium">Leave</span>
          </button>
        </div>
      </div>

      {/* Lock/Unlock PIN dialog */}
      {showLockPinDialog && activeChannel && (
        <PinDialog
          title={lockAction === "lock" ? "Lock Channel" : "Unlock Channel"}
          description={
            lockAction === "lock"
              ? "Set a 4-digit PIN. Others will need this PIN to join."
              : "Enter the PIN to unlock this channel."
          }
          submitLabel={lockAction === "lock" ? "Lock" : "Unlock"}
          onCancel={() => setShowLockPinDialog(false)}
          onSubmit={async (pin) => {
            if (!accessToken) return;
            if (lockAction === "lock") {
              await lockChannel(activeChannel.id, pin, accessToken);
              setChannelLocked(true);
            } else {
              await unlockChannel(activeChannel.id, pin, accessToken);
              setChannelLocked(false);
            }
            setShowLockPinDialog(false);
          }}
        />
      )}

      {quickSettingsOpen && (
        <VoiceQuickSettingsSheet
          localParticipant={localParticipant}
          otherParticipants={visibleParticipants.filter((p) => p.identity !== localParticipant.identity)}
          onClose={() => setQuickSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function ParticipantNameLabel({
  userId,
  isSelf,
  serverId,
  onClick,
}: {
  userId: string;
  isSelf: boolean;
  serverId: string;
  onClick?: () => void;
}) {
  const displayName = useDisplayName(userId);
  const accessToken = useAuthStore((s) => s.accessToken);
  const loadMembers = useServerStore((s) => s.loadMembers);
  const addToast = useToastStore((s) => s.addToast);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(displayName);

  const handleDoubleClick = () => {
    if (!isSelf) return;
    setEditValue(displayName);
    setEditing(true);
  };

  const handleSave = async () => {
    setEditing(false);
    if (!accessToken) return;
    const newName = editValue.trim() || null;
    try {
      await updateDisplayName(serverId, userId, newName, accessToken);
      await loadMembers(serverId, accessToken);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update name");
    }
  };

  if (editing) {
    return (
      <input
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSave();
          if (e.key === "Escape") setEditing(false);
        }}
        autoFocus
        maxLength={32}
        className="text-sm text-on-surface bg-surface-container-highest border border-primary rounded px-1.5 py-0.5 text-center w-24 focus:outline-none"
      />
    );
  }

  return (
    <span
      onClick={onClick}
      onDoubleClick={handleDoubleClick}
      className={`text-sm ${isSelf ? "cursor-default" : "hover:text-on-surface cursor-pointer"} text-on-surface`}
      title={isSelf ? "Double-click to edit display name" : "Click to adjust volume"}
    >
      {displayName}
      {isSelf && (
        <span className="text-on-surface-variant text-xs ml-1">(you)</span>
      )}
    </span>
  );
}

/* ── Voice Quick Settings ── */

function useAudioInputDevices(): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () => {
      navigator.mediaDevices.enumerateDevices()
        .then((all) => setDevices(all.filter((d) => d.kind === "audioinput")))
        .catch(() => {});
    };
    load();
    navigator.mediaDevices.addEventListener("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener("devicechange", load);
  }, []);
  return devices;
}

function VoiceQuickSettingsSheet({
  localParticipant,
  otherParticipants,
  onClose,
}: {
  localParticipant: ReturnType<typeof useLocalParticipant>["localParticipant"];
  otherParticipants: ReturnType<typeof useParticipants>;
  onClose: () => void;
}) {
  const devices = useAudioInputDevices();
  const [audioLevel, setAudioLevel] = useState(0);
  const preferredInputDeviceId = useSettingsStore((s) => s.preferredInputDeviceId);
  const setPreferredInputDeviceId = useSettingsStore((s) => s.setPreferredInputDeviceId);
  const userVolumes = useSettingsStore((s) => s.userVolumes);
  const setUserVolume = useSettingsStore((s) => s.setUserVolume);

  // Poll audio level while sheet is open
  useEffect(() => {
    const id = setInterval(() => setAudioLevel(localParticipant.audioLevel), 80);
    return () => clearInterval(id);
  }, [localParticipant]);

  const levelBars = 14;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-t-2xl bg-surface-container border border-outline-variant/20 shadow-2xl p-4 safe-bottom animate-[fadeSlideUp_0.2s_ease-out]">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-headline font-semibold text-on-surface">Voice Settings</h3>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>

        {/* Input device + level */}
        <div className="space-y-2 mb-4">
          <p className="text-xs font-label text-on-surface-variant uppercase tracking-wider">Microphone</p>
          <div className="flex gap-0.5 h-2.5 mb-2">
            {Array.from({ length: levelBars }).map((_, i) => {
              const threshold = i / levelBars;
              const active = audioLevel > threshold;
              const color = i < levelBars * 0.5 ? "bg-green-500" : i < levelBars * 0.75 ? "bg-yellow-400" : "bg-red-500";
              return (
                <div
                  key={i}
                  className={`flex-1 rounded-sm transition-all duration-75 ${active ? color : "bg-surface-container-highest"}`}
                />
              );
            })}
          </div>
          <select
            value={preferredInputDeviceId ?? ""}
            onChange={(e) => setPreferredInputDeviceId(e.target.value || null)}
            className="w-full px-3 py-2 bg-surface-container-highest rounded-lg text-sm text-on-surface border border-outline-variant/20 focus:border-primary/50 focus:outline-none"
          >
            <option value="">System default</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone (${d.deviceId.slice(0, 6)})`}
              </option>
            ))}
          </select>
          {!localParticipant.isMicrophoneEnabled && (
            <p className="text-xs text-on-surface-variant/60">Mic is muted — level shown when unmuted</p>
          )}
        </div>

        {/* Per-user volumes */}
        {otherParticipants.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-label text-on-surface-variant uppercase tracking-wider">User Volumes</p>
            {otherParticipants.map((p) => {
              const name = p.name || p.identity.split(":")[0].replace("@", "");
              const vol = userVolumes[p.identity] ?? 1.0;
              return (
                <div key={p.identity} className="flex items-center gap-3">
                  <span className="text-sm text-on-surface flex-1 truncate min-w-0">{name}</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={vol}
                    onChange={(e) => setUserVolume(p.identity, parseFloat(e.target.value))}
                    className="w-28 h-1 rounded-full appearance-none cursor-pointer bg-surface-container-highest
                      [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3
                      [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full
                      [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-sm
                      [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3
                      [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white
                      [&::-moz-range-thumb]:border-0"
                    style={{ background: `linear-gradient(to right, #6366f1 0%, #6366f1 ${(vol / 2) * 100}%, #3f3f46 ${(vol / 2) * 100}%, #3f3f46 100%)` }}
                  />
                  <span className="text-xs text-on-surface-variant tabular-nums w-8 text-right flex-shrink-0">
                    {Math.round(vol * 100)}%
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const config: Record<string, { color: string; label: string }> = {
    [ConnectionState.Connected]: { color: "bg-secondary", label: "Connected" },
    [ConnectionState.Connecting]: { color: "bg-yellow-500", label: "Connecting" },
    [ConnectionState.Reconnecting]: { color: "bg-yellow-500", label: "Reconnecting" },
    [ConnectionState.Disconnected]: { color: "bg-error", label: "Disconnected" },
  };
  const { color, label } = config[state] ?? { color: "bg-on-surface-variant/50", label: state };

  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-2 h-2 rounded-full ${color}`} />
      <span
        className={`text-sm font-medium ${
          state === ConnectionState.Connected
            ? "text-secondary"
            : "text-on-surface-variant"
        }`}
      >
        {label}
      </span>
    </div>
  );
}
