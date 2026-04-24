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
  bot_token_configured: boolean;
  appservice_id: string | null;
  sender_mxid_localpart: string | null;
  user_namespace_regex: string | null;
  alias_namespace_regex: string | null;
  registration_file_path: string | null;
  /**
   * Human-readable description of a broken state when registration.yaml
   * and tuwunel.toml disagree, or when stale registrations from previous
   * builds are still present. Null when everything is consistent.
   * When non-null, the UI should surface a "Reset to clean state" button.
   */
  desync: string | null;
  /**
   * All concord-prefixed appservice IDs currently registered with the
   * homeserver. More than one entry, or an entry that doesn't match
   * `appservice_id`, indicates a desync.
   */
  stale_appservice_ids: string[];
}

export interface HttpBridgeMutationStep {
  name: string;
  status: "ok" | "skipped" | "failed";
  detail: string | null;
}

export interface HttpBridgeMutationResponse {
  // The mutation response shape predates the user-scoped redesign. Kept
  // because /bot-token / /bot-profile still return it for voice-bridge
  // callers. The action literals enable/disable/rotate/force_reset were
  // removed along with their endpoints in PR4.
  action: string;
  ok: boolean;
  steps: HttpBridgeMutationStep[];
  message: string;
}

export interface DiscordVoiceBridgeRoom {
  id: number;
  server_id: string;
  channel_id: number;
  matrix_room_id: string;
  discord_guild_id: string;
  discord_channel_id: string;
  enabled: boolean;
  // W4: video bridge expansion fields
  video_enabled: boolean;
  projection_policy: "screen_share_first" | "active_speaker";
  quality_cap: "720p" | "1080p" | "auto";
  audio_only_fallback: boolean;
}

export interface DiscordVoiceBridgeMutation {
  ok: boolean;
  message: string;
  docker?: Record<string, unknown> | null;
}

export interface DiscordChannelInfo {
  id: string;
  guild_id: string | null;
  name: string;
  type: number;
  kind: "text" | "voice" | "unsupported";
}

