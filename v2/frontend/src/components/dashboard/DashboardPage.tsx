import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import GlassPanel from "@/components/ui/GlassPanel";
import NodeChip from "@/components/ui/NodeChip";
import Skeleton from "@/components/ui/Skeleton";
import { useWindowSize } from "@/hooks/useWindowSize";
import { useMeshStore } from "@/stores/mesh";
import { useServersStore } from "@/stores/servers";
import { useForumStore } from "@/stores/forum";
import { useFriendsStore } from "@/stores/friends";
import { useConversationsStore } from "@/stores/conversations";
import {
  getNodeStatus,
  getNearbyPeers,
} from "@/api/tauri";
import { shortenPeerId, formatRelativeTime } from "@/utils/format";

function DashboardPage() {
  const { tier } = useWindowSize();
  const nodeStatus = useMeshStore((s) => s.nodeStatus);
  const setNodeStatus = useMeshStore((s) => s.setNodeStatus);
  const setNearbyPeers = useMeshStore((s) => s.setNearbyPeers);
  const nearbyPeers = useMeshStore((s) => s.nearbyPeers);
  const servers = useServersStore((s) => s.servers);
  const loadServers = useServersStore((s) => s.loadServers);
  const localPosts = useForumStore((s) => s.localPosts);
  const globalPosts = useForumStore((s) => s.globalPosts);
  const loadPosts = useForumStore((s) => s.loadPosts);
  const friends = useFriendsStore((s) => s.friends);
  const loadFriends = useFriendsStore((s) => s.loadFriends);
  const conversations = useConversationsStore((s) => s.conversations);
  const loadConversations = useConversationsStore((s) => s.loadConversations);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Clear any active server when returning to dashboard
    useServersStore.getState().clearActiveServer();

    async function init() {
      try {
        const [status, peers] = await Promise.all([
          getNodeStatus(),
          getNearbyPeers(),
        ]);
        setNodeStatus(status);
        setNearbyPeers(peers);
      } catch (err) {
        console.warn("Dashboard init failed (backend not ready?):", err);
      } finally {
        setLoading(false);
      }
    }
    void init();
    void loadServers();
    void loadPosts("local");
    void loadPosts("global");
    void loadFriends();
    void loadConversations();
  }, [setNodeStatus, setNearbyPeers, loadServers, loadPosts, loadFriends, loadConversations]);

  const isOnline = nodeStatus?.isOnline ?? false;
  const displayPeerId = nodeStatus?.peerId
    ? shortenPeerId(nodeStatus.peerId)
    : "---";
  const isCompact = tier === "compact";

  const onlineFriendsCount = friends.filter((f) => f.presenceStatus === "online").length;

  // Combine recent activity: latest forum posts + conversations
  const recentForumPosts = [...localPosts, ...globalPosts]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 3);

  if (loading) {
    return (
      <div className="mesh-background h-full flex flex-col overflow-hidden">
        <div className="relative z-10 flex flex-col flex-1 min-h-0 overflow-y-auto">
          <div className="px-4 pt-3 pb-2 space-y-2 shrink-0">
            <GlassPanel className="rounded-xl p-3">
              <div className="flex items-center gap-2 mb-1">
                <Skeleton className="w-5 h-5" circle />
                <Skeleton className="h-5 w-32" />
              </div>
              <Skeleton className="h-3 w-48 ml-7" />
            </GlassPanel>
            <div className="grid grid-cols-2 gap-2">
              <GlassPanel className="rounded-xl p-3 space-y-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-5 w-20" />
              </GlassPanel>
              <GlassPanel className="rounded-xl p-3 space-y-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-7 w-10" />
              </GlassPanel>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mesh-background h-full flex flex-col overflow-hidden">
      <div className="relative z-10 flex flex-col flex-1 min-h-0 overflow-y-auto px-4 pt-3 pb-4 space-y-4">
        {/* Node Status Card */}
        <GlassPanel className="rounded-xl p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary text-lg">
              hub
            </span>
            <span className="font-headline font-bold text-base text-on-surface">
              Node {isOnline ? "Active" : "Offline"}
            </span>
            <NodeChip
              status={isOnline ? "active" : "inactive"}
              label={isOnline ? "Online" : "Offline"}
            />
          </div>
          {!isCompact && (
            <p className="text-xs text-on-surface-variant font-body pl-7">
              Hosting on{" "}
              <span className="text-on-surface font-medium">
                {displayPeerId}
              </span>
            </p>
          )}
        </GlassPanel>

        {/* Quick Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <GlassPanel className="rounded-xl p-3 space-y-0.5">
            <div className="flex items-center gap-1.5 text-on-surface-variant">
              <span className="material-symbols-outlined text-secondary text-base">
                sensors
              </span>
              <span className="font-label text-[10px] uppercase tracking-wider">
                Nearby
              </span>
            </div>
            <p className="font-headline text-xl font-bold text-on-surface">
              {nearbyPeers.length}
            </p>
          </GlassPanel>

          <GlassPanel className="rounded-xl p-3 space-y-0.5">
            <div className="flex items-center gap-1.5 text-on-surface-variant">
              <span className="material-symbols-outlined text-primary text-base">
                forum
              </span>
              <span className="font-label text-[10px] uppercase tracking-wider">
                Forum Posts
              </span>
            </div>
            <p className="font-headline text-xl font-bold text-on-surface">
              {localPosts.length + globalPosts.length}
            </p>
          </GlassPanel>

          <GlassPanel className="rounded-xl p-3 space-y-0.5">
            <div className="flex items-center gap-1.5 text-on-surface-variant">
              <span className="material-symbols-outlined text-secondary text-base">
                dns
              </span>
              <span className="font-label text-[10px] uppercase tracking-wider">
                Servers
              </span>
            </div>
            <p className="font-headline text-xl font-bold text-on-surface">
              {servers.length}
            </p>
          </GlassPanel>

          <GlassPanel className="rounded-xl p-3 space-y-0.5">
            <div className="flex items-center gap-1.5 text-on-surface-variant">
              <span className="material-symbols-outlined text-secondary text-base">
                group
              </span>
              <span className="font-label text-[10px] uppercase tracking-wider">
                Friends Online
              </span>
            </div>
            <p className="font-headline text-xl font-bold text-on-surface">
              {onlineFriendsCount}
            </p>
          </GlassPanel>
        </div>

        {/* Nearby Peer Avatars */}
        {nearbyPeers.length > 0 && (
          <div className="flex items-center gap-2 px-1">
            <div className="flex -space-x-2">
              {nearbyPeers.filter(p => p?.peerId).slice(0, 5).map((peer) => (
                <div
                  key={peer.peerId}
                  className="w-7 h-7 rounded-full bg-primary/15 border-2 border-surface flex items-center justify-center"
                  title={peer.displayName ?? peer.peerId ?? "unknown"}
                >
                  <span className="text-[9px] font-bold text-primary">
                    {(peer.displayName ?? peer.peerId ?? "??").slice(0, 2).toUpperCase()}
                  </span>
                </div>
              ))}
              {nearbyPeers.length > 5 && (
                <div className="w-7 h-7 rounded-full bg-surface-container-high border-2 border-surface flex items-center justify-center">
                  <span className="text-[9px] font-bold text-on-surface-variant">
                    +{nearbyPeers.length - 5}
                  </span>
                </div>
              )}
            </div>
            <span className="text-[10px] text-on-surface-variant">
              {nearbyPeers.length} node{nearbyPeers.length !== 1 ? "s" : ""} on mesh
            </span>
          </div>
        )}

        {/* Quick Action Cards */}
        <div className="space-y-2">
          <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant">
            Quick Actions
          </span>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Link to="/forum" className="block">
              <GlassPanel className="rounded-xl p-3 hover:bg-surface-container-high/30 transition-colors group">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 group-hover:bg-primary/20 transition-colors shrink-0">
                    <span className="material-symbols-outlined text-primary text-lg">
                      forum
                    </span>
                  </div>
                  <div>
                    <p className="font-headline font-semibold text-sm text-on-surface">
                      Post to Forum
                    </p>
                    <p className="text-[10px] text-on-surface-variant font-body">
                      Share with the mesh
                    </p>
                  </div>
                </div>
              </GlassPanel>
            </Link>
            <Link to="/host" className="block">
              <GlassPanel className="rounded-xl p-3 hover:bg-surface-container-high/30 transition-colors group">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-secondary/10 group-hover:bg-secondary/20 transition-colors shrink-0">
                    <span className="material-symbols-outlined text-secondary text-lg">
                      dns
                    </span>
                  </div>
                  <div>
                    <p className="font-headline font-semibold text-sm text-on-surface">
                      Host Server
                    </p>
                    <p className="text-[10px] text-on-surface-variant font-body">
                      Create a new server
                    </p>
                  </div>
                </div>
              </GlassPanel>
            </Link>
            <Link to="/direct" className="block">
              <GlassPanel className="rounded-xl p-3 hover:bg-surface-container-high/30 transition-colors group">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 group-hover:bg-primary/20 transition-colors shrink-0">
                    <span className="material-symbols-outlined text-primary text-lg">
                      chat
                    </span>
                  </div>
                  <div>
                    <p className="font-headline font-semibold text-sm text-on-surface">
                      New Conversation
                    </p>
                    <p className="text-[10px] text-on-surface-variant font-body">
                      Start a direct message
                    </p>
                  </div>
                </div>
              </GlassPanel>
            </Link>
          </div>
        </div>

        {/* Recent Activity */}
        <div className="space-y-2">
          <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant">
            Recent Activity
          </span>
          {recentForumPosts.length === 0 && conversations.length === 0 ? (
            <GlassPanel className="rounded-xl p-6 text-center">
              <p className="text-sm text-on-surface-variant font-body">
                No recent activity. Post to the forum or start a conversation!
              </p>
            </GlassPanel>
          ) : (
            <div className="space-y-2">
              {recentForumPosts.map((post) => (
                <Link key={post.id} to="/forum" className="block">
                  <GlassPanel className={`rounded-xl p-3 border-l-2 hover:bg-surface-container-high/30 transition-colors ${
                    post.forumScope === "local" ? "border-l-secondary" : "border-l-primary"
                  }`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="material-symbols-outlined text-sm text-on-surface-variant">
                        forum
                      </span>
                      <span className="text-xs font-label font-medium text-on-surface truncate">
                        {post.aliasName ?? `Peer ${post.authorId.slice(0, 8)}`}
                      </span>
                      <span className={`text-[10px] rounded-full px-2 py-0.5 font-label ${
                        post.forumScope === "local"
                          ? "bg-secondary/10 text-secondary"
                          : "bg-primary/10 text-primary"
                      }`}>
                        {post.forumScope === "local" ? "Local" : "Global"}
                      </span>
                      <span className="text-[10px] text-on-surface-variant ml-auto">
                        {formatRelativeTime(post.timestamp)}
                      </span>
                    </div>
                    <p className="text-xs text-on-surface-variant font-body truncate pl-5">
                      {post.content}
                    </p>
                  </GlassPanel>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Servers Section */}
        {servers.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant">
                Your Servers
              </span>
              <Link
                to="/servers"
                className="text-[10px] text-primary font-label font-medium hover:text-primary-dim transition-colors"
              >
                View All
              </Link>
            </div>
            <div className="space-y-1.5">
              {servers.slice(0, 3).map((server) => (
                <Link key={server.id} to={`/server/${server.id}`} className="block">
                  <GlassPanel className="rounded-xl p-3 hover:bg-surface-container-high/30 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 shrink-0">
                        <span className="material-symbols-outlined text-primary text-lg">
                          dns
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-headline font-bold text-sm text-on-surface truncate">
                          {server.name}
                        </p>
                        <p className="text-[10px] text-on-surface-variant font-body">
                          {server.channels.length} channels &middot; {server.memberCount} members
                        </p>
                      </div>
                    </div>
                  </GlassPanel>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default DashboardPage;
