import { memo, useState, useMemo, useEffect, useCallback } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useServerStore } from "../../stores/server";
import { useSourcesStore } from "../../stores/sources";
import { useServerConfigStore } from "../../stores/serverConfig";
import {
  useFederatedInstanceStore,
  filterInstances,
  hostnameFromRoomId,
} from "../../stores/federatedInstances";
import { useDMStore } from "../../stores/dm";
import { useAuthStore } from "../../stores/auth";
import {
  useUnreadCounts,
  useHighlightCounts,
} from "../../hooks/useUnreadCounts";
import { NewServerModal } from "../server/NewServerModal";
import { ExploreModal } from "../server/ExploreModal";

/**
 * INS-002B: Server-list drag reorder.
 *
 * Persists the user's preferred server order in localStorage under this
 * key, scoped by the current user id so multiple accounts on the same
 * browser don't clobber each other. localStorage is device-local (cross-
 * device sync is a follow-up that could use Matrix account data under
 * `com.concord.server_order`), but it satisfies the INS-002B acceptance
 * criterion of "persists across page reload". The stored value is a JSON
 * array of server ids (the concord server primary key, NOT the Matrix
 * room id).
 */
const SERVER_ORDER_STORAGE_KEY_PREFIX = "concord_server_order";
// Separate persistence bucket for the vanilla Matrix federated
// stack at the bottom of the sidebar. Stored independently from the
// main list so the two drag orderings don't interfere — the main
// list contains server ids for local + Concord-federated entries,
// while this one only contains matrix-federated ids (either live
// `federated:<roomId>` or placeholder `federated-placeholder:<host>`
// forms).
const MATRIX_FEDERATED_ORDER_STORAGE_KEY_PREFIX =
  "concord_matrix_federated_order";

