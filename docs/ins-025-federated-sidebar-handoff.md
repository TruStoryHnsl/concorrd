# INS-025 Federated Sidebar — Status & Handoff

**Date**: 2026-04-09
**Status**: Dropped for later — core UX works but UX rough edges and edge cases remain
**Last commit on this thread**: `cb084ff` — "fix(client): wire federated hydration into useMatrixSync + auto-backfill empty rooms"

## What this feature is

Surfacing joined federated Matrix rooms (rooms on other homeservers, reached via Matrix federation — `mozilla.org`, `matrix.org`, friend-run instances) in the Concord sidebar alongside Concord-managed servers. The user's mental model is **one federated homeserver = one sidebar tile**, with the individual rooms on that homeserver appearing as channels under the tile.

Follow-on to INS-025 (Federated Server Explore Menu). The Explore modal shipped; this thread was about what happens *after* the user clicks Join on a federated public room.

## What is working

| Capability | Status | Notes |
|---|---|---|
| Explore modal → browse public rooms on a federated host | **Working** | `client/src/components/server/ExploreModal.tsx` |
| Joining a public room over federation | **Working** | Uses `client.joinRoom(id, {viaServers: [domain]})`. Parent-space walk also auto-joins any advertised `m.space.parent`. |
| Federated rooms rendered as synthetic sidebar tiles | **Working** | `hydrateFederatedRooms()` in `client/src/stores/server.ts`. Tiles have a distinct tertiary-color palette + globe badge. |
| Persistent federated-instance catalog across reloads | **Working** | `client/src/stores/federatedInstances.ts` — Zustand persist-middleware-backed. Survives page refresh + logout. |
| `.well-known/concord/client` probe to detect other Concord instances | **Working** | Concord-on-Concord tiles get a secondary-color palette + "C" badge instead of the generic globe. |
| Search filter over federated instances | **Working** | `filterInstances()` in the catalog store, wired to the sidebar. |
| Sidebar scroll overflow | **Working** | Fixed with `[&>*]:shrink-0` arbitrary Tailwind selector. |
| Explore button positioned at bottom of sidebar | **Working** | Natural flow, no flex-1 spacer. |
| Orphan-room cleanup (ghosts from deleted Concord servers) | **Working** | `leaveOrphanRooms()` gated behind a per-user localStorage flag — runs at most once per user per browser. |
| Clicking a tile auto-selects its first channel | **Working** | `handleServerClick()` in `ServerSidebar.tsx`. |
| Federated hydration runs on page load (not only after Explore) | **Working** | Moved to `useMatrixSync` in `cb084ff`. Was dead code in `useRooms()` before. |
| Fresh-join rooms auto-backfill history | **Working** | Added in `cb084ff` — `useRoomMessages` fires one eager `paginateEventTimeline({backwards: true, limit: 50})` when the live timeline is empty on room-open. |
| 104 unit tests | **Passing** | `client/src/stores/__tests__/server.test.ts` covers both space-aware and homeserver grouping passes. |

## Known-rough edges (not yet verified in live testing)

These were implemented but not visually confirmed working end-to-end on the deployed build before dropping:

1. **Stale "Add-ons" catalog displayName** — `recordSeen()` now prefers caller metadata → confirmed-Concord existing displayName → hostname fallback. `hydrateFederatedRooms` no longer passes displayName into `recordSeen` at all. The next hydration pass on a browser that has the stale "Add-ons" entry cached should overwrite it with `mozilla.org`. **Needs live confirmation** that the old entry actually gets clobbered.

2. **Empty-timeline auto-backfill** — the fix in `cb084ff` fires a scrollback on the first effect run when `room.getLiveTimeline().getEvents().length === 0`. Cancellation guard prevents a slow backfill from clobbering state if the user moves to another room. **Needs live confirmation**: click a federated channel, wait ~1s, messages should appear. If the backfill fails, the console should log `Initial scrollback failed for <roomId>:`.

