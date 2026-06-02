/**
 * Vanity instance-name API wrapper.
 *
 * The operator's vanity instance name has two jobs:
 *
 *   1. Replaces the "local" label on the source-rail home tile so the
 *      user sees their own name (e.g. "patio") at the top of the rail.
 *   2. Travels in the libp2p Identify protocol's `agent_version` so
 *      peers connecting to this device can confirm they reached the
 *      right one.
 *
 * Storage backs onto `ServitudeConfig.display_name`. An empty string
 * means "user has not picked a name yet" — the renderer shows the
 * default "local" label and the Identify agent_version omits the
 * vanity suffix.
 *
 * Native-only: rejects on the web build. Web docker stacks pick a
 * name at compose time via env vars (no runtime mutation surface).
 */

import { isTauri } from "./servitude";

export async function getInstanceName(): Promise<string> {
  if (!isTauri()) {
    throw new Error(
      "getInstanceName: web builds do not support runtime instance-name " +
        "management — the docker stack picks a label at compose time.",
    );
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const value = await invoke<string>("get_instance_name");
  return typeof value === "string" ? value : "";
}

export async function setInstanceName(name: string): Promise<void> {
  if (!isTauri()) {
    throw new Error(
      "setInstanceName: web builds cannot change the instance name — " +
        "the docker stack fixes it at compose time.",
    );
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_instance_name", { name });
}
