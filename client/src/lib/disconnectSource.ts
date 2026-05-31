/**
 * disconnectSource — full teardown for a source connection.
 *
 * Reported (the bug this exists to fix):
 *
 *   "The source icon disappeared but the content did not. I still see
 *    all three servers being served by concorrd.com."
 *
 * And, after the first iteration (which only called logout for active
 * sessions):
 *
 *   "No change in behavior. The tile disappears but the connection is
 *    never removed. When I restart the app the tile comes back. You
 *    need to ACTUALLY disconnect."
 *
 * The reason a half-measure didn't work: a Concord source with an
 * empty inviteToken is treated as the install's "primary source" by
 * `useSourcesStore.bindToUser()`. `logout()` calls `bindToUser(null)`
 * which intentionally PRESERVES primary source rows (it just nulls
 * the ownerUserId). The whole point of preservation is so a docker
 * install's homeserver tile survives every logout — but it's exactly
 * the wrong behaviour when the user explicitly asked to disconnect
 * that source. On top of that, `useServerConfigStore.config` still
 * held the host, and on next launch `migrateFromSession` re-created
 * the primary source from that config. Tile came back.
 *
 * Full nuke (this version):
 *
 *   1. If the source matches the currently-active Matrix session
 *      (`source.userId === auth.userId`), run `logout()` so the
 *      matrix-js-sdk client stops syncing, the server cache is
 *      reset, and `concord_session` localStorage is cleared.
 *
 *   2. Call `removeSource(id)` unconditionally — preserves primary
 *      sources is the wrong behaviour for an explicit disconnect.
 *
 *   3. If the now-removed source's host equals the host stored in
 *      `useServerConfigStore.config`, clear that config too. Without
 *      this step, the next launch's `migrateFromSession()` resurrects
 *      a primary source row from the cached config and the tile is
 *      back as if nothing happened.
 *
 * After all three: the source is gone from every persisted layer.
 * Next launch starts clean.
 */

import { useAuthStore } from "../stores/auth";
import { useServerConfigStore } from "../stores/serverConfig";
import { useSourcesStore } from "../stores/sources";

export function disconnectSource(sourceId: string): void {
  const sources = useSourcesStore.getState();
  const source = sources.sources.find((s) => s.id === sourceId);
  if (!source) return;

  const auth = useAuthStore.getState();

  // 1) Tear down the live Matrix session if this source owns it.
  if (auth.userId && source.userId === auth.userId) {
    auth.logout();
  }

  // 2) Drop the source row unconditionally. logout() preserves
  //    primary sources via bindToUser; that's the wrong behaviour
  //    for an explicit disconnect.
  useSourcesStore.getState().removeSource(sourceId);

  // 3) If the persisted homeserver config points at the same host
  //    we just disconnected, clear it so `migrateFromSession()` on
  //    the next launch doesn't resurrect a primary source row from
  //    it. setServerUrl(\"\") inside clearHomeserver also flushes the
  //    in-process cache so any code path still reading the legacy
  //    `getHomeserverUrl()` sees an empty value.
  const config = useServerConfigStore.getState().config;
  if (config && config.host.toLowerCase() === source.host.toLowerCase()) {
    useServerConfigStore.getState().clearHomeserver();
  }
}
