import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import GlassPanel from "@/components/ui/GlassPanel";
import Button from "@/components/ui/Button";
import TrustBadge from "@/components/ui/TrustBadge";
import NodeChip from "@/components/ui/NodeChip";
import Skeleton from "@/components/ui/Skeleton";
import { useMeshStore } from "@/stores/mesh";
import { useAuthStore } from "@/stores/auth";
import { getPeerTrust, getNearbyPeers } from "@/api/tauri";
import type { TrustInfo, PeerInfo } from "@/api/tauri";
import { shortenPeerId } from "@/utils/format";

/** Augmented peer for the friends list */
interface FriendEntry {
  peer: PeerInfo;
  trust?: TrustInfo;
  status: "online" | "away" | "offline";
}

function FriendsPage() {
  const navigate = useNavigate();
  const nearbyPeers = useMeshStore((s) => s.nearbyPeers);
  const setNearbyPeers = useMeshStore((s) => s.setNearbyPeers);
  const myPeerId = useAuthStore((s) => s.peerId);
  const nodeStatus = useMeshStore((s) => s.nodeStatus);

  const [searchQuery, setSearchQuery] = useState("");
  const [trustMap, setTrustMap] = useState<Record<string, TrustInfo>>({});
  const [loading, setLoading] = useState(true);

  // Load peers and their trust info
  useEffect(() => {
    async function loadData() {
      try {
        const peers = await getNearbyPeers();
        setNearbyPeers(peers);

        // Load trust for each peer
        const trustEntries = await Promise.all(
          peers.map(async (p) => {
            try {
              const t = await getPeerTrust(p.peerId);
              return [p.peerId, t] as const;
            } catch {
              return null;
            }
          }),
        );
        const map: Record<string, TrustInfo> = {};
        for (const entry of trustEntries) {
          if (entry) map[entry[0]] = entry[1];
        }
        setTrustMap(map);
      } catch (err) {
        console.warn("Failed to load friends data:", err);
      } finally {
        setLoading(false);
      }
    }
    void loadData();
  }, [setNearbyPeers]);

  // Build friend entries from nearby peers (excluding self)
  const friends: FriendEntry[] = useMemo(() => {
    return nearbyPeers
      .filter((p) => p.peerId !== myPeerId)
      .map((peer, i) => ({
        peer,
        trust: trustMap[peer.peerId],
        // Mock some varied statuses for display
        status: (i === 0 ? "online" : i === 1 ? "away" : "online") as FriendEntry["status"],
      }));
  }, [nearbyPeers, myPeerId, trustMap]);

  // Filter by search
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return friends;
    const q = searchQuery.toLowerCase();
    return friends.filter(
      (f) =>
        (f.peer.displayName?.toLowerCase().includes(q) ?? false) ||
        f.peer.peerId.toLowerCase().includes(q),
    );
  }, [friends, searchQuery]);

  const onlineFriends = filtered.filter((f) => f.status === "online");
  const awayFriends = filtered.filter((f) => f.status === "away");
  const offlineFriends = filtered.filter((f) => f.status === "offline");

  // Mock pending requests
  const pendingRequests = [
    { id: "req1", name: "Nova_Node", peerId: "12D3KooWReq1xxxxxxxxxxxxxx", direction: "incoming" as const },
    { id: "req2", name: "Echo_Runner", peerId: "12D3KooWReq2xxxxxxxxxxxxxx", direction: "incoming" as const },
  ];

  if (loading) {
    return (
      <div className="mesh-background min-h-full p-6">
        <div className="relative z-10 max-w-5xl mx-auto space-y-6">
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-80" />
          </div>
          <Skeleton className="h-10 w-full" />
          <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
            <div className="space-y-5">
              <GlassPanel className="p-4 space-y-3">
                <Skeleton className="h-4 w-32" />
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </GlassPanel>
            </div>
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mesh-background min-h-full p-6">
      <div className="relative z-10 max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="font-headline font-bold text-3xl text-on-surface">
              Friends Hub
            </h1>
            <p className="text-on-surface-variant text-sm font-body">
              Connect with peers across the decentralized mesh. Send DMs or
              join a node for a group session.
            </p>
          </div>
          <Button variant="primary">
            <span className="material-symbols-outlined text-lg">person_add</span>
            Add Friend
          </Button>
        </div>

        {/* Search */}
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg">
            search
          </span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search friends & peers..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-surface-container text-on-surface placeholder:text-on-surface-variant/50 font-body text-sm border-none focus:outline-none focus:ring-1 focus:ring-primary/30 transition-colors"
          />
        </div>

        {/* Layout: sidebar + main */}
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
          {/* Left sidebar */}
          <div className="space-y-5">
            {/* Pending Requests */}
            <GlassPanel className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-lg">
                  person_add
                </span>
                <span className="font-label text-xs uppercase tracking-wider text-on-surface-variant">
                  Pending Requests
                </span>
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary/20 text-primary text-[10px] font-label font-semibold">
                  {pendingRequests.length}
                </span>
              </div>
              <div className="space-y-2">
                {pendingRequests.map((req) => (
                  <div
                    key={req.id}
                    className="flex items-center gap-2.5 px-2 py-2 rounded-lg bg-surface-container/50"
                  >
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10">
                      <span className="material-symbols-outlined text-primary text-sm">
                        person
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-label font-medium text-on-surface truncate">
                        {req.name}
                      </p>
                      <p className="text-[10px] text-on-surface-variant font-body">
                        {shortenPeerId(req.peerId)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button className="flex items-center justify-center w-7 h-7 rounded-lg bg-secondary/10 text-secondary hover:bg-secondary/20 transition-colors">
                        <span className="material-symbols-outlined text-sm">
                          check
                        </span>
                      </button>
                      <button className="flex items-center justify-center w-7 h-7 rounded-lg bg-error/10 text-error hover:bg-error/20 transition-colors">
                        <span className="material-symbols-outlined text-sm">
                          close
                        </span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </GlassPanel>

            {/* Node Status */}
            <GlassPanel className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-secondary text-lg">
                  hub
                </span>
                <span className="font-label text-xs uppercase tracking-wider text-on-surface-variant">
                  Your Node Status
                </span>
              </div>
              <div className="flex items-center gap-3">
                <NodeChip
                  status={nodeStatus?.isOnline ? "active" : "inactive"}
                  label={nodeStatus?.isOnline ? "Online" : "Offline"}
                />
                <span className="text-xs text-on-surface-variant font-body">
                  {nodeStatus?.connectedPeers ?? 0} peers connected
                </span>
              </div>
            </GlassPanel>
          </div>

          {/* Main area — friends list */}
          <div className="space-y-6">
            {/* Online */}
            {onlineFriends.length > 0 && (
              <FriendSection
                label="Online"
                count={onlineFriends.length}
                friends={onlineFriends}
                onMessage={(peerId) => navigate(`/dm/${peerId}`)}
              />
            )}

            {/* Away */}
            {awayFriends.length > 0 && (
              <FriendSection
                label="Away"
                count={awayFriends.length}
                friends={awayFriends}
                onMessage={(peerId) => navigate(`/dm/${peerId}`)}
              />
            )}

            {/* Offline */}
            {offlineFriends.length > 0 && (
              <FriendSection
                label="Offline"
                count={offlineFriends.length}
                friends={offlineFriends}
                onMessage={(peerId) => navigate(`/dm/${peerId}`)}
              />
            )}

            {filtered.length === 0 && (
              <GlassPanel className="p-8 flex flex-col items-center justify-center text-center space-y-4">
                <div className="flex items-center justify-center w-16 h-16 rounded-full bg-primary/10">
                  <span className="material-symbols-outlined text-4xl text-primary/40">
                    {searchQuery ? "search_off" : "group"}
                  </span>
                </div>
                <div className="space-y-1">
                  <p className="font-headline font-semibold text-on-surface">
                    {searchQuery
                      ? "No results found"
                      : "No friends yet"}
                  </p>
                  <p className="text-sm text-on-surface-variant font-body max-w-xs mx-auto">
                    {searchQuery
                      ? "No friends matching your search. Try a different query."
                      : "Add friends via the mesh to start chatting and join nodes together."}
                  </p>
                </div>
                {!searchQuery && (
                  <Button variant="primary">
                    <span className="material-symbols-outlined text-lg">person_add</span>
                    Add Friend
                  </Button>
                )}
              </GlassPanel>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Friend Section ─────────────────────────────────────── */

function FriendSection({
  label,
  count,
  friends,
  onMessage,
}: {
  label: string;
  count: number;
  friends: FriendEntry[];
  onMessage: (peerId: string) => void;
}) {
  const statusColor =
    label === "Online"
      ? "text-secondary"
      : label === "Away"
        ? "text-amber-400"
        : "text-on-surface-variant/50";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`font-label text-xs uppercase tracking-wider ${statusColor}`}>
          {label}
        </span>
        <span className="text-[10px] text-on-surface-variant font-body">
          {count}
        </span>
      </div>
      <div className="space-y-1.5">
        {friends.map((f) => (
          <FriendCard
            key={f.peer.peerId}
            entry={f}
            onMessage={() => onMessage(f.peer.peerId)}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Friend Card ────────────────────────────────────────── */

function FriendCard({
  entry,
  onMessage,
}: {
  entry: FriendEntry;
  onMessage: () => void;
}) {
  const { peer, trust, status } = entry;
  const displayName = peer.displayName ?? shortenPeerId(peer.peerId);

  const statusDotColor =
    status === "online"
      ? "bg-secondary"
      : status === "away"
        ? "bg-amber-400"
        : "bg-on-surface-variant/40";

  return (
    <GlassPanel className="p-3">
      <div className="flex items-center gap-3">
        {/* Avatar + status */}
        <div className="relative shrink-0">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10">
            <span className="material-symbols-outlined text-primary text-lg">
              person
            </span>
          </div>
          <span
            className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-surface ${statusDotColor}`}
          />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-label font-medium text-on-surface truncate">
              {displayName}
            </p>
            {trust && <TrustBadge level={trust.badge} size="sm" />}
          </div>
          <p className="text-[10px] text-on-surface-variant font-body truncate">
            {shortenPeerId(peer.peerId)}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onMessage}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors text-xs font-label"
          >
            <span className="material-symbols-outlined text-sm">chat</span>
            Message
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary transition-colors text-xs font-label">
            <span className="material-symbols-outlined text-sm">
              connected_tv
            </span>
            Join Node
          </button>
        </div>
      </div>
    </GlassPanel>
  );
}

export default FriendsPage;