3. **StrictMode sync crash** — `client.stopClient()` was removed from `useMatrixSync` cleanup to avoid a matrix-js-sdk 41.0.0-rc.0 bug where `callEventHandler` gets set to undefined on the second React-StrictMode effect run and the sync listener crashes. **Verified working** in the previous round of testing, but worth re-verifying after `cb084ff` since that commit touched `useMatrixSync`.

## Known open problems

1. **Joining a space with no joined children produces no sidebar tile.**
   `hydrateFederatedRooms` Pass 3a skips spaces whose joined-children count is zero (`if (channels.length === 0) continue`). Pass 3b filters out spaces via the `regularRooms` split. So a user who joined only the parent space (e.g. `#mozilla:mozilla.org` as a space) with no children joined sees nothing in the sidebar. **Possible fix**: render an empty space as a single-channel tile whose lone channel IS the space's own `roomId`, even though spaces have no message timeline. Or: auto-join the first few children when joining a space.

2. **Parent-space join race (600ms hard-coded delay).**
   `ExploreModal.joinRoom` calls `client.joinRoom(parentId, ...)` fire-and-forget, then waits 600ms before calling `hydrateFederatedRooms`. The delay is a guess — on a slow link the parent's state events won't have propagated in 600ms and Pass 2a/2b classification misses them, falling through to Pass 3b homeserver grouping. Not broken, just suboptimal naming. **Fix**: wait on a `ClientEvent.Room` fire for the parent roomId instead of a fixed timer.

3. **`peek` vs `join` for browsing.**
   The current Explore flow requires the user to actually JOIN a room before they can see its content. There is no "peek" (read-only browse without membership). This means joining a federated room leaves a permanent membership trail on the remote homeserver. Not a bug — intentional for v1 — but worth considering later.

4. **Federated tile ordering is unstable across browsers.**
   `new Map` iteration order = insertion order, which depends on `client.getRooms()` return order, which matrix-js-sdk does not guarantee to be stable. The user has drag-reorder persistence (`concord_server_order:<userId>` in localStorage, INS-002B) for Concord servers, but federated synthetic IDs (`federated:homeserver:<host>`) aren't in that list until the user drags them. On a fresh login they appear in whatever order matrix-js-sdk happens to hand them over.

5. **Tile click on a space-based Pass 3a entry.**
   Auto-select-first-channel works, but if the user clicks a Pass 3a synthetic whose only channel is a deep child of a space, the timeline backfill might hit 0 results if the child is private / access-controlled on the remote. There's no "you don't have access" UX — it just silently looks empty. Same surface as #1.

6. **No explicit leave-a-federated-room flow.**
   The user can join but has no in-UI way to leave a federated synthetic server. `leaveOrphanRooms` will clean them up only if they're on the LOCAL homeserver (explicit domain-suffix check), so federated rooms are excluded from the cleanup pass by design. Need a proper "Leave" menu item on federated tiles.

## Architecture summary

### Three-pass classifier in `hydrateFederatedRooms` (`client/src/stores/server.ts`)

```
Pass 1: split joined federated rooms into `spaces` vs `regularRooms`
        (room.getType() === "m.space" vs not)

Pass 2a: for each joined space, read m.space.child state events
         → parentIdToChildren map

Pass 2b: for each regular room, read m.space.parent state events
         → add to parentIdToChildren even if parent isn't joined

Pass 3a: build one synthetic server per (parent id → joined children)
         group; skip empty parents; use joined-space name if available

Pass 3b: FALLBACK — every regular room that wasn't placed under a space
         gets grouped by its homeserver domain. One tile per unique
         host. Channel order sorted alphabetically for stability.
```

The Pass 3b fallback was added because Mozilla and most public Matrix hosts publish their public rooms as a **flat list**, not as Matrix spaces. Without Pass 3b, joining 5 Mozilla rooms produced 5 sidebar tiles instead of one "mozilla.org" tile.

### Persistent catalog (`client/src/stores/federatedInstances.ts`)

