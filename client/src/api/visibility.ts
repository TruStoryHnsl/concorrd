/**
 * Visibility API wrapper (F-VIS — per-server mesh-hop visibility).
 *
 * Thin wrapper around the `visibility_get_server` / `visibility_set_server`
 * Tauri commands exposed by `src-tauri/src/lib.rs`. The Rust side persists
 * the per-server `max_hops` ceiling in the `visibility_meta` SQLite table
 * (schema v9) and broadcasts the change over the F3 gossipsub mesh.
 *
 * Wire shape: the backend already uses camelCase via `#[serde(rename_all)]`
 * (see `VisibilityRowPublic`), so this wrapper only maps the field names
 * 1:1 and validates `maxHops` at the surface so the renderer never sends
 * a value the Rust side will reject.
 *
 * Defence-in-depth: same pattern as `peerStore.ts` — fields are copied
 * explicitly (NOT spread) so any future accidental field expansion on
 * the backend gets dropped here rather than leaking into UI state.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * Server identifiers used by the `visibility_meta` table. The two
 * intrinsic servers ("porch" + "home") are hard-coded here so the UI
 * doesn't have to import them from elsewhere; future user-created
 * servers will surface as UUID strings the renderer fetches from a
 * server-list endpoint.
 *
 * Kept in sync with `src-tauri/src/porch/db.rs::VISIBILITY_SERVER_ID_*`.
 */
export const VISIBILITY_SERVER_ID_PORCH = "porch";
export const VISIBILITY_SERVER_ID_HOME = "home";

/**
 * One row of the `visibility_meta` table — what the renderer needs to
 * render the per-server visibility slider.
 */
export interface VisibilityRow {
  serverId: string;
  /** 0..=255. 0 = owner only. */
  maxHops: number;
  /** unix-ms timestamp of the most recent change. */
  lastChangedAt: number;
}

/**
 * Hard cap matching the Rust-side u8 ceiling. Keep in sync with the
 * application-layer validation in `Porch::set_visibility`.
 */
export const VISIBILITY_MAX_HOPS_CEILING = 255;

interface RawVisibilityRow {
  serverId: string;
  maxHops: number;
  lastChangedAt: number;
}

function fromRaw(raw: RawVisibilityRow): VisibilityRow {
  return {
    serverId: raw.serverId,
    maxHops: raw.maxHops,
    lastChangedAt: raw.lastChangedAt,
  };
}

/**
 * Read a single server's visibility row. Returns `null` for an unknown
 * server id so callers can distinguish "no such server" from "the
 * default (max_hops=0)" — the renderer uses this to decide whether to
 * show a "create server" affordance vs. a slider.
 */
export async function fetchVisibility(
  serverId: string,
): Promise<VisibilityRow | null> {
  const raw = await invoke<RawVisibilityRow | null>("visibility_get_server", {
    serverId,
  });
  return raw === null ? null : fromRaw(raw);
}

/**
 * Persist a new max-hops value for `serverId`. The Rust side validates
 * the integer fits in u8 (0..=255) and rejects empty server ids; we
 * surface a friendlier error here for the common "negative number"
 * mistake the slider can't actually produce but a programmatic caller
 * might.
 */
export async function setVisibility(
  serverId: string,
  maxHops: number,
): Promise<VisibilityRow> {
  if (!Number.isInteger(maxHops)) {
    throw new Error(`maxHops must be an integer, got ${maxHops}`);
  }
  if (maxHops < 0 || maxHops > VISIBILITY_MAX_HOPS_CEILING) {
    throw new Error(
      `maxHops must be in 0..=${VISIBILITY_MAX_HOPS_CEILING}, got ${maxHops}`,
    );
  }
  const raw = await invoke<RawVisibilityRow>("visibility_set_server", {
    serverId,
    maxHops,
  });
  return fromRaw(raw);
}
