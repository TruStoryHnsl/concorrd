import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { PassThrough } from "node:stream";

import { Client, GatewayIntentBits } from "discord.js";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import prism from "prism-media";
import {
  AudioFrame,
  AudioMixer,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  dispose,
} from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";

const CONFIG_PATH = process.env.DISCORD_VOICE_ROOMS_FILE || "/config/rooms.json";
const DISCORD_TOKEN_FILE = process.env.DISCORD_BOT_TOKEN_FILE || "";
let discordToken = process.env.DISCORD_BOT_TOKEN || process.env.MAUTRIX_DISCORD_BOT_TOKEN || "";
const LIVEKIT_URL = process.env.LIVEKIT_URL || "ws://livekit:7880";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";
const HEALTH_PORT = Number(process.env.DISCORD_VOICE_HEALTH_PORT || "3098");
const POLL_MS = Number(process.env.DISCORD_VOICE_CONFIG_POLL_MS || "5000");
const DISCORD_VOICE_IDLE_MS = Number(process.env.DISCORD_VOICE_IDLE_MS || "15000");
const DISCORD_VOICE_IDENTITY_PREFIX = "discord-voice:";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_MS = 20;
const SAMPLES_PER_CHANNEL = (SAMPLE_RATE / 1000) * FRAME_MS;
const PCM_BYTES_PER_FRAME = SAMPLES_PER_CHANNEL * CHANNELS * 2;

const active = new Map();
let lastConfigHash = "";
let shuttingDown = false;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function requiredEnv() {
  if (!discordToken && DISCORD_TOKEN_FILE) {
    discordToken = (await fs.readFile(DISCORD_TOKEN_FILE, "utf8")).trim();
  }
  const missing = [];
  if (!discordToken) missing.push("DISCORD_BOT_TOKEN, MAUTRIX_DISCORD_BOT_TOKEN, or DISCORD_BOT_TOKEN_FILE");
  if (!LIVEKIT_API_KEY) missing.push("LIVEKIT_API_KEY");
  if (!LIVEKIT_API_SECRET) missing.push("LIVEKIT_API_SECRET");
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

async function readConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const rooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
    return rooms.filter((room) => room.enabled !== false);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function roomKey(room) {
  return String(room.id ?? `${room.matrix_room_id}:${room.discord_channel_id}`);
}

async function liveKitToken(roomName, identity) {
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: "Discord Voice",
    ttl: "6h",
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
  });
  return await token.toJwt();
}

function audioFrameToBuffer(frame) {
  return Buffer.from(
    new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
  );
}

function bufferToAudioFrame(buffer) {
  const usableBytes = buffer.byteLength - (buffer.byteLength % (CHANNELS * 2));
  const view = new Int16Array(buffer.buffer, buffer.byteOffset, usableBytes / 2);
  const copy = Int16Array.from(view);
  return new AudioFrame(copy, SAMPLE_RATE, CHANNELS, copy.length / CHANNELS);
}

async function* pcmFrames(readable) {
  let carry = Buffer.alloc(0);
  for await (const chunk of readable) {
    carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    while (carry.length >= PCM_BYTES_PER_FRAME) {
      const frame = carry.subarray(0, PCM_BYTES_PER_FRAME);
      carry = carry.subarray(PCM_BYTES_PER_FRAME);
      yield bufferToAudioFrame(frame);
    }
  }
}

function writeLiveKitMixToDiscord(mixer, output) {
  return (async () => {
    try {
      for await (const frame of mixer) {
        if (!output.writableEnded) output.write(audioFrameToBuffer(frame));
      }
    } catch (error) {
      if (!shuttingDown) log("livekit->discord mixer failed", error);
    } finally {
      output.end();
    }
  })();
}

function captureDiscordMixToLiveKit(mixer, source) {
  return (async () => {
    try {
      for await (const frame of mixer) {
        await source.captureFrame(frame);
      }
    } catch (error) {
      if (!shuttingDown) log("discord->livekit mixer failed", error);
    }
  })();
}

