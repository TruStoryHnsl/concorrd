/**
 * Sources store — manages connections to Concord instances (INS-020).
 *
 * Native apps (iOS, desktop Tauri) connect to MULTIPLE Concord instances
 * simultaneously. Each connection is a "source" established via an invite
 * token. The server sidebar aggregates servers from all connected sources.
 *
 * Web clients (docker-served) skip this layer entirely — the single
 * instance IS the source, and the browser user is already "inside" it.
 *
 * Persistence: localStorage via Zustand's `persist` middleware, same
 * pattern as `serverConfig.ts`. Tokens are stored locally — future
 * enhancement could use Tauri Stronghold for encrypted storage.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useServerConfigStore } from "./serverConfig";

export interface ConcordSource {
  /** Unique ID for this source connection. */
  id: string;
  /** The hostname of the Concord instance (e.g., "chat.example.com"). */
  host: string;
  /** Human-readable instance name (from .well-known/concord/client). */
  instanceName?: string;
  /** The invite token used to establish this connection. */
  inviteToken: string;
  /** Matrix access token for authenticated API calls to this instance. */
  accessToken?: string;
  /** Matrix user ID on this instance (e.g., "@user:chat.example.com"). */
  userId?: string;
  /** Concord API base URL (from well-known discovery). */
  apiBase: string;
  /** Matrix homeserver URL (from well-known discovery). */
  homeserverUrl: string;
  /** Connection status. */
  status: "connecting" | "connected" | "disconnected" | "error";
  /** Whether this source's servers are visible in the server column. */
  enabled: boolean;
  /** Error message if status is "error". */
  error?: string;
  /** When this source was added (ISO timestamp). */
  addedAt: string;
  /** What kind of network this source represents. Defaults to "concord". */
  platform?: "concord" | "matrix" | "discord-bot" | "discord-account";
}

export interface SourcesState {
  sources: ConcordSource[];
  /** Add a new source. Returns the generated source ID. */
  addSource: (source: Omit<ConcordSource, "id" | "addedAt">) => string;
  /** Update an existing source by ID. */
  updateSource: (id: string, patch: Partial<ConcordSource>) => void;
  /** Remove a source by ID. */
  removeSource: (id: string) => void;
  /** Get a source by ID. */
  getSource: (id: string) => ConcordSource | undefined;
  /** Get all connected + enabled sources. */
  connectedSources: () => ConcordSource[];
  /** Toggle a source's visibility in the server column. */
  toggleSource: (id: string) => void;
  /** Sync Discord bridge source state from Matrix room scan. */
  syncDiscordBridge: (bridgeRunning: boolean) => void;
  /** One-time migration from active session (native first launch). */
  migrateFromSession: () => void;
  /**
   * Idempotent: ensure a source entry exists for the given primary
   * instance config. Called from the server picker's confirm handler
   * immediately after `setHomeserver` so the sources store reflects
   * the newly-picked instance without waiting for the next app launch.
   *
   * If a source with a matching host already exists, updates its
   * fields in place (instanceName, apiBase, homeserverUrl) so stale
   * entries from previous launches pick up new well-known values.
   * Otherwise inserts a new enabled "connected" entry.
   */
  ensurePrimarySource: (config: {
    host: string;
    instance_name?: string;
    api_base: string;
    homeserver_url: string;
  }) => void;
}

const STORAGE_KEY = "concord_sources";

function generateSourceId(): string {
  return `src_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useSourcesStore = create<SourcesState>()(
  persist(
    (set, get) => ({
      sources: [],

      addSource: (source) => {
        const id = generateSourceId();
        const full: ConcordSource = {
          ...source,
          id,
          addedAt: new Date().toISOString(),
        };
        set((state) => ({ sources: [...state.sources, full] }));
        return id;
      },

      updateSource: (id, patch) => {
        set((state) => ({
          sources: state.sources.map((s) =>
            s.id === id ? { ...s, ...patch } : s,
          ),
        }));
      },

      removeSource: (id) => {
        set((state) => ({
          sources: state.sources.filter((s) => s.id !== id),
        }));
      },

      getSource: (id) => get().sources.find((s) => s.id === id),

      connectedSources: () =>
        get().sources.filter((s) => s.status === "connected" && s.enabled),

      toggleSource: (id) => {
        set((state) => ({
          sources: state.sources.map((s) =>
            s.id === id ? { ...s, enabled: !s.enabled } : s,
          ),
        }));
      },

      syncDiscordBridge: (_bridgeRunning) => {
        // Stub — Discord bridge source management is handled by
        // the migration flow. This satisfies calls from useMatrix.ts.
      },

      ensurePrimarySource: (config) => {
        const hostLc = config.host.toLowerCase();
        const existing = get().sources.find(
          (s) => s.host.toLowerCase() === hostLc,
        );
        if (existing) {
          // Update in place — new well-known values may differ from
          // what was persisted last session (e.g. instance rename).
          set((state) => ({
            sources: state.sources.map((s) =>
              s.id === existing.id
                ? {
                    ...s,
                    instanceName: config.instance_name ?? s.instanceName,
                    apiBase: config.api_base,
                    homeserverUrl: config.homeserver_url,
                    status: "connected",
                    // Preserve the user's enabled toggle if they
                    // previously hid this source — don't force-enable.
                  }
                : s,
            ),
          }));
          return;
        }
        const id = generateSourceId();
        const primary: ConcordSource = {
          id,
          host: config.host,
          instanceName: config.instance_name,
          inviteToken: "",
          accessToken: undefined,
          apiBase: config.api_base,
          homeserverUrl: config.homeserver_url,
          status: "connected",
          enabled: true,
          addedAt: new Date().toISOString(),
        };
        set((state) => ({ sources: [...state.sources, primary] }));
      },

      /**
       * One-time migration: populate sources from the active session.
       * Called on native app startup when the sources store is empty
       * but an existing serverConfig has been set (typically by a
       * prior picker-confirm that wrote the config but never hit
       * `addSource`). Only ever writes ONE entry: the primary source
       * for `serverConfig.config`. Federated instance entries are
       * NOT migrated — the old federatedInstances catalog has been
       * deleted under the 2026-04-11 architecture rule, and federated
       * homeservers are now added by the user through the Sources
       * `+` tile rather than auto-populated from a catalog.
       */
      migrateFromSession: () => {
        if (get().sources.length > 0) return; // already populated

        const config = useServerConfigStore.getState().config;
        if (!config) return;

        const id = generateSourceId();
        const primary: ConcordSource = {
          id,
          host: config.host,
          instanceName: config.instance_name,
          inviteToken: "",
          accessToken: undefined,
          apiBase: config.api_base,
          homeserverUrl: config.homeserver_url,
          status: "connected",
          enabled: true,
          addedAt: new Date().toISOString(),
        };
        set((state) => ({ sources: [...state.sources, primary] }));
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof window !== "undefined" && window.localStorage
          ? window.localStorage
          : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      ),
      partialize: (state) => ({ sources: state.sources }),
      version: 2,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as { sources?: ConcordSource[] };
        if (version === 0 && state.sources) {
          // v0 → v1: ensure every source has `enabled` defaulting to true.
          state.sources = state.sources.map((s) => ({
            ...s,
            enabled: s.enabled ?? true,
          }));
        }
        if (version < 2 && state.sources) {
          state.sources = state.sources.map((s) => ({
            ...s,
            platform: s.platform ?? "concord",
          }));
        }
        return state as SourcesState;
      },
    },
  ),
);
