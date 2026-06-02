/**
 * Home-server vanity-name API wrapper (F4 / F1b shared surface).
 *
 * The "home" server is the persistent default Concord server hosted by
 * the local instance — the user's actual data (channels, voice rooms,
 * applications, custom UI). Its name is separate from the source-rail
 * label (which is `instanceName` — what peers see when they reach this
 * device). On a fresh install the home server's name defaults to
 * `"home"` and the user picks a vanity (e.g. "patio", "kitchen").
 *
 * F1b-IMPL will add the backing Tauri command + persistence. Until that
 * lands, this wrapper:
 *
 *   - calls `home_set_server_name` / `home_get_server_name` if the
 *     backend exposes them (post-F1b merge: no behaviour change),
 *   - silently no-ops if the command isn't registered yet, so F4's
 *     banner ships standalone without crashing the app on Save.
 *
 * The detection is at call time, not import time, so once F1b lands the
 * existing builds pick it up on next launch without a client rebuild.
 *
 * Native-only: rejects on the web build for symmetry with the instance
 * name API. Web docker stacks fix the home name at compose time.
 */

import { isTauri } from "./servitude";

/** Tauri error string substring that means "command not registered". */
const NOT_REGISTERED_MARKERS = [
  "not allowed",
  "not found",
  "unknown command",
  "command not found",
];

function isCommandMissingError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return NOT_REGISTERED_MARKERS.some((m) => msg.includes(m));
}

export async function getHomeServerName(): Promise<string> {
  if (!isTauri()) {
    throw new Error(
      "getHomeServerName: web builds do not support runtime home-server " +
        "name management — the docker stack picks a label at compose time.",
    );
  }
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const value = await invoke<string>("home_get_server_name");
    return typeof value === "string" ? value : "";
  } catch (e) {
    if (isCommandMissingError(e)) {
      // F1b-IMPL not merged yet — treat as "no value set". The banner
      // will still render and Save will best-effort write through to
      // the same missing command (also gracefully no-op).
      return "";
    }
    throw e;
  }
}

export async function setHomeServerName(name: string): Promise<void> {
  if (!isTauri()) {
    throw new Error(
      "setHomeServerName: web builds cannot change the home-server name — " +
        "the docker stack fixes it at compose time.",
    );
  }
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("home_set_server_name", { name });
  } catch (e) {
    if (isCommandMissingError(e)) {
      // F1b-IMPL not merged yet — the in-memory store still updates
      // for the rest of the session so the user sees their chosen
      // name reflected immediately. Persistence kicks in once F1b
      // lands.
      return;
    }
    throw e;
  }
}