async function startBridge(client, roomConfig) {
  const identity = `${DISCORD_VOICE_IDENTITY_PREFIX}${roomConfig.discord_guild_id}:${roomConfig.discord_channel_id}`;
  const bridgeId = roomKey(roomConfig);
  log("starting voice bridge", bridgeId, roomConfig.matrix_room_id, roomConfig.discord_channel_id);

  const channel = await client.channels.fetch(roomConfig.discord_channel_id);
  if (!channel?.isVoiceBased?.()) {
    throw new Error(`Discord channel ${roomConfig.discord_channel_id} is not a voice channel`);
  }

  const lkRoom = new Room();
  const token = await liveKitToken(roomConfig.matrix_room_id, identity);
  await lkRoom.connect(LIVEKIT_URL, token, { autoSubscribe: true });
  let discordConnection = null;
  let discordPlayer = null;
  let discordAudioOut = null;
  let discordToLiveKitMixer = null;
  let liveKitToDiscordMixer = null;
  let source = null;
  let track = null;
  let tasks = [];
  let idleTimer = null;
  let onDiscordSpeaking = null;
  const discordStreams = new Map();
  const liveKitStreams = new Map();
  const subscribedLiveKitTracks = new Map();

  const clearIdleTimer = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const nonBridgeParticipantCount = () =>
    [...lkRoom.remoteParticipants.values()].filter(
      (participant) => !participant.identity.startsWith(DISCORD_VOICE_IDENTITY_PREFIX),
    ).length;

  const removeLiveKitStream = (key) => {
    const stream = liveKitStreams.get(key);
    if (!stream || !liveKitToDiscordMixer) return;
    liveKitStreams.delete(key);
    liveKitToDiscordMixer.removeStream(stream);
  };

  const addLiveKitTrackToMixer = (key, remoteTrack) => {
    if (!liveKitToDiscordMixer || liveKitStreams.has(key)) return;
    const stream = new AudioStream(remoteTrack, {
      sampleRate: SAMPLE_RATE,
      numChannels: CHANNELS,
      frameSizeMs: FRAME_MS,
    });
    liveKitStreams.set(key, stream);
    liveKitToDiscordMixer.addStream(stream);
  };

  const disconnectDiscord = async (reason = "idle") => {
    clearIdleTimer();
    if (
      !discordConnection &&
      !discordPlayer &&
      !discordAudioOut &&
      !discordToLiveKitMixer &&
      !liveKitToDiscordMixer &&
      !source &&
      !track
    ) {
      return;
    }
    log("disconnecting discord voice", bridgeId, reason);
    if (discordConnection && onDiscordSpeaking) {
      discordConnection.receiver.speaking.off("start", onDiscordSpeaking);
    }
    for (const stream of discordStreams.values()) {
      discordToLiveKitMixer?.removeStream(stream);
    }
    discordStreams.clear();
    for (const key of liveKitStreams.keys()) {
      removeLiveKitStream(key);
    }
    discordToLiveKitMixer?.endInput();
    liveKitToDiscordMixer?.endInput();
    if (discordAudioOut && !discordAudioOut.writableEnded) {
      discordAudioOut.end();
    }
    try {
      discordPlayer?.stop(true);
    } catch (error) {
      log("discord player stop failed", bridgeId, error);
    }
    try {
      if (discordConnection?.state?.status !== VoiceConnectionStatus.Destroyed) {
        discordConnection?.destroy();
      }
    } catch (error) {
      log("discord connection destroy failed", bridgeId, error);
    }
    // Note: skip explicit unpublishTrack — livekit-ffi 0.13.25 panics in Rust
    // (room.rs:525 unwrap on "[object Object]") when unpublishTrack is called
    // during disconnect. track.close() implicitly unpublishes in this version.
    try {
      await source?.close?.();
    } catch (error) {
      log("livekit source close failed", bridgeId, error);
    }
    try {
      await track?.close?.();
    } catch (error) {
      log("livekit track close failed", bridgeId, error);
    }
    await Promise.allSettled(tasks);
    tasks = [];
    await discordToLiveKitMixer?.aclose?.();
    await liveKitToDiscordMixer?.aclose?.();
    discordConnection = null;
    discordPlayer = null;
    discordAudioOut = null;
    discordToLiveKitMixer = null;
    liveKitToDiscordMixer = null;
    source = null;
    track = null;
    onDiscordSpeaking = null;
  };

  const ensureDiscordConnected = async () => {
    clearIdleTimer();
    if (discordConnection || shuttingDown) return;
    log("connecting discord voice", bridgeId);
    discordConnection = joinVoiceChannel({
      channelId: roomConfig.discord_channel_id,
      guildId: roomConfig.discord_guild_id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    discordConnection.on("error", (error) => log("discord voice error", bridgeId, error));
    await entersState(discordConnection, VoiceConnectionStatus.Ready, 30_000);

    discordToLiveKitMixer = new AudioMixer(SAMPLE_RATE, CHANNELS, {
      blocksize: SAMPLES_PER_CHANNEL,
      streamTimeoutMs: 100,
    });
    liveKitToDiscordMixer = new AudioMixer(SAMPLE_RATE, CHANNELS, {
      blocksize: SAMPLES_PER_CHANNEL,
      streamTimeoutMs: 100,
    });

    source = new AudioSource(SAMPLE_RATE, CHANNELS);
    track = LocalAudioTrack.createAudioTrack("discord-voice", source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await lkRoom.localParticipant.publishTrack(track, options);

    discordAudioOut = new PassThrough({ highWaterMark: PCM_BYTES_PER_FRAME * 10 });
    discordPlayer = createAudioPlayer();
    const resource = createAudioResource(discordAudioOut, { inputType: StreamType.Raw });
    discordPlayer.on("error", (error) => log("discord audio player error", bridgeId, error));
    discordPlayer.on(AudioPlayerStatus.Idle, () => {
      if (!shuttingDown) log("discord audio player idle", bridgeId);
    });
    discordConnection.subscribe(discordPlayer);
    discordPlayer.play(resource);

    tasks = [
      captureDiscordMixToLiveKit(discordToLiveKitMixer, source),
      writeLiveKitMixToDiscord(liveKitToDiscordMixer, discordAudioOut),
    ];

    onDiscordSpeaking = (userId) => {
      if (userId === client.user?.id || discordStreams.has(userId) || !discordConnection) return;
      const opus = discordConnection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
      });
      const decoder = new prism.opus.Decoder({
        rate: SAMPLE_RATE,
        channels: CHANNELS,
        frameSize: SAMPLES_PER_CHANNEL,
      });
      const pcm = opus.pipe(decoder);
      const stream = pcmFrames(pcm);
      discordStreams.set(userId, stream);
      discordToLiveKitMixer.addStream(stream);
      pcm.once("close", () => {
        discordStreams.delete(userId);
        discordToLiveKitMixer?.removeStream(stream);
      });
      pcm.once("error", (error) => {
        log("discord receive decode error", bridgeId, userId, error);
        discordStreams.delete(userId);
        discordToLiveKitMixer?.removeStream(stream);
      });
    };

    discordConnection.receiver.speaking.on("start", onDiscordSpeaking);
    for (const [key, remoteTrack] of subscribedLiveKitTracks.entries()) {
      addLiveKitTrackToMixer(key, remoteTrack);
    }
  };

  const scheduleIdleDisconnect = () => {
    clearIdleTimer();
    if (!discordConnection) return;
    idleTimer = setTimeout(() => {
      disconnectDiscord("no-local-participants").catch((error) =>
        log("idle disconnect failed", bridgeId, error),
      );
    }, DISCORD_VOICE_IDLE_MS);
  };

  const onTrackSubscribed = (remoteTrack, _publication, participant) => {
    if (participant.identity === identity) return;
    if (!(remoteTrack instanceof RemoteAudioTrack)) return;
    const key = `${participant.identity}:${remoteTrack.sid ?? remoteTrack.name ?? Date.now()}`;
    subscribedLiveKitTracks.set(key, remoteTrack);
    if (!participant.identity.startsWith(DISCORD_VOICE_IDENTITY_PREFIX)) {
      clearIdleTimer();
      ensureDiscordConnected().catch((error) =>
        log("discord connect failed", bridgeId, error),
      );
    }
    addLiveKitTrackToMixer(key, remoteTrack);
  };

  const onTrackUnsubscribed = (remoteTrack, _publication, participant) => {
    const prefix = `${participant.identity}:`;
    for (const key of [...subscribedLiveKitTracks.keys()]) {
      if (!key.startsWith(prefix)) continue;
      if (remoteTrack.sid && !key.includes(remoteTrack.sid)) continue;
      subscribedLiveKitTracks.delete(key);
      removeLiveKitStream(key);
    }
    if (nonBridgeParticipantCount() === 0) {
      scheduleIdleDisconnect();
    }
  };

  const onParticipantConnected = (participant) => {
    if (participant.identity.startsWith(DISCORD_VOICE_IDENTITY_PREFIX)) return;
    clearIdleTimer();
    ensureDiscordConnected().catch((error) =>
      log("discord connect failed", bridgeId, error),
    );
  };

  const onParticipantDisconnected = (participant) => {
    if (participant.identity.startsWith(DISCORD_VOICE_IDENTITY_PREFIX)) return;
    if (nonBridgeParticipantCount() === 0) {
      scheduleIdleDisconnect();
    }
  };

  lkRoom
    .on(RoomEvent.TrackSubscribed, onTrackSubscribed)
    .on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
    .on(RoomEvent.ParticipantConnected, onParticipantConnected)
    .on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected)
    .on(RoomEvent.Disconnected, () => log("livekit room disconnected", bridgeId));

  if (nonBridgeParticipantCount() > 0) {
    await ensureDiscordConnected();
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    log("stopping voice bridge", bridgeId);
    lkRoom.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    lkRoom.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
    lkRoom.off(RoomEvent.ParticipantConnected, onParticipantConnected);
    lkRoom.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    await disconnectDiscord("shutdown");
    try {
      await lkRoom.disconnect();
    } catch (error) {
      log("livekit disconnect failed", bridgeId, error);
    }
  };

  return {
    stop,
    roomConfig,
    getStatus: async () => {
      const liveChannel = client.channels.cache.get(roomConfig.discord_channel_id) ?? channel;
      const discordMembers = liveChannel?.isVoiceBased?.()
        ? [...liveChannel.members.values()]
            .filter((member) => !member.user?.bot)
            .map((member) => ({
              id: member.user.id,
              name: member.displayName ?? member.user.globalName ?? member.user.username,
            }))
        : [];
      return {
        id: bridgeId,
        matrix_room_id: roomConfig.matrix_room_id,
        discord_guild_id: roomConfig.discord_guild_id,
        discord_channel_id: roomConfig.discord_channel_id,
        connected: Boolean(discordConnection),
        discord_members: discordMembers,
      };
    },
  };
}

