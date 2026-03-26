import { useEffect, useCallback, useRef, useState, useMemo } from "react";
import { useMeshStore } from "@/stores/mesh";
import { getNearbyPeers, getTunnels } from "@/api/tauri";
import type { TunnelInfo, PeerInfo } from "@/api/tauri";
import { shortenPeerId, formatRelativeTime } from "@/utils/format";
import GlassPanel from "@/components/ui/GlassPanel";
import Skeleton from "@/components/ui/Skeleton";

/* ── Helpers ─────────────────────────────────────────────────── */

interface NodePosition {
  x: number;
  y: number;
  peerId: string;
  connectionType: "local" | "direct" | "relayed" | "self";
  displayName?: string;
  rttMs: number | null;
  remoteAddress: string;
  establishedAt: number;
}

function getLineColor(connectionType: string): string {
  switch (connectionType) {
    case "local":
      return "#afefdd";
    case "direct":
      return "#a4a5ff";
    case "relayed":
      return "#46484b";
    default:
      return "#46484b";
  }
}

function getDotColor(connectionType: string): string {
  switch (connectionType) {
    case "local":
      return "bg-secondary";
    case "direct":
      return "bg-primary-fixed";
    case "relayed":
      return "bg-outline-variant";
    case "self":
      return "bg-primary";
    default:
      return "bg-on-surface-variant";
  }
}

function getDotGlow(connectionType: string): string {
  switch (connectionType) {
    case "local":
      return "shadow-[0_0_12px_rgba(175,239,221,0.5)]";
    case "direct":
      return "shadow-[0_0_10px_rgba(148,150,255,0.5)]";
    case "relayed":
      return "shadow-[0_0_6px_rgba(70,72,75,0.4)]";
    default:
      return "";
  }
}

function connectionLabel(type: string): string {
  switch (type) {
    case "local":
      return "Local (mDNS)";
    case "direct":
      return "Direct Tunnel";
    case "relayed":
      return "Relayed";
    default:
      return type;
  }
}

function connectionBadgeStyle(type: string): string {
  switch (type) {
    case "local":
      return "bg-secondary/15 text-secondary border-secondary/20";
    case "direct":
      return "bg-primary/15 text-primary border-primary/20";
    case "relayed":
      return "bg-outline-variant/20 text-on-surface-variant border-outline-variant/30";
    default:
      return "bg-surface-container-high text-on-surface-variant";
  }
}

/**
 * Calculate node positions in a radial layout.
 * - Self at center
 * - Local peers in inner ring
 * - Direct peers in middle ring
 * - Relayed peers in outer ring
 */
function calculateNodePositions(
  peers: PeerInfo[],
  tunnels: TunnelInfo[],
  width: number,
  height: number,
): NodePosition[] {
  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.min(cx, cy) * 0.85;

  // Build a map of peerId -> tunnel info
  const tunnelMap = new Map<string, TunnelInfo>();
  for (const t of tunnels) {
    tunnelMap.set(t.peerId, t);
  }

  // Categorize nodes
  const localNodes: { peer: PeerInfo; tunnel?: TunnelInfo }[] = [];
  const directNodes: { peer: PeerInfo; tunnel: TunnelInfo }[] = [];
  const relayedNodes: { peer: PeerInfo; tunnel: TunnelInfo }[] = [];
  const discoveredOnlyNodes: PeerInfo[] = [];

  for (const peer of peers) {
    const tunnel = tunnelMap.get(peer.peerId);
    if (tunnel) {
      if (tunnel.connectionType === "local") {
        localNodes.push({ peer, tunnel });
      } else if (tunnel.connectionType === "direct") {
        directNodes.push({ peer, tunnel });
      } else {
        relayedNodes.push({ peer, tunnel });
      }
      tunnelMap.delete(peer.peerId);
    } else {
      discoveredOnlyNodes.push(peer);
    }
  }

  // Any tunnels without a matching peer
  for (const [, tunnel] of tunnelMap) {
    const fakePeer: PeerInfo = { peerId: tunnel.peerId, addresses: [tunnel.remoteAddress] };
    if (tunnel.connectionType === "local") {
      localNodes.push({ peer: fakePeer, tunnel });
    } else if (tunnel.connectionType === "direct") {
      directNodes.push({ peer: fakePeer, tunnel });
    } else {
      relayedNodes.push({ peer: fakePeer, tunnel });
    }
  }

  // Also add discovered-only as local (mDNS discovered but no tunnel)
  for (const peer of discoveredOnlyNodes) {
    localNodes.push({ peer });
  }

  const positions: NodePosition[] = [];

  // Ring radii
  const innerRadius = maxRadius * 0.25;
  const midRadius = maxRadius * 0.55;
  const outerRadius = maxRadius * 0.82;

  // Place local nodes in inner ring
  const placeRing = (
    nodes: { peer: PeerInfo; tunnel?: TunnelInfo }[],
    radius: number,
    connType: "local" | "direct" | "relayed",
  ) => {
    const count = nodes.length;
    if (count === 0) return;
    const angleStep = (2 * Math.PI) / count;
    // Add a random-looking but deterministic offset per ring
    const offset = connType === "local" ? 0.3 : connType === "direct" ? 1.1 : 2.2;
    for (let i = 0; i < count; i++) {
      const node = nodes[i]!;
      const angle = offset + i * angleStep;
      // Add slight variance based on peerId to avoid perfect circle
      const charCode = node.peer.peerId.charCodeAt(10) ?? 0;
      const variance = 1 + ((charCode % 20) - 10) / 100;
      positions.push({
        x: cx + Math.cos(angle) * radius * variance,
        y: cy + Math.sin(angle) * radius * variance,
        peerId: node.peer.peerId,
        connectionType: connType,
        displayName: node.peer.displayName,
        rttMs: node.tunnel?.rttMs ?? null,
        remoteAddress: node.tunnel?.remoteAddress ?? node.peer.addresses[0] ?? "",
        establishedAt: node.tunnel?.establishedAt ?? 0,
      });
    }
  };

  placeRing(localNodes, innerRadius, "local");
  placeRing(directNodes, midRadius, "direct");
  placeRing(relayedNodes, outerRadius, "relayed");

  return positions;
}

