/**
 * Discord bridge control surface — typed wrappers for the Tauri bridge
 * commands added in INS-024 Wave 4.
 *
 * Mirrors the pattern in `servitude.ts`: each function guards against
 * non-Tauri (browser) environments and returns a typed result. The Rust
 * side lives in `src-tauri/src/bridge_commands.rs`.
 */

import { isTauri } from "./servitude";

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
