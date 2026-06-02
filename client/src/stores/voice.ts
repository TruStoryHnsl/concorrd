import { create } from "zustand";
import { startVoiceSession, endVoiceSession } from "../api/concord";
import { useAuthStore } from "./auth";

const VOICE_SESSION_KEY = "concord_voice_session";
const VOICE_STATS_SESSION_KEY = "concord_voice_stats_session";

function userScopedStorageKey(base: string): string {
  const userId = useAuthStore.getState().userId;
  return userId ? `${base}:${userId}` : base;
}

/** Connection lifecycle states for voice. */
export type VoiceConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

/**
 * Phase 8 follow-up — which media plane carries the voice for this
 * session.
 *
 *   - `"livekit"` — LiveKit SFU (existing path; default fallback).
 *   - `"libp2p_mesh"` — direct peer-to-peer via libp2p WebRTC. Active
 *     when the selector picked mesh AND the mesh-join succeeded.
 *
 * The UI uses this to render the right participant list: SFU pulls
 * from LiveKit's React hooks; mesh pulls from the per-tab voice mesh
 * registry (`client/src/libp2p/voiceMesh.ts`).
 */
export type VoiceTransport = "livekit" | "libp2p_mesh";

interface VoiceSession {
  serverId: string;
  serverName?: string | null;
  channelId: string;
  channelName: string;
  roomName: string;
  returnChannelId?: string | null;
  returnChannelName?: string | null;
}

interface VoiceState {
  connected: boolean;
  connectionState: VoiceConnectionState;
  reconnectAttempt: number;
  /** Phase 8 follow-up: which media plane is in use for this session.
   *  Defaults to `"livekit"` when no session is active. Set by
   *  `connect()` to `"libp2p_mesh"` when the path selector picked
   *  mesh AND the mesh-join succeeded. */
  transport: VoiceTransport;
  token: string | null;
  livekitUrl: string | null;
  iceServers: RTCIceServer[];
  serverId: string | null;
  serverName: string | null;
  channelId: string | null; // matrix_room_id
  channelName: string | null;
  roomName: string | null; // LiveKit room name (same as matrix room id)
  returnChannelId: string | null;
  returnChannelName: string | null;
  micGranted: boolean;
  statsSessionId: number | null;
  channelType: "place" | "voice" | null;
  /** INS-048: Whether the local mic is actively capturing (set by VoiceChannel). */
  micActive: boolean;
  /** INS-048: Whether the local camera is actively capturing (set by VoiceChannel). */
  cameraActive: boolean;

  connect: (params: {
    token: string;
    livekitUrl: string;
    iceServers: RTCIceServer[];
    serverId: string;
    serverName?: string | null;
    channelId: string;
    channelName: string;
    roomName: string;
    returnChannelId?: string | null;
    returnChannelName?: string | null;
    micGranted: boolean;
    channelType?: "place" | "voice";
    /** Phase 8 follow-up — defaults to `"livekit"` when omitted. The
     *  mesh-mode `joinVoiceSession` path passes `"libp2p_mesh"` so
     *  the UI can branch. */
    transport?: VoiceTransport;
  }) => void;
  disconnect: () => void;
  setConnectionState: (state: VoiceConnectionState) => void;
  /** Claim the "connection attempt in flight" lock. Returns false if another
   *  attempt (page-refresh auto-reconnect or a manual join) is already running,
   *  in which case the caller should bail. Sets connectionState to "connecting"
   *  (or "reconnecting" when reconnecting=true). Must be paired with a
   *  setConnectionState("connected"|"disconnected"|"failed") on resolve. */
  beginConnectAttempt: (opts?: { reconnecting?: boolean }) => boolean;
  incrementReconnectAttempt: () => void;
  resetReconnectAttempt: () => void;
  /** INS-048: Called by VoiceChannel when local mic enabled state changes. */
  setMicActive: (active: boolean) => void;
  /** INS-048: Called by VoiceChannel when local camera enabled state changes. */
  setCameraActive: (active: boolean) => void;
}

