/**
 * useExtensionRoomBridge — INS-066-FUP-A wiring.
 *
 * Builds the two callbacks `<ExtensionSurfaceManager>` needs in order for
 * the W5/W6 SDK channels to actually flow against the live matrix-js-sdk
 * client + room store:
 *
 *   - `subscribeRoomEvents(handler)` — called once per session mount.
 *     Registers a `RoomEvent.Timeline` listener (catches inbound timeline
 *     messages AND state events that arrive on the live timeline) plus a
 *     `RoomStateEvent.Events` listener on the room's currentState (catches
 *     any state-event delivery path the timeline misses, e.g. snapshot
 *     applications). Filters to the target room and emits the minimal
 *     `IncomingMatrixEvent` shape the shell forwards as
 *     `concord:state_event`.
 *
 *   - `onSendStateEvent({roomId, eventType, stateKey, content})` — calls
 *     `client.sendStateEvent(...)` so an iframe-emitted
 *     `extension:send_state_event` (after passing both InputRouter and
 *     manifest gates inside the manager) lands as a real Matrix state
 *     event in the room. Returns the SDK promise so the manager's `.catch`
 *     reports backend errors back to the iframe via
 *     `concord:permission_denied { reason: "backend_error" }`.
 *
 * The hook keeps the dependency on `matrix-js-sdk` confined here so
 * `<ExtensionSurfaceManager>` stays SDK-agnostic and unit-testable in
 * isolation against a fake bus (see existing W5/W6 component tests).
 */

import { useEffect, useMemo, useRef } from "react";
import { RoomEvent, RoomStateEvent } from "matrix-js-sdk";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import type { IncomingMatrixEvent } from "../components/extension/ExtensionEmbed";

/** Convert a matrix-js-sdk MatrixEvent into the minimal shape consumed by
 *  the ExtensionSurfaceManager's W5 forwarder. Strips the SDK type so the
 *  shell layer stays decoupled. */
function toIncoming(ev: MatrixEvent): IncomingMatrixEvent {
  // matrix-js-sdk MatrixEvent.getStateKey() returns string | undefined.
  const stateKey = ev.getStateKey?.();
  return {
    type: ev.getType(),
    content: { ...(ev.getContent?.() ?? {}) },
    sender: ev.getSender?.() ?? "",
    origin_server_ts: ev.getTs?.() ?? Date.now(),
    ...(stateKey !== undefined ? { state_key: stateKey } : {}),
  };
}

export interface ExtensionRoomBridge {
  subscribeRoomEvents: (
    handler: (ev: IncomingMatrixEvent) => void,
  ) => () => void;
  onSendStateEvent: (args: {
    roomId: string;
    eventType: string;
    stateKey: string;
    content: Record<string, unknown>;
  }) => Promise<void>;
}

/**
 * Build a bridge for the given (`client`, `roomId`). Returns `null` if
 * either is missing — the call site treats null as "no wiring", which the
 * shell tolerates by leaving the props undefined (no events flow, no
 * sends accepted; matches the fail-closed posture documented in the
 * manager).
 */
export function useExtensionRoomBridge(
  client: MatrixClient | null,
  roomId: string | null,
): ExtensionRoomBridge | null {
  // Stash the latest client in a ref so the returned `subscribeRoomEvents`
  // stays referentially stable across renders (the manager subscribes once
  // on mount and re-subscribes only when its key deps change — we don't
  // want to thrash the subscription every parent rerender).
  const clientRef = useRef<MatrixClient | null>(client);
  const roomIdRef = useRef<string | null>(roomId);
  useEffect(() => {
    clientRef.current = client;
    roomIdRef.current = roomId;
  }, [client, roomId]);

  return useMemo<ExtensionRoomBridge | null>(() => {
    if (!client || !roomId) return null;

    const subscribeRoomEvents = (
      handler: (ev: IncomingMatrixEvent) => void,
    ): (() => void) => {
      const c = clientRef.current;
      const rid = roomIdRef.current;
      if (!c || !rid) return () => {};

      // Dedupe across both listeners (timeline + room currentState).
      // Many Matrix state-event deliveries fan out to BOTH buses; without
      // this set the iframe would receive the same event twice.
      const seen = new Set<string>();

      const onTimeline = (event: MatrixEvent, room: Room | undefined) => {
        if (!room || room.roomId !== rid) return;
        const eid = event.getId?.();
        if (eid && seen.has(eid)) return;
        if (eid) seen.add(eid);
        handler(toIncoming(event));
      };

      const onStateEvent = (event: MatrixEvent) => {
        // RoomStateEvent.Events fires for every state event the room
        // applies. The timeline listener above catches state events that
        // also arrive via the live timeline; this handler exists so we
        // also see snapshot/initial-sync deliveries that might bypass
        // the timeline. Dedupe is best-effort: we forward by event id.
        const eid = event.getId?.();
        if (eid && seen.has(eid)) return;
        if (eid) seen.add(eid);
        handler(toIncoming(event));
      };
      c.on(RoomEvent.Timeline, onTimeline);

      // Also subscribe to the room's state-event stream for the target
      // room only. The room may not exist yet if sync hasn't reached it,
      // so we pull it lazily — a missed state-event from a not-yet-known
      // room is acceptable; the timeline listener will pick up the next
      // delivery.
      const room = c.getRoom?.(rid) ?? null;
      const currentState = room?.currentState ?? null;
      if (currentState) {
        currentState.on(RoomStateEvent.Events, onStateEvent);
      }

      return () => {
        c.removeListener?.(RoomEvent.Timeline, onTimeline);
        if (currentState) {
          currentState.removeListener?.(RoomStateEvent.Events, onStateEvent);
        }
      };
    };

    const onSendStateEvent = async (args: {
      roomId: string;
      eventType: string;
      stateKey: string;
      content: Record<string, unknown>;
    }): Promise<void> => {
      const c = clientRef.current;
      if (!c) throw new Error("matrix client unavailable");
      // matrix-js-sdk types for sendStateEvent vary across versions; the
      // existing call sites in stores/extension.ts use the same `as any`
      // escape hatch. Match the established pattern.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (c as any).sendStateEvent(
        args.roomId,
        args.eventType,
        args.content,
        args.stateKey,
      );
    };

    return { subscribeRoomEvents, onSendStateEvent };
    // Bridge identity tracks (client, roomId). Inner callbacks read the
    // refs so a stale closure cannot capture the wrong client.
  }, [client, roomId]);
}
