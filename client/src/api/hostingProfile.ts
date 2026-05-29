/**
 * Hosting / deployment profile API wrapper (Phase 7 — native default
 * profile).
 *
 * Two surfaces talk to the same persisted profile from different sides:
 *
 *   - Native (Tauri): the {@link getServitudeProfile} /
 *     {@link setServitudeProfile} Tauri commands flip the value in the
 *     servitude settings store. Next `servitude_start` materializes the
 *     new transport set.
 *   - Web (docker): the same profile is reported by
 *     `GET /api/hosting/profile` and is read-only — the docker stack
 *     fixes it via the `CONCORD_PROFILE` env var, so the toggle on the
 *     web build is informational only.
 *
 * This module wraps both surfaces with one TS-facing API. Consumers
 * call {@link fetchHostingProfile} to learn what state the toggle is in
 * and {@link setHostingProfile} to flip it; the wrapper picks the right
 * transport (Tauri command vs HTTP) based on {@link isTauri}.
 *
 * Mirrors the convention established by `peerStore.ts` /
 * `peerIdentity.ts`: explicit field-by-field copy at the IPC boundary so
 * a hypothetical future backend leak (a secret-shaped field that doesn't
 * belong) is silently dropped rather than propagated.
 */

import { isTauri } from "./servitude";

/**
 * Deployment profile wire form. Matches the Rust ``Profile`` enum
 * (`#[serde(rename_all = "snake_case")]`) and the FastAPI
 * `HostingProfileResponse.profile` literal.
 */
export type DeploymentProfile = "p2p_only" | "web_first";

/**
 * Frontend-facing snapshot of `/api/hosting/profile`. Used by the
 * Settings → Profile section to render the toggle state + helper
 * panel.
 */
export interface HostingProfileSnapshot {
  /** The active profile. Defaults to ``p2p_only`` for fresh installs. */
  profile: DeploymentProfile;
  /**
   * Whether the docker web stack (Caddy / LiveKit / coturn / sslh,
   * conduwuit, the API container) is actually running right now.
   * Heuristic on the backend — see ``/api/hosting/profile`` docstring.
   */
  webStackRunning: boolean;
  /**
   * ISO 8601 timestamp of the last time the profile changed. ``null``
   * until something flips it. The backend reserves this field but
   * doesn't populate it yet; kept in the TS shape so consumers can
   * adopt the value when it lands without an API contract bump.
   */
  lastChanged: string | null;
}

/**
 * Response shape from `POST /api/hosting/profile/enable_web_stack`.
 * Mirrors the FastAPI `EnableWebStackResponse` model.
 */
export interface EnableWebStackResult {
  profile: DeploymentProfile;
  webStackRunning: boolean;
  /** Raw voice-subsystem health snapshot (mirrors `/api/hosting/status`). */
  voice: Record<string, unknown>;
  /** Container short-IDs that transitioned from stopped to running. */
  startedServices: string[];
  /** Container short-IDs that were already running pre-call. */
  alreadyRunningServices: string[];
  /** Operator-facing message (e.g. "Web stack already running"). */
  message: string | null;
}

interface RawHostingProfileSnapshot {
  profile: DeploymentProfile;
  web_stack_running: boolean;
  last_changed: string | null;
}

interface RawEnableWebStackResponse {
  profile: DeploymentProfile;
  web_stack_running: boolean;
  voice: Record<string, unknown>;
  started_services: string[];
  already_running_services: string[];
  message: string | null;
}

function snapshotFromRaw(
  raw: RawHostingProfileSnapshot,
): HostingProfileSnapshot {
  return {
    profile: raw.profile,
    webStackRunning: Boolean(raw.web_stack_running),
    lastChanged: raw.last_changed ?? null,
  };
}

function enableResultFromRaw(
  raw: RawEnableWebStackResponse,
): EnableWebStackResult {
  return {
    profile: raw.profile,
    webStackRunning: Boolean(raw.web_stack_running),
    voice: { ...raw.voice },
    startedServices: [...raw.started_services],
    alreadyRunningServices: [...raw.already_running_services],
    message: raw.message ?? null,
  };
}

/**
 * Read the current deployment profile and web-stack running state.
 *
 * Native: invokes the Tauri command to read the persisted servitude
 * config (the env-override-aware path). The web-stack heuristic is
 * not available native-side so we report ``webStackRunning=false`` —
 * native instances don't run a docker stack by definition.
 *
 * Web: fetches `/api/hosting/profile` for the full picture.
 */
export async function fetchHostingProfile(): Promise<HostingProfileSnapshot> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const profile = await invoke<DeploymentProfile>(
      "get_servitude_profile",
    );
    return {
      profile,
      // Native builds don't run docker-compose; the web stack is
      // never "running" from a native install's perspective. The
      // Settings UI doesn't render the Phase-0 panel on native
      // anyway — toggling the profile is what triggers it.
      webStackRunning: false,
      lastChanged: null,
    };
  }
  const resp = await fetch("/api/hosting/profile", {
    credentials: "include",
  });
  if (!resp.ok) {
    throw new Error(
      `GET /api/hosting/profile returned ${resp.status}: ${await resp.text()}`,
    );
  }
  const raw = (await resp.json()) as RawHostingProfileSnapshot;
  return snapshotFromRaw(raw);
}

/**
 * Flip the deployment profile.
 *
 * Native: persists the new value via the Tauri command. The next
 * `servitude_start` materializes the new transport set; the caller is
 * responsible for triggering that follow-up.
 *
 * Web: rejects — the docker stack owns its profile through the
 * `CONCORD_PROFILE` env var and the web UI cannot modify it. The
 * Settings section renders the toggle disabled when running on the
 * web build for this reason, but the wrapper guards against a stray
 * call too.
 */
export async function setHostingProfile(
  profile: DeploymentProfile,
): Promise<void> {
  if (!isTauri()) {
    throw new Error(
      "setHostingProfile: web builds cannot change the profile — " +
        "this instance is configured via the CONCORD_PROFILE env var " +
        "on the docker stack.",
    );
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_servitude_profile", { profile });
}

/**
 * Tell the backend to start the docker web stack. Web-build only —
 * the operator who can flip a docker stack from p2p_only to
 * web_first IS the operator running the web UI behind it. Native
 * installs that flip the toggle do so via {@link setHostingProfile}
 * and the next servitude restart.
 *
 * Rejects if not admin (HTTP 403) or if every service start fails
 * (HTTP 503 — error_code DOCKER_PROXY_UNAVAILABLE).
 */
export async function enableWebStack(): Promise<EnableWebStackResult> {
  const resp = await fetch("/api/hosting/profile/enable_web_stack", {
    method: "POST",
    credentials: "include",
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `POST /api/hosting/profile/enable_web_stack returned ${resp.status}: ${body}`,
    );
  }
  const raw = (await resp.json()) as RawEnableWebStackResponse;
  return enableResultFromRaw(raw);
}