async function reconcile(client) {
  const rooms = await readConfig();
  const hash = JSON.stringify(rooms);
  if (hash === lastConfigHash) return;
  lastConfigHash = hash;

  const desired = new Map(rooms.map((room) => [roomKey(room), room]));

  for (const [key, bridge] of active.entries()) {
    const next = desired.get(key);
    if (!next || JSON.stringify(next) !== JSON.stringify(bridge.roomConfig)) {
      await bridge.stop().catch((error) => log("stop failed", key, error));
      active.delete(key);
    }
  }

  for (const [key, room] of desired.entries()) {
    if (active.has(key)) continue;
    try {
      active.set(key, await startBridge(client, room));
    } catch (error) {
      log("failed to start voice bridge", key, error);
    }
  }
}

function startHealthServer() {
  const server = http.createServer(async (_req, res) => {
    try {
      const rooms = await Promise.all(
        [...active.values()].map((bridge) => bridge.getStatus()),
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, active_bridges: active.size, rooms }));
    } catch (error) {
      log("health status failed", error);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, active_bridges: active.size, rooms: [] }));
    }
  });
  server.listen(HEALTH_PORT, "0.0.0.0", () => {
    log(`health server listening on ${HEALTH_PORT}`);
  });
  return server;
}

async function main() {
  await requiredEnv();
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  client.on("error", (error) => log("discord client error", error));
  await client.login(discordToken);
  log("discord voice bot logged in as", client.user?.tag ?? client.user?.id);

  const health = startHealthServer();
  await reconcile(client);
  const interval = setInterval(() => {
    reconcile(client).catch((error) => log("config reconcile failed", error));
  }, POLL_MS);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(interval);
    health.close();
    for (const [key, bridge] of active.entries()) {
      await bridge.stop().catch((error) => log("stop failed", key, error));
      active.delete(key);
    }
    client.destroy();
    await dispose();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
