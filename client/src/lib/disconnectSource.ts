/**
 * disconnectSource — teardown for a source connection.
 *
 * The plain `useSourcesStore.removeSource(id)` only removes the row
 * from the rail/list. It does NOT:
 *   - stop the matrix-js-sdk client (the live Matrix client keeps
 *     syncing, so cached rooms and servers stay populated long after
 *     the tile is gone),
 *   - clear `useServerStore.servers` (Sources rail's content area
 *     still renders the same channels),
 *   - clear the cached session credentials in localStorage
 *     (`concord_session`), so the next launch silently restores.
 *
 * Result: the user "disconnects" but the chats stay visible — they
 * just lose the disconnect button. Reported as:
 *
 *   "The source icon disappeared but the content did not. I still see
 *    all three servers being served by concorrd.com."
 *
 * This helper does the right thing: if the disconnected source is
 * tied to the currently-active Matrix session, it triggers the full
 * `logout()` flow (which stops the client, resets the server store,
 * clears localStorage, AND removes sources tied to the prior user via
 * `bindToUser(null)`). For any other source — not tied to the active
 * session — it falls back to `removeSource(id)` so the row is dropped
 * without disturbing the live session.
 */

import { useAuthStore } from "../stores/auth";
import { useSourcesStore } from "../stores/sources";

export function disconnectSource(sourceId: string): void {
  const source = useSourcesStore
    .getState()
    .sources.find((s) => s.id === sourceId);
  const { userId, logout } = useAuthStore.getState();

  // Active-session match: the disconnected source is the one whose
  // Matrix session is live. Full teardown.
  if (source && userId && source.userId === userId) {
    logout();
    return;
  }

  // Fallback: drop the row only.
  useSourcesStore.getState().removeSource(sourceId);
}
