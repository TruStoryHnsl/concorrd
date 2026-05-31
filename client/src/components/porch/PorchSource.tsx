/**
 * PorchSource — Phase A.
 *
 * A tile (or list row) representing a paired peer's porch as a
 * Source. Clicking the tile opens the peer's porch in the visit view
 * via `onOpen`.
 *
 * Online indicator: Phase A renders gray by default. The real
 * liveness signal will come from the libp2p swarm event mirror in a
 * follow-up — for now the tile reflects "we have a pairing" rather
 * than "they're reachable right now". Anything more is Phase B's job.
 */

import type { KnownPeer } from "../../api/peerStore";

export interface PorchSourceProps {
  peer: KnownPeer;
  online?: boolean;
  onOpen: (peerId: string) => void;
}

export function PorchSource({ peer, online = false, onOpen }: PorchSourceProps) {
  const label = peer.peerId.slice(0, 12) + "…";
  return (
    <button
      type="button"
      onClick={() => onOpen(peer.peerId)}
      title={`Visit porch for ${peer.peerId}`}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        background: "transparent",
        border: 0,
        color: "inherit",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span
        aria-label={online ? "online" : "offline"}
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: online ? "#3ad17d" : "#8a8d92",
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 11,
            opacity: 0.6,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {peer.source} · porch
        </div>
      </div>
    </button>
  );
}

export default PorchSource;
