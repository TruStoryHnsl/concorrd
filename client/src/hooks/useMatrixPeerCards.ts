/**
 * Matrix peer-card detector (Phase 5 — peer pairing).
 *
 * Scans every joined room's incoming timeline events for the custom
 * `msgtype === 'concord.peer_card'` payload that `PeerCardDisplay`
 * broadcasts. Each detected card is offered to the user via the
 * `PeerCardScanner` "from Matrix rooms" tab.
 *
 * Tolerance is the design point: this hook MUST NOT throw on a
 * malformed event. The Matrix room is an untrusted channel — any
 * client (or a maliciously crafted state replay) could ship an event
 * with `msgtype: concord.peer_card` and garbage fields, and we cannot
 * let that crash the React tree. Every field is validated and a
 * malformed event is silently dropped.
 *
 * Storage policy: only the most recent `MAX_TRACKED` cards are kept,
 * keyed by peer-id (newer events for the same peer-id replace the
 * earlier one). This prevents the list from growing unbounded on a
 * room with frequent re-broadcasts.
 */

import { useEffect, useState } from "react";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { RoomEvent } from "matrix-js-sdk";
import { useAuthStore } from "../stores/auth";
import type { PeerCard } from "../api/peerStore";

/** Custom msgtype used by `PeerCardDisplay` to broadcast a peer card. */
const PEER_CARD_MSGTYPE = "concord.peer_card";

/** Cap on tracked cards to keep memory bounded in chatty rooms. */
const MAX_TRACKED = 50;

/**
 * One observed peer card. Adds the source-room and observed-at metadata
 * the scanner UI uses to disambiguate two cards from the same install
 * posted into different rooms.
 */
export interface RecentPeerCard extends PeerCard {
  roomId: string;
  roomName: string | null;
  sender: string;
  observedAt: number;
}

/**
 * Type-safe field extractor for an `m.room.message` event whose content
 * we DON'T trust. Returns the validated `PeerCard` or null if the event
 * isn't a peer card or is malformed. Never throws.
 */
function extractPeerCard(event: MatrixEvent): PeerCard | null {
  // Wrap the entire extraction in a try/catch — `event.getContent()`
  // can theoretically throw on a partially-decrypted event in olm flows
  // and we don't want that to take down the timeline listener.
  try {
    if (event.getType() !== "m.room.message") return null;
    const content = event.getContent();
    if (!content || typeof content !== "object") return null;
    const c = content as Record<string, unknown>;
    if (c.msgtype !== PEER_CARD_MSGTYPE) return null;

    const peerId = c.peer_id;
    if (typeof peerId !== "string" || peerId.length === 0) return null;

    const publicKeyHex = c.public_key_hex;
    if (typeof publicKeyHex !== "string") return null;
    // Same shape check as `peerCard.ts::validateCard` — 64 hex chars.
    if (publicKeyHex.length !== 64) return null;
    if (!/^[0-9a-fA-F]+$/.test(publicKeyHex)) return null;

    const multiaddrs = c.multiaddrs;
    if (!Array.isArray(multiaddrs)) return null;
    if (multiaddrs.length === 0) return null;
    const cleaned: string[] = [];
    for (const addr of multiaddrs) {
      if (typeof addr !== "string" || addr.length === 0) return null;
      cleaned.push(addr);
    }

    return {
      peerId,
      publicKeyHex,
      multiaddrs: cleaned,
    };
  } catch {
    // Any unexpected error → silently drop. The room continues to render.
    return null;
  }
}

/**
 * React hook returning the most recent peer cards observed in any
 * joined room, newest first.
 *
 * Listens on `RoomEvent.Timeline` against the active Matrix client, plus
 * a one-time scan of every joined room's existing live timeline on mount
 * so cards posted before the hook was subscribed are still discoverable.
 */
export function useMatrixPeerCards(): RecentPeerCard[] {
  const client = useAuthStore((s) => s.client);
  const [cards, setCards] = useState<RecentPeerCard[]>([]);

  useEffect(() => {
    if (!client) return;

    /**
     * Upsert a card into the list — newer entry replaces older entry
     * with the same peer-id; total list capped at `MAX_TRACKED`.
     */
    const upsert = (newCard: RecentPeerCard) => {
      setCards((prev) => {
        const filtered = prev.filter((c) => c.peerId !== newCard.peerId);
        const next = [newCard, ...filtered];
        return next.slice(0, MAX_TRACKED);
      });
    };

    /**
     * Convert a (MatrixEvent, Room) pair into a RecentPeerCard if it's
     * a valid peer-card event. Returns null otherwise.
     */
    const toRecent = (
      event: MatrixEvent,
      room: Room | undefined,
    ): RecentPeerCard | null => {
      const card = extractPeerCard(event);
      if (!card) return null;
      return {
        ...card,
        roomId: room?.roomId ?? event.getRoomId() ?? "(unknown)",
        roomName: room?.name ?? null,
        sender: event.getSender() ?? "(unknown)",
        observedAt: event.getTs(),
      };
    };

    // ── Initial scan of existing room timelines ──────────────────────
    // A card posted before the user opened this UI should still appear,
    // so we walk every joined room's live timeline once.
    const seen: RecentPeerCard[] = [];
    for (const room of client.getRooms()) {
      if (room.getMyMembership() !== "join") continue;
      const events = room.getLiveTimeline().getEvents();
      for (const ev of events) {
        const recent = toRecent(ev, room);
        if (recent) seen.push(recent);
      }
    }
    if (seen.length > 0) {
      // Deduplicate by peer-id, keep newest, cap at MAX_TRACKED.
      const byPeer = new Map<string, RecentPeerCard>();
      for (const c of seen) {
        const existing = byPeer.get(c.peerId);
        if (!existing || c.observedAt > existing.observedAt) {
          byPeer.set(c.peerId, c);
        }
      }
      const initial = [...byPeer.values()]
        .sort((a, b) => b.observedAt - a.observedAt)
        .slice(0, MAX_TRACKED);
      setCards(initial);
    }

    // ── Live timeline listener for future events ─────────────────────
    const onTimeline = (event: MatrixEvent, room: Room | undefined) => {
      const recent = toRecent(event, room);
      if (recent) upsert(recent);
    };
    client.on(RoomEvent.Timeline, onTimeline);

    return () => {
      client.removeListener(RoomEvent.Timeline, onTimeline);
    };
  }, [client]);

  return cards;
}
