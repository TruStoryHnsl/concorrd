import { memo, useState, useMemo, useEffect } from "react";
import { useServerStore } from "../../stores/server";
import { useDMStore } from "../../stores/dm";
import { useAuthStore } from "../../stores/auth";
import { useUnreadCounts } from "../../hooks/useUnreadCounts";
import { usePresenceMap } from "../../hooks/usePresence";
import { NewServerModal } from "../server/NewServerModal";
import { ExploreModal } from "../server/ExploreModal";

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

  // Mobile: full-width list view
  if (mobile) {
    return (
      <div className="h-full bg-surface-container-low overflow-y-auto p-3">
        <h3 className="text-xs font-label font-medium text-on-surface-variant uppercase tracking-widest px-2 mb-3">
          Your Servers
        </h3>
        <div className="space-y-1">
          {servers.map((server) => {
            const isActive = !dmActive && activeServerId === server.id;
            const hasUnreads = !isActive && server.channels.some(
              (ch) => (unreadCounts.get(ch.matrix_room_id) ?? 0) > 0,
            );
            const hasOnline = onlineByServer.get(server.id) ?? false;
            return (
              <button
                key={server.id}
                onClick={() => handleServerClick(server.id)}
                className={`btn-press w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-on-surface hover:bg-surface-container-high"
                }`}
              >
                <div className="relative flex-shrink-0">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm font-headline font-bold ${
                    isActive
                      ? "primary-glow text-on-primary"
                      : "bg-surface-container-highest text-on-surface-variant"
                  }`}>
                    {server.abbreviation || server.name.charAt(0).toUpperCase()}
                  </div>
                  {hasOnline && (
                    <div
                      className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-secondary rounded-full border-2 border-surface-container-low"
                      aria-label="Members online"
                    />
                  )}
                </div>
                <span className="truncate font-body font-medium">{server.name}</span>
                {hasUnreads && (
                  <div className="w-2.5 h-2.5 rounded-full bg-primary ml-auto flex-shrink-0 node-pulse" />
                )}
              </button>
            );
          })}
        </div>

        <button
          onClick={() => setShowNewServer(true)}
          className="btn-press w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-on-surface-variant hover:text-secondary hover:bg-secondary/5 transition-all mt-2"
        >
          <div className="w-10 h-10 rounded-xl bg-surface-container-highest flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-xl">add</span>
          </div>
          <span className="font-body font-medium">Add Server</span>
        </button>

        <button
          onClick={() => setExploreOpen(true)}
          className="btn-press w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-on-surface-variant hover:text-secondary hover:bg-secondary/5 transition-all"
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

      {/* Server list */}
      {servers.map((server) => {
        const isActive = !dmActive && activeServerId === server.id;
        const hasUnreads = !isActive && server.channels.some(
          (ch) => (unreadCounts.get(ch.matrix_room_id) ?? 0) > 0,
        );
        const hasOnline = onlineByServer.get(server.id) ?? false;
        return (
          <div key={server.id} className="relative group">
            {/* Active indicator bar */}
            <div className={`absolute -left-1 top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-primary transition-all ${
              isActive ? "h-8" : hasUnreads ? "h-2" : "h-0 group-hover:h-5"
            }`} />
            <button
              onClick={() => handleServerClick(server.id)}
              title={server.name}
              className={`btn-press w-12 h-12 flex items-center justify-center text-sm font-headline font-bold transition-all ${
                isActive
                  ? "primary-glow text-on-primary rounded-xl"
                  : "bg-surface-container-high text-on-surface-variant rounded-2xl hover:rounded-xl hover:bg-surface-container-highest hover:text-on-surface"
              }`}
            >
              {server.abbreviation || server.name.charAt(0).toUpperCase()}
            </button>
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
        );
      })}

      {/* Add server */}
      <button
        onClick={() => setShowNewServer(true)}
        title="Add Server"
        className="btn-press w-12 h-12 rounded-2xl bg-surface-container-high text-on-surface-variant hover:bg-secondary/10 hover:text-secondary hover:rounded-xl flex items-center justify-center transition-all"
      >
        <span className="material-symbols-outlined text-xl">add</span>
      </button>

      {/* Explore federated servers */}
      <button
        onClick={() => setExploreOpen(true)}
        title="Explore"
        aria-label="Explore federated servers"
        className="btn-press w-12 h-12 rounded-2xl bg-surface-container-high text-on-surface-variant hover:bg-secondary/10 hover:text-secondary hover:rounded-xl flex items-center justify-center transition-all"
      >
        <span className="material-symbols-outlined text-xl">public</span>
      </button>

      {showNewServer && <NewServerModal onClose={() => setShowNewServer(false)} />}
      <ExploreModal isOpen={exploreOpen} onClose={() => setExploreOpen(false)} />
    </div>
  );
});
