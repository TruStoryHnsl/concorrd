/**
 * Home-server name API wrapper.
 *
 * The HOME server is the persistent local data layer described in the
 * 2026-06-01 CONSOLIDATED ARCHITECTURE filing. Its user-set name
 * (default `"home"`) lives in the `home_meta` table inside the
 * existing `porch.sqlite` and is surfaced through the two Tauri
 * commands wrapped here.
 *
 * Web builds have no home server (the porch.sqlite layer is desktop-
 * only), so both functions short-circuit. The zustand store treats
 * the resolved value as just the default string `"home"` in that
 * case and never attempts a write.
 */

import { isTauri } from "./servitude";

/** Resolve the home-server name. Returns the default `"home"` on web
 *  builds (which never speak to the native SQLite). */
export async function getHomeServerName(): Promise<string> {
  if (!isTauri()) {
    return "home";
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const value = await invoke<string>("home_get_server_name");
  return typeof value === "string" && value.trim().length > 0
    ? value
    : "home";
}

/** Persist a new user-set name for the home server. Native-only —
 *  rejects on web. Trims whitespace, throws if the trimmed input is
 *  empty or exceeds 64 chars (matching the Rust cap). */
export async function setHomeServerName(name: string): Promise<void> {
  if (!isTauri()) {
    throw new Error(
      "setHomeServerName: web builds cannot rename the home server — " +
        "the persistent SQLite layer is desktop-only.",
    );
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("home server name must not be empty");
  }
  if ([...trimmed].length > 64) {
    throw new Error("home server name must be 64 characters or fewer");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("home_set_server_name", { name: trimmed });
}
