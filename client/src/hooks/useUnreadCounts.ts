import { useEffect, useState, useRef } from "react";
import { RoomEvent, ClientEvent } from "matrix-js-sdk";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { useAuthStore } from "../stores/auth";

/** Event types the unread counter cares about. State events, reactions,
 *  receipts, and other ambient updates don't contribute to unread and
 *  marking them read doesn't decrement anything. */
const UNREAD_CONTRIBUTING_TYPES = new Set([
  "m.room.message",
  "m.room.encrypted",
  "m.sticker",
  "m.call.invite",
]);

/** How many unread we'll bother showing before clamping to "99+". */
const UNREAD_DISPLAY_CAP = 99;

/** Walk the live timeline backwards and return the most recent event whose
 *  type contributes to the unread run. The server only treats certain event
 *  types as "unread-contributing", so anchoring the read marker on the raw
 *  tail (which might be a state event or a reaction) leaves the badge lit
 *  even after the receipt round-trips. */
function findLastUnreadContributingEvent(room: Room): MatrixEvent | null {
  const timeline = room.getLiveTimeline().getEvents();
  for (let i = timeline.length - 1; i >= 0; i--) {
    const ev = timeline[i];
    if (ev && UNREAD_CONTRIBUTING_TYPES.has(ev.getType())) {
      return ev;
    }
  }
  // No message-shaped event in the live timeline. Don't anchor a receipt
  // on a state event — the homeserver doesn't treat state events as
  // unread-contributing, so the receipt lands but the server-side
  // notification count never decrements and the badge re-lights on the
  // next sync push. Sparse-timeline rooms (lazy-load batched, freshly-
  // synced app channels per v0.7.2) regularly hit this path. Returning
  // null short-circuits markRoomRead → no spurious receipt; computeUnread
  // already skips state events so the local count is 0 anyway.
  return null;
}

/** Deterministic, client-side unread count for a single room. We don't
 *  trust `room.getUnreadNotificationCount(Total)` because tuwunel's push
 *  count refresh after a read marker is unreliable — counts can persist
 *  long after the receipt is acked, which is the user-visible "always
 *  says the same thing" bug. Instead we walk the live timeline ourselves
 *  and ask `room.hasUserReadEvent` per event, which consults the local
 *  read-receipt state. */
function computeUnreadForRoom(room: Room, userId: string): {
  unread: number;
  highlight: number;
} {
  const events = room.getLiveTimeline().getEvents();
  let unread = 0;
  let highlight = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev) continue;
    const type = ev.getType();
    if (!UNREAD_CONTRIBUTING_TYPES.has(type)) continue;
    // Don't count my own messages as unread.
    if (ev.getSender() === userId) continue;
    const evId = ev.getId();
    if (!evId) continue;
    // hasUserReadEvent walks both threaded and unthreaded receipts.
    if (room.hasUserReadEvent(userId, evId)) {
      // Everything older than this is also read — short-circuit.
      break;
    }
    unread++;
    // Highlight if the message explicitly mentions me via m.mentions
    // or the body contains my MXID. Push-rule keyword matching isn't
    // implemented client-side; this is the conservative subset.
    const content = ev.getContent?.() ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mentions = (content as any)["m.mentions"];
    if (
      mentions &&
      Array.isArray(mentions.user_ids) &&
      mentions.user_ids.includes(userId)
    ) {
      highlight++;
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (content as any).body;
    if (typeof body === "string" && body.includes(userId)) {
      highlight++;
    }
  }
  return {
    unread: Math.min(unread, UNREAD_DISPLAY_CAP + 1),
    highlight,
  };
}

async function markRoomRead(
  client: ReturnType<typeof useAuthStore.getState>["client"],
  roomId: string,
): Promise<void> {
  if (!client) return;
  const room = client.getRoom(roomId);
  if (!room) return;
  const target = findLastUnreadContributingEvent(room);
  const targetId = target?.getId?.();
  if (!target || !targetId) return;
  try {
    await client.setRoomReadMarkers(roomId, targetId, target);
  } catch (err) {
    // Surface failures instead of swallowing — when the receipt doesn't
    // land the badge stays lit forever and the user has no signal for
    // why.
    console.warn("[unread] setRoomReadMarkers failed", { roomId, err });
    throw err;
  }
}

/** Shared core for useUnreadCounts / useHighlightCounts. Subscribes to the
 *  events that can change either count and invokes the supplied selector
 *  to project a per-room number. */
