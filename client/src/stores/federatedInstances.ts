/**
 * Federated instance catalog (INS-028 follow-up).
 *
 * Persistent store of every federated homeserver Concord has seen
 * this user interact with. Unlike the volatile `servers` array in
 * `server.ts`, this catalog survives page reloads and logout/login
 * cycles because it's backed by localStorage via Zustand's persist
 * middleware. The catalog answers three questions the sidebar needs
 * to render federated tiles meaningfully:
 *
 *   1. "Which federated instances have I joined anything on?"
 *      → Populated by `recordSeen()` whenever
 *        `hydrateFederatedRooms` observes a joined room on a remote
 *        homeserver. Lets the sidebar render placeholder tiles
 *        immediately on page load, before the Matrix sync has
 *        finished rebuilding the server store.
 *
 *   2. "Is this federated host another Concord instance, or a
 *      vanilla Matrix server?"
 *      → Populated by `probeConcordHost()`, which fetches the
 *        target's `/.well-known/concord/client` endpoint and
 *        caches the result (success → Concord instance,
 *        404/timeout → vanilla Matrix). Enables distinct sidebar
 *        visuals for Concord-on-Concord federation.
 *
 *   3. "Is this instance currently reachable?"
 *      → A `status` field on each record: `"live"` (reached
 *        within the last few minutes), `"stale"` (haven't seen
 *        recently), or `"unreachable"` (probe failed). The
 *        sidebar uses this to mark tiles as available / degraded
 *        / offline.
 *
 * Design note — persistence shape: we store a map keyed by
 * hostname, not an array, so `recordSeen()` is idempotent without
 * needing de-dup bookkeeping. On each recordSeen we overwrite the
 * existing record's last_seen timestamp and merge any new metadata.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/** Reachability state for a federated instance. */
export type FederatedInstanceStatus =
  | "live" /* seen by the Matrix client or probed successfully recently */
  | "stale" /* in the catalog but not seen this session yet */
  | "unreachable" /* probe failed during this session */
  | "unknown"; /* never probed */

/**
 * One catalog record per federated homeserver. Keyed by `hostname`
 * (the Matrix server name, e.g. `mozilla.org`). Only serializable
 * fields live here — no matrix-js-sdk Room references.
 */
export interface FederatedInstance {
  /** Matrix server name, e.g. `mozilla.org`. Lowercase, no scheme. */
  hostname: string;
  /**
   * Human-readable instance label. For Concord instances this is
   * the `instance_name` field from `.well-known/concord/client`.
   * For vanilla Matrix hosts it falls back to the bare hostname.
   */
  displayName: string;
  /**
   * `true` when this host advertises a `.well-known/concord/client`
   * document, signalling it's a Concord instance (not a vanilla
   * Matrix homeserver). Enables the distinct sidebar visuals the
   * user asked for so "other Concord instances visible in the
   * matrix federation" are obvious at a glance.
   */
  isConcord: boolean;
  /**
   * Current reachability state — see {@link FederatedInstanceStatus}.
   */
  status: FederatedInstanceStatus;
  /**
   * Unix timestamp (ms) of the most recent time this record was
   * touched by `recordSeen()`, `markStatus()`, or `probeConcordHost()`.
   * The sidebar can use this to render "last seen 2m ago" style
   * timestamps, and future cleanup logic can drop records that
   * haven't been seen in a long time.
   */
  lastSeenTs: number;
  /**
   * Optional advertised LiveKit URL from the host's well-known
   * doc. Populated for Concord instances where known; null for
   * vanilla Matrix hosts.
   */
  livekitUrl?: string | null;
  /**
   * Optional feature list from the host's well-known doc — useful
   * for future capability-gated UI (e.g. "this instance supports
   * voice but not soundboard").
   */
  features?: string[];
}

interface FederatedInstanceState {
  /** Keyed by `hostname`. Iteration order is insertion-order per JS spec. */
  instances: Record<string, FederatedInstance>;
  /**
   * Search query for the sidebar filter. Empty string = no filter.
   * Applied to both `hostname` and `displayName` substring-wise,
   * case-insensitive.
   */
  searchQuery: string;

  /**
   * Idempotently register a federated hostname as "seen". Updates
   * `lastSeenTs` and bumps the status to `"live"` if it wasn't
   * already. Called from `hydrateFederatedRooms` every time a
   * joined federated room is classified.
   */
  recordSeen: (
    hostname: string,
    metadata?: { displayName?: string },
  ) => void;

  /**
   * Explicit status override — used by the reachability probe to
   * mark an instance unreachable without having to touch the
   * timestamp.
   */
  markStatus: (hostname: string, status: FederatedInstanceStatus) => void;

  /**
   * Fire a `.well-known/concord/client` probe against the given
   * hostname and record the result. Safe to call multiple times;
   * implementations should de-duplicate in-flight probes in the
   * caller (a Set of hostnames currently being probed).
   */
  probeConcordHost: (hostname: string) => Promise<void>;

  /** Remove an instance entirely (e.g. on leave). */
  removeInstance: (hostname: string) => void;

  /** Update the sidebar search filter. */
  setSearchQuery: (query: string) => void;
}

const STORAGE_KEY = "concord_federated_instances";

/**
 * Extract the hostname portion of a Matrix room id. Accepts the
 * `!opaqueId:host` form only. Returns `null` for malformed inputs.
 */
export function hostnameFromRoomId(roomId: string): string | null {
  const colonIdx = roomId.lastIndexOf(":");
  if (colonIdx < 0) return null;
  const host = roomId.slice(colonIdx + 1).trim().toLowerCase();
  return host.length > 0 ? host : null;
}

