import type { Server } from "../../api/concord";
import { getVoiceToken } from "../../api/livekit";
import { getHomeserverUrl } from "../../api/serverUrl";
import {
  selectVoicePath,
  type VoiceParticipant,
} from "../../api/voicePath";
import { useServerConfigStore } from "../../stores/serverConfig";
import { useSettingsStore } from "../../stores/settings";
import { useVoiceStore } from "../../stores/voice";
import { buildMicTrackConstraints } from "../../voice/noiseGate";

interface JoinVoiceSessionParams {
  roomId: string;
  channelName: string;
  serverId: string;
  accessToken: string;
  activeServer?: Server;
  activeChannelId?: string | null;
  channelType?: "place" | "voice";
  /** When set (i.e. coming from a persisted pending session on page refresh),
   *  these win over the values derived from activeServer/activeChannelId. */
  serverName?: string | null;
  returnChannelId?: string | null;
  returnChannelName?: string | null;
  /** When true, transition connectionState through "reconnecting" rather
   *  than "connecting". The lock is acquired in either case. */
  reconnecting?: boolean;
}

export async function joinVoiceSession({
  roomId,
  channelName,
  serverId,
  accessToken,
  activeServer,
  activeChannelId,
  channelType,
  serverName,
  returnChannelId: returnChannelIdOverride,
  returnChannelName: returnChannelNameOverride,
  reconnecting,
}: JoinVoiceSessionParams): Promise<void> {
  const claimed = useVoiceStore.getState().beginConnectAttempt({ reconnecting });
  if (!claimed) {
    // Another attempt is already in flight. Bail to avoid concurrent
    // getUserMedia + connect calls fighting each other.
    return;
  }
  const {
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    preferredInputDeviceId,
    masterInputVolume,
    inputNoiseGateEnabled,
    inputNoiseGateThresholdDb,
  } = useSettingsStore.getState();

  let micGranted = false;
  if (navigator.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: buildMicTrackConstraints({
          masterInputVolume,
          preferredInputDeviceId,
          echoCancellation,
          noiseSuppression,
          autoGainControl,
          inputNoiseGateEnabled,
          inputNoiseGateThresholdDb,
        }),
      });
      stream.getTracks().forEach((track) => track.stop());
      micGranted = true;
    } catch {
      // Permission denial is non-fatal. Continue muted.
    }
  }

  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
  } catch {
    // Best-effort playback resume only.
  } finally {
    ctx?.close();
  }

  // Phase 8 follow-up — ask the native servitude layer which voice
  // path to use. If the selector picks `libp2p_mesh`, attempt the
  // mesh-join Tauri command; on success the function returns early
  // and LiveKit is never contacted. On any failure (no native
  // runtime, command errored, peer connection setup failed) the flow
  // falls through to the existing LiveKit path — the same property
  // that holds today, plus a real mesh-media-plane attempt in front.
  let meshJoined = false;
  try {
    // The Phase 8 selector treats `peer_id === null` as a web-only
    // participant. The room-roster → peer-store resolution still
    // lands as a follow-up; today we send an empty participant
    // list. With no remotes named, mesh-join is a degenerate
    // single-peer call (the orchestrator wires the local
    // PeerConnection + signaling sink so subsequent inbound Offers
    // from late joiners are still handled).
    const participants: VoiceParticipant[] = [];
    const decision = await selectVoicePath(participants);
    if (decision.path === "libp2p_mesh") {
      // eslint-disable-next-line no-console
      console.info(
        `[voice] libp2p mesh selected — reason=${decision.reason}; attempting mesh-join`,
      );
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("voice_mesh_join", {
          roomId,
          participants: participants
            .map((p) => p.peer_id)
            .filter((p): p is string => !!p),
          iceServers: [] as string[],
        });
        useVoiceStore.getState().connect({
          token: "",
          livekitUrl: "",
          iceServers: [],
          serverId,
          serverName: serverName ?? activeServer?.name ?? null,
          channelId: roomId,
          channelName,
          channelType: channelType ?? "voice",
          roomName: roomId,
          returnChannelId:
            returnChannelIdOverride ??
            activeServer?.channels.find(
              (channel) =>
                channel.matrix_room_id === activeChannelId &&
                channel.channel_type !== "voice",
            )?.matrix_room_id ??
            null,
          returnChannelName:
            returnChannelNameOverride ??
            activeServer?.channels.find(
              (channel) =>
                channel.matrix_room_id === activeChannelId &&
                channel.channel_type !== "voice",
            )?.name ??
            null,
          micGranted,
          transport: "libp2p_mesh",
        });
        meshJoined = true;
      } catch (meshErr) {
        // eslint-disable-next-line no-console
        console.warn(
          "[voice] mesh-join failed; falling back to LiveKit",
          meshErr,
        );
      }
    } else {
      // eslint-disable-next-line no-console
      console.info(
        `[voice] LiveKit SFU selected — reason=${decision.reason}`,
      );
    }
  } catch (decisionErr) {
    // selectVoicePath has its own try/catch fallback; this is
    // belt-and-suspenders so a bug in path selection cannot prevent
    // the voice flow from progressing to LiveKit.
    // eslint-disable-next-line no-console
    console.warn(
      "[voice] voice path selection threw; continuing on LiveKit:",
      decisionErr,
    );
  }
  if (meshJoined) return;

  let result;
  try {
    result = await getVoiceToken(roomId, accessToken);
  } catch (err) {
    // Release the connect lock so the next attempt (manual retry or the next
    // backoff iteration) can proceed.
    useVoiceStore.getState().setConnectionState("disconnected");
    throw err;
  }
  const wkLivekit = useServerConfigStore.getState().config?.livekit_url;
  const rawUrl = wkLivekit
    || result.livekit_url
    || `${getHomeserverUrl().replace(/^http/, "ws")}/livekit/`;
  const livekitUrl = rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`;

  const derivedReturnChannelId =
    activeServer?.channels.find(
      (channel) =>
        channel.matrix_room_id === activeChannelId &&
        channel.channel_type !== "voice",
    )?.matrix_room_id ??
    activeServer?.channels.find((channel) => channel.channel_type !== "voice")?.matrix_room_id ??
    null;
  const derivedReturnChannelName =
    activeServer?.channels.find(
      (channel) =>
        channel.matrix_room_id === activeChannelId &&
        channel.channel_type !== "voice",
    )?.name ??
    activeServer?.channels.find((channel) => channel.channel_type !== "voice")?.name ??
    null;

  useVoiceStore.getState().connect({
    token: result.token,
    livekitUrl,
    iceServers: result.ice_servers?.length ? result.ice_servers : [],
    serverId,
    serverName: serverName ?? activeServer?.name ?? null,
    channelId: roomId,
    channelName,
    channelType: channelType ?? "voice",
    roomName: roomId,
    returnChannelId: returnChannelIdOverride ?? derivedReturnChannelId,
    returnChannelName: returnChannelNameOverride ?? derivedReturnChannelName,
    micGranted,
  });
}