Zustand store with persist middleware, keyed by hostname. Records:
- `displayName` — from well-known probe for Concord hosts, else hostname
- `isConcord` — true if `.well-known/concord/client` returned a valid payload with an `api_base` field
- `status` — `live` | `stale` | `unreachable` | `unknown`
- `lastSeenTs`, `livekitUrl`, `features`

Catalog is populated by:
- `recordSeen(host)` — called for each unique host seen in `hydrateFederatedRooms`
- `probeConcordHost(host)` — fetches `.well-known/concord/client` once per session, called from `useMatrixSync` after each hydration pass

### Where hydration gets kicked

Only place now: `useMatrixSync` in `client/src/hooks/useMatrix.ts`.
- Listens on `ClientEvent.Sync` + `ClientEvent.Room`
- De-dupes via `prevIdsSig` signature string so it only re-hydrates on actual joined-room-set changes
- Also fires once immediately on mount in case matrix-js-sdk has cached rooms from a prior session
- `ExploreModal.joinRoom` still calls `hydrateFederatedRooms` directly as a belt-and-braces explicit kick after a join, to avoid a race on the sync tick timing

## Files touched (cumulative, this thread)

- `client/src/stores/server.ts` — Three-pass classifier, homeserver grouping fallback, `leaveOrphanRooms`
- `client/src/stores/federatedInstances.ts` — Persistent catalog, `.well-known/concord/client` probe, `recordSeen` displayName resolution
- `client/src/hooks/useMatrix.ts` — Moved federated hydration into `useMatrixSync`, added initial-scrollback auto-backfill in `useRoomMessages`, removed `stopClient()` from cleanup (StrictMode fix)
- `client/src/components/layout/ServerSidebar.tsx` — Tertiary/secondary palette tiles, globe/C badges, Explore button at bottom, search filter, `handleServerClick` auto-select first channel, `[&>*]:shrink-0` scroll overflow fix
- `client/src/components/server/ExploreModal.tsx` — Parent-space auto-join after regular-room join, 600ms propagation wait
- `client/src/App.tsx` — Orphan-room cleanup effect (gated by `concord_orphan_cleanup_v1:<userId>` localStorage flag)
- `client/src/stores/__tests__/server.test.ts` — Coverage for homeserver grouping, 104 tests passing

## Follow-on work when picking this back up

Priority order (subjective):

1. **Verify live** — load the deployed build, look for:
   - stale "Add-ons" tile being replaced by "mozilla.org" on first sync
   - federated channel opens → messages appear within ~1s (not "No messages yet")
   - clicking a tile after reload actually changes the chat view

2. **Fix the space-with-no-joined-children dead tile** (open problem #1) — most likely approach: when ExploreModal joins a space, also auto-join the first N children advertised by `m.space.child` state events. Or render the space as its own single channel even when empty.

3. **Replace the 600ms hardcoded delay** (open problem #2) with an event-based wait.

4. **Add a Leave menu item** on federated tiles (open problem #6).

5. **Drag-reorder integration** — figure out how federated synthetic IDs should interact with INS-002B's `concord_server_order:<userId>` persistence. Probably just: if the saved order lacks a federated tile, append it at the end; if it has it, honour the stored position. Test that deletion of a federated room (leave) correctly evicts it from the stored order.

6. **Visual regression pass** — the federated-tile design has not been reviewed against the Material 3 palette at the top level of the sidebar. Tertiary + secondary palettes read OK in isolation but might clash with the primary-glow of Concord tiles.

## Why we're dropping it now

The core feature works — federated tiles render, clicking them works, messages backfill on first open. What remains is verification, polish, and edge cases that do not block using the feature day-to-day. Higher-priority work is the INS-028 GitHub Bug Report Integration per `PLAN.md`.

This doc is the handoff. To resume: read it, read `client/src/stores/server.ts` (the classifier), then re-run `npm test` from `client/` to confirm the 104-test baseline before making changes.
