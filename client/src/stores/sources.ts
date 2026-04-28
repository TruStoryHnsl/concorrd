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
import type { MatrixLoginFlowKind } from "../api/matrix";
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
  /** Matrix device ID for the authenticated source session. */
  deviceId?: string;
  /** Concord API base URL (from well-known discovery). */
  apiBase: string;
  /** Matrix homeserver URL (from well-known discovery). */
  homeserverUrl: string;
  /** Canonical Matrix server_name after login/discovery, if known. */
  serverName?: string;
  /** Original typed host when discovery delegates elsewhere. */
  delegatedFrom?: string;
  /** Server-advertised login flows supported by this source. */
  authFlows?: MatrixLoginFlowKind[];
  /** Last source-auth error surfaced to the user. */
  authError?: string;
  /** Connection status. */
  status: "connecting" | "connected" | "disconnected" | "error";
  /** Whether this source's servers are visible in the server column. */
  enabled: boolean;
  /** Error message if status is "error". */
  error?: string;
  /** When this source was added (ISO timestamp). */
  addedAt: string;
  /** What kind of network this source represents. Defaults to "concord". */
  platform?: "concord" | "matrix" | "reticulum";
  /** Concord user who owns this persisted source. Null => instance-global primary source. */
  ownerUserId?: string | null;
  /**
   * True when this source represents a Concord instance that the
   * current user OWNS — i.e. the embedded servitude module on this
   * device created the homeserver and the current Matrix user is
   * its admin. Drives the owner badge in the Sources rail tile and
   * gates the "Server Settings" affordance. Distinct from
   * `ownerUserId`, which scopes the persisted source to a Concord
   * user (multi-account isolation); `isOwner` is about the homeserver
   * itself. Defaults to false on every existing entry; only set true
   * by the Host onboarding flow (W2-06) when servitude_start
   * succeeds and the owner account is registered + elevated.
   */
  isOwner?: boolean;
}

