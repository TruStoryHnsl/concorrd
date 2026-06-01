/**
 * disconnectSource — full teardown for a source connection.
 *
 * After multiple prior iterations of this function still left the
 * disconnected user persistently logged-in across app restarts, the
 * root cause was identified: matrix-js-sdk and our own per-userId
 * localStorage keys (`concord_orphan_cleanup_v1:<userId>`,
 * `concord_source_rail_order:<userId>`, `concord_last_channel:<userId>`,
 * `concord_server_order:<userId>`) survive `logout()`. Next launch,
 * the cached SDK state + the rail-order keys re-bind the user to the
 * very source they just disconnected from. Tile comes back, sync
 * resumes, the user is "still logged in."
 *
 * Full nuke (this version):
 *
 *   1. If the source matches the currently-active Matrix session,
 *      call `auth.logout()` so the matrix-js-sdk client stops syncing,
 *      the server cache is reset, and `concord_session` is removed.
 *
 *   2. Drop the source row unconditionally via `removeSource(id)` —
 *      bypasses the bindToUser primary-source preservation rule which
 *      is the wrong behaviour for an explicit disconnect.
 *
 *   3. If `useServerConfigStore.config.host` matches the disconnected
 *      source, clear it so `migrateFromSession()` on next launch
 *      doesn't resurrect the row from the cached config.
 *
 *   4. **Purge every per-userId localStorage key tied to this source.**
 *      Both matrix-js-sdk's internal `mxjssdk_*` cache AND every
 *      `concord_*:<userId>` rail/order/cleanup key go. Without this
 *      step the SDK's filter cache + our rail-order keys regenerate
 *      a logged-in shell on the next boot even though `concord_session`
 *      is gone.
 *
 *   5. Schedule a best-effort matrix-js-sdk IndexedDB drop. The SDK
 *      writes some state to IndexedDB ("matrix-js-sdk:crypto" etc.);
 *      delete those databases so a fresh sign-in on the same userId
 *      starts from zero.
 *
 * After all five: the source is gone from every persisted layer the
 * client controls. Next launch starts clean.
 */

import { useAuthStore } from "../stores/auth";
import { useServerConfigStore } from "../stores/serverConfig";
import { useSourcesStore } from "../stores/sources";

export function disconnectSource(sourceId: string): void {
  const sources = useSourcesStore.getState();
  const source = sources.sources.find((s) => s.id === sourceId);
  if (!source) return;

  const auth = useAuthStore.getState();
  const disconnectedUserId = source.userId ?? auth.userId ?? null;

  // 1) Tear down the live Matrix session if this source owns it.
  if (auth.userId && source.userId === auth.userId) {
    auth.logout();
  }

  // 2) Drop the source row unconditionally.
  useSourcesStore.getState().removeSource(sourceId);

  // 3) If the persisted homeserver config points at the same host
  //    we just disconnected, clear it so migrateFromSession() on the
  //    next launch doesn't resurrect a primary source row from it.
  const config = useServerConfigStore.getState().config;
  if (config && config.host.toLowerCase() === source.host.toLowerCase()) {
    useServerConfigStore.getState().clearHomeserver();
  }

  // 4) Purge per-userId localStorage keys. Both the matrix-js-sdk
  //    internal cache (`mxjssdk_*`) and our own per-user rail/order
  //    keys (`concord_<feature>:<userId>`) regenerate a logged-in
  //    shell on next launch if left alone. The disconnected userId
  //    is the only safe anchor for matching the per-user keys —
  //    other users' state must stay intact.
  if (typeof window !== "undefined" && window.localStorage) {
    const ls = window.localStorage;
    const toRemove: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      if (!key) continue;
      // Every matrix-js-sdk localStorage prefix the bug report could
      // possibly resurrect from:
      //   - `mxjssdk_*` — MemoryStore filter cache
      //   - `mx_pending_events_*` — send-queue replay state
      //   - `mx_oidc_*` — OIDC WebStorageStateStore
      //   - `concord_matrix_store_*` — IndexedDBStore's localStorage
      //     side-companion (see `client/src/api/matrix.ts::buildStoreKey`)
      // The native client is single-user so dropping every match is
      // safe; if the key carries a userId suffix we still scope it
      // to the disconnected user as a belt-and-suspenders.
      const isMatrixKey =
        key.startsWith("mxjssdk_") ||
        key.startsWith("mx_pending_events_") ||
        key.startsWith("mx_oidc_") ||
        key.startsWith("concord_matrix_store_");
      if (isMatrixKey) {
        if (!disconnectedUserId || key.includes(disconnectedUserId)) {
          toRemove.push(key);
        }
        continue;
      }
      // Per-user concord_*:<userId> keys (orphan cleanup, source
      // rail order, last channel, server order).
      if (
        disconnectedUserId &&
        key.startsWith("concord_") &&
        key.endsWith(`:${disconnectedUserId}`)
      ) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      ls.removeItem(key);
    }
  }

  // 5) Drop matrix-js-sdk's IndexedDB stores. The IndexedDBStore used
  //    by `client/src/api/matrix.ts::createMatrixClient` names each
  //    database `concord_matrix_store_<userId|homeserverUrl>` — that
  //    is the database with the room state, filters, and sync token
  //    that would otherwise rebuild a logged-in shell on the next
  //    launch. Also delete every legacy `matrix-js-sdk*` database
  //    (older client builds named them that way + crypto stores
  //    still do). Async/best-effort — failures are non-fatal and
  //    just mean a slightly larger re-fetch on next sign-in.
  if (typeof window !== "undefined" && window.indexedDB) {
    const idb = window.indexedDB;
    const knownDbs = [
      "matrix-js-sdk:crypto",
      "matrix-js-sdk:riot-web-sync",
      "matrix-js-sdk:default",
    ];
    const dropDb = (name: string) => {
      try {
        idb.deleteDatabase(name);
      } catch {
        // ignore — best-effort
      }
    };
    const isMatrixDb = (name: string) =>
      name.startsWith("matrix-js-sdk") ||
      name.startsWith("concord_matrix_store_");
    if (typeof idb.databases === "function") {
      idb
        .databases()
        .then((dbs) => {
          for (const db of dbs) {
            if (db.name && isMatrixDb(db.name)) {
              dropDb(db.name);
            }
          }
        })
        .catch(() => {
          for (const name of knownDbs) dropDb(name);
          if (disconnectedUserId) {
            dropDb(buildSyncDbName(disconnectedUserId, source.homeserverUrl));
          }
        });
    } else {
      for (const name of knownDbs) dropDb(name);
      if (disconnectedUserId) {
        dropDb(buildSyncDbName(disconnectedUserId, source.homeserverUrl));
      }
    }
  }
}

/**
 * Mirror of `client/src/api/matrix.ts::buildStoreKey`. Kept in sync
 * by hand — if the live createMatrixClient ever changes its dbName
 * scheme, this fallback must follow or the sync DB will leak through
 * a disconnect again. Reads identically: `userId|homeserverUrl` with
 * non-alphanumerics replaced by `_`, prefixed with
 * `concord_matrix_store_`.
 */
function buildSyncDbName(userId: string, homeserverUrl: string): string {
  const scope = `${userId}|${homeserverUrl}`.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return `concord_matrix_store_${scope}`;
}
