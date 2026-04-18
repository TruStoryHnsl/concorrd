import type { Server } from "../../api/concord";
import { getVoiceToken } from "../../api/livekit";
import { getHomeserverUrl } from "../../api/serverUrl";
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
}

export async function joinVoiceSession({
  roomId,
  channelName,
  serverId,
  accessToken,
  activeServer,
  activeChannelId,
  channelType,
}: JoinVoiceSessionParams): Promise<void> {
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

  const result = await getVoiceToken(roomId, accessToken);
  const wkLivekit = useServerConfigStore.getState().config?.livekit_url;
  const rawUrl = wkLivekit
    || result.livekit_url
    || `${getHomeserverUrl().replace(/^http/, "ws")}/livekit/`;
  const livekitUrl = rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`;

  useVoiceStore.getState().connect({
    token: result.token,
    livekitUrl,
    iceServers: result.ice_servers?.length ? result.ice_servers : [],
    serverId,
    serverName: activeServer?.name ?? null,
    channelId: roomId,
    channelName,
    channelType: channelType ?? "voice",
    roomName: roomId,
    returnChannelId:
      activeServer?.channels.find(
        (channel) =>
          channel.matrix_room_id === activeChannelId &&
          channel.channel_type !== "voice",
      )?.matrix_room_id ??
      activeServer?.channels.find((channel) => channel.channel_type !== "voice")?.matrix_room_id ??
      null,
    returnChannelName:
      activeServer?.channels.find(
        (channel) =>
          channel.matrix_room_id === activeChannelId &&
          channel.channel_type !== "voice",
      )?.name ??
      activeServer?.channels.find((channel) => channel.channel_type !== "voice")?.name ??
      null,
    micGranted,
  });
}