export function getSourceHomeserverHost(source: Pick<ConcordSource, "homeserverUrl">): string | null {
  if (!source.homeserverUrl) return null;
  try {
    return new URL(source.homeserverUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

export function getSourceMatrixDomains(
  source: Pick<ConcordSource, "host" | "serverName" | "delegatedFrom" | "homeserverUrl">,
): string[] {
  const domains = new Set<string>();
  const push = (value?: string) => {
    const normalized = value?.trim().toLowerCase();
    if (normalized) domains.add(normalized);
  };
  push(source.host);
  push(source.serverName);
  push(source.delegatedFrom);
  push(getSourceHomeserverHost(source) ?? undefined);
  return [...domains];
}

export function sourceMatchesMatrixDomain(
  source: Pick<ConcordSource, "host" | "serverName" | "delegatedFrom" | "homeserverUrl">,
  domain: string,
): boolean {
  const normalized = domain.trim().toLowerCase();
  if (!normalized) return false;
  return getSourceMatrixDomains(source).includes(normalized);
}

export interface SourcesState {
  sources: ConcordSource[];
  /** Concord user currently bound to the persisted source set. */
  boundUserId: string | null;
  /** Add a new source. Returns the generated source ID. */
  addSource: (source: Omit<ConcordSource, "id" | "addedAt">) => string;
  /** Persist a new source tile order. */
  reorderSources: (activeId: string, overId: string) => void;
  /** Replace the full persisted source order. */
  setSourceOrder: (orderedIds: string[]) => void;
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
  /**
   * Set the `isOwner` flag on a source. Called by the Host
   * onboarding flow (W2-06) after servitude_start + owner account
   * registration + admin elevation succeed. The Sources rail tile
   * uses this to render the owner badge; "Server Settings" is gated
   * on it.
   */
  markOwner: (id: string, isOwner: boolean) => void;
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
  /** Scope persisted sources to the currently-authenticated Concord user. */
  bindToUser: (userId: string | null) => void;
}

const STORAGE_KEY = "concord_sources";

function generateSourceId(): string {
  return `src_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isPrimarySource(source: Pick<ConcordSource, "platform" | "inviteToken">): boolean {
  return (source.platform ?? "concord") === "concord" && source.inviteToken.trim() === "";
}

function resolveOwnedSourceUserId(
  source: Pick<ConcordSource, "ownerUserId" | "platform" | "inviteToken">,
  boundUserId: string | null,
): string | null | undefined {
  if (isPrimarySource(source)) return null;
  return source.ownerUserId ?? boundUserId ?? undefined;
}

export const useSourcesStore = create<SourcesState>()(
  persist(
    (set, get) => ({
      sources: [],
      boundUserId: null,

      addSource: (source) => {
        const id = generateSourceId();
        const full: ConcordSource = {
          ...source,
          ownerUserId: source.ownerUserId ?? get().boundUserId ?? null,
          id,
          addedAt: new Date().toISOString(),
        };
        set((state) => ({ sources: [...state.sources, full] }));
        return id;
      },

      reorderSources: (activeId, overId) => {
        if (activeId === overId) return;
        set((state) => {
          const from = state.sources.findIndex((source) => source.id === activeId);
          const to = state.sources.findIndex((source) => source.id === overId);
          if (from === -1 || to === -1) return state;
          const next = [...state.sources];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          return { sources: next };
        });
      },

      setSourceOrder: (orderedIds) => {
        set((state) => {
          const byId = new Map(state.sources.map((source) => [source.id, source] as const));
          const ordered: ConcordSource[] = [];
          const seen = new Set<string>();
          for (const id of orderedIds) {
            const source = byId.get(id);
            if (!source || seen.has(id)) continue;
            ordered.push(source);
            seen.add(id);
          }
          for (const source of state.sources) {
            if (!seen.has(source.id)) ordered.push(source);
          }
          return { sources: ordered };
        });
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

      markOwner: (id, isOwner) => {
        set((state) => ({
          sources: state.sources.map((s) =>
            s.id === id ? { ...s, isOwner } : s,
          ),
        }));
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
                    ownerUserId: null,
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
          ownerUserId: null,
          addedAt: new Date().toISOString(),
        };
        set((state) => ({ sources: [...state.sources, primary] }));
      },

      bindToUser: (userId) => {
        set((state) => {
          const nextSources: ConcordSource[] = [];
          for (const source of state.sources) {
            if (isPrimarySource(source)) {
              nextSources.push({ ...source, ownerUserId: null });
              continue;
            }

            const ownerUserId = resolveOwnedSourceUserId(source, state.boundUserId);
            if (!userId || ownerUserId !== userId) {
              continue;
            }

            nextSources.push({ ...source, ownerUserId });
          }

          return {
            sources: nextSources,
            boundUserId: userId,
          };
        });
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
          ownerUserId: null,
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
      partialize: (state) => ({
        sources: state.sources,
        boundUserId: state.boundUserId,
      }),
      version: 5,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as { sources?: ConcordSource[]; boundUserId?: string | null };
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
        if (version < 3 && state.sources) {
          state.sources = state.sources.map((s) => ({
            ...s,
            serverName: s.serverName ?? undefined,
            delegatedFrom: s.delegatedFrom ?? undefined,
            authFlows: s.authFlows ?? undefined,
            authError: s.authError ?? undefined,
            deviceId: s.deviceId ?? undefined,
          }));
        }
        if (version < 4 && state.sources) {
          state.sources = state.sources.map((s) => ({
            ...s,
            ownerUserId: isPrimarySource(s) ? null : s.ownerUserId ?? undefined,
          }));
          state.boundUserId = state.boundUserId ?? null;
        }
        if (version < 5 && state.sources) {
          // v4 → v5 (W2-09): add `isOwner` field. Default false for
          // every existing entry — only the Host onboarding flow
          // (W2-06) sets it true on a freshly-created local source.
          state.sources = state.sources.map((s) => ({
            ...s,
            isOwner: s.isOwner ?? false,
          }));
        }
        return state as SourcesState;
      },
    },
  ),
);
