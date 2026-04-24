/**
 * Embedded servitude control surface.
 *
 * Thin wrapper around the three Tauri commands exposed by `src-tauri/src/lib.rs`:
 *   - servitude_start: loads config from the store, constructs/reuses the
 *     `ServitudeHandle`, drives the lifecycle to Running.
 *   - servitude_stop: drives the lifecycle from Running back to Stopped.
 *   - servitude_status: returns a JSON-serialized `LifecycleState` string.
 *
 * All three are only available when the app runs inside the Tauri shell.
 * In a plain browser build (Vite dev server, deployed web UI) the `invoke`
 * import is dynamic so the file is safe to import from components rendered
 * in both environments.
 *
 * The Rust side is specified in `src-tauri/src/servitude/mod.rs` — see also
 * `src-tauri/src/lib.rs` for the command registrations.
 */

/**
 * Whether we are running inside the Tauri desktop/mobile shell.
 *
 * Kept as a function (not a module-level const) so tests can flip the
 * underlying global without needing to reset module state.
 */
export function isTauri(): boolean {
  // `__TAURI_INTERNALS__` is the canonical Tauri v2 global; see the
  // comment in `serverUrl.ts` for the full explanation of why the v1
  // `__TAURI__` key was wrong.
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Servitude lifecycle states, mirrored from `LifecycleState` in
 * `src-tauri/src/servitude/lifecycle.rs`. The Rust enum is
 * `#[serde(rename_all = "snake_case")]`, so the wire form is the
 * lowercase string.
 */
export type ServitudeState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping";

/**
 * Full status response from `servitude_status` (INS-024 Wave 4).
 * Contains the lifecycle state plus the degraded transports map from
 * Wave 3's partial-failure surface — any transport that started but
 * then entered a non-critical failure state shows up here.
 */
export interface ServitudeStatusResponse {
  state: ServitudeState;
  degraded_transports: Record<string, string>;
}

/**
 * Type guard for the four known lifecycle states. Anything else coming off
 * the wire is treated as an unknown/invalid state at the call site.
 */
export function isServitudeState(value: unknown): value is ServitudeState {
  return (
    value === "stopped" ||
    value === "starting" ||
    value === "running" ||
    value === "stopping"
  );
}

function isServitudeStatusResponse(value: unknown): value is ServitudeStatusResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isServitudeState(v.state) &&
    typeof v.degraded_transports === "object" &&
    v.degraded_transports !== null
  );
}

/**
 * Start the embedded servitude module.
 *
 * Rejects with `Error("not-in-tauri")` when called from a browser build —
 * the caller is expected to guard with {@link isTauri} first, but the
 * explicit error code exists so UI code can treat the browser case as a
 * "nothing to toggle" state instead of a failure.
 */
export async function servitudeStart(): Promise<void> {
  if (!isTauri()) {
    throw new Error("not-in-tauri");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("servitude_start");
}

/**
 * Stop the embedded servitude module. Same browser-guard semantics as
 * {@link servitudeStart}.
 */
export async function servitudeStop(): Promise<void> {
  if (!isTauri()) {
    throw new Error("not-in-tauri");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("servitude_stop");
}

/**
 * Poll the current lifecycle state and degraded transports.
 *
 * INS-024 Wave 4: the return shape is now a `ServitudeStatusResponse`
 * with `state` (lifecycle string) and `degraded_transports` (map of
 * transport name → failure reason).
 *
 * Returns `{ state: "stopped", degraded_transports: {} }` in the browser
 * build — the "no Tauri runtime" case is indistinguishable from the
 * "handle not yet constructed" case on the Rust side.
 *
 * The Rust command may return either a plain lifecycle string (legacy,
 * pre-Wave-3) or the full `{ state, degraded_transports }` object
 * (Wave-3+). Both are handled for backward compatibility during rollout.
 */
export async function servitudeStatus(): Promise<ServitudeStatusResponse> {
  if (!isTauri()) {
    return { state: "stopped", degraded_transports: {} };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<string>("servitude_status");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`servitude_status returned non-JSON payload: ${raw}`);
  }
  // Wave-3+ response: full object with state + degraded_transports.
  if (isServitudeStatusResponse(parsed)) {
    return parsed;
  }
  // Legacy response: plain lifecycle string.
  if (isServitudeState(parsed)) {
    return { state: parsed, degraded_transports: {} };
  }
  throw new Error(`servitude_status returned unknown payload: ${raw}`);
}
