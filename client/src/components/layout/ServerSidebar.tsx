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
  type Modifier,
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
import { useDMStore } from "../../stores/dm";
import { useAuthStore } from "../../stores/auth";
import { useSourcesStore } from "../../stores/sources";
import {
  useUnreadCounts,
  useHighlightCounts,
} from "../../hooks/useUnreadCounts";
import { useVoiceParticipants } from "../../hooks/useVoiceParticipants";
import { NewServerModal } from "../server/NewServerModal";
import { splitDiscordVoiceBridgeParticipants } from "../voice/discordVoiceBridge";
import { Avatar } from "../ui/Avatar";
import { SourceBrandIcon } from "../sources/sourceBrand";

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
const ADD_SERVER_TILE_ID = "__add_server_tile__";
const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

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

function normalizeServerOrder(
  nativeIds: string[],
  bridgedIds: string[],
  stored: string[] | null,
): string[] {
  const nativeSet = new Set(nativeIds);
  const bridgedSet = new Set(bridgedIds);
  const nativeSeen = new Set<string>();
  const bridgedSeen = new Set<string>();
  const nativePart: string[] = [];
  const bridgedPart: string[] = [];

  for (const id of stored ?? []) {
    if (nativeSet.has(id) && !nativeSeen.has(id)) {
      nativePart.push(id);
      nativeSeen.add(id);
    } else if (bridgedSet.has(id) && !bridgedSeen.has(id)) {
      bridgedPart.push(id);
      bridgedSeen.add(id);
    }
  }
  for (const id of nativeIds) {
    if (!nativeSeen.has(id)) {
      nativePart.push(id);
      nativeSeen.add(id);
    }
  }
  for (const id of bridgedIds) {
    if (!bridgedSeen.has(id)) {
      bridgedPart.push(id);
      bridgedSeen.add(id);
    }
  }

  return [...nativePart, ADD_SERVER_TILE_ID, ...bridgedPart];
}

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
  const [preferredOrder, setPreferredOrder] = useState<string[]>(
    () => readStoredServerOrder(currentUserId) ?? [],
  );
  useEffect(() => {
    setPreferredOrder(readStoredServerOrder(currentUserId) ?? []);
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
  const allSources = useSourcesStore((s) => s.sources);

  // Which source platforms are enabled? Each platform type is independent.
  const enabledPlatforms = useMemo(() => {
    const platforms = new Set<string>();
    for (const src of allSources) {
      if (src.enabled) platforms.add(src.platform ?? "concord");
    }
    // Bootstrap: no sources yet → show concord servers
    if (allSources.length === 0) platforms.add("concord");
    return platforms;
  }, [allSources]);

  const localServers = useMemo(
    () => {
      return servers.filter((s) => {
        if (s.federated) return false;
        if (s.bridgeType === "discord") {
          return enabledPlatforms.has("discord-bot") || enabledPlatforms.has("discord-account");
        }
        // Native Concord servers
        return enabledPlatforms.has("concord");
      });
    },
    [servers, enabledPlatforms],
  );
  const federatedServers = useMemo(
    () => {
      return servers.filter((s) => {
        if (!s.federated) return false;
        if (s.bridgeType === "discord") {
          return enabledPlatforms.has("discord-bot") || enabledPlatforms.has("discord-account");
        }
        // Matrix federated servers
        return enabledPlatforms.has("matrix");
      });
    },
    [servers, enabledPlatforms],
  );

  // Compute the display order for CONCORD servers only: any server
  // present in the preferredOrder list first (in that order),
  // followed by any newly-joined servers that haven't been placed
  // yet, appended alphabetically by name. Federated servers are
  // handled separately and do NOT participate in drag-reorder —
  // their position is deterministic from join order.
  const orderedServers = useMemo(() => {
    if (preferredOrder.length === 0) return localServers;
    const byId = new Map(localServers.map((s) => [s.id, s] as const));
    const placed: typeof localServers = [];
    const placedIds = new Set<string>();
    for (const id of preferredOrder) {
      if (id === ADD_SERVER_TILE_ID) continue;
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

  const visibleServers = useMemo(() => {
    const byId = new Map<string, (typeof servers)[number]>();
    for (const server of orderedServers) byId.set(server.id, server);
    for (const entry of federatedStack) byId.set(entry.server.id, entry.server);
    return [...byId.values()];
  }, [federatedStack, orderedServers, servers]);
  const allVoiceRoomIds = useMemo(
    () =>
      visibleServers.flatMap((server) =>
        server.channels
          .filter((channel) => channel.channel_type === "voice")
          .map((channel) => channel.matrix_room_id),
      ),
    [visibleServers],
  );
  const voiceParticipants = useVoiceParticipants(allVoiceRoomIds);
  const voiceActiveByServer = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const server of visibleServers) {
      const active = server.channels
        .filter((channel) => channel.channel_type === "voice")
        .some((channel) => {
          const participants = voiceParticipants.get(channel.matrix_room_id) ?? [];
          return splitDiscordVoiceBridgeParticipants(participants).visibleParticipants.length > 0;
        });
      map.set(server.id, active);
    }
    return map;
  }, [visibleServers, voiceParticipants]);

  const railOrder = useMemo(
    () =>
      normalizeServerOrder(
        orderedServers.map((s) => s.id),
        federatedStack.map((e) => e.server.id),
        preferredOrder,
      ),
    [preferredOrder, orderedServers, federatedStack],
  );

  useEffect(() => {
    const next = normalizeServerOrder(
      orderedServers.map((s) => s.id),
      federatedStack.map((e) => e.server.id),
      preferredOrder,
    );
    if (
      next.length !== preferredOrder.length ||
      next.some((id, index) => preferredOrder[index] !== id)
    ) {
      setPreferredOrder(next);
    }
    writeStoredServerOrder(currentUserId, next);
  }, [currentUserId, preferredOrder, orderedServers, federatedStack]);

  const topRailIds = useMemo(() => {
    const split = railOrder.indexOf(ADD_SERVER_TILE_ID);
    return split === -1 ? railOrder : railOrder.slice(0, split);
  }, [railOrder]);
  const bottomRailIds = useMemo(() => {
    const split = railOrder.indexOf(ADD_SERVER_TILE_ID);
    return split === -1 ? [ADD_SERVER_TILE_ID] : railOrder.slice(split);
  }, [railOrder]);

  const getRailServer = useCallback(
    (id: string) => visibleServers.find((server) => server.id === id),
    [visibleServers],
  );

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
      const oldIndex = railOrder.findIndex((id) => id === active.id);
      const newIndex = railOrder.findIndex((id) => id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const next = arrayMove(railOrder, oldIndex, newIndex);
      setPreferredOrder(next);
      writeStoredServerOrder(currentUserId, next);
    },
    [currentUserId, railOrder],
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
  const activeDMRoomId = useDMStore((s) => s.activeDMRoomId);
  const setDMActive = useDMStore((s) => s.setDMActive);
  const setActiveDM = useDMStore((s) => s.setActiveDM);
  const dmConversations = useDMStore((s) => s.conversations);
  const pinnedRoomIds = useDMStore((s) => s.pinnedRoomIds);

  const pinnedDMs = useMemo(
    () =>
      pinnedRoomIds
        .map((roomId) =>
          dmConversations.find((conversation) => conversation.matrix_room_id === roomId),
        )
        .filter((conversation): conversation is (typeof dmConversations)[number] => Boolean(conversation)),
    [dmConversations, pinnedRoomIds],
  );

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

  const handlePinnedDMClick = (roomId: string) => {
    useServerStore.setState({ activeServerId: null, activeChannelId: null });
    setActiveDM(roomId);
    setDMActive(true);
    onServerSelect?.();
  };

  const renderMobileRailItem = (id: string) => {
    if (id === ADD_SERVER_TILE_ID) {
      return (
        <SortableServerRow key={id} id={id} orientation="row">
          <button
            onClick={() => setShowNewServer(true)}
            className="btn-press w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-on-surface-variant hover:text-secondary hover:bg-secondary/5 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-surface-container-highest flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-xl">add</span>
            </div>
            <span className="font-body font-medium">Add Server</span>
          </button>
        </SortableServerRow>
      );
    }

    const server = getRailServer(id);
    if (!server) return null;
    const isActive = !dmActive && activeServerId === server.id;
    const hasUnreads =
      !isActive &&
      server.channels.some((channel) => (unreadCounts.get(channel.matrix_room_id) ?? 0) > 0);
    const hasHighlight = hasHighlightByServer.get(server.id) ?? false;
    const isFromConcordFederation = concordFederatedIds.has(server.id);
    const isDiscordBridge = server.bridgeType === "discord";
    const isDisconnected = !syncing;
    const voiceActive = voiceActiveByServer.get(server.id) ?? false;
    const statusDot = isDisconnected
      ? "red"
      : hasHighlight
        ? "yellow"
        : hasUnreads
          ? "unread"
          : null;

    return (
      <SortableServerRow key={server.id} id={server.id} orientation="row">
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
            <ServerGlyph
              server={server}
              active={isActive}
              fromConcordFederation={isFromConcordFederation}
              size="mobile"
            />
            {isDiscordBridge && (
              <div
                className="absolute -top-1 -left-1 w-4 h-4 bg-[#5865F2] rounded-full border-2 border-surface-container-low flex items-center justify-center"
                aria-label="Discord bridge"
              >
                <SourceBrandIcon brand="discord" size={9} className="text-white" />
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
            {voiceActive && (
              <div
                className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 border-2 border-surface-container-low flex items-center justify-center"
                aria-label="Users in voice"
              >
                <span className="material-symbols-outlined text-white" style={{ fontSize: "10px" }}>
                  volume_up
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
  };

  const renderDesktopRailItem = (id: string) => {
    if (id === ADD_SERVER_TILE_ID) {
      return (
        <SortableServerRow key={id} id={id} orientation="icon">
          <button
            onClick={() => setShowNewServer(true)}
            title="Add Server"
            className="btn-press w-12 h-12 rounded-2xl bg-surface-container-high text-on-surface-variant hover:bg-secondary/10 hover:text-secondary hover:rounded-xl flex items-center justify-center transition-all flex-shrink-0"
          >
            <span className="material-symbols-outlined text-xl">add</span>
          </button>
        </SortableServerRow>
      );
    }

    const server = getRailServer(id);
    if (!server) return null;
    const isActive = !dmActive && activeServerId === server.id;
    const hasUnreads = !isActive && server.channels.some(
      (ch) => (unreadCounts.get(ch.matrix_room_id) ?? 0) > 0,
    );
    const hasHighlight = hasHighlightByServer.get(server.id) ?? false;
    const isFromConcordFederation = concordFederatedIds.has(server.id);
    const isDiscordBridge = server.bridgeType === "discord";
    const isDisconnected = !syncing;
    const voiceActive = voiceActiveByServer.get(server.id) ?? false;
    const statusDot = isDisconnected
      ? "red"
      : hasHighlight
        ? "yellow"
        : hasUnreads
          ? "unread"
          : null;

    return (
      <SortableServerRow key={server.id} id={server.id} orientation="icon">
        <div
          className={`relative group ${
            isDisconnected ? "opacity-55 grayscale" : ""
          }`}
        >
          <button
            onClick={() => handleServerClick(server.id)}
            title={
              isDisconnected
                ? `${server.name} — disconnected`
                : isDiscordBridge
                  ? `${server.name} — Discord`
                  : server.name
            }
            aria-label={server.name}
            className={`btn-press w-12 h-12 flex items-center justify-center text-sm font-headline font-bold transition-all ${
              isActive
                ? isDiscordBridge
                  ? "bg-[#5865F2] text-white rounded-xl shadow-[0_0_12px_rgba(88,101,242,0.4)]"
                  : isFromConcordFederation
                    ? "bg-secondary text-on-secondary rounded-xl shadow-[0_0_12px_rgba(120,220,180,0.35)]"
                    : "primary-glow text-on-primary rounded-xl"
                : isDiscordBridge
                  ? "bg-[#5865F2]/20 text-[#5865F2] rounded-2xl hover:rounded-xl hover:bg-[#5865F2]/35 ring-1 ring-[#5865F2]/40"
                  : isFromConcordFederation
                  ? "bg-secondary/15 text-secondary rounded-2xl hover:rounded-xl hover:bg-secondary/25 ring-1 ring-secondary/40"
                  : "bg-surface-container-high text-on-surface-variant rounded-2xl hover:rounded-xl hover:bg-surface-container-highest hover:text-on-surface"
            }`}
          >
            <ServerGlyph
              server={server}
              active={isActive}
              fromConcordFederation={isFromConcordFederation}
              size="desktop"
            />
          </button>
          {(isDiscordBridge || isFromConcordFederation) && (
            <div
              className={`absolute -top-0.5 -left-0.5 w-4 h-4 rounded-full border-2 border-surface flex items-center justify-center ${
                isDiscordBridge ? "bg-[#5865F2]" : "bg-secondary"
              }`}
              aria-hidden="true"
            >
              {isDiscordBridge ? (
                <SourceBrandIcon brand="discord" size={9} className="text-white" />
              ) : (
                <span className="font-headline font-bold text-on-secondary" style={{ fontSize: "8px", lineHeight: 1 }}>C</span>
              )}
            </div>
          )}
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
          {voiceActive && (
            <div
              className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-emerald-500 rounded-full border-2 border-surface flex items-center justify-center"
              aria-label="Users in voice"
            >
              <span className="material-symbols-outlined text-white" style={{ fontSize: "10px" }}>
                volume_up
              </span>
            </div>
          )}
        </div>
      </SortableServerRow>
    );
  };

  // Mobile: full-width list view. The outer wrapper is a flex
  // column with a free spacer between the top and bottom rail stacks.
  // Anything dragged below the add tile becomes part of the bottom
  // stack, which keeps its items pinned near the bottom edge.
  if (mobile) {
    return (
      <div className="h-full bg-surface-container-low overflow-y-auto overflow-x-hidden overscroll-y-auto p-3 flex flex-col">
        <h3 className="text-xs font-label font-medium text-on-surface-variant uppercase tracking-widest px-2 mb-3">
          Your Servers
        </h3>
        {pinnedDMs.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {pinnedDMs.map((conversation) => {
              const unread = unreadCounts.get(conversation.matrix_room_id) ?? 0;
              const isActivePinnedDm =
                dmActive && activeDMRoomId === conversation.matrix_room_id;
              const username = conversation.other_user_id.split(":")[0].replace("@", "");
              return (
                <button
                  key={conversation.matrix_room_id}
                  onClick={() => handlePinnedDMClick(conversation.matrix_room_id)}
                  className={`btn-press w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-all ${
                    isActivePinnedDm
                      ? "bg-rose-500 text-white"
                      : "bg-rose-500/10 text-rose-200 hover:bg-rose-500/15"
                  }`}
                >
                  <Avatar userId={conversation.other_user_id} size="md" showPresence />
                  <span className="truncate font-body font-medium flex-1 min-w-0 text-left">
                    {username}
                  </span>
                  {unread > 0 && !isActivePinnedDm && (
                    <span className="min-w-5 h-5 px-1.5 rounded-full bg-rose-500 text-white text-xs font-bold flex items-center justify-center node-pulse">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={railOrder}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col min-h-0 flex-1">
              <div className="space-y-0.5">
                {topRailIds.map(renderMobileRailItem)}
              </div>
              <div className="flex-1 min-h-4" aria-hidden="true" />
              <div className="space-y-0.5 pb-1">
                {bottomRailIds.map(renderMobileRailItem)}
              </div>
            </div>
          </SortableContext>
        </DndContext>
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
    <div className="w-[51px] pr-[3px] bg-surface" style={{ height: "100%" }}>
      <div className="h-full overflow-y-auto overflow-x-hidden py-3 flex flex-col items-center gap-2 [&>*]:shrink-0">
      {/* DM button */}
      <div className="relative group">
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

      {pinnedDMs.map((conversation) => {
        const unread = unreadCounts.get(conversation.matrix_room_id) ?? 0;
        const isActivePinnedDm =
          dmActive && activeDMRoomId === conversation.matrix_room_id;
        const username = conversation.other_user_id.split(":")[0].replace("@", "");
        return (
          <div key={conversation.matrix_room_id} className="relative group">
            <button
              onClick={() => handlePinnedDMClick(conversation.matrix_room_id)}
              title={`Pinned DM — ${username}`}
              className={`btn-press w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${
                isActivePinnedDm
                  ? "bg-rose-500 text-white rounded-xl shadow-[0_0_12px_rgba(244,63,94,0.35)]"
                  : "bg-rose-500/12 text-rose-300 ring-1 ring-rose-400/30 hover:bg-rose-500/20 hover:rounded-xl"
              }`}
            >
              <Avatar userId={conversation.other_user_id} size="md" showPresence />
            </button>
            {unread > 0 && !isActivePinnedDm && (
              <div className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold border-2 border-surface flex items-center justify-center node-pulse">
                {unread > 99 ? "99+" : unread}
              </div>
            )}
          </div>
        );
      })}

      {/* Divider */}
      <div className="w-8 h-px bg-outline-variant/20 my-0.5" />

      {/* Server list — wrapped in DndContext for drag-reorder (INS-002B). */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={railOrder}
          strategy={verticalListSortingStrategy}
        >
          <div className="w-full flex flex-col items-center min-h-0 flex-1">
            <div className="w-full flex flex-col items-center gap-2">
              {topRailIds.map(renderDesktopRailItem)}
            </div>
            <div className="flex-1 min-h-4" aria-hidden="true" />
            <div className="w-full flex flex-col items-center gap-2 pb-1">
              {bottomRailIds.map(renderDesktopRailItem)}
            </div>
          </div>
        </SortableContext>
      </DndContext>
      {/* Modals */}
      {showNewServer && <NewServerModal onClose={() => setShowNewServer(false)} />}
      {/* ExploreModal mount removed from desktop ServerSidebar — it
          is now mounted by ChatLayout because the open/close state
          lives there too. The mobile render path below still owns
          its own ExploreModal mount. */}
      </div>
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
  const constrainedTransform = transform ? { ...transform, x: 0 } : null;
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(constrainedTransform),
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

function ServerGlyph({
  server,
  active,
  fromConcordFederation,
  size,
}: {
  server: {
    name: string;
    abbreviation: string | null;
    icon_url: string | null;
    bridgeType?: "discord";
  };
  active: boolean;
  fromConcordFederation: boolean;
  size: "mobile" | "desktop";
}) {
  const isDiscordBridge = server.bridgeType === "discord";
  const dimension = size === "mobile" ? "w-10 h-10" : "w-12 h-12";
  const fallbackClass = active
    ? isDiscordBridge
      ? "bg-[#5865F2] text-white"
      : fromConcordFederation
        ? "bg-secondary text-on-secondary"
        : "primary-glow text-on-primary"
    : isDiscordBridge
      ? "bg-[#5865F2]/12 text-[#5865F2] ring-1 ring-[#5865F2]/30"
      : fromConcordFederation
        ? "bg-secondary/15 text-secondary ring-1 ring-secondary/40"
        : "bg-surface-container-highest text-on-surface-variant";

  if (server.icon_url) {
    return (
      <div className={`${dimension} rounded-[inherit] overflow-hidden bg-surface-container-highest`}>
        <img
          src={server.icon_url}
          alt=""
          className="w-full h-full object-cover"
          loading="lazy"
          draggable={false}
        />
      </div>
    );
  }

  return (
    <div className={`${dimension} rounded-[inherit] flex items-center justify-center text-sm font-headline font-bold ${fallbackClass}`}>
      {server.abbreviation || server.name.charAt(0).toUpperCase()}
    </div>
  );
}
