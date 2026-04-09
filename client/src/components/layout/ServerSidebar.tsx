import { memo, useState, useMemo, useEffect, useCallback } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
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
import { useDMStore } from "../../stores/dm";
import { useAuthStore } from "../../stores/auth";
import { useUnreadCounts } from "../../hooks/useUnreadCounts";
import { usePresenceMap } from "../../hooks/usePresence";
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

function readStoredServerOrder(userId: string | null): string[] | null {
  if (typeof window === "undefined" || !userId) return null;
  try {
    const raw = window.localStorage.getItem(
      `${SERVER_ORDER_STORAGE_KEY_PREFIX}:${userId}`,
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
}

function writeStoredServerOrder(userId: string | null, order: string[]): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.setItem(
      `${SERVER_ORDER_STORAGE_KEY_PREFIX}:${userId}`,
      JSON.stringify(order),
    );
  } catch {
    // Quota exceeded or private-mode — silently skip. The list just
    // won't persist this session; it will fall back to the default
    // ordering on reload.
  }
}

interface ServerSidebarProps {
  mobile?: boolean;
  onServerSelect?: () => void;
}

export const ServerSidebar = memo(function ServerSidebar({ mobile, onServerSelect }: ServerSidebarProps) {
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const membersByServer = useServerStore((s) => s.members);
  const loadMembers = useServerStore((s) => s.loadMembers);
  const accessToken = useAuthStore((s) => s.accessToken);
  const currentUserId = useAuthStore((s) => s.userId);
  const unreadCounts = useUnreadCounts();
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

  // Split the server list into Concord-managed ("home") servers and
  // federated (non-local) rooms. They render in two separate sections
  // — Concord at the top of the sidebar, federated pinned to the
  // bottom above the Explore button — and only the Concord list
  // participates in the INS-002B drag-reorder flow. Federated rooms
  // stack upward from Explore with the oldest entry adjacent to it,
  // matching the user's mental model of "Explore is how you find
  // new servers, so the newest finds grow away from it".
  const concordServers = useMemo(
    () => servers.filter((s) => s.federated !== true),
    [servers],
  );
  const federatedServers = useMemo(
    () => servers.filter((s) => s.federated === true),
    [servers],
  );

  // Compute the display order for CONCORD servers only: any server
  // present in the preferredOrder list first (in that order),
  // followed by any newly-joined servers that haven't been placed
  // yet, appended alphabetically by name. Federated servers are
  // handled separately and do NOT participate in drag-reorder —
  // their position is deterministic from join order.
  const orderedServers = useMemo(() => {
    if (!preferredOrder || preferredOrder.length === 0) return concordServers;
    const byId = new Map(concordServers.map((s) => [s.id, s] as const));
    const placed: typeof concordServers = [];
    const placedIds = new Set<string>();
    for (const id of preferredOrder) {
      const srv = byId.get(id);
      if (srv) {
        placed.push(srv);
        placedIds.add(id);
      }
    }
    const unplaced = concordServers
      .filter((s) => !placedIds.has(s.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...placed, ...unplaced];
  }, [concordServers, preferredOrder]);

  // Federated servers are rendered REVERSED in the bottom stack so
  // the array's first entry (the user's first federated join, per
  // matrix-js-sdk's getRooms() order) sits adjacent to Explore, and
  // subsequent joins stack upward away from it. React needs a new
  // array identity for a reverse, so we useMemo rather than
  // calling federatedServers.slice().reverse() inline on every render.
  const federatedStack = useMemo(
    () => [...federatedServers].reverse(),
    [federatedServers],
  );

  // dnd-kit sensors. PointerSensor activates after 5px of movement so
  // regular clicks on the server tile still fire (for server select). The
  // KeyboardSensor enables arrow-key reorder for keyboard users.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
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

  // Ensure each server we're a member of has its member list loaded so we can
  // compute presence badges. loadMembers is idempotent (it simply overwrites
  // that server's entry in the members record), and fetches are cheap — one
  // call per server on initial render and when the server list changes.
  // We deliberately don't gate on `membersByServer[id]` being missing because
  // we still want to pick up new servers as they appear.
  useEffect(() => {
    if (!accessToken) return;
    for (const srv of servers) {
      if (!membersByServer[srv.id]) {
        loadMembers(srv.id, accessToken);
      }
    }
    // membersByServer intentionally omitted — we only fetch on server list
    // changes, not every time the member map updates (which would loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, servers, loadMembers]);

  // Determine which servers should show a presence badge. Private servers
  // are suppressed unless the current user is the owner (so owners of their
  // own private servers still see activity).
  const presenceVisibleServerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const srv of servers) {
      const isPrivate = srv.visibility === "private";
      const isOwner = currentUserId !== null && srv.owner_id === currentUserId;
      if (!isPrivate || isOwner) {
        ids.add(srv.id);
      }
    }
    return ids;
  }, [servers, currentUserId]);

  // Flatten member IDs across all presence-visible servers into a single
  // deduped, sorted list. Sorting gives usePresenceMap a stable reference
  // shape so it doesn't re-subscribe on every render — the identity of the
  // returned array only changes when the underlying set of IDs changes.
  const presenceUserIds = useMemo(() => {
    const set = new Set<string>();
    for (const srv of servers) {
      if (!presenceVisibleServerIds.has(srv.id)) continue;
      const members = membersByServer[srv.id];
      if (!members) continue;
      for (const m of members) {
        if (m.user_id) set.add(m.user_id);
      }
    }
    return Array.from(set).sort();
  }, [servers, presenceVisibleServerIds, membersByServer]);

  // usePresenceMap needs a stable array identity across renders, otherwise
  // its effect re-runs every render. We depend on the sorted join as the key
  // so identity only changes when the set of tracked users actually changes.
  const presenceUserIdsKey = presenceUserIds.join(",");
  const stablePresenceUserIds = useMemo(
    () => presenceUserIds,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [presenceUserIdsKey],
  );
  const presenceMap = usePresenceMap(stablePresenceUserIds);

  // Per-server online detection. A server is "online" if any of its tracked
  // members are in the `online` or `unavailable` (idle) Matrix presence state.
  const onlineByServer = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const srv of servers) {
      if (!presenceVisibleServerIds.has(srv.id)) {
        map.set(srv.id, false);
        continue;
      }
      const members = membersByServer[srv.id];
      if (!members || members.length === 0) {
        map.set(srv.id, false);
        continue;
      }
      let online = false;
      for (const m of members) {
        const p = presenceMap.get(m.user_id);
        if (p === "online" || p === "unavailable") {
          online = true;
          break;
        }
      }
      map.set(srv.id, online);
    }
    return map;
  }, [servers, presenceVisibleServerIds, membersByServer, presenceMap]);

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
    onServerSelect?.();
  };

  const handleDMClick = () => {
    useServerStore.setState({ activeServerId: null, activeChannelId: null });
    setDMActive(true);
  };

  // Mobile: full-width list view. The outer wrapper is a flex
  // column (not a plain block) so `mt-auto` on the Explore button
  // can push it to the bottom of the sidebar regardless of how many
  // servers are in the list above.
  if (mobile) {
    return (
      <div className="h-full bg-surface-container-low overflow-y-auto p-3 flex flex-col">
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
            <div className="space-y-1">
              {orderedServers.map((server) => {
                const isActive = !dmActive && activeServerId === server.id;
                const hasUnreads = !isActive && server.channels.some(
                  (ch) => (unreadCounts.get(ch.matrix_room_id) ?? 0) > 0,
                );
                const hasOnline = onlineByServer.get(server.id) ?? false;
                const isFederated = server.federated === true;
                return (
                  <SortableServerRow
                    key={server.id}
                    id={server.id}
                    orientation="row"
                  >
                    <button
                      onClick={() => handleServerClick(server.id)}
                      title={isFederated ? `${server.name} (federated)` : server.name}
                      className={`btn-press w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                        isActive
                          ? isFederated
                            ? "bg-tertiary/10 text-tertiary"
                            : "bg-primary/10 text-primary"
                          : "text-on-surface hover:bg-surface-container-high"
                      }`}
                    >
                      <div className="relative flex-shrink-0">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm font-headline font-bold ${
                          isActive
                            ? isFederated
                              ? "bg-tertiary text-on-tertiary"
                              : "primary-glow text-on-primary"
                            : isFederated
                              ? "bg-tertiary/15 text-tertiary ring-1 ring-tertiary/40"
                              : "bg-surface-container-highest text-on-surface-variant"
                        }`}>
                          {server.abbreviation || server.name.charAt(0).toUpperCase()}
                        </div>
                        {isFederated && (
                          <div
                            className="absolute -top-1 -left-1 w-4 h-4 bg-tertiary rounded-full border-2 border-surface-container-low flex items-center justify-center"
                            aria-label="Federated (non-local) server"
                          >
                            <span className="material-symbols-outlined text-tertiary-container" style={{ fontSize: "10px" }}>public</span>
                          </div>
                        )}
                        {hasOnline && (
                          <div
                            className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-secondary rounded-full border-2 border-surface-container-low"
                            aria-label="Members online"
                          />
                        )}
                      </div>
                      <span className="truncate font-body font-medium">{server.name}</span>
                      {isFederated && (
                        <span className="text-[10px] uppercase tracking-wider text-tertiary/80 font-label ml-1">
                          federated
                        </span>
                      )}
                      {hasUnreads && (
                        <div className="w-2.5 h-2.5 rounded-full bg-primary ml-auto flex-shrink-0 node-pulse" />
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
          className="btn-press w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-on-surface-variant hover:text-secondary hover:bg-secondary/5 transition-all mt-2"
        >
          <div className="w-10 h-10 rounded-xl bg-surface-container-highest flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-xl">add</span>
          </div>
          <span className="font-body font-medium">Add Server</span>
        </button>

        {/* Spacer pushes federated stack + Explore to the bottom. */}
        <div className="flex-1 min-h-0" aria-hidden="true" />

        {/* Federated (non-local) servers stacked upward from Explore.
            Same reverse ordering as desktop: oldest join sits
            directly above Explore, new joins stack upward. */}
        {federatedStack.map((server) => {
          const isActive = !dmActive && activeServerId === server.id;
          const hasUnreads = !isActive && server.channels.some(
            (ch) => (unreadCounts.get(ch.matrix_room_id) ?? 0) > 0,
          );
          return (
            <button
              key={server.id}
              onClick={() => handleServerClick(server.id)}
              className={`btn-press w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
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
                    public
                  </span>
                </div>
              </div>
              <span className="truncate font-body font-medium">{server.name}</span>
              <span className="text-[10px] uppercase tracking-wider text-tertiary/80 font-label ml-1">
                federated
              </span>
              {hasUnreads && (
                <div className="w-2.5 h-2.5 rounded-full bg-primary ml-auto flex-shrink-0 node-pulse" />
              )}
            </button>
          );
        })}

        {/* Explore pinned to the bottom of the federated stack. */}
        <button
          onClick={() => setExploreOpen(true)}
          className="btn-press w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-on-surface-variant hover:text-tertiary hover:bg-tertiary/5 transition-all"
        >
          <div className="w-10 h-10 rounded-xl bg-surface-container-highest flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-xl">public</span>
          </div>
          <span className="font-body font-medium">Explore</span>
        </button>

        {showNewServer && <NewServerModal onClose={() => setShowNewServer(false)} />}
        <ExploreModal isOpen={exploreOpen} onClose={() => setExploreOpen(false)} />
      </div>
    );
  }

  // Desktop: compact icon sidebar
  return (
    <div className="w-16 bg-surface flex flex-col items-center py-3 gap-2 overflow-y-auto min-h-0">
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
            const hasOnline = onlineByServer.get(server.id) ?? false;
            const isFederated = server.federated === true;
            return (
              <SortableServerRow
                key={server.id}
                id={server.id}
                orientation="icon"
              >
                <div className="relative group">
                  {/* Active indicator bar — tertiary color for
                      federated servers so the left rail hint matches
                      the button fill, primary for Concord-managed
                      servers. */}
                  <div className={`absolute -left-1 top-1/2 -translate-y-1/2 w-1 rounded-r-full transition-all ${
                    isFederated ? "bg-tertiary" : "bg-primary"
                  } ${
                    isActive ? "h-8" : hasUnreads ? "h-2" : "h-0 group-hover:h-5"
                  }`} />
                  <button
                    onClick={() => handleServerClick(server.id)}
                    title={isFederated ? `${server.name} (federated)` : server.name}
                    aria-label={isFederated ? `${server.name} (federated server)` : server.name}
                    className={`btn-press w-12 h-12 flex items-center justify-center text-sm font-headline font-bold transition-all ${
                      isActive
                        ? isFederated
                          ? "bg-tertiary text-on-tertiary rounded-xl shadow-[0_0_12px_rgba(var(--tertiary-rgb,180,120,255),0.35)]"
                          : "primary-glow text-on-primary rounded-xl"
                        : isFederated
                          ? "bg-tertiary/15 text-tertiary rounded-2xl hover:rounded-xl hover:bg-tertiary/25 ring-1 ring-tertiary/40"
                          : "bg-surface-container-high text-on-surface-variant rounded-2xl hover:rounded-xl hover:bg-surface-container-highest hover:text-on-surface"
                    }`}
                  >
                    {server.abbreviation || server.name.charAt(0).toUpperCase()}
                  </button>
                  {isFederated && (
                    /* Small globe badge at top-left marks this as a
                       non-local (federated) room. Sits opposite the
                       unread/presence badges so they don't collide. */
                    <div
                      className="absolute -top-0.5 -left-0.5 w-4 h-4 bg-tertiary rounded-full border-2 border-surface flex items-center justify-center"
                      aria-hidden="true"
                    >
                      <span className="material-symbols-outlined text-on-tertiary" style={{ fontSize: "10px" }}>public</span>
                    </div>
                  )}
                  {hasUnreads && (
                    <div className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-primary rounded-full border-2 border-surface node-pulse" />
                  )}
                  {/* Presence badge: green dot when any member is online/idle.
                      Bottom-right so it doesn't collide with the unread dot at
                      top-right. Uses bg-secondary to match the presence color
                      defined in ui/Avatar.tsx. */}
                  {hasOnline && (
                    <div
                      className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-secondary rounded-full border-2 border-surface"
                      aria-label="Members online"
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
        className="btn-press w-12 h-12 rounded-2xl bg-surface-container-high text-on-surface-variant hover:bg-secondary/10 hover:text-secondary hover:rounded-xl flex items-center justify-center transition-all"
      >
        <span className="material-symbols-outlined text-xl">add</span>
      </button>

      {/* Spacer: consumes whatever vertical space is left between the
          Add-Server button and the federated stack at the bottom. The
          flex container's gap-2 handles internal spacing; this
          mt-auto div just pushes the federated stack + Explore to
          the bottom edge. */}
      <div className="flex-1 min-h-0" aria-hidden="true" />

      {/* Federated (non-local) servers, stacked upward from Explore.
          Rendered in reverse order so the OLDEST federated join sits
          directly above the Explore button and each new join stacks
          upward away from it. These don't participate in
          drag-reorder — they're deterministic by join order and the
          user only gets new entries here via the Explore flow. */}
      {federatedStack.map((server) => {
        const isActive = !dmActive && activeServerId === server.id;
        const hasUnreads = !isActive && server.channels.some(
          (ch) => (unreadCounts.get(ch.matrix_room_id) ?? 0) > 0,
        );
        return (
          <div key={server.id} className="relative group">
            <div
              className={`absolute -left-1 top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-tertiary transition-all ${
                isActive ? "h-8" : hasUnreads ? "h-2" : "h-0 group-hover:h-5"
              }`}
            />
            <button
              onClick={() => handleServerClick(server.id)}
              title={`${server.name} (federated)`}
              aria-label={`${server.name} (federated server)`}
              className={`btn-press w-12 h-12 flex items-center justify-center text-sm font-headline font-bold transition-all ${
                isActive
                  ? "bg-tertiary text-on-tertiary rounded-xl shadow-[0_0_12px_rgba(180,120,255,0.35)]"
                  : "bg-tertiary/15 text-tertiary rounded-2xl hover:rounded-xl hover:bg-tertiary/25 ring-1 ring-tertiary/40"
              }`}
            >
              {server.abbreviation || server.name.charAt(0).toUpperCase()}
            </button>
            <div
              className="absolute -top-0.5 -left-0.5 w-4 h-4 bg-tertiary rounded-full border-2 border-surface flex items-center justify-center"
              aria-hidden="true"
            >
              <span
                className="material-symbols-outlined text-on-tertiary"
                style={{ fontSize: "10px" }}
              >
                public
              </span>
            </div>
            {hasUnreads && (
              <div className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-primary rounded-full border-2 border-surface node-pulse" />
            )}
          </div>
        );
      })}

      {/* Explore federated servers — pinned to the bottom of the
          sidebar. Federated servers stack upward from here, with the
          oldest join adjacent and the newest at the top of the
          federated section. Visually separates "manage your own
          servers" from "discover the broader federated network". */}
      <button
        onClick={() => setExploreOpen(true)}
        title="Explore"
        aria-label="Explore federated servers"
        className="btn-press w-12 h-12 rounded-2xl bg-surface-container-high text-on-surface-variant hover:bg-tertiary/15 hover:text-tertiary hover:rounded-xl flex items-center justify-center transition-all"
      >
        <span className="material-symbols-outlined text-xl">public</span>
      </button>

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
  children,
}: {
  id: string;
  orientation: "row" | "icon";
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    touchAction: orientation === "icon" ? "none" : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}
