import { create } from "zustand";
import type { MatrixClient } from "matrix-js-sdk";
import { createMatrixClient } from "../api/matrix";
import { useServerStore } from "./server";
import { useSourcesStore } from "./sources";

interface AuthState {
  client: MatrixClient | null;
  userId: string | null;
  accessToken: string | null;
  isLoggedIn: boolean;
  isLoading: boolean;
  /** True when the active session is an anonymous guest session. */
  isGuest: boolean;
  // Matrix client sync health. Mirrors the boolean returned by
  // `useMatrixSync()` so any component (e.g. ServerSidebar) can read
  // connection state without re-subscribing to ClientEvent.Sync and
  // duplicating that hook's federated-hydration side effects.
  syncing: boolean;

  login: (accessToken: string, userId: string, deviceId: string) => void;
  /** Log in as a guest (anonymous, read-mostly, ephemeral session). */
  loginGuest: (accessToken: string, userId: string, deviceId: string) => void;
  logout: () => void;
  restoreSession: () => boolean;
  setSyncing: (syncing: boolean) => void;
}

const STORAGE_KEY = "concord_session";

interface StoredSession {
  accessToken: string;
  userId: string;
  deviceId: string;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  client: null,
  userId: null,
  accessToken: null,
  isLoggedIn: false,
  isGuest: false,
  isLoading: true,
  syncing: false,

  setSyncing: (syncing) => set({ syncing }),

  login: (accessToken, userId, deviceId) => {
    const client = createMatrixClient(accessToken, userId, deviceId);
    useServerStore.getState().resetState();
    useSourcesStore.getState().bindToUser(userId);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ accessToken, userId, deviceId }),
    );
    set({ client, userId, accessToken, isLoggedIn: true, isGuest: false, isLoading: false });
  },

  loginGuest: (accessToken, userId, deviceId) => {
    const client = createMatrixClient(accessToken, userId, deviceId);
    useServerStore.getState().resetState();
    // Guest sessions are ephemeral — do NOT persist to localStorage.
    // Clearing the storage key ensures a real login prompt appears on
    // next app launch rather than restoring the stale guest session.
    localStorage.removeItem(STORAGE_KEY);
    set({ client, userId, accessToken, isLoggedIn: true, isGuest: true, isLoading: false });
  },

  logout: () => {
    const { client } = get();
    if (client) {
      client.stopClient();
    }
    useServerStore.getState().resetState();
    useSourcesStore.getState().bindToUser(null);
    localStorage.removeItem(STORAGE_KEY);
    set({
      client: null,
      userId: null,
      accessToken: null,
      isLoggedIn: false,
      isGuest: false,
      isLoading: false,
      syncing: false,
    });
  },

  restoreSession: () => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      useServerStore.getState().resetState();
      set({ isLoading: false });
      return false;
    }
    try {
      const { accessToken, userId, deviceId }: StoredSession =
        JSON.parse(stored);
      const client = createMatrixClient(accessToken, userId, deviceId);
      useServerStore.getState().resetState();
      useSourcesStore.getState().bindToUser(userId);
      set({
        client,
        userId,
        accessToken,
        isLoggedIn: true,
        isLoading: false,
      });
      return true;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      useServerStore.getState().resetState();
      useSourcesStore.getState().bindToUser(null);
      set({ isLoading: false });
      return false;
    }
  },
}));