/* ── Peer Info Tooltip ───────────────────────────────────────── */

interface PeerTooltipProps {
  node: NodePosition;
  onClose: () => void;
}

function PeerTooltip({ node, onClose }: PeerTooltipProps) {
  return (
    <GlassPanel className="absolute z-50 p-4 rounded-xl min-w-[220px] space-y-3 border border-outline-variant/20 shadow-2xl">
      <div className="flex items-center justify-between">
        <span className="font-headline text-sm font-bold text-on-surface">
          {node.displayName ?? shortenPeerId(node.peerId)}
        </span>
        <button
          onClick={onClose}
          className="text-on-surface-variant hover:text-on-surface transition-colors"
        >
          <span className="material-symbols-outlined text-base">close</span>
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-label font-semibold uppercase tracking-wider ${connectionBadgeStyle(node.connectionType)}`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${getDotColor(node.connectionType)}`}
            />
            {connectionLabel(node.connectionType)}
          </span>
        </div>

        <div className="text-[11px] font-body text-on-surface-variant space-y-1">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-xs text-on-surface-variant">fingerprint</span>
            <span className="truncate max-w-[160px]">{shortenPeerId(node.peerId)}</span>
          </div>
          {node.rttMs !== null && (
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-xs text-on-surface-variant">speed</span>
              <span>{node.rttMs}ms latency</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-xs text-on-surface-variant">link</span>
            <span className="truncate max-w-[160px]">{node.remoteAddress || "unknown"}</span>
          </div>
          {node.establishedAt > 0 && (
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-xs text-on-surface-variant">schedule</span>
              <span>{formatRelativeTime(node.establishedAt)}</span>
            </div>
          )}
        </div>
      </div>

      <button className="w-full text-center text-[10px] font-label font-semibold uppercase tracking-wider text-error hover:text-error-dim transition-colors py-1">
        Disconnect
      </button>
    </GlassPanel>
  );
}

/* ── Stats Card ──────────────────────────────────────────────── */

interface StatsCardProps {
  icon: string;
  iconColor: string;
  label: string;
  value: number | string;
  sublabel: string;
  bgIcon: string;
}

function StatsCard({ icon, iconColor, label, value, sublabel, bgIcon }: StatsCardProps) {
  return (
    <div className="glass-panel p-6 rounded-2xl min-w-[200px] border border-outline-variant/5 shadow-2xl relative overflow-hidden group hover:bg-surface-container-high/80 transition-all duration-300">
      <div className="absolute -right-4 -bottom-4 opacity-5 group-hover:opacity-10 transition-opacity">
        <span
          className="material-symbols-outlined text-8xl"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          {bgIcon}
        </span>
      </div>
      <div className="flex items-center gap-3 mb-2">
        <span className={`material-symbols-outlined text-sm ${iconColor}`}>
          {icon}
        </span>
        <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
          {label}
        </span>
      </div>
      <div className="text-3xl font-headline font-bold text-on-surface tracking-tighter">
        {value}
      </div>
      <div className="text-[11px] font-body uppercase tracking-widest text-on-surface-variant mt-1">
        {sublabel}
      </div>
    </div>
  );
}

/* ── Signal Bars ─────────────────────────────────────────────── */

function SignalBars({ strength }: { strength: number }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4].map((level) => (
        <span
          key={level}
          className={`w-1 h-3 rounded-full ${
            level <= strength ? "bg-secondary" : "bg-secondary/30"
          }`}
        />
      ))}
    </div>
  );
}