export const useFederatedInstanceStore = create<FederatedInstanceState>()(
  persist(
    (set, get) => ({
      instances: {},
      searchQuery: "",

      recordSeen: (hostname, metadata) => {
        const normalized = hostname.toLowerCase();
        const now = Date.now();
        set((s) => {
          const existing = s.instances[normalized];
          // Display-name resolution priority:
          //   1. Caller-supplied metadata.displayName wins outright —
          //      this is the only way hydrateFederatedRooms or the
          //      well-known probe can update the label.
          //   2. If the existing record is a confirmed Concord
          //      instance, keep its displayName (which was set by
          //      `probeConcordHost` from the well-known's
          //      `instance_name` field and is authoritative).
          //   3. Otherwise default to the hostname. This is important
          //      for migrating stale entries from earlier code that
          //      stored room names (e.g. "Add-ons") as the
          //      displayName: if the record isn't confirmed Concord
          //      and the caller didn't supply a new name, we drop
          //      back to the hostname and overwrite the stale label.
          let displayName: string;
          if (metadata?.displayName) {
            displayName = metadata.displayName;
          } else if (existing?.isConcord && existing.displayName) {
            displayName = existing.displayName;
          } else {
            displayName = normalized;
          }
          const merged: FederatedInstance = {
            hostname: normalized,
            displayName,
            isConcord: existing?.isConcord ?? false,
            status: "live",
            lastSeenTs: now,
            livekitUrl: existing?.livekitUrl ?? null,
            features: existing?.features,
          };
          return {
            instances: { ...s.instances, [normalized]: merged },
          };
        });
      },

      markStatus: (hostname, status) => {
        const normalized = hostname.toLowerCase();
        set((s) => {
          const existing = s.instances[normalized];
          if (!existing) return s;
          return {
            instances: {
              ...s.instances,
              [normalized]: { ...existing, status, lastSeenTs: Date.now() },
            },
          };
        });
      },

      probeConcordHost: async (hostname) => {
        const normalized = hostname.toLowerCase();
        // Guard: never probe empty / obviously-bogus hostnames.
        if (!normalized || normalized.length < 3 || !normalized.includes(".")) {
          return;
        }

        // Build the well-known URL. We use https:// unconditionally
        // because Matrix federation over plain http is forbidden in
        // modern deployments, and Concord's own deploy only serves
        // the well-known over TLS.
        const url = `https://${normalized}/.well-known/concord/client`;
        let body: unknown;
        try {
          const resp = await fetch(url, {
            method: "GET",
            // Well-known documents are public — no credentials.
            credentials: "omit",
            // Short timeout so a dead host doesn't keep the UI
            // spinning. AbortSignal.timeout is the modern form.
            signal: AbortSignal.timeout(5000),
          });
          if (!resp.ok) {
            // 404 = not a Concord instance. Mark the existing
            // record (if any) as live but non-Concord.
            get().markStatus(normalized, "live");
            return;
          }
          body = await resp.json();
        } catch (err) {
          // Network error / timeout / CORS — leave the record in
          // whatever state it was in, but downgrade to stale so
          // the UI can reflect the reachability issue.
          // eslint-disable-next-line no-console
          console.warn(
            `probeConcordHost(${normalized}) failed:`,
            err instanceof Error ? err.message : err,
          );
          get().markStatus(normalized, "stale");
          return;
        }

        if (!body || typeof body !== "object") {
          get().markStatus(normalized, "live");
          return;
        }

        // Parse the Concord well-known shape. Matches the contract
        // in server/routers/wellknown.py: `{api_base, livekit_url?,
        // instance_name?, features?}`. Presence of `api_base` is
        // how we identify this as a Concord-authored document.
        const payload = body as {
          api_base?: string;
          livekit_url?: string | null;
          instance_name?: string;
          features?: string[];
        };
        if (typeof payload.api_base !== "string") {
          // Hosts can serve their own /.well-known/concord/client
          // with a different shape — treat as non-Concord.
          get().markStatus(normalized, "live");
          return;
        }

        const now = Date.now();
        set((s) => {
          const existing = s.instances[normalized];
          const merged: FederatedInstance = {
            hostname: normalized,
            displayName:
              payload.instance_name ?? existing?.displayName ?? normalized,
            isConcord: true,
            status: "live",
            lastSeenTs: now,
            livekitUrl: payload.livekit_url ?? null,
            features: payload.features,
          };
          return {
            instances: { ...s.instances, [normalized]: merged },
          };
        });
      },

      removeInstance: (hostname) => {
        const normalized = hostname.toLowerCase();
        set((s) => {
          if (!(normalized in s.instances)) return s;
          const next = { ...s.instances };
          delete next[normalized];
          return { instances: next };
        });
      },

      setSearchQuery: (query) => set({ searchQuery: query }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof window !== "undefined" && window.localStorage
          ? window.localStorage
          : {
              getItem: () => null,
              setItem: () => {},
              removeItem: () => {},
            },
      ),
      // Only persist the instances map. The search query is UI
      // state and should reset on reload.
      partialize: (state) => ({ instances: state.instances }),
    },
  ),
);

/**
 * Filter a list of federated instances against the current search
 * query. Returns the full list when the query is empty. Match is
 * case-insensitive, substring-based, and checks both `hostname`
 * and `displayName`. Export for reuse in sidebar + search modal.
 */
export function filterInstances(
  instances: FederatedInstance[],
  query: string,
): FederatedInstance[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return instances;
  return instances.filter(
    (inst) =>
      inst.hostname.includes(q) ||
      inst.displayName.toLowerCase().includes(q),
  );
}
