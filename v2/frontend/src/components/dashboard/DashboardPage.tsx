import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import GlassPanel from "@/components/ui/GlassPanel";
import NodeChip from "@/components/ui/NodeChip";
import Skeleton from "@/components/ui/Skeleton";
import MessageList from "@/components/chat/MessageList";
import MessageInput from "@/components/chat/MessageInput";
import JoinServerModal from "@/components/server/JoinServerModal";
import { useWindowSize } from "@/hooks/useWindowSize";
import { useMeshStore } from "@/stores/mesh";
import { useServersStore, MESH_GENERAL_CHANNEL, MESH_GENERAL_TOPIC } from "@/stores/servers";
import { useAuthStore } from "@/stores/auth";
import {
  getNodeStatus,
  getNearbyPeers,
  getMessages,
  subscribeChannel,
} from "@/api/tauri";
import type { ServerPayload } from "@/api/tauri";
import { shortenPeerId } from "@/utils/format";

function DashboardPage() {
  const { tier } = useWindowSize();
  const nodeStatus = useMeshStore((s) => s.nodeStatus);
  const setNodeStatus = useMeshStore((s) => s.setNodeStatus);
  const setNearbyPeers = useMeshStore((s) => s.setNearbyPeers);
  const messages = useServersStore((s) => s.messages);
  const setMessages = useServersStore((s) => s.setMessages);
  const servers = useServersStore((s) => s.servers);
  const loadServers = useServersStore((s) => s.loadServers);
  const nearbyPeers = useMeshStore((s) => s.nearbyPeers);
  const peerId = useAuthStore((s) => s.peerId);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [serversCollapsed, setServersCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Clear any active server when returning to dashboard
    useServersStore.getState().clearActiveServer();

    async function init() {
      try {
        const [status, peers, history] = await Promise.all([
          getNodeStatus(),
          getNearbyPeers(),
          getMessages(MESH_GENERAL_CHANNEL, 50),
        ]);
        setNodeStatus(status);
        setNearbyPeers(peers);
        setMessages(history);
        await subscribeChannel(MESH_GENERAL_TOPIC);
      } catch (err) {
        console.warn("Dashboard init failed (backend not ready?):", err);
      } finally {
        setLoading(false);
      }
    }
    void init();
    void loadServers();
  }, [setNodeStatus, setNearbyPeers, setMessages, loadServers]);

  const isOnline = nodeStatus?.isOnline ?? false;
  const displayPeerId = nodeStatus?.peerId
    ? shortenPeerId(nodeStatus.peerId)
    : "---";

  const isCompact = tier === "compact";
  const isMobile = tier === "mobile";
  const isDesktop = tier === "desktop";
  const showServers = !isCompact;

  if (loading) {
    return (
      <div className="mesh-background h-full flex flex-col overflow-hidden">
        <div className="relative z-10 flex flex-col flex-1 min-h-0 overflow-hidden">
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
          <div className="flex-1 px-4 space-y-3 pt-4">
            <Skeleton className="h-4 w-24" />
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mesh-background h-full flex flex-col overflow-hidden">
      <div className="relative z-10 flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* Status Cards -- shrink-0 */}
        <div className="px-4 pt-3 pb-2 space-y-2 shrink-0">
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

          {/* Stat Pills + Peers integrated */}
          <div className="grid grid-cols-2 gap-2">
            <GlassPanel className="rounded-xl p-3 space-y-0.5">
              <div className="flex items-center gap-1.5 text-on-surface-variant">
                <span className="material-symbols-outlined text-tertiary text-base">
                  tag
                </span>
                <span className="font-label text-[10px] uppercase tracking-wider">
                  Topic
                </span>
              </div>
              <p className="font-headline text-sm font-bold text-on-surface truncate">
                general
              </p>
            </GlassPanel>

            <GlassPanel className="rounded-xl p-3 space-y-0.5">
              <div className="flex items-center gap-1.5 text-on-surface-variant">
                <span className="material-symbols-outlined text-secondary text-base">
                  sensors
                </span>
                <span className="font-label text-[10px] uppercase tracking-wider">
                  Nearby
                </span>
              </div>
              <div className="flex items-center gap-2">
                <p className="font-headline text-xl font-bold text-on-surface">
                  {nearbyPeers.length}
                </p>
                <span className="text-[10px] text-on-surface-variant">peers</span>
              </div>
            </GlassPanel>
          </div>

          {/* Nearby Peer Avatars (inline in status cluster) */}
          {nearbyPeers.length > 0 && (
            <div className="flex items-center gap-2 px-1">
              <div className="flex -space-x-2">
                {nearbyPeers.slice(0, 5).map((peer) => (
                  <div
                    key={peer.peerId}
                    className="w-7 h-7 rounded-full bg-primary/15 border-2 border-surface flex items-center justify-center"
                    title={peer.displayName ?? peer.peerId}
                  >
                    <span className="text-[9px] font-bold text-primary">
                      {(peer.displayName ?? peer.peerId).slice(0, 2).toUpperCase()}
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
                {nearbyPeers.length === 0
                  ? "Scanning..."
                  : `${nearbyPeers.length} node${nearbyPeers.length !== 1 ? "s" : ""} on mesh`}
              </span>
            </div>
          )}
        </div>

        {/* Servers Section -- shrink-0, collapsible, hidden in compact */}
        {showServers && (
          <div className="px-4 pt-1 pb-2 shrink-0">
            <button
              onClick={() => setServersCollapsed((c) => !c)}
              className="flex items-center justify-between w-full mb-2"
            >
              <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant">
                Your Servers
              </span>
              <div className="flex items-center gap-2">
                <Link
                  to="/host"
                  onClick={(e) => e.stopPropagation()}
                  className="text-[10px] text-primary font-label font-medium hover:text-primary-dim transition-colors"
                >
                  Explore
                </Link>
                <span
                  className={`material-symbols-outlined text-on-surface-variant text-sm transition-transform duration-200 ${
                    serversCollapsed ? "-rotate-90" : ""
                  }`}
                >
                  expand_more
                </span>
              </div>
            </button>

            {!serversCollapsed && (
              <div className="space-y-1.5">
                {servers.length === 0 && (
                  <div className="flex items-center gap-3 px-3 py-4 rounded-xl bg-surface-container-low/50 text-center">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-surface-container-high shrink-0">
                      <span className="material-symbols-outlined text-on-surface-variant/40 text-lg">
                        dns
                      </span>
                    </div>
                    <p className="text-xs text-on-surface-variant font-body">
                      No servers yet. Create your first one below.
                    </p>
                  </div>
                )}
                {servers.map((server) => (
                  <ServerCard key={server.id} server={server} />
                ))}

                {/* Host New Session Card */}
                <Link to="/host" className="block">
                  <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-dashed border-outline-variant/50 hover:border-primary/40 hover:bg-surface-container-high/30 transition-all group">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-surface-container-high group-hover:bg-primary/10 transition-colors shrink-0">
                      <span className="material-symbols-outlined text-on-surface-variant group-hover:text-primary text-lg transition-colors">
                        add
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-headline font-semibold text-sm text-on-surface">
                        Host New Session
                      </p>
                      {(isMobile || isDesktop) && (
                        <p className="text-[11px] text-on-surface-variant font-body">
                          Create a new server on your node
                        </p>
                      )}
                    </div>
                  </div>
                </Link>

                {/* Join Server Card */}
                <button
                  onClick={() => setShowJoinModal(true)}
                  className="w-full text-left"
                >
                  <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-dashed border-outline-variant/50 hover:border-secondary/40 hover:bg-surface-container-high/30 transition-all group">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-surface-container-high group-hover:bg-secondary/10 transition-colors shrink-0">
                      <span className="material-symbols-outlined text-on-surface-variant group-hover:text-secondary text-lg transition-colors">
                        login
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-headline font-semibold text-sm text-on-surface">
                        Join Server
                      </p>
                      {(isMobile || isDesktop) && (
                        <p className="text-[11px] text-on-surface-variant font-body">
                          Enter a node address or invite
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Chat area -- flex-1, fills remaining space */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Chat column */}
          <div className="flex flex-col flex-1 min-w-0 min-h-0">
            {/* Channel header */}
            <div className="flex items-center gap-2 px-4 py-1.5 shrink-0">
              <span className="material-symbols-outlined text-on-surface-variant text-base">
                tag
              </span>
              <span className="font-headline font-semibold text-sm text-on-surface">
                mesh/general
              </span>
              {!isCompact && (
                <span className="text-[10px] text-on-surface-variant font-body">
                  Public mesh channel
                </span>
              )}
            </div>

            {/* Messages -- flex-1 with internal scroll */}
            <MessageList messages={messages} ownPeerId={peerId} />

            {/* Input -- pinned to bottom of chat column */}
            <MessageInput channelId={MESH_GENERAL_CHANNEL} />
          </div>

          {/* Peers sidebar removed — peers are now in the top status cluster */}
        </div>
      </div>

      {/* Join Server Modal */}
      {showJoinModal && (
        <JoinServerModal onClose={() => setShowJoinModal(false)} />
      )}
    </div>
  );
}

/* -- Server Card ------------------------------------------------- */

function ServerCard({ server }: { server: ServerPayload }) {
  const channelTypes = server.channels.map((c) => c.channelType);
  const hasText = channelTypes.includes("text");
  const hasVoice = channelTypes.includes("voice");
  const hasVideo = channelTypes.includes("video");

  return (
    <Link to={`/server/${server.id}`} className="block">
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-surface-container-low hover:bg-surface-container-high transition-colors group">
        {/* Server Icon */}
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 shrink-0">
          <span className="material-symbols-outlined text-primary text-lg">
            dns
          </span>
        </div>

        {/* Server Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-headline font-bold text-sm text-on-surface truncate">
              {server.name}
            </p>
            {server.visibility === "public" && (
              <NodeChip status="active" label="Public" />
            )}
          </div>
          <p className="text-[11px] text-on-surface-variant font-body truncate">
            {server.channels.length} channel{server.channels.length !== 1 ? "s" : ""}
          </p>
        </div>

        {/* Right side: channel types + member count */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1">
            {hasText && (
              <span className="material-symbols-outlined text-on-surface-variant text-base" title="Text channels">
                tag
              </span>
            )}
            {hasVoice && (
              <span className="material-symbols-outlined text-on-surface-variant text-base" title="Voice channels">
                volume_up
              </span>
            )}
            {hasVideo && (
              <span className="material-symbols-outlined text-on-surface-variant text-base" title="Video channels">
                videocam
              </span>
            )}
          </div>
          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-secondary/15 text-secondary text-[11px] font-label font-semibold">
            {server.memberCount}
          </span>
        </div>
      </div>
    </Link>
  );
}

export default DashboardPage;