/* ── Main NodeMapPage ────────────────────────────────────────── */

function NodeMapPage() {
  const nearbyPeers = useMeshStore((s) => s.nearbyPeers);
  const tunnels = useMeshStore((s) => s.tunnels);
  const setNearbyPeers = useMeshStore((s) => s.setNearbyPeers);
  const setTunnels = useMeshStore((s) => s.setTunnels);

  const mapRef = useRef<HTMLDivElement>(null);
  const [mapSize, setMapSize] = useState({ width: 800, height: 600 });
  const [selectedNode, setSelectedNode] = useState<NodePosition | null>(null);
  const [searchValue, setSearchValue] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);

  // Fetch data on mount + poll every 5s
  const fetchData = useCallback(async () => {
    try {
      const [peers, tunnelData] = await Promise.all([
        getNearbyPeers(),
        getTunnels(),
      ]);
      setNearbyPeers(peers);
      setTunnels(tunnelData);
    } catch (err) {
      console.warn("Failed to fetch mesh data:", err);
    } finally {
      setInitialLoading(false);
    }
  }, [setNearbyPeers, setTunnels]);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Observe map container size
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setMapSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Calculate positions
  const nodePositions = useMemo(
    () => calculateNodePositions(nearbyPeers, tunnels, mapSize.width, mapSize.height),
    [nearbyPeers, tunnels, mapSize.width, mapSize.height],
  );

  const cx = mapSize.width / 2;
  const cy = mapSize.height / 2;

  // Stats
  const localCount = tunnels.filter((t) => t.connectionType === "local").length + nearbyPeers.filter((p) => !tunnels.some((t) => t.peerId === p.peerId)).length;
  const backboneCount = tunnels.filter(
    (t) => t.connectionType === "direct" || t.connectionType === "relayed",
  ).length;

  // Determine sync quality
  const avgRtt = tunnels.length > 0
    ? tunnels.reduce((sum, t) => sum + (t.rttMs ?? 0), 0) / tunnels.length
    : 0;
  const signalStrength = avgRtt < 20 ? 4 : avgRtt < 50 ? 3 : avgRtt < 100 ? 2 : 1;
  const syncLabel = signalStrength >= 3 ? "Optimal" : signalStrength >= 2 ? "Good" : "Weak";

  // Handle search / locate
  const handleLocate = useCallback(() => {
    if (!searchValue.trim()) return;
    const found = nodePositions.find(
      (n) =>
        n.peerId.toLowerCase().includes(searchValue.toLowerCase()) ||
        (n.displayName?.toLowerCase().includes(searchValue.toLowerCase()) ?? false),
    );
    if (found) {
      setSelectedNode(found);
    }
  }, [searchValue, nodePositions]);

  // Calculate tooltip position
  const getTooltipStyle = useCallback(
    (node: NodePosition): React.CSSProperties => {
      const tooltipWidth = 240;
      const tooltipHeight = 200;
      let left = node.x + 16;
      let top = node.y - 20;

      // Keep tooltip within map bounds
      if (left + tooltipWidth > mapSize.width) {
        left = node.x - tooltipWidth - 16;
      }
      if (top + tooltipHeight > mapSize.height) {
        top = mapSize.height - tooltipHeight - 10;
      }
      if (top < 10) {
        top = 10;
      }

      return { left, top };
    },
    [mapSize.width, mapSize.height],
  );

  if (initialLoading) {
    return (
      <main className="relative flex-grow w-full h-full overflow-hidden bg-surface">
        <div className="absolute inset-0 mesh-background" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center space-y-4 relative z-10">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
              <span className="material-symbols-outlined text-4xl text-primary/40 animate-pulse">
                map
              </span>
            </div>
            <div className="space-y-2">
              <Skeleton className="h-5 w-40 mx-auto" />
              <Skeleton className="h-3 w-56 mx-auto" />
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex-grow w-full h-full overflow-hidden">
      {/* Map Background */}
      <div ref={mapRef} className="absolute inset-0 z-0 bg-surface">
        {/* Mesh dot pattern background */}
        <div className="absolute inset-0 mesh-background" />
        <div className="absolute inset-0 map-gradient" />

        {/* SVG connection lines */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          {nodePositions.map((node) => (
            <line
              key={`line-${node.peerId}`}
              x1={cx}
              y1={cy}
              x2={node.x}
              y2={node.y}
              stroke={getLineColor(node.connectionType)}
              strokeWidth={1}
              opacity={0.25}
              strokeDasharray={
                node.connectionType === "relayed" ? "4 4" : undefined
              }
            />
          ))}
        </svg>

        {/* Your node (center) */}
        <div
          className="absolute w-4 h-4 rounded-full bg-primary node-dot-pulse z-10 cursor-pointer"
          style={{
            left: cx - 8,
            top: cy - 8,
          }}
          title="Your Node"
        />

        {/* Peer nodes */}
        {nodePositions.map((node) => {
          const dotSize =
            node.connectionType === "direct" ? 10 : node.connectionType === "local" ? 8 : 6;
          const half = dotSize / 2;
          return (
            <button
              key={`dot-${node.peerId}`}
              className={`absolute rounded-full ${getDotColor(node.connectionType)} ${getDotGlow(node.connectionType)} cursor-pointer hover:scale-150 transition-transform duration-200`}
              style={{
                left: node.x - half,
                top: node.y - half,
                width: dotSize,
                height: dotSize,
                opacity: node.connectionType === "relayed" ? 0.7 : 0.9,
              }}
              onClick={() =>
                setSelectedNode(
                  selectedNode?.peerId === node.peerId ? null : node,
                )
              }
            />
          );
        })}

        {/* Peer tooltip */}
        {selectedNode && (
          <div style={getTooltipStyle(selectedNode)}>
            <PeerTooltip
              node={selectedNode}
              onClose={() => setSelectedNode(null)}
            />
          </div>
        )}
      </div>

      {/* Floating UI Overlays */}
      <div className="relative z-10 w-full h-full pointer-events-none p-6 md:p-10 flex flex-col justify-between">
        {/* Top Controls: Search + Legend */}
        <div className="flex flex-col md:flex-row justify-between items-start gap-6">
          {/* Search Bar */}
          <div className="w-full md:w-96 pointer-events-auto">
            <div className="glass-panel rounded-xl p-1 flex items-center shadow-2xl border border-outline-variant/15">
              <div className="pl-4 pr-2 text-on-surface-variant">
                <span className="material-symbols-outlined text-lg">
                  search
                </span>
              </div>
              <input
                className="bg-transparent border-none focus:ring-0 focus:outline-none text-sm w-full font-body py-3 text-on-surface placeholder:text-on-surface-variant"
                placeholder="Find specific node address..."
                type="text"
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleLocate();
                }}
              />
              <button
                onClick={handleLocate}
                className="bg-primary hover:bg-primary-dim text-on-primary-fixed px-4 py-2 rounded-lg font-bold text-xs uppercase tracking-widest transition-all active:scale-95 mx-1 whitespace-nowrap"
              >
                Locate
              </button>
            </div>
          </div>

          {/* Legend */}
          <div className="pointer-events-auto glass-panel rounded-xl p-5 border border-outline-variant/10 shadow-xl">
            <h3 className="font-headline text-[10px] uppercase tracking-[0.2em] text-on-surface-variant mb-4 font-bold">
              Network Legend
            </h3>
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-secondary shadow-[0_0_8px_rgba(175,239,221,0.5)]" />
                <span className="text-xs font-semibold tracking-wide text-on-surface-variant">
                  Active Nodes
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-primary-fixed shadow-[0_0_8px_rgba(148,150,255,0.5)]" />
                <span className="text-xs font-semibold tracking-wide text-on-surface-variant">
                  Public Servers
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-primary node-dot-pulse" />
                <span className="text-xs font-semibold tracking-wide text-on-surface">
                  Your Node
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Stats */}
        <div className="flex flex-col md:flex-row gap-4 md:items-end pointer-events-auto">
          <StatsCard
            icon="wifi_tethering"
            iconColor="text-secondary"
            label="Coverage"
            value={localCount.toLocaleString()}
            sublabel="Nearby Nodes"
            bgIcon="cell_tower"
          />
          <StatsCard
            icon="hub"
            iconColor="text-primary"
            label="Backbone"
            value={backboneCount.toLocaleString()}
            sublabel="Public Servers"
            bgIcon="dns"
          />
          {/* Network Status Badge */}
          <div className="glass-panel px-4 py-3 rounded-xl ml-auto border border-secondary/20 flex items-center gap-3">
            <SignalBars strength={signalStrength} />
            <span className="text-xs font-bold uppercase tracking-widest text-secondary">
              Local Sync: {syncLabel}
            </span>
          </div>
        </div>
      </div>
    </main>
  );
}

export default NodeMapPage;
