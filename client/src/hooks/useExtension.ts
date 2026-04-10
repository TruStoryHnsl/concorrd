import { useEffect, useCallback } from "react";
import { RoomStateEvent } from "matrix-js-sdk";
import type { MatrixEvent } from "matrix-js-sdk";
import { useAuthStore } from "../stores/auth";
import {
  useExtensionStore,
  EXTENSION_EVENT_TYPE,
  EXTENSION_STATE_KEY,
  type ActiveExtension,
} from "../stores/extension";

/**
 * Parse a `com.concord.extension` state event's content into an
 * ActiveExtension, or null if the extension is not active / malformed.
 */
function parseExtensionContent(
  content: Record<string, unknown>,
): ActiveExtension | null {
  if (!content?.active) return null;
  const id = content.extension_id;
  const url = content.extension_url;
  const name = content.extension_name;
  const host = content.host_user_id;
  const started = content.started_at;
  if (
    typeof id !== "string" ||
    typeof url !== "string" ||
    typeof name !== "string" ||
    typeof host !== "string" ||
    typeof started !== "number"
  )
    return null;

  // Validate URL against catalog to prevent injection
  const catalog = useExtensionStore.getState().catalog;
  if (!catalog.some((d) => d.id === id && d.url === url)) return null;

  return {
    extensionId: id,
    extensionUrl: url,
    extensionName: name,
    hostUserId: host,
    startedAt: started,
  };
}

/**
 * Syncs extension state from Matrix room state for the given room.
 * Returns the active extension (if any), whether the current user is
 * the host, and start/stop actions.
 */
export function useExtension(roomId: string | null) {
  const client = useAuthStore((s) => s.client);
  const userId = useAuthStore((s) => s.userId);
  const activeExtension = useExtensionStore(
    (s) => (roomId ? s.activeExtensions[roomId] : null) ?? null,
  );
  const startExtension = useExtensionStore((s) => s.startExtension);
  const stopExtension = useExtensionStore((s) => s.stopExtension);

  const readState = useCallback(() => {
    if (!client || !roomId) return;
    const room = client.getRoom(roomId);
    if (!room) return;

    const stateEvent = room.currentState?.getStateEvents(
      EXTENSION_EVENT_TYPE,
      EXTENSION_STATE_KEY,
    );
    if (!stateEvent) {
      useExtensionStore.getState().setActiveExtension(roomId, null);
      return;
    }

    const content = stateEvent.getContent?.() ?? {};
    const parsed = parseExtensionContent(content as Record<string, unknown>);
    useExtensionStore.getState().setActiveExtension(roomId, parsed);
  }, [client, roomId]);

  // Read initial state when room changes
  useEffect(() => {
    readState();
  }, [readState]);

  // Subscribe to room state changes
  useEffect(() => {
    if (!client || !roomId) return;
    const room = client.getRoom(roomId);
    if (!room?.currentState) return;

    const onStateEvent = (event: MatrixEvent) => {
      if (event.getType() === EXTENSION_EVENT_TYPE) {
        readState();
      }
    };

    room.currentState.on(RoomStateEvent.Events, onStateEvent);
    return () => {
      room.currentState.removeListener(RoomStateEvent.Events, onStateEvent);
    };
  }, [client, roomId, readState]);

  const isHost = !!(activeExtension && userId && activeExtension.hostUserId === userId);

  return {
    activeExtension,
    isHost,
    startExtension: useCallback(
      (extensionId: string) => {
        if (roomId) return startExtension(roomId, extensionId);
        return Promise.resolve();
      },
      [roomId, startExtension],
    ),
    stopExtension: useCallback(() => {
      if (roomId) return stopExtension(roomId);
      return Promise.resolve();
    }, [roomId, stopExtension]),
  };
}