export interface DiscordBotProfile {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

// ---------------------------------------------------------------------------
// Per-user connections (user-scoped bridge, PR1/PR3)
// ---------------------------------------------------------------------------
//
// The /api/users/me/discord/* endpoints are user-scoped — any authenticated
// user manages THEIR OWN Discord connection without admin intervention.
// Admins have no path to read another user's state or trigger their login.
// See docs/bridges/user-scoped-bridge-redesign.md for the full trust model.

// User-scoped Discord bridge types / helpers were removed in v0.5.0
// when Discord moved to an OAuth2-based per-user login. See
// client/src/api/concord.ts (`userDiscordStatus`, `userDiscordOAuthStart`,
// `userDiscordOAuthRevoke`) for the replacements. The rest of this
// module still exposes the admin-level bridge configuration helpers.

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

// enable/disable/rotate/force-reset wrappers were deleted in PR4 of the
// user-scoped bridge redesign. The backend endpoints are gone — the bridge
// now bootstraps automatically at concord-api startup. Per-user connection
// management happens via userDiscordStatus / userDiscordLogin /
// userDiscordLogout below.

export async function discordBridgeHttpSaveBotToken(
  accessToken: string,
  token: string,
): Promise<{ ok: boolean; message: string }> {
  return bridgeApiFetch<{ ok: boolean; message: string }>(
    "/admin/bridges/discord/bot-token",
    accessToken,
    { method: "POST", body: JSON.stringify({ token }) },
  );
}

export async function discordBridgeHttpLoginRelay(
  accessToken: string,
): Promise<{ ok: boolean; message: string }> {
  return bridgeApiFetch<{ ok: boolean; message: string }>(
    "/admin/bridges/discord/login-relay",
    accessToken,
    { method: "POST", body: "{}" },
  );
}

export async function discordBridgeHttpListGuilds(
  accessToken: string,
): Promise<{ id: string; name: string; icon: string | null }[]> {
  return bridgeApiFetch<{ id: string; name: string; icon: string | null }[]>(
    "/admin/bridges/discord/guilds",
    accessToken,
  );
}

export async function discordBridgeHttpGetChannel(
  accessToken: string,
  channelId: string,
): Promise<DiscordChannelInfo> {
  return bridgeApiFetch<DiscordChannelInfo>(
    `/admin/bridges/discord/channels/${encodeURIComponent(channelId)}`,
    accessToken,
  );
}

export async function discordBridgeHttpGetInviteUrl(
  accessToken: string,
): Promise<{ app_id: string; invite_url: string }> {
  return bridgeApiFetch<{ app_id: string; invite_url: string }>(
    "/admin/bridges/discord/bot-invite-url",
    accessToken,
  );
}

export async function discordBridgeHttpGetBotProfile(
  accessToken: string,
): Promise<DiscordBotProfile> {
  return bridgeApiFetch<DiscordBotProfile>(
    "/admin/bridges/discord/bot-profile",
    accessToken,
  );
}

export async function discordBridgeHttpUpdateBotProfile(
  accessToken: string,
  body: { username: string },
): Promise<DiscordBotProfile> {
  return bridgeApiFetch<DiscordBotProfile>(
    "/admin/bridges/discord/bot-profile",
    accessToken,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function discordVoiceBridgeHttpListRooms(
  accessToken: string,
): Promise<DiscordVoiceBridgeRoom[]> {
  return bridgeApiFetch<DiscordVoiceBridgeRoom[]>(
    "/admin/bridges/discord/voice/rooms",
    accessToken,
  );
}

export async function discordVoiceBridgeHttpUpsertRoom(
  accessToken: string,
  body: {
    channel_id: number;
    discord_guild_id: string;
    discord_channel_id: string;
    enabled?: boolean;
    // W4: video bridge expansion fields
    video_enabled?: boolean;
    projection_policy?: "screen_share_first" | "active_speaker";
    quality_cap?: "720p" | "1080p" | "auto";
    audio_only_fallback?: boolean;
  },
): Promise<DiscordVoiceBridgeRoom> {
  return bridgeApiFetch<DiscordVoiceBridgeRoom>(
    "/admin/bridges/discord/voice/rooms",
    accessToken,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function discordVoiceBridgeHttpDeleteRoom(
  accessToken: string,
  bridgeId: number,
): Promise<DiscordVoiceBridgeMutation> {
  return bridgeApiFetch<DiscordVoiceBridgeMutation>(
    `/admin/bridges/discord/voice/rooms/${bridgeId}`,
    accessToken,
    { method: "DELETE" },
  );
}

export async function discordVoiceBridgeHttpRestart(
  accessToken: string,
): Promise<DiscordVoiceBridgeMutation> {
  return bridgeApiFetch<DiscordVoiceBridgeMutation>(
    "/admin/bridges/discord/voice/restart",
    accessToken,
    { method: "POST" },
  );
}

export async function discordVoiceBridgeHttpStart(
  accessToken: string,
): Promise<DiscordVoiceBridgeMutation> {
  return bridgeApiFetch<DiscordVoiceBridgeMutation>(
    "/admin/bridges/discord/voice/start",
    accessToken,
    { method: "POST" },
  );
}

export async function discordVoiceBridgeHttpStop(
  accessToken: string,
): Promise<DiscordVoiceBridgeMutation> {
  return bridgeApiFetch<DiscordVoiceBridgeMutation>(
    "/admin/bridges/discord/voice/stop",
    accessToken,
    { method: "POST" },
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

// ---------------------------------------------------------------------------
// Per-user connections API (user-scoped; admin-independent)
// ---------------------------------------------------------------------------

/**
 * Get the caller's own Discord connection status.
 *
 * The response never contains another user's data. Both web and
 * native paths go through the same backend endpoint.
 */
// Per-user Discord flows moved to OAuth2 in v0.5.0 — see
// client/src/api/concord.ts. This block intentionally left empty.