function readStoredOrder(
  prefix: string,
  userId: string | null,
): string[] | null {
  if (typeof window === "undefined" || !userId) return null;
  try {
    const raw = window.localStorage.getItem(`${prefix}:${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
}

function writeStoredOrder(
  prefix: string,
  userId: string | null,
  order: string[],
): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.setItem(`${prefix}:${userId}`, JSON.stringify(order));
  } catch {
    // Quota exceeded or private-mode — silently skip. The list just
    // won't persist this session; it will fall back to the default
    // ordering on reload.
  }
}

const readStoredServerOrder = (userId: string | null) =>
  readStoredOrder(SERVER_ORDER_STORAGE_KEY_PREFIX, userId);
const writeStoredServerOrder = (userId: string | null, order: string[]) =>
  writeStoredOrder(SERVER_ORDER_STORAGE_KEY_PREFIX, userId, order);
const readStoredMatrixFederatedOrder = (userId: string | null) =>
  readStoredOrder(MATRIX_FEDERATED_ORDER_STORAGE_KEY_PREFIX, userId);
const writeStoredMatrixFederatedOrder = (
  userId: string | null,
  order: string[],
) =>
  writeStoredOrder(
    MATRIX_FEDERATED_ORDER_STORAGE_KEY_PREFIX,
    userId,
    order,
  );

interface ServerSidebarProps {
  mobile?: boolean;
  onServerSelect?: () => void;
}

export const ServerSidebar = memo(function ServerSidebar({ mobile, onServerSelect }: ServerSidebarProps) {
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const currentUserId = useAuthStore((s) => s.userId);
  // Global Matrix sync state — mirrored from `useMatrixSync()` into the
  // auth store by that hook. When false, the client is either starting
  // up, errored, or stopped, and every server tile should render in its
  // "disconnected" state (grayed + red dot).
  const syncing = useAuthStore((s) => s.syncing);
  const unreadCounts = useUnreadCounts();
  const highlightCounts = useHighlightCounts();
  const [showNewServer, setShowNewServer] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);

  // INS-002B: user-preferred order, loaded from localStorage keyed on the
  // current user id. Held in state so drag operations can optimistically
  // update it without waiting for the next storage read.
  const [preferredOrder, setPreferredOrder] = useState<string[] | null>(() =>
    readStoredServerOrder(currentUserId),
  );
  useEffect(() => {
    setPreferredOrder(readStoredServerOrder(currentUserId));
  }, [currentUserId]);

  // Parallel state for the vanilla Matrix federated stack (bottom
  // of the sidebar). Drag-reorder here persists under its own
  // localStorage key so it doesn't fight with the main-list ordering
  // above. When unset, the stack falls back to the original
  // reverse-join ordering (oldest above Explore, newest at the top
  // of the federated section).
  const [preferredMatrixOrder, setPreferredMatrixOrder] = useState<
    string[] | null
  >(() => readStoredMatrixFederatedOrder(currentUserId));
  useEffect(() => {
    setPreferredMatrixOrder(readStoredMatrixFederatedOrder(currentUserId));
  }, [currentUserId]);

  // Split the server list into three buckets:
  //   1. Local Concord-managed servers (this instance owns them).
  //   2. Federated rooms that turned out to be ANOTHER Concord
  //      instance (catalog `isConcord === true`) — these live in
  //      the main sidebar alongside local servers, participate in
  //      drag-reorder, and are styled with a secondary-palette
  //      highlight + "C" monogram so the user can tell they're
  //      not native.
  //   3. Vanilla Matrix federation — still pinned to the bottom
  //      stack above Explore.
  //
  // Bucket (2) is new: Concord-from-Concord federation used to sit
  // in the bottom stack alongside vanilla Matrix rooms, which hid
  // those servers behind a visual divider that didn't match the
  // user's mental model ("another Concord server is still one of
  // my servers"). Moving them into the main list lets the user
  // drag them wherever they want in their personal ordering.
  // INS-020: Source-based filtering. On native, servers only show if
  // their source is enabled. The primary instance host comes from
  // serverConfig; federated servers are matched by their hostname
  // (extracted from the synthetic server id or room id).
  // `__TAURI_INTERNALS__` — canonical Tauri v2 global. See the
  // explanation in `client/src/api/serverUrl.ts`.
  const isNative =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const allSources = useSourcesStore((s) => s.sources);
  const primaryHost = useServerConfigStore((s) => s.config?.host ?? "");
  const enabledHosts = useMemo(() => {
    if (!isNative) return null; // web: no source filtering
    const hosts = new Set<string>();
    for (const src of allSources) {
      if (src.enabled) hosts.add(src.host.toLowerCase());
    }
    return hosts;
  }, [isNative, allSources]);

  // Is the primary Concord instance enabled?
  const primaryEnabled = !enabledHosts || enabledHosts.has(primaryHost.toLowerCase());

  const localServers = useMemo(
    () => {
      const all = servers.filter((s) => s.federated !== true);
      return primaryEnabled ? all : [];
    },
    [servers, primaryEnabled],
  );
  const federatedServers = useMemo(
    () => {
      const all = servers.filter((s) => s.federated === true);
      if (!enabledHosts) return all; // web: show all
      return all.filter((s) => {
        // Extract hostname from the server's first channel room_id
        // format: "!xxx:hostname" → hostname
        const roomId = s.channels?.[0]?.matrix_room_id ?? "";
        const hostPart = roomId.split(":")[1]?.toLowerCase() ?? "";
        return enabledHosts.has(hostPart);
      });
    },
    [servers, enabledHosts],
  );

  // Persistent federated-instance catalog drives three features the
  // ephemeral `federatedServers` list above can't: (1) tiles appear
  // at page load BEFORE the Matrix client has finished syncing,
  // (2) each tile knows whether its host is another Concord instance
  // (distinct sidebar visuals), (3) a search filter over both
  // hostnames and display names.
  const instancesMap = useFederatedInstanceStore((s) => s.instances);
  const searchQuery = useFederatedInstanceStore((s) => s.searchQuery);

  // Map each live federated Server (from Matrix client state) back
  // to its catalog record so the render loop has access to the
  // `isConcord` flag and persistent metadata. Keyed by matrix host
  // extracted from the synthetic server id. Live servers that don't
  // yet have a catalog entry (e.g. freshly joined before
  // recordSeen has fired) fall through to a synthesized default.
  const liveFederatedEntries = useMemo(() => {
    return federatedServers.map((server) => {
      const roomId = server.id.replace(/^federated:/, "");
      const host = hostnameFromRoomId(roomId) ?? "";
      const catalog = host ? instancesMap[host] : undefined;
      return {
        server,
        host,
        isConcord: catalog?.isConcord ?? false,
        status: catalog?.status ?? "live",
      };
    });
  }, [federatedServers, instancesMap]);

  // Concord-federated servers that the Matrix client has actually
  // joined (the live slice of bucket 2 above). Promoted into the
  // main list. Placeholders for Concord-federated instances stay
  // in the bottom stack until their live entry materializes — they
  //'re a transient page-load state and the flicker window is brief.
  const concordFederatedLive = useMemo(
    () => liveFederatedEntries.filter((e) => {
      if (!e.isConcord) return false;
      // INS-020: also filter by enabled sources
      if (!enabledHosts) return true;
      return enabledHosts.has(e.host.toLowerCase());
    }),
    [liveFederatedEntries, enabledHosts],
  );

  // Set of ids for servers that came from Concord-on-Concord
  // federation. The render loop checks membership to decide between
  // the local-server palette and the "highlighted, not yours"
  // secondary palette + "C" monogram treatment.
  const concordFederatedIds = useMemo(
    () => new Set(concordFederatedLive.map((e) => e.server.id)),
    [concordFederatedLive],
  );

  // Base pool for the main (draggable) list: local servers plus
  // live Concord-federated servers. All of these share the same
  // drag-reorder flow — the preferredOrder array can contain ids
  // from both kinds, and they can be freely interleaved.
  const mainListPool = useMemo(
    () => [
      ...localServers,
      ...concordFederatedLive.map((e) => e.server),
    ],
    [localServers, concordFederatedLive],
  );

  // Compute the display order for the MAIN list (local + Concord-
  // federated). Any server present in the preferredOrder list first
  // (in that order), followed by any newly-joined servers that
  // haven't been placed yet, appended alphabetically by name.
  // Vanilla Matrix federation is handled separately and does NOT
  // participate in drag-reorder — its position is deterministic
  // from join order.
  const orderedServers = useMemo(() => {
    if (!preferredOrder || preferredOrder.length === 0) return mainListPool;
    const byId = new Map(mainListPool.map((s) => [s.id, s] as const));
    const placed: typeof mainListPool = [];
    const placedIds = new Set<string>();
    for (const id of preferredOrder) {
      const srv = byId.get(id);
      if (srv) {
        placed.push(srv);
        placedIds.add(id);
      }
    }
    const unplaced = mainListPool
      .filter((s) => !placedIds.has(s.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...placed, ...unplaced];
  }, [mainListPool, preferredOrder]);

  // Placeholder tiles: catalog records whose host has NO matching
  // live federated Server yet. These appear on a fresh page load
  // because the persist middleware hydrates the catalog synchronously
  // but the Matrix sync takes a few seconds to rebuild the server
  // list. The placeholders give the user something to see (and
  // click) during that window. Once hydrateFederatedRooms fires, the
  // placeholder for a given host is replaced by the live entry via
  // the Map below.
  const placeholderTiles = useMemo(() => {
    const liveHosts = new Set(liveFederatedEntries.map((e) => e.host));
    return Object.values(instancesMap)
      .filter((inst) => !liveHosts.has(inst.hostname))
      .map((inst) => ({
        // Synthetic server shape just enough for the render loop
        // below. Placeholder tiles don't have a matching real
        // Server record and clicking them is a no-op until the
        // Matrix client catches up.
        placeholder: true as const,
        server: {
          id: `federated-placeholder:${inst.hostname}`,
          name: inst.displayName,
          abbreviation: inst.displayName.charAt(0).toUpperCase() || "#",
          channels: [],
        },
        host: inst.hostname,
        isConcord: inst.isConcord,
        status: inst.status,
      }));
  }, [instancesMap, liveFederatedEntries]);

  // Apply the search filter across BOTH live and placeholder
  // tiles. An empty query returns everything. Reuses
  // `filterInstances` to stay consistent with any future
  // search-over-catalog UI. Concord-federated live entries are
  // filtered OUT here — they've been promoted into the main list
  // above and the bottom stack is now exclusively vanilla Matrix
  // federation.
  const filteredLive = useMemo(() => {
    const vanillaLive = liveFederatedEntries.filter((e) => !e.isConcord);
    if (!searchQuery.trim()) return vanillaLive;
    return vanillaLive.filter((e) => {
      const q = searchQuery.trim().toLowerCase();
      return (
        e.server.name.toLowerCase().includes(q) ||
        e.host.toLowerCase().includes(q)
      );
    });
  }, [liveFederatedEntries, searchQuery]);
  const filteredPlaceholders = useMemo(() => {
    return filterInstances(
      placeholderTiles.map((p) => ({
        hostname: p.host,
        displayName: p.server.name,
        isConcord: p.isConcord,
        status: p.status,
        lastSeenTs: 0,
      })),
      searchQuery,
    ).map((inst) =>
      placeholderTiles.find((p) => p.host === inst.hostname)!,
    );
  }, [placeholderTiles, searchQuery]);

  // Federated stack ordering.
  //
  // Default (no user preference): first joined at the bottom
  // (adjacent to Explore), newest at the top — the original
  // reverse-join layout. Live entries first, then placeholders
  // (catalog records we haven't seen in the Matrix client this
  // session yet).
  //
  // With a user preference: honor it. Any stack entry whose id
  // appears in `preferredMatrixOrder` renders in that order first,
  // and any entries the preference doesn't cover (new joins,
  // placeholders the user hasn't positioned yet) fall through to
  // the default reverse-join order after them.
  const federatedStack = useMemo(() => {
    const base = [
      ...filteredLive.map((e) => ({ ...e, placeholder: false as const })),
      ...filteredPlaceholders,
    ].filter((e) => {
      // INS-020: filter by enabled sources — toggled-off sources'
      // federated tiles also vanish. Only Explore stays always visible.
      if (!enabledHosts) return true; // web: show all
      return enabledHosts.has(e.host.toLowerCase());
    });
    if (!preferredMatrixOrder || preferredMatrixOrder.length === 0) {
      return base.slice().reverse();
    }
    const byId = new Map(base.map((e) => [e.server.id, e] as const));
    const placed: typeof base = [];
    const placedIds = new Set<string>();
    for (const id of preferredMatrixOrder) {
      const entry = byId.get(id);
      if (entry) {
        placed.push(entry);
        placedIds.add(id);
      }
    }
    // Unplaced entries (joined since the last drag, or placeholders
    // whose hosts haven't been dragged yet) keep the default reverse-
    // join ordering so new arrivals land at the top of the "everything
    // else" block, matching what the user would see if they hadn't
    // dragged at all.
    const unplaced = base
      .filter((e) => !placedIds.has(e.server.id))
      .reverse();
    return [...placed, ...unplaced];
  }, [filteredLive, filteredPlaceholders, preferredMatrixOrder]);

  // dnd-kit sensors — platform-specific.
  // Mobile: ONLY TouchSensor with 1-second hold. PointerSensor must NOT
  // be registered on touch devices because it fires at 5px movement,
  // overriding TouchSensor's delay and making tiles drag on any swipe.
  // Desktop: PointerSensor (5px distance) for mouse drag.
  // Both: KeyboardSensor for arrow-key reorder.
  const isTouchDevice = typeof window !== "undefined" && "ontouchstart" in window;
  const sensors = useSensors(
    ...(isTouchDevice
      ? [useSensor(TouchSensor, { activationConstraint: { delay: 1000, tolerance: 5 } })]
      : [useSensor(PointerSensor, { activationConstraint: { distance: 5 } })]),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = orderedServers.findIndex((s) => s.id === active.id);
      const newIndex = orderedServers.findIndex((s) => s.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const next = arrayMove(orderedServers, oldIndex, newIndex);
      const nextIds = next.map((s) => s.id);
      setPreferredOrder(nextIds);
      writeStoredServerOrder(currentUserId, nextIds);
    },
    [orderedServers, currentUserId],
  );

  // Drag-end handler for the vanilla Matrix federated stack. Same
  // shape as `handleDragEnd` above but writes to the matrix-
  // federated-specific localStorage key so the two draggable
  // surfaces don't cross-contaminate their orderings.
  const handleMatrixFederatedDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = federatedStack.findIndex(
        (e) => e.server.id === active.id,
      );
      const newIndex = federatedStack.findIndex(
        (e) => e.server.id === over.id,
      );
      if (oldIndex === -1 || newIndex === -1) return;
      const next = arrayMove(federatedStack, oldIndex, newIndex);
      const nextIds = next.map((e) => e.server.id);
      setPreferredMatrixOrder(nextIds);
      writeStoredMatrixFederatedOrder(currentUserId, nextIds);
    },
    [federatedStack, currentUserId],
  );

  // Per-server "needs attention" flag: true iff any channel in the
  // server has a highlight-worthy notification (Matrix mention, keyword
  // alert, etc.). Drives the yellow dot on the server tile. Plain
  // unread counts are already surfaced by the existing `hasUnreads`
  // computation at render time; this one is strictly for the louder
  // "come look at this" signal.
  const hasHighlightByServer = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const srv of servers) {
      const hit = srv.channels.some(
        (ch) => (highlightCounts.get(ch.matrix_room_id) ?? 0) > 0,
      );
      map.set(srv.id, hit);
    }
    return map;
  }, [servers, highlightCounts]);

  // DM state
  const dmActive = useDMStore((s) => s.dmActive);
  const setDMActive = useDMStore((s) => s.setDMActive);
  const dmConversations = useDMStore((s) => s.conversations);

  // Check if any DM has unreads
  const hasDMUnreads = useMemo(
    () => dmConversations.some((dm) => (unreadCounts.get(dm.matrix_room_id) ?? 0) > 0),
    [dmConversations, unreadCounts],
  );

  const handleServerClick = (serverId: string) => {
    setDMActive(false);
    setActiveServer(serverId);
    // Auto-select the server's first channel on click so the chat
    // view populates immediately. Without this, the activeChannelId
    // stays whatever it was before (often a channel from a DIFFERENT
    // server), the chat view keeps rendering that stale channel, and
    // the newly-clicked tile looks dead. Mattered most for federated
    // synthetic servers — their tiles looked unresponsive because
    // nothing in the right-hand chat pane changed on click.
    //
    // We only reset the channel when the new server's channel list
    // doesn't already contain the currently-active channel id. That
    // way re-clicking the currently-active server keeps your current
    // channel selection instead of resetting it every time the tile
    // is tapped.
    const state = useServerStore.getState();
    const target = state.servers.find((s) => s.id === serverId);
    if (target && target.channels.length > 0) {
      const current = state.activeChannelId;
      const alreadyInServer = current
        ? target.channels.some((c) => c.matrix_room_id === current)
        : false;
      if (!alreadyInServer) {
        useServerStore
          .getState()
          .setActiveChannel(target.channels[0].matrix_room_id);
      }
    }
    onServerSelect?.();
  };

  const handleDMClick = () => {
    useServerStore.setState({ activeServerId: null, activeChannelId: null });
    setDMActive(true);
  };

  // Mobile: full-width list view. The outer wrapper is a flex
  // column (not a plain block) so flex-shrink-0 on children forces
  // the parent's overflow-y-auto to scroll when content overflows,
  // instead of squeezing entries to fit. The `[&>*]:shrink-0`
  // arbitrary selector is a cheaper way to apply shrink-0 to every
  // direct child than marking each row individually.
  if (mobile) {
    return (
      <div className="h-full bg-surface-container-low">
        {/* ── Top scroll region: local + Concord servers ── */}
        <div className="overflow-y-auto overflow-x-hidden overscroll-y-auto p-3" style={{ height: "50%" }}>
        <h3 className="text-xs font-label font-medium text-on-surface-variant uppercase tracking-widest px-2 mb-3">
          Your Servers
        </h3>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={orderedServers.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-0.5">
              {orderedServers.map((server) => {
                const isActive = !dmActive && activeServerId === server.id;
                const hasUnreads = !isActive && server.channels.some(
                  (ch) => (unreadCounts.get(ch.matrix_room_id) ?? 0) > 0,
                );
                const hasHighlight = hasHighlightByServer.get(server.id) ?? false;
                // The main list now contains both native local
                // servers and Concord-from-Concord federated ones.
                // Vanilla Matrix federation is still pushed to the
                // bottom stack below and doesn't reach this branch.
                const isFromConcordFederation = concordFederatedIds.has(server.id);
                const isDiscordBridge = server.bridgeType === "discord";
                const isDisconnected = !syncing;
                // Dot precedence: disconnected (red) > needs attention
                // (yellow) > unread (primary). Only one dot at a time so
                // the tile doesn't turn into a traffic light cluster.
                const statusDot = isDisconnected
                  ? "red"
                  : hasHighlight
                    ? "yellow"
                    : hasUnreads
                      ? "unread"
                      : null;
                return (
                  <SortableServerRow
                    key={server.id}
                    id={server.id}
                    orientation="row"
                  >
                    <button
                      onClick={() => handleServerClick(server.id)}
                      title={
                        isDisconnected
                          ? `${server.name} (disconnected)`
                          : isDiscordBridge
                            ? `${server.name} — Discord bridge`
                            : isFromConcordFederation
                              ? `${server.name} — another Concord instance`
                              : server.name
                      }
                      className={`btn-press w-full flex items-center gap-3 px-3 py-1.5 rounded-xl transition-all ${
                        isDisconnected ? "opacity-50 grayscale" : ""
                      } ${
                        isActive
                          ? isDiscordBridge
                            ? "bg-[#5865F2]/10 text-[#5865F2]"
                            : isFromConcordFederation
                              ? "bg-secondary/10 text-secondary"
                              : "bg-primary/10 text-primary"
                          : "text-on-surface hover:bg-surface-container-high"
                      }`}
                    >
                      <div className="relative flex-shrink-0">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm font-headline font-bold ${
                          isActive
                            ? isDiscordBridge
                              ? "bg-[#5865F2] text-white"
                              : isFromConcordFederation
                                ? "bg-secondary text-on-secondary"
                                : "primary-glow text-on-primary"
                            : isDiscordBridge
                              ? "bg-[#5865F2]/15 text-[#5865F2] ring-1 ring-[#5865F2]/40"
                              : isFromConcordFederation
                                ? "bg-secondary/15 text-secondary ring-1 ring-secondary/40"
                                : "bg-surface-container-highest text-on-surface-variant"
                        }`}>
                          {server.abbreviation || server.name.charAt(0).toUpperCase()}
                        </div>
                        {isDiscordBridge && (
                          <div
                            className="absolute -top-1 -left-1 w-4 h-4 bg-[#5865F2] rounded-full border-2 border-surface-container-low flex items-center justify-center"
                            aria-label="Discord bridge"
                          >
                            <span
                              className="font-headline font-bold text-white"
                              style={{ fontSize: "8px", lineHeight: 1 }}
                            >
                              D
                            </span>
                          </div>
                        )}
                        {isFromConcordFederation && !isDiscordBridge && (
                          <div
                            className="absolute -top-1 -left-1 w-4 h-4 bg-secondary rounded-full border-2 border-surface-container-low flex items-center justify-center"
                            aria-label="Another Concord instance (federated)"
                          >
                            <span
                              className="font-headline font-bold text-on-secondary"
                              style={{ fontSize: "8px", lineHeight: 1 }}
                            >
                              C
                            </span>
                          </div>
                        )}
                      </div>
                      <span className="truncate font-body font-medium">{server.name}</span>
                      {isDiscordBridge && (
                        <span className="text-[10px] uppercase tracking-wider text-[#5865F2]/80 font-label ml-1">
                          discord
                        </span>
                      )}
                      {isFromConcordFederation && !isDiscordBridge && (
                        <span className="text-[10px] uppercase tracking-wider text-secondary/80 font-label ml-1">
                          concord federated
                        </span>
                      )}
                      {statusDot === "red" && (
                        <div
                          className="w-2.5 h-2.5 rounded-full bg-error ml-auto flex-shrink-0"
                          aria-label="Disconnected"
                        />
                      )}
                      {statusDot === "yellow" && (
                        <div
                          className="w-2.5 h-2.5 rounded-full bg-yellow-500 ml-auto flex-shrink-0 node-pulse"
                          aria-label="Needs attention"
                        />
                      )}
                      {statusDot === "unread" && (
                        <div
                          className="w-2.5 h-2.5 rounded-full bg-primary ml-auto flex-shrink-0 node-pulse"
                          aria-label="Unread messages"
                        />
                      )}
                    </button>
                  </SortableServerRow>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>

        <button
          onClick={() => setShowNewServer(true)}
          className="btn-press w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-on-surface-variant hover:text-secondary hover:bg-secondary/5 transition-all mt-2 flex-shrink-0"
        >
          <div className="w-10 h-10 rounded-xl bg-surface-container-highest flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-xl">add</span>
          </div>
          <span className="font-body font-medium">Add Server</span>
        </button>

        </div>
        {/* ── Bottom region: federated + Discord + Explore ── */}
        <div className="overflow-y-auto overflow-x-hidden overscroll-y-auto p-3 border-t border-outline-variant/20" style={{ height: "50%" }}>

        {/* Vanilla Matrix federated stack (mobile). Now draggable
            via dnd-kit to match the desktop sidebar and the main
            list. Placeholder tiles are non-draggable — same rule
            as desktop. */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleMatrixFederatedDragEnd}
        >
          <SortableContext
            items={federatedStack.map((e) => e.server.id)}
            strategy={verticalListSortingStrategy}
          >
            {federatedStack.map((entry) => {
              const { server, isConcord, placeholder } = entry;
              const isActive = !dmActive && activeServerId === server.id;
              const hasUnreads =
                !isActive &&
                !placeholder &&
                "channels" in server &&
                server.channels.some(
                  (ch: { matrix_room_id: string }) =>
                    (unreadCounts.get(ch.matrix_room_id) ?? 0) > 0,
                );
              const accentClass = isConcord ? "bg-secondary" : "bg-tertiary";
              const accentTextClass = isConcord
                ? "text-on-secondary"
                : "text-on-tertiary";
              const ringClass = isConcord
                ? "ring-secondary/40"
                : "ring-tertiary/40";
              const textAccentClass = isConcord
                ? "text-secondary"
                : "text-tertiary";
              return (
                <SortableServerRow
                  key={server.id}
                  id={server.id}
                  orientation="row"
                  disabled={placeholder}
                >
                  <button
                    onClick={
                      placeholder ? undefined : () => handleServerClick(server.id)
                    }
                    disabled={placeholder}
                    className={`btn-press w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all flex-shrink-0 ${
                      placeholder ? "opacity-55 cursor-default" : ""
                    } ${
                      isActive
                        ? isConcord
                          ? "bg-secondary/15 text-secondary ring-1 ring-secondary/40"
                          : "bg-tertiary/15 text-tertiary ring-1 ring-tertiary/40"
                        : "text-on-surface hover:bg-tertiary/10"
                    }`}
                  >
                    <div className="relative flex-shrink-0">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm font-headline font-bold ${
                          isActive
                            ? `${accentClass} ${accentTextClass}`
                            : `${isConcord ? "bg-secondary/15 text-secondary" : "bg-tertiary/15 text-tertiary"} ring-1 ${ringClass}`
                        }`}
                      >
                        {server.abbreviation || server.name.charAt(0).toUpperCase()}
                      </div>
                      <div
                        className={`absolute -top-1 -left-1 w-4 h-4 ${accentClass} rounded-full border-2 border-surface-container-low flex items-center justify-center`}
                        aria-hidden="true"
                      >
                        {isConcord ? (
                          <span
                            className={`font-headline font-bold ${accentTextClass}`}
                            style={{ fontSize: "8px", lineHeight: 1 }}
                          >
                            C
                          </span>
                        ) : (
                          <span
                            className={`material-symbols-outlined ${accentTextClass}`}
                            style={{ fontSize: "10px" }}
                          >
                            public
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1 text-left">
                      <div className="truncate font-body font-medium">{server.name}</div>
                      <div className={`text-[10px] uppercase tracking-wider ${textAccentClass}/80 font-label`}>
                        {isConcord ? "concord federated" : "matrix federated"}
                        {placeholder && " • connecting"}
                      </div>
                    </div>
                    {hasUnreads && (
                      <div className="w-2.5 h-2.5 rounded-full bg-primary flex-shrink-0 node-pulse" />
                    )}
                  </button>
                </SortableServerRow>
              );
            })}
          </SortableContext>
        </DndContext>

        {/* Explore — always the last row in the natural flow.
            Sidebar scrolls via the parent's overflow-y-auto when
            content is too tall. */}
        <button
          onClick={() => setExploreOpen(true)}
          className="btn-press w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-on-surface-variant hover:text-tertiary hover:bg-tertiary/5 transition-all flex-shrink-0"
        >
          <div className="w-10 h-10 rounded-xl bg-surface-container-highest flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-xl">public</span>
          </div>
          <span className="font-body font-medium">Explore</span>
        </button>

        </div>
        {/* Modals — outside both scroll regions */}
        {showNewServer && <NewServerModal onClose={() => setShowNewServer(false)} />}
        <ExploreModal isOpen={exploreOpen} onClose={() => setExploreOpen(false)} />
      </div>
    );
  }

  // Desktop: compact icon sidebar. The `[&>*]:shrink-0` arbitrary
  // selector forces every direct flex child (DM button, divider,
  // SortableServerRow, Add Server, federated tiles, Explore) to
  // keep its natural size so overflow-y-auto actually triggers when
  // the list grows beyond the viewport. Without it the default
  // `flex-shrink: 1` causes tiles to squish before the scrollbar
  // ever appears.
  return (
    <div className="w-16 bg-surface" style={{ height: "100%" }}>
      {/* ── Top scroll region: DMs + local servers ── */}
      <div className="overflow-y-auto overflow-x-hidden py-3 flex flex-col items-center gap-2 [&>*]:shrink-0" style={{ height: "50%" }}>
      {/* DM button */}
      <div className="relative group">
        <div className={`absolute -left-1 top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-primary transition-all ${
          dmActive ? "h-8" : hasDMUnreads ? "h-2" : "h-0 group-hover:h-5"
        }`} />
        <button
          onClick={handleDMClick}
          title="Direct Messages"
          className={`btn-press w-12 h-12 flex items-center justify-center transition-all ${
            dmActive
              ? "primary-glow text-on-primary rounded-xl"
              : "bg-surface-container-high text-on-surface-variant rounded-2xl hover:rounded-xl hover:bg-surface-container-highest hover:text-on-surface"
          }`}
        >
          <span className="material-symbols-outlined text-xl">chat_bubble</span>
        </button>
        {hasDMUnreads && !dmActive && (
          <div className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-primary rounded-full border-2 border-surface node-pulse" />
        )}
      </div>

      {/* Divider */}
      <div className="w-8 h-px bg-outline-variant/20 my-0.5" />

      {/* Server list — wrapped in DndContext for drag-reorder (INS-002B). */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={orderedServers.map((s) => s.id)}
          strategy={verticalListSortingStrategy}
        >
          {orderedServers.map((server) => {
            const isActive = !dmActive && activeServerId === server.id;
            const hasUnreads = !isActive && server.channels.some(
              (ch) => (unreadCounts.get(ch.matrix_room_id) ?? 0) > 0,
            );
            const hasHighlight = hasHighlightByServer.get(server.id) ?? false;
            // After the bucket reorganization, the only federated
            // servers that reach this main-list render path are
            // Concord-on-Concord federated ones (bucket 2). Keep
            // `isFromConcordFederation` as the explicit flag so the
            // styling branches stay readable.
            const isFromConcordFederation = concordFederatedIds.has(server.id);
            const isDisconnected = !syncing;
            // Status dot precedence: disconnected (red) > needs attention
            // (yellow) > unread (primary). Only ONE dot renders at a time.
            // The green "members online" dot was removed — activity is now
            // surfaced at the channel row level inside ChannelSidebar.
            const statusDot = isDisconnected
              ? "red"
              : hasHighlight
                ? "yellow"
                : hasUnreads
                  ? "unread"
                  : null;
            return (
              <SortableServerRow
                key={server.id}
                id={server.id}
                orientation="icon"
              >
                <div
                  className={`relative group ${
                    isDisconnected ? "opacity-55 grayscale" : ""
                  }`}
                >
                  {/* Active indicator bar — secondary palette for
                      Concord-federated tiles so the left rail hint
                      matches the tile's highlight treatment, primary
                      for native local servers. */}
                  <div className={`absolute -left-1 top-1/2 -translate-y-1/2 w-1 rounded-r-full transition-all ${
                    isFromConcordFederation ? "bg-secondary" : "bg-primary"
                  } ${
                    isActive ? "h-8" : hasUnreads ? "h-2" : "h-0 group-hover:h-5"
                  }`} />
                  <button
                    onClick={() => handleServerClick(server.id)}
                    title={
                      isDisconnected
                        ? `${server.name} — disconnected (drag to reorder)`
                        : isFromConcordFederation
                          ? `${server.name} — another Concord instance (drag to reorder)`
                          : `${server.name} — drag to reorder`
                    }
                    aria-label={
                      isFromConcordFederation
                        ? `${server.name} (Concord instance)`
                        : server.name
                    }
                    className={`btn-press w-12 h-12 flex items-center justify-center text-sm font-headline font-bold transition-all ${
                      isActive
                        ? isFromConcordFederation
                          ? "bg-secondary text-on-secondary rounded-xl shadow-[0_0_12px_rgba(120,220,180,0.35)]"
                          : "primary-glow text-on-primary rounded-xl"
                        : isFromConcordFederation
                          ? "bg-secondary/15 text-secondary rounded-2xl hover:rounded-xl hover:bg-secondary/25 ring-1 ring-secondary/40"
                          : "bg-surface-container-high text-on-surface-variant rounded-2xl hover:rounded-xl hover:bg-surface-container-highest hover:text-on-surface"
                    }`}
                  >
                    {server.abbreviation || server.name.charAt(0).toUpperCase()}
                  </button>
                  {isFromConcordFederation && (
                    /* Small "C" monogram badge at top-left marks this
                       tile as another Concord instance reached via
                       federation. Same treatment the bottom-stack
                       Concord-federated tiles used to carry, ported
                       up so the visual language stays consistent. */
                    <div
                      className="absolute -top-0.5 -left-0.5 w-4 h-4 bg-secondary rounded-full border-2 border-surface flex items-center justify-center"
                      aria-hidden="true"
                    >
                      <span
                        className="font-headline font-bold text-on-secondary"
                        style={{ fontSize: "8px", lineHeight: 1 }}
                      >
                        C
                      </span>
                    </div>
                  )}
                  {/* Single status dot, top-right. Precedence established
                      above: red (disconnected) beats yellow (attention)
                      beats primary (unread). */}
                  {statusDot === "red" && (
                    <div
                      className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-error rounded-full border-2 border-surface"
                      aria-label="Disconnected"
                    />
                  )}
                  {statusDot === "yellow" && (
                    <div
                      className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-yellow-500 rounded-full border-2 border-surface node-pulse"
                      aria-label="Needs attention"
                    />
                  )}
                  {statusDot === "unread" && (
                    <div
                      className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-primary rounded-full border-2 border-surface node-pulse"
                      aria-label="Unread messages"
                    />
                  )}
                </div>
              </SortableServerRow>
            );
          })}
        </SortableContext>
      </DndContext>

      {/* Add server — sits right below the Concord server list. */}
      <button
        onClick={() => setShowNewServer(true)}
        title="Add Server"
        className="btn-press w-12 h-12 rounded-2xl bg-surface-container-high text-on-surface-variant hover:bg-secondary/10 hover:text-secondary hover:rounded-xl flex items-center justify-center transition-all flex-shrink-0"
      >
        <span className="material-symbols-outlined text-xl">add</span>
      </button>

      </div>
      {/* ── Bottom region: federated + Explore ── */}
      <div className="overflow-y-auto overflow-x-hidden py-2 flex flex-col items-center gap-2 [&>*]:shrink-0 border-t border-outline-variant/20" style={{ height: "50%" }}>

      {/* Vanilla Matrix federated stack, stacked upward from Explore.
          Now draggable so users can reorder their federated rooms —
          backed by its own localStorage key so it doesn't tangle
          with the main-list ordering. Without a user preference,
          entries default to reverse-join order (oldest adjacent to
          Explore, newest at top).

          Concord-on-Concord federation lives in the main list
          above; this branch only renders vanilla Matrix federation
          (with the globe badge + tertiary palette).

          Placeholder entries (from the persistent catalog but not
          yet visible to the live Matrix client this session) render
          at reduced opacity, have their onClick disabled, and are
          passed `disabled` to the SortableServerRow so they don't
          participate in drag — their synthetic ids change the
          moment the matrix room syncs, which would leave a stale
          slot in the saved order. */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleMatrixFederatedDragEnd}
      >
        <SortableContext
          items={federatedStack.map((e) => e.server.id)}
          strategy={verticalListSortingStrategy}
        >
          {federatedStack.map((entry) => {
            const { server, host, isConcord, placeholder } = entry;
            const isActive = !dmActive && activeServerId === server.id;
            const hasUnreads =
              !isActive &&
              !placeholder &&
              "channels" in server &&
              server.channels.some(
                (ch: { matrix_room_id: string }) =>
                  (unreadCounts.get(ch.matrix_room_id) ?? 0) > 0,
              );
            const accentClass = isConcord ? "bg-secondary" : "bg-tertiary";
            const accentTextClass = isConcord
              ? "text-on-secondary"
              : "text-on-tertiary";
            const inactiveClass = isConcord
              ? "bg-secondary/15 text-secondary rounded-2xl hover:rounded-xl hover:bg-secondary/25 ring-1 ring-secondary/40"
              : "bg-tertiary/15 text-tertiary rounded-2xl hover:rounded-xl hover:bg-tertiary/25 ring-1 ring-tertiary/40";
            const activeClass = isConcord
              ? "bg-secondary text-on-secondary rounded-xl shadow-[0_0_12px_rgba(120,220,180,0.35)]"
              : "bg-tertiary text-on-tertiary rounded-xl shadow-[0_0_12px_rgba(180,120,255,0.35)]";
            return (
              <SortableServerRow
                key={server.id}
                id={server.id}
                orientation="icon"
                disabled={placeholder}
              >
                <div
                  className={`relative group flex-shrink-0 ${placeholder ? "opacity-55" : ""}`}
                >
                  <div
                    className={`absolute -left-1 top-1/2 -translate-y-1/2 w-1 rounded-r-full ${accentClass} transition-all ${
                      isActive ? "h-8" : hasUnreads ? "h-2" : "h-0 group-hover:h-5"
                    }`}
                  />
                  <button
                    onClick={
                      placeholder
                        ? undefined
                        : () => handleServerClick(server.id)
                    }
                    disabled={placeholder}
                    title={
                      placeholder
                        ? `${server.name} (${host}) — connecting…`
                        : isConcord
                          ? `${server.name} (${host}, Concord instance) — drag to reorder`
                          : `${server.name} (${host}, federated Matrix) — drag to reorder`
                    }
                    aria-label={
                      isConcord
                        ? `${server.name} Concord instance`
                        : `${server.name} federated Matrix server`
                    }
                    className={`btn-press w-12 h-12 flex items-center justify-center text-sm font-headline font-bold transition-all ${
                      isActive ? activeClass : inactiveClass
                    } ${placeholder ? "cursor-default" : ""}`}
                  >
                    {server.abbreviation ||
                      server.name.charAt(0).toUpperCase()}
                  </button>
                  {/* Top-left badge marks the instance type. A globe for
                      vanilla Matrix, a stylised "C" for Concord. Both
                      share the same absolute positioning so the rest of
                      the tile layout is unchanged. */}
                  <div
                    className={`absolute -top-0.5 -left-0.5 w-4 h-4 ${accentClass} rounded-full border-2 border-surface flex items-center justify-center`}
                    aria-hidden="true"
                  >
                    {isConcord ? (
                      <span
                        className={`font-headline font-bold ${accentTextClass}`}
                        style={{ fontSize: "8px", lineHeight: 1 }}
                      >
                        C
                      </span>
                    ) : (
                      <span
                        className={`material-symbols-outlined ${accentTextClass}`}
                        style={{ fontSize: "10px" }}
                      >
                        public
                      </span>
                    )}
                  </div>
                  {hasUnreads && (
                    <div className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-primary rounded-full border-2 border-surface node-pulse" />
                  )}
                </div>
              </SortableServerRow>
            );
          })}
        </SortableContext>
      </DndContext>

      {/* Explore federated servers — always rendered last so it
          sits at the bottom of the natural flow. Federated servers
          above it stack in reverse chronological order (first join
          adjacent to this button, newest join at the top of the
          federated section). When the sidebar overflows, the whole
          list scrolls via the parent's overflow-y-auto. */}
      <button
        onClick={() => setExploreOpen(true)}
        title="Explore"
        aria-label="Explore federated servers"
        className="btn-press w-12 h-12 rounded-2xl bg-surface-container-high text-on-surface-variant hover:bg-tertiary/15 hover:text-tertiary hover:rounded-xl flex items-center justify-center transition-all flex-shrink-0"
      >
        <span className="material-symbols-outlined text-xl">public</span>
      </button>

      </div>
      {/* Modals */}
      {showNewServer && <NewServerModal onClose={() => setShowNewServer(false)} />}
      <ExploreModal isOpen={exploreOpen} onClose={() => setExploreOpen(false)} />
    </div>
  );
});

/**
 * Sortable wrapper for a single server tile. Shares the same dnd-kit
 * plumbing the channel reorder uses in ChannelSidebar.tsx: pulls the
 * transform/transition from `useSortable`, applies it via inline style,
 * and binds the drag listeners to the wrapper. Child click handlers
 * continue to fire because PointerSensor has an activation distance of
 * 5px, so clicks with <5px of movement bypass the drag.
 */
function SortableServerRow({
  id,
  orientation,
  disabled,
  children,
}: {
  id: string;
  orientation: "row" | "icon";
  // Opt out of drag handling for rows that shouldn't participate
  // (e.g. federated-instance placeholder tiles whose synthetic ids
  // change the moment their matrix room syncs). Disabled rows still
  // live inside the SortableContext so their position within the
  // list is preserved, they just refuse to pick up.
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    touchAction: orientation === "icon" ? "none" : undefined,
    // Grab cursor gives users a visible affordance that the tile can
    // be dragged to reorder. PointerSensor still has a 5px activation
    // distance so a plain click to select the server keeps working.
    // Disabled rows use the default cursor so they don't falsely
    // advertise drag affordance.
    cursor: disabled ? undefined : isDragging ? "grabbing" : "grab",
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}
