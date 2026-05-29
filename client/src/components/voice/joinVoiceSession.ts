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

  // Phase 8 (INS-019b) — ask the native servitude layer which voice
  // path to use. Mesh decisions land in this PR; the mesh-MEDIA layer
  // (real audio over libp2p WebRTC via webrtc-rs) is queued as a
  // Phase 8 follow-up. Until that lands the decision is logged and
  // we fall through to LiveKit so the existing working voice path
  // remains the default behavior.
  //
  // Web builds short-circuit to `livekit_sfu` inside `selectVoicePath`;
  // a browser tab can't participate in the libp2p mesh until Phase 9
  // (js-libp2p in the browser client) ships.
  try {
    // The Phase 8 selector treats `peer_id === null` as a web-only
    // participant. The room-roster → peer-store resolution lands as
    // part of the Phase 8 media follow-up; for now we send an empty
    // participant list, which the Rust selector evaluates as a
    // degenerate mesh case (path: "libp2p_mesh", reason:
    // "all_native_under_cap"). This is informational only — the
    // result is logged but does NOT branch the join flow yet.
    const participants: VoiceParticipant[] = [];
    const decision = await selectVoicePath(participants);
    if (decision.path === "libp2p_mesh") {
      // eslint-disable-next-line no-console
      console.info(
        "[voice] libp2p mesh selected (Phase 8 scaffolding); " +
          "falling back to LiveKit for media — " +
          `reason=${decision.reason}`,
      );
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
