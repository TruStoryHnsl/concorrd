/**
 * Discord bridge control surface.
 *
 * Two paths:
 *
 * 1. Native (Tauri): typed wrappers around Tauri bridge commands
 *    (`src-tauri/src/bridge_commands.rs`). For standalone Concord installs.
 *
 * 2. Web / Docker: typed wrappers around the Concord API HTTP endpoints
 *    (`/api/admin/bridges/discord/*`). For the docker-compose deployment.
 *    Uses the same admin-gated REST surface as the server's bridge management
 *    (admin_bridges.py).
 */

import { getApiBase } from "./serverUrl";
import { isTauri } from "./servitude";

// ---------------------------------------------------------------------------
// HTTP API types (docker / web path)
// ---------------------------------------------------------------------------

export interface HttpBridgeStatus {
  enabled: boolean;
  appservice_id: string | null;
  sender_mxid_localpart: string | null;
  user_namespace_regex: string | null;
  alias_namespace_regex: string | null;
  registration_file_path: string | null;
}

export interface HttpBridgeMutationStep {
  name: string;
  status: "ok" | "skipped" | "failed";
  detail: string | null;
}

export interface HttpBridgeMutationResponse {
  action: "enable" | "disable" | "rotate";
  ok: boolean;
  steps: HttpBridgeMutationStep[];
  message: string;
}

async function bridgeApiFetch<T>(
  path: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const resp = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...((options.headers as Record<string, string>) ?? {}),
    },
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: resp.statusText }));
    const message =
      typeof err.detail === "string"
        ? err.detail
        : err.error ?? "API error";
    throw new Error(message);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// HTTP bridge API (docker / web)
// ---------------------------------------------------------------------------

export async function discordBridgeHttpStatus(
  accessToken: string,
): Promise<HttpBridgeStatus> {
  return bridgeApiFetch<HttpBridgeStatus>(
    "/admin/bridges/discord/status",
    accessToken,
  );
}

export async function discordBridgeHttpEnable(
  accessToken: string,
): Promise<HttpBridgeMutationResponse> {
  return bridgeApiFetch<HttpBridgeMutationResponse>(
    "/admin/bridges/discord/enable",
    accessToken,
    { method: "POST", body: "{}" },
  );
}

export async function discordBridgeHttpDisable(
  accessToken: string,
): Promise<HttpBridgeMutationResponse> {
  return bridgeApiFetch<HttpBridgeMutationResponse>(
    "/admin/bridges/discord/disable",
    accessToken,
    { method: "POST", body: "{}" },
  );
}

export async function discordBridgeHttpRotate(
  accessToken: string,
): Promise<HttpBridgeMutationResponse> {
  return bridgeApiFetch<HttpBridgeMutationResponse>(
    "/admin/bridges/discord/rotate",
    accessToken,
    { method: "POST", body: "{}" },
  );
}

/**
 * Bridge status shape returned by `discord_bridge_status`.
 * Matches `BridgeStatus` in `src-tauri/src/bridge_commands.rs`.
 */
export interface BridgeStatus {
  has_bot_token: boolean;
  lifecycle: string;
  degraded_transports: Record<string, string>;
  bridge_enabled: boolean;
  binary_available: boolean;
  bwrap_available: boolean;
}

/**
 * Store a Discord bot token. The Rust side writes it into the bridge's
 * config.yaml and generates cryptographically random AS tokens.
 *
 * The token is validated for basic shape (non-empty, 30-200 chars) on
 * the Rust side. The frontend should also validate before calling to
 * give the user immediate feedback.
 */
export async function discordBridgeSetBotToken(token: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("not-in-tauri");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("discord_bridge_set_bot_token", { token });
}

/**
 * Enable the Discord bridge transport in the servitude config.
 * Requires a bot token to be stored first.
 */
export async function discordBridgeEnable(): Promise<void> {
  if (!isTauri()) {
    throw new Error("not-in-tauri");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("discord_bridge_enable");
}

/**
 * Disable the Discord bridge transport. Does NOT remove the stored
 * bot token — the user can re-enable without re-entering it.
 */
export async function discordBridgeDisable(): Promise<void> {
  if (!isTauri()) {
    throw new Error("not-in-tauri");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("discord_bridge_disable");
}

/**
 * Poll the current Discord bridge status. Returns a default "no bridge"
 * status in browser mode.
 */
export async function discordBridgeStatus(): Promise<BridgeStatus> {
  if (!isTauri()) {
    return {
      has_bot_token: false,
      lifecycle: "stopped",
      degraded_transports: {},
      bridge_enabled: false,
      binary_available: false,
      bwrap_available: false,
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<BridgeStatus>("discord_bridge_status");
}

/**
 * Download the mautrix-discord binary from GitHub releases if not
 * already available. Returns the path to the binary.
 */
export async function discordBridgeEnsureBinary(): Promise<string> {
  if (!isTauri()) {
    throw new Error("not-in-tauri");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<string>("discord_bridge_ensure_binary");
}

/**
 * Enable the Discord bridge AND restart servitude so it actually starts.
 * One-click flow: downloads binary if needed, checks bwrap, enables
 * the transport, and restarts servitude.
 */
export async function discordBridgeEnableAndStart(): Promise<void> {
  if (!isTauri()) {
    throw new Error("not-in-tauri");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("discord_bridge_enable_and_start");
}

/**
 * Discord guild returned by the provisioning API.
 */
export interface DiscordGuild {
  id: string;
  name: string;
  icon: string;
  mxid: string;
  bridged: boolean;
}

/**
 * List Discord guilds the connected user has access to.
 * Requires the bridge to be running with provisioning API enabled.
 */
export async function discordBridgeListGuilds(): Promise<DiscordGuild[]> {
  if (!isTauri()) {
    throw new Error("not-in-tauri");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<DiscordGuild[]>("discord_bridge_list_guilds");
}

/**
 * Bridge a specific Discord guild by ID. Creates Matrix rooms
 * for all channels in the guild.
 */
export async function discordBridgeGuild(guildId: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("not-in-tauri");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("discord_bridge_guild", { guildId });
}

/**
 * Unbridge a Discord guild by ID. Removes the Matrix rooms.
 */
export async function discordBridgeUnbridgeGuild(guildId: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("not-in-tauri");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("discord_bridge_unbridge_guild", { guildId });
}
