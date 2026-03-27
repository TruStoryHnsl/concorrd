import { create } from "zustand";
import type { PeerInfo, NodeStatus, TunnelInfo } from "@/api/tauri";

interface MeshState {
  nearbyPeers: PeerInfo[];
  nodeStatus: NodeStatus | null;
  tunnels: TunnelInfo[];
  setNearbyPeers: (peers: PeerInfo[]) => void;
  setNodeStatus: (status: NodeStatus) => void;
  addPeer: (peer: PeerInfo) => void;
  removePeer: (peerId: string) => void;
  updateConnectionCount: (count: number) => void;
  setTunnels: (tunnels: TunnelInfo[]) => void;
  addTunnel: (tunnel: TunnelInfo) => void;
  removeTunnel: (peerId: string) => void;
}

export const useMeshStore = create<MeshState>((set) => ({
  nearbyPeers: [],
  nodeStatus: null,
  tunnels: [],

  setNearbyPeers: (peers) => set({ nearbyPeers: peers }),
  setNodeStatus: (status) => set({ nodeStatus: status }),

  addPeer: (peer) =>
    set((state) => {
      if (!peer?.peerId) return state; // guard against malformed events
      const exists = state.nearbyPeers.some((p) => p.peerId === peer.peerId);
      if (exists) {
        return {
          nearbyPeers: state.nearbyPeers.map((p) =>
            p.peerId === peer.peerId ? peer : p,
          ),
        };
      }
      return { nearbyPeers: [...state.nearbyPeers, peer] };
    }),

  removePeer: (peerId) =>
    set((state) => ({
      nearbyPeers: state.nearbyPeers.filter((p) => p.peerId !== peerId),
    })),

  updateConnectionCount: (count) =>
    set((state) => ({
      nodeStatus: state.nodeStatus
        ? { ...state.nodeStatus, connectedPeers: count }
        : { isOnline: true, connectedPeers: count, peerId: "" },
    })),

  setTunnels: (tunnels) => set({ tunnels }),

  addTunnel: (tunnel) =>
    set((state) => {
      const exists = state.tunnels.some((t) => t.peerId === tunnel.peerId);
      if (exists) {
        return {
          tunnels: state.tunnels.map((t) =>
            t.peerId === tunnel.peerId ? tunnel : t,
          ),
        };
      }
      return { tunnels: [...state.tunnels, tunnel] };
    }),

  removeTunnel: (peerId) =>
    set((state) => ({
      tunnels: state.tunnels.filter((t) => t.peerId !== peerId),
    })),
}));