/** Read a pending voice session from sessionStorage (if any). */
export function getPendingVoiceSession(): VoiceSession | null {
  try {
    const raw =
      localStorage.getItem(userScopedStorageKey(VOICE_SESSION_KEY)) ??
      sessionStorage.getItem(VOICE_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as VoiceSession;
  } catch {
    return null;
  }
}

/** Clear the pending voice session (called after successful reconnect or explicit disconnect). */
export function clearPendingVoiceSession(): void {
  localStorage.removeItem(userScopedStorageKey(VOICE_SESSION_KEY));
  sessionStorage.removeItem(VOICE_SESSION_KEY);
}

/** Maximum number of auto-reconnect attempts before giving up. */
export const MAX_RECONNECT_ATTEMPTS = 3;

/** Base delay (ms) for exponential backoff: 1s, 2s, 4s. */
export const RECONNECT_BASE_DELAY_MS = 1000;

export const useVoiceStore = create<VoiceState>((set, get) => ({
  connected: false,
  connectionState: "disconnected",
  reconnectAttempt: 0,
  transport: "livekit",
  token: null,
  livekitUrl: null,
  iceServers: [],
  serverId: null,
  serverName: null,
  channelId: null,
  channelName: null,
  roomName: null,
  returnChannelId: null,
  returnChannelName: null,
  micGranted: false,
  statsSessionId: null,
  channelType: null,
  micActive: false,
  cameraActive: false,

  setConnectionState: (state) => set({ connectionState: state }),
  beginConnectAttempt: ({ reconnecting } = {}) => {
    const current = get().connectionState;
    if (current === "connecting" || current === "reconnecting") return false;
    set({ connectionState: reconnecting ? "reconnecting" : "connecting" });
    return true;
  },
  incrementReconnectAttempt: () => set({ reconnectAttempt: get().reconnectAttempt + 1 }),
  resetReconnectAttempt: () => set({ reconnectAttempt: 0 }),
  setMicActive: (active) => set({ micActive: active }),
  setCameraActive: (active) => set({ cameraActive: active }),

  connect: (params) => {
    // Persist session info so we can reconnect after page refresh
    const session: VoiceSession = {
      serverId: params.serverId,
      serverName: params.serverName ?? null,
      channelId: params.channelId,
      channelName: params.channelName,
      roomName: params.roomName,
      returnChannelId: params.returnChannelId ?? null,
      returnChannelName: params.returnChannelName ?? null,
    };
    try {
      localStorage.setItem(userScopedStorageKey(VOICE_SESSION_KEY), JSON.stringify(session));
      sessionStorage.setItem(VOICE_SESSION_KEY, JSON.stringify(session));
    } catch {
      // storage unavailable — non-critical
    }

    set({
      connected: true,
      connectionState: "connected",
      reconnectAttempt: 0,
      channelType: params.channelType ?? "voice",
      transport: params.transport ?? "livekit",
      ...params,
    });

    // Start stats tracking (fire-and-forget)
    const token = useAuthStore.getState().accessToken;
    if (token) {
      startVoiceSession(params.channelId, params.serverId, token)
        .then((res) => {
          set({ statsSessionId: res.session_id });
          try {
            sessionStorage.setItem(VOICE_STATS_SESSION_KEY, String(res.session_id));
          } catch {}
        })
        .catch(() => {});
    }
  },

  disconnect: () => {
    // End stats tracking (fire-and-forget)
    const sessionId = get().statsSessionId || Number(sessionStorage.getItem(VOICE_STATS_SESSION_KEY) || 0);
    if (sessionId) {
      const token = useAuthStore.getState().accessToken;
      if (token) {
        endVoiceSession(sessionId, token).catch(() => {});
      }
      try { sessionStorage.removeItem(VOICE_STATS_SESSION_KEY); } catch {}
    }

    clearPendingVoiceSession();
    set({
      connected: false,
      connectionState: "disconnected",
      reconnectAttempt: 0,
      transport: "livekit",
      token: null,
      livekitUrl: null,
      iceServers: [],
      serverId: null,
      serverName: null,
      channelId: null,
      channelName: null,
      roomName: null,
      returnChannelId: null,
      returnChannelName: null,
      micGranted: false,
      statsSessionId: null,
      channelType: null,
      micActive: false,
      cameraActive: false,
    });
  },
}));
