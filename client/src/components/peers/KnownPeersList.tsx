/**
 * KnownPeersList (Phase 5 — peer pairing).
 *
 * Renders the paired-peers list from `usePeerStore`. Each row shows:
 *   - A short fingerprint (first 12 chars + ellipsis) so the row stays
 *     compact in the Profile tab's narrow column.
 *   - A source badge (Qr / Link / Matrix / DHT) so the user knows where
 *     the pairing came from.
 *   - A relative "last seen" timestamp.
 *   - A trash-icon remove button with a confirm prompt.
 *
 * Empty state: a one-line italic placeholder. The "Add a peer…" button
 * lives in the parent ProfileTab section, not here, because the empty
 * state for "no peers yet" is the same height as a populated row and
 * we want the parent's layout to stay stable as the list fills in.
 */

import { useEffect } from "react";
import { usePeerStore } from "../../stores/peerStore";
import type { KnownPeer, PeerSource } from "../../api/peerStore";
import { useToastStore } from "../../stores/toast";

/**
 * Human-readable label for each source, kept short to fit in a chip.
 * The mapping is intentional duplication with the API layer's enum —
 * the enum is the wire contract; this is the display contract.
 */
const SOURCE_LABEL: Record<PeerSource, string> = {
  qr: "QR",
  deeplink: "Link",
  matrix_room: "Matrix",
  dht: "DHT",
};

/**
 * Format an ISO timestamp as a short relative-time string like "2m ago"
 * or "3h ago". Inline helper rather than pulling a date-fns dep because
 * we only need four bands (seconds, minutes, hours, days) and the input
 * is always recent.
 */
function relativeTime(isoTimestamp: string, now: number = Date.now()): string {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) return "—";
  const deltaSec = Math.max(0, Math.floor((now - parsed) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.floor(deltaHr / 24);
  return `${deltaDay}d ago`;
}

export function KnownPeersList() {
  const knownPeers = usePeerStore((s) => s.knownPeers);
  const isLoading = usePeerStore((s) => s.isLoading);

  useEffect(() => {
    // Same one-shot load convention as the identity store. Future
    // pushes from `peer_paired` events are wired by the store itself.
    // Phase 9: on web, `load()` reads from localStorage; on native, it
    // calls the `peer_store_list` Tauri command. Identical KnownPeer
    // shape on both sides.
    void usePeerStore.getState().load();
  }, []);

  if (isLoading && knownPeers.length === 0) {
    return (
      <p className="text-xs text-on-surface-variant italic">Loading peers…</p>
    );
  }

  if (knownPeers.length === 0) {
    return (
      <p className="text-xs text-on-surface-variant italic">
        No paired peers yet. Use the "Add a peer…" button above.
      </p>
    );
  }

  return (
    <ul className="space-y-1">
      {knownPeers.map((peer) => (
        <li key={peer.peerId}>
          <KnownPeerRow peer={peer} />
        </li>
      ))}
    </ul>
  );
}

function KnownPeerRow({ peer }: { peer: KnownPeer }) {
  const remove = usePeerStore((s) => s.remove);
  const addToast = useToastStore((s) => s.addToast);

  const handleRemove = async () => {
    // window.confirm is fine here — it's a destructive action on a single
    // identity-shaped object, and a full modal would be overkill for a
    // section that itself lives inside the Profile tab.
    const ok =
      typeof window !== "undefined" &&
      window.confirm(
        `Remove paired peer ${peer.peerId.slice(0, 12)}…?\nThis only removes the local pairing; the other install is unaffected.`,
      );
    if (!ok) return;
    const removed = await remove(peer.peerId);
    if (removed) {
      addToast("Peer removed", "success");
    } else {
      addToast("Could not remove peer");
    }
  };

  const sourceLabel = SOURCE_LABEL[peer.source] ?? peer.source;

  return (
    <div className="flex items-center justify-between gap-3 py-1.5 px-2 rounded hover:bg-surface-container-high">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span
          className="text-sm text-on-surface-variant font-mono truncate"
          title={peer.peerId}
        >
          {peer.peerId.slice(0, 12)}…
        </span>
        <span
          className="text-xs px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant whitespace-nowrap"
          title={`Source: ${sourceLabel}`}
        >
          {sourceLabel}
        </span>
      </div>
      <span
        className="text-xs text-on-surface-variant whitespace-nowrap"
        title={`Last seen: ${peer.lastSeen}`}
      >
        {relativeTime(peer.lastSeen)}
      </span>
      <button
        type="button"
        onClick={handleRemove}
        className="btn-press inline-flex items-center justify-center px-1.5 py-1 rounded-md text-on-surface-variant hover:bg-error/10 hover:text-error transition-colors"
        aria-label={`Remove paired peer ${peer.peerId.slice(0, 12)}`}
        title="Remove paired peer"
      >
        <span
          className="material-symbols-outlined text-base leading-none"
          style={{
            fontVariationSettings:
              '"FILL" 0, "wght" 500, "GRAD" 0, "opsz" 24',
          }}
        >
          delete
        </span>
      </button>
    </div>
  );
}
