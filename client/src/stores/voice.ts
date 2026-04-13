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

interface VoiceSession {
  serverId: string;
  channelId: string;
  channelName: string;
  roomName: string;
}

interface VoiceState {
  connected: boolean;
  connectionState: VoiceConnectionState;
  reconnectAttempt: number;
  token: string | null;
  livekitUrl: string | null;
  iceServers: RTCIceServer[];
  serverId: string | null;
  channelId: string | null; // matrix_room_id
  channelName: string | null;
  roomName: string | null; // LiveKit room name (same as matrix room id)
  micGranted: boolean;
  statsSessionId: number | null;

  connect: (params: {
    token: string;
    livekitUrl: string;
    iceServers: RTCIceServer[];
    serverId: string;
    channelId: string;
    channelName: string;
    roomName: string;
    micGranted: boolean;
  }) => void;
  disconnect: () => void;
  setConnectionState: (state: VoiceConnectionState) => void;
  incrementReconnectAttempt: () => void;
  resetReconnectAttempt: () => void;
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
  token: null,
  livekitUrl: null,
  iceServers: [],
  serverId: null,
  channelId: null,
  channelName: null,
  roomName: null,
  micGranted: false,
  statsSessionId: null,

  setConnectionState: (state) => set({ connectionState: state }),
  incrementReconnectAttempt: () => set({ reconnectAttempt: get().reconnectAttempt + 1 }),
  resetReconnectAttempt: () => set({ reconnectAttempt: 0 }),

  connect: (params) => {
    // Persist session info so we can reconnect after page refresh
    const session: VoiceSession = {
      serverId: params.serverId,
      channelId: params.channelId,
      channelName: params.channelName,
      roomName: params.roomName,
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
      token: null,
      livekitUrl: null,
      iceServers: [],
      serverId: null,
      channelId: null,
      channelName: null,
      roomName: null,
      micGranted: false,
      statsSessionId: null,
    });
  },
}));
