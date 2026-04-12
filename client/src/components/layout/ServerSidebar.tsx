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
import { useDMStore } from "../../stores/dm";
import { useAuthStore } from "../../stores/auth";
import {
  useUnreadCounts,
  useHighlightCounts,
} from "../../hooks/useUnreadCounts";
import { NewServerModal } from "../server/NewServerModal";

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

  // Compute the display order for CONCORD servers only: any server
  // present in the preferredOrder list first (in that order),
  // followed by any newly-joined servers that haven't been placed
  // yet, appended alphabetically by name. Federated servers are
  // handled separately and do NOT participate in drag-reorder —
  // their position is deterministic from join order.
  const orderedServers = useMemo(() => {
    if (!preferredOrder || preferredOrder.length === 0) return localServers;
    const byId = new Map(localServers.map((s) => [s.id, s] as const));
    const placed: typeof localServers = [];
    const placedIds = new Set<string>();
    for (const id of preferredOrder) {
      const srv = byId.get(id);
      if (srv) {
        placed.push(srv);
        placedIds.add(id);
      }
    }
    const unplaced = localServers
      .filter((s) => !placedIds.has(s.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...placed, ...unplaced];
  }, [localServers, preferredOrder]);

  // Under the 2026-04-11 architecture, Concord-federated servers are
  // their own Sources — not a special visual category. This set is
  // kept for the server tile's `isFromConcordFederation` check but
  // is always empty under the new model.
  const concordFederatedIds = new Set<string>();

  // Federated stack: now only reflects live server entries from the
  // active source's Matrix client state. Under the 2026-04-11
  // architecture rule, the old persistent federated-instance catalog
  // has been deleted along with its placeholder-tile synthesis and
  // search filter — federated homeservers are their own Sources,
  // added by the user through the Sources `+` tile, and do not
  // surface as sidebar tiles on their own. The only non-Concord
  // tiles remaining are local-domain bridge spaces (e.g. Discord
  // guilds), which `hydrateFederatedRooms` still produces because
  // they live on the same homeserver as the active source and
  // belong to it by construction.
  //
  // The stack order (oldest adjacent to Explore, newest at the top
  // of the federated section) is preserved for the live entries
  // we do render.
  const federatedStack = useMemo(() => {
    return federatedServers
      .map((server) => ({
        server,
        placeholder: false as const,
      }))
      .slice()
      .reverse();
  }, [federatedServers]);

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

        {/* Flex spacer — pushes the federated search, federated
            stack, and Explore button to the bottom of the mobile
            column, mirroring the desktop sidebar's "explore at
            bottom" layout. Collapses to zero when content overflows
            so scrolling still behaves naturally. */}
        <div className="flex-grow min-h-0" aria-hidden="true" />

        {/* Bridge-space tiles: the only non-Concord entries the
            sidebar still renders. These are local-homeserver
            `m.space` rooms produced by bridges (currently just
            mautrix-discord). They belong to the active source's
            own infrastructure and are NOT cross-instance Matrix
            federation. The old federated search input + catalog
            placeholder tiles were removed along with the
            federatedInstances store. */}
        {federatedStack.map((entry) => {
          const { server } = entry;
          const isActive = !dmActive && activeServerId === server.id;
          const hasUnreads =
            !isActive &&
            "channels" in server &&
            server.channels.some(
              (ch: { matrix_room_id: string }) =>
                (unreadCounts.get(ch.matrix_room_id) ?? 0) > 0,
            );
          return (
            <button
              key={server.id}
              onClick={() => handleServerClick(server.id)}
              className={`btn-press w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all flex-shrink-0 ${
                isActive
                  ? "bg-tertiary/15 text-tertiary ring-1 ring-tertiary/40"
                  : "text-on-surface hover:bg-tertiary/10"
              }`}
            >
              <div className="relative flex-shrink-0">
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm font-headline font-bold ${
                    isActive
                      ? "bg-tertiary text-on-tertiary"
                      : "bg-tertiary/15 text-tertiary ring-1 ring-tertiary/40"
                  }`}
                >
                  {server.abbreviation || server.name.charAt(0).toUpperCase()}
                </div>
                <div
                  className="absolute -top-1 -left-1 w-4 h-4 bg-tertiary rounded-full border-2 border-surface-container-low flex items-center justify-center"
                  aria-hidden="true"
                >
                  <span
                    className="material-symbols-outlined text-on-tertiary"
                    style={{ fontSize: "10px" }}
                  >
                    link
                  </span>
                </div>
              </div>
              <div className="min-w-0 flex-1 text-left">
                <div className="truncate font-body font-medium">{server.name}</div>
                <div className="text-[10px] uppercase tracking-wider text-tertiary/80 font-label">
                  bridge
                </div>
              </div>
              {hasUnreads && (
                <div className="w-2.5 h-2.5 rounded-full bg-primary flex-shrink-0 node-pulse" />
              )}
            </button>
          );
        })}

        </div>
        {/* Modals — outside both scroll regions */}
        {showNewServer && <NewServerModal onClose={() => setShowNewServer(false)} />}
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

      {/* Bridge-space tiles, stacked upward from Explore.
          These are the only non-Concord entries remaining in the
          sidebar: local-homeserver `m.space` rooms produced by
          bridges (currently only mautrix-discord). They belong
          to the active source's own bridge infrastructure and do
          not represent cross-instance Matrix federation.
          Everything else — the Concord/Matrix federation
          distinction, the persistent catalog, placeholder tiles
          during sync, the search filter — was removed along with
          the federatedInstances store. */}
      {federatedStack.map((entry) => {
        const { server } = entry;
        const isActive = !dmActive && activeServerId === server.id;
        const hasUnreads =
          !isActive &&
          "channels" in server &&
          server.channels.some(
            (ch: { matrix_room_id: string }) =>
              (unreadCounts.get(ch.matrix_room_id) ?? 0) > 0,
          );
        const inactiveClass =
          "bg-tertiary/15 text-tertiary rounded-2xl hover:rounded-xl hover:bg-tertiary/25 ring-1 ring-tertiary/40";
        const activeClass =
          "bg-tertiary text-on-tertiary rounded-xl shadow-[0_0_12px_rgba(180,120,255,0.35)]";
        return (
          <div key={server.id} className="relative group flex-shrink-0">
            <div
              className={`absolute -left-1 top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-tertiary transition-all ${
                isActive ? "h-8" : hasUnreads ? "h-2" : "h-0 group-hover:h-5"
              }`}
            />
            <button
              onClick={() => handleServerClick(server.id)}
              title={`${server.name} (bridge)`}
              aria-label={`${server.name} bridge`}
              className={`btn-press w-12 h-12 flex items-center justify-center text-sm font-headline font-bold transition-all ${
                isActive ? activeClass : inactiveClass
              }`}
            >
              {server.abbreviation || server.name.charAt(0).toUpperCase()}
            </button>
            {/* Top-left badge — a link glyph marks this tile as a
                bridge-produced space so operators can tell it apart
                from native Concord servers at a glance. */}
            <div
              className="absolute -top-0.5 -left-0.5 w-4 h-4 bg-tertiary rounded-full border-2 border-surface flex items-center justify-center"
              aria-hidden="true"
            >
              <span
                className="material-symbols-outlined text-on-tertiary"
                style={{ fontSize: "10px" }}
              >
                link
              </span>
            </div>
            {hasUnreads && (
              <div className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-primary rounded-full border-2 border-surface node-pulse" />
            )}
          </div>
        );
      })}

      {/* Explore button removed from desktop server rail per the
          2026-04-11 user spec — Explore now lives at the bottom of
          the Sources column (SourcesPanel's footer), opened by a
          callback hoisted up to ChatLayout. The federated bridge
          tiles still stack from the bottom of this rail upward, but
          the catalog-discovery affordance moved to a more
          appropriate column. */}

      </div>
      {/* Modals */}
      {showNewServer && <NewServerModal onClose={() => setShowNewServer(false)} />}
      {/* ExploreModal mount removed from desktop ServerSidebar — it
          is now mounted by ChatLayout because the open/close state
          lives there too. The mobile render path below still owns
          its own ExploreModal mount. */}
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
