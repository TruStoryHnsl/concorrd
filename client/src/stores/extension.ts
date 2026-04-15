import { create } from "zustand";
import { useAuthStore } from "./auth";
import { listExtensions, type ServerExtension } from "../api/concord";

/* ── Types ─────────────────────────────────────────────────────── */

export interface ExtensionDefinition {
  id: string;
  name: string;
  url: string;
  icon: string;
  description: string;
}

export interface ActiveExtension {
  extensionId: string;
  extensionUrl: string;
  extensionName: string;
  hostUserId: string;
  startedAt: number;
  /**
   * Optional surface descriptors from the INS-036 session model.
   * When absent or empty, a single default panel surface is rendered
   * (backward compat with legacy `com.concord.extension` events).
   */
  surfaces?: import("../components/extension/ExtensionEmbed").SurfaceDescriptor[];
}

interface ExtensionState {
  /** Per-room active extension, keyed by matrix room ID */
  activeExtensions: Record<string, ActiveExtension | null>;
  /** Available extensions fetched from the server */
  catalog: ExtensionDefinition[];
  /** Whether the catalog has been loaded */
  catalogLoaded: boolean;
  /** Whether the extension picker menu is open */
  menuOpen: boolean;

  loadCatalog: (accessToken: string) => Promise<void>;
  setActiveExtension: (roomId: string, ext: ActiveExtension | null) => void;
  startExtension: (roomId: string, extensionId: string) => Promise<void>;
  stopExtension: (roomId: string) => Promise<void>;
  setMenuOpen: (open: boolean) => void;
}

/* ── Matrix event constants ────────────────────────────────────── */

export const EXTENSION_EVENT_TYPE = "com.concord.extension";
export const EXTENSION_STATE_KEY = "";

/* ── Store ──────────────────────────────────────────────────────── */

export const useExtensionStore = create<ExtensionState>((set, get) => ({
  activeExtensions: {},
  catalog: [],
  catalogLoaded: false,
  menuOpen: false,

  loadCatalog: async (accessToken) => {
    if (get().catalogLoaded) return;
    try {
      const exts: ServerExtension[] = await listExtensions(accessToken);
      set({
        catalog: exts.map((e) => ({
          id: e.id,
          name: e.name,
          url: e.url,
          icon: e.icon,
          description: e.description,
        })),
        catalogLoaded: true,
      });
    } catch (err) {
      console.warn("[extensions] Failed to load catalog from server:", err);
    }
  },

  setActiveExtension: (roomId, ext) =>
    set((s) => ({
      activeExtensions: { ...s.activeExtensions, [roomId]: ext },
    })),

  startExtension: async (roomId, extensionId) => {
    const client = useAuthStore.getState().client;
    const userId = useAuthStore.getState().userId;
    if (!client || !userId) return;

    const def = get().catalog.find((d) => d.id === extensionId);
    if (!def) return;

    const content = {
      active: true,
      extension_id: def.id,
      extension_url: def.url,
      extension_name: def.name,
      host_user_id: userId,
      started_at: Date.now(),
    };

    // Optimistic update
    set((s) => ({
      activeExtensions: {
        ...s.activeExtensions,
        [roomId]: {
          extensionId: def.id,
          extensionUrl: def.url,
          extensionName: def.name,
          hostUserId: userId,
          startedAt: content.started_at,
        },
      },
      menuOpen: false,
    }));

    // Broadcast to other room members via Matrix state event.
    // If it fails, keep the local state — extension still works for this user.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any).sendStateEvent(
        roomId,
        EXTENSION_EVENT_TYPE,
        content,
        EXTENSION_STATE_KEY,
      );
    } catch (err) {
      console.warn("[extensions] State event failed (extension still active locally):", err);
    }
  },

  stopExtension: async (roomId) => {
    const client = useAuthStore.getState().client;
    if (!client) return;

    // Optimistic update
    set((s) => ({
      activeExtensions: { ...s.activeExtensions, [roomId]: null },
    }));

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any).sendStateEvent(
        roomId,
        EXTENSION_EVENT_TYPE,
        { active: false },
        EXTENSION_STATE_KEY,
      );
    } catch (err) {
      console.error("[extensions] Failed to clear state event:", err);
    }
  },

  setMenuOpen: (menuOpen) => set({ menuOpen }),
}));