function useRoomCountMap(
  selector: (per: { unread: number; highlight: number }) => number,
): Map<string, number> {
  const client = useAuthStore((s) => s.client);
  const userId = useAuthStore((s) => s.userId);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevKeyRef = useRef<string>("");

  useEffect(() => {
    if (!client || !userId) return;

    const update = () => {
      const rooms = client.getRooms();
      const map = new Map<string, number>();
      for (const room of rooms) {
        const per = computeUnreadForRoom(room, userId);
        const value = selector(per);
        if (value > 0) {
          map.set(room.roomId, value);
        }
      }
      const key = Array.from(map.entries())
        .map(([id, c]) => `${id}:${c}`)
        .join(",");
      if (key !== prevKeyRef.current) {
        prevKeyRef.current = key;
        setCounts(map);
      }
    };

    // Debounce: Timeline / Receipt events fire frequently. 200ms is short
    // enough to feel instant when a receipt clears a badge, long enough
    // that a burst of 50 incoming messages doesn't recompute 50 times.
    const debouncedUpdate = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(update, 200);
    };

    update();

    client.on(RoomEvent.Timeline, debouncedUpdate);
    client.on(RoomEvent.Receipt, debouncedUpdate);
    // Account-data updates carry the `m.fully_read` marker — without
    // this listener the badge can stay lit until the next Receipt or
    // Timeline event happens to bump the refresh.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.on(ClientEvent.AccountData as any, debouncedUpdate);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      client.removeListener(RoomEvent.Timeline, debouncedUpdate);
      client.removeListener(RoomEvent.Receipt, debouncedUpdate);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.removeListener(ClientEvent.AccountData as any, debouncedUpdate);
    };
  }, [client, userId, selector]);

  return counts;
}

const selectUnread = (per: { unread: number; highlight: number }) => per.unread;
const selectHighlight = (per: { unread: number; highlight: number }) => per.highlight;

export function useUnreadCounts(): Map<string, number> {
  return useRoomCountMap(selectUnread);
}

export function useHighlightCounts(): Map<string, number> {
  return useRoomCountMap(selectHighlight);
}

/**
 * Send read receipts for the active room.
 *
 * Fires on every trigger that signals "the user is looking at this":
 *   1. Room switch (debounced 300ms after `roomId` changes).
 *   2. Live message arrival in the active room (debounced 500ms).
 *   3. Tab/window becomes visible (visibilitychange → visible).
 *   4. Window regains focus.
 *
 * All triggers gate on visibility (`document.visibilityState === "visible"`
 * + the caller's `isVisible` arg, which on mobile reflects the chat-pane
 * tab state). Without the aggressive visibility/focus triggers, switching
 * away from the tab while a message arrives leaves the badge stuck even
 * after the user comes back and stares straight at the message.
 */
export function useSendReadReceipt(
  roomId: string | null,
  isVisible: boolean = true,
) {
  const client = useAuthStore((s) => s.client);
  const switchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Room-switch read receipt — fires once 300ms after roomId changes.
  useEffect(() => {
    if (switchDebounceRef.current) clearTimeout(switchDebounceRef.current);

    if (!client || !roomId) return;
    if (!isVisible) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;

    switchDebounceRef.current = setTimeout(() => {
      markRoomRead(client, roomId).catch(() => {
        // Non-critical — silently ignore
      });
    }, 300);

    return () => {
      if (switchDebounceRef.current) clearTimeout(switchDebounceRef.current);
    };
  }, [client, roomId, isVisible]);

  // Live-message read receipt — listens for Timeline events in the active
  // room and marks them read while the user is looking at the chat.
  useEffect(() => {
    if (!client || !roomId) return;

    const onTimeline = (
      _event: unknown,
      room: { roomId: string } | undefined,
      _toStartOfTimeline: boolean | undefined,
      removed: boolean,
      data: { liveEvent?: boolean } | undefined,
    ) => {
      if (removed) return;
      if (!data?.liveEvent) return;
      if (!room || room.roomId !== roomId) return;

      if (!isVisible) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;

      if (liveDebounceRef.current) clearTimeout(liveDebounceRef.current);
      liveDebounceRef.current = setTimeout(() => {
        markRoomRead(client, roomId).catch(() => {
          // Non-critical — silently ignore
        });
      }, 500);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.on(RoomEvent.Timeline, onTimeline as any);

    return () => {
      if (liveDebounceRef.current) clearTimeout(liveDebounceRef.current);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.removeListener(RoomEvent.Timeline, onTimeline as any);
    };
  }, [client, roomId, isVisible]);

  // Visibility / focus read receipt — when the user returns to the tab or
  // the window regains focus, mark the active room read. Without this, a
  // message that arrives while the tab is hidden stays unread forever
  // even after the user returns and visibly reads it.
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    if (!client || !roomId) return;
    if (!isVisible) return;

    const fire = () => {
      if (document.visibilityState !== "visible") return;
      if (focusDebounceRef.current) clearTimeout(focusDebounceRef.current);
      focusDebounceRef.current = setTimeout(() => {
        markRoomRead(client, roomId).catch(() => {});
      }, 200);
    };

    document.addEventListener("visibilitychange", fire);
    window.addEventListener("focus", fire);
    return () => {
      if (focusDebounceRef.current) clearTimeout(focusDebounceRef.current);
      document.removeEventListener("visibilitychange", fire);
      window.removeEventListener("focus", fire);
    };
  }, [client, roomId, isVisible]);
}
