/**
 * Porch Phase A — API wrapper.
 *
 * Thin wrappers around the six `porch_*` Tauri commands exposed by
 * `src-tauri/src/lib.rs`:
 *
 *   - porch_list_my_channels — LOCAL: list this install's channels.
 *   - porch_get_messages — LOCAL: page messages from a local channel.
 *   - porch_post_message — LOCAL: append a message to a local channel.
 *   - porch_visit_peer — VISIT: dial a peer + ListChannels.
 *   - porch_visit_get_messages — VISIT: dial a peer + GetMessages.
 *   - porch_visit_post_message — VISIT: dial a peer + PostMessage.
 *
 * The three LOCAL commands are native-only — browsers don't host a
 * porch. The three VISIT commands work on both native (Tauri command)
 * and web (browser libp2p stream via `client/src/libp2p/porch.ts`),
 * with the dispatch picked automatically based on `isTauri()`.
 *
 * Wire shapes mirror the Rust types in
 * `src-tauri/src/porch/channel.rs` and `src-tauri/src/porch/protocol.rs`.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./servitude";

/** Channel kinds. Phase A only ships `porch`; the other variants are
 * present so Phase B/D can land without an enum change. */
export type ChannelKind = "porch" | "inner" | "obsidian";

/** ACL gating mode for a channel. */
export type AclMode = "open" | "allowlist" | "owner_only";

/** Roles inside a channel ACL row. */
export type AclRole = "visitor" | "member" | "owner";

/** Public channel record. Mirrors `PorchChannel` on the Rust side. */
export interface PorchChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  acl_mode: AclMode;
  /** Unix milliseconds. */
  created_at: number;
}

/** A single channel message. */
export interface ChannelMessage {
  id: string;
  channel_id: string;
  author_peer_id: string;
  body: string;
  /** Unix milliseconds. */
  created_at: number;
}

/** Phase B — knock lifecycle status. Mirrors Rust's `KnockStatus`. */
export type KnockStatus = "pending" | "accepted" | "rejected" | "withdrawn";

/** Phase B — a single knock row. Mirrors Rust's `Knock`. */
export interface Knock {
  id: string;
  channel_id: string;
  knocker_peer_id: string;
  message: string | null;
  status: KnockStatus;
  /** Unix milliseconds. */
  created_at: number;
  /** Unix milliseconds. `null` while still pending. */
  resolved_at: number | null;
}

/** Phase B — per-row visibility on a `ListChannels` response. */
export type ChannelVisibility =
  | { kind: "visible" }
  | {
      kind: "needs_knock";
      /** Most recent knock status for this visitor; `null` if they've never knocked. */
      existing_knock?: KnockStatus | null;
    };

/** Phase B — flattened row returned by `ListChannels`. */
export interface PorchListChannelRow {
  id: string;
  name: string;
  kind: ChannelKind;
  acl_mode: AclMode;
  created_at: number;
  visibility: ChannelVisibility;
  /** Phase C — compact theme swatch for the channel-rail preview.
   *  `null`/absent if the owner hasn't customized; the UI substitutes
   *  the default-theme summary. */
  theme_summary?: ThemeSummary | null;
}

// ---------------------------------------------------------------------------
// Phase C — per-channel theming + asset storage
// ---------------------------------------------------------------------------

/** Phase C — font-family enum on a channel theme. The renderer maps
 *  each variant to a concrete `font-family` CSS stack. */
export type FontFamily = "system" | "serif" | "mono" | "display";

/** Phase C — background descriptor on a channel theme. Tagged union:
 *  the `kind` discriminator picks the variant and `value` carries its
 *  payload (hex string for solid, CSS gradient string for gradient,
 *  asset-id binding for image). */
export type Background =
  | { kind: "none"; value?: null }
  | { kind: "solid"; value: string }
  | { kind: "gradient"; value: string }
  | { kind: "image"; value: { asset_id: string } };

/** Phase C — full theme row for a channel. Mirrors Rust's `ChannelTheme`. */
export interface ChannelTheme {
  channel_id: string;
  primary_color: string;
  surface_color: string;
  on_surface_color: string;
  accent_color: string;
  font_family: FontFamily;
  background: Background;
  /** Unix milliseconds — server-stamped on every save. */
  updated_at: number;
}

/** Phase C — compact theme summary embedded in `ListChannels` rows. */
export interface ThemeSummary {
  primary_color: string;
  accent_color: string;
}

/** Phase C — uploaded image asset metadata. The raw bytes live on
 *  disk under `<data_dir>/porch_assets/<file_path>`; fetch them via
 *  the visit-side helper. */
export interface PorchAsset {
  id: string;
  channel_id: string;
  mime_type: string;
  /** Path relative to `<data_dir>/porch_assets/`. */
  file_path: string;
  bytes: number;
  sha256: string;
  created_at: number;
}

/** Phase C — sensible default theme. Used as a fallback when the
 *  owner hasn't customized a channel. Mirrors Rust's
 *  `ChannelTheme::default_for` so the client and server agree on what
 *  "unset" looks like. */
export function defaultChannelTheme(channelId: string): ChannelTheme {
  return {
    channel_id: channelId,
    primary_color: "#4f9eff",
    surface_color: "#18191c",
    on_surface_color: "#e3e4e6",
    accent_color: "#7c4dff",
    font_family: "system",
    background: { kind: "none" },
    updated_at: 0,
  };
}

// ---------------------------------------------------------------------------
// Local (host's own porch) — native only
// ---------------------------------------------------------------------------

/** List every channel on the LOCAL porch (this install's). Browsers
 *  return an empty list — they don't host a porch. */
export async function listMyChannels(): Promise<PorchChannel[]> {
  if (!isTauri()) return [];
  return await invoke<PorchChannel[]>("porch_list_my_channels");
}

/** Read messages from a LOCAL channel. Browsers return an empty list. */
export async function getLocalMessages(
  channelId: string,
  since: number | null,
  limit: number,
): Promise<ChannelMessage[]> {
  if (!isTauri()) return [];
  return await invoke<ChannelMessage[]>("porch_get_messages", {
    channelId,
    since,
    limit,
  });
}

/** Append a message to a LOCAL channel. Throws on the web build. */
export async function postLocalMessage(
  channelId: string,
  body: string,
): Promise<ChannelMessage> {
  if (!isTauri()) {
    throw new Error("porch_post_message is native-only");
  }
  return await invoke<ChannelMessage>("porch_post_message", {
    channelId,
    body,
  });
}

// ---------------------------------------------------------------------------
// Visit (a paired peer's porch) — native + web
// ---------------------------------------------------------------------------

/** Visit a paired peer's porch and read their channel list. Picks
 *  Tauri vs browser libp2p based on `isTauri()`.
 *
 *  Phase B: returns visibility-aware rows so the UI can render a
 *  Knock affordance for gated channels. */
export async function visitPeer(peerId: string): Promise<PorchListChannelRow[]> {
  if (isTauri()) {
    return await invoke<PorchListChannelRow[]>("porch_visit_peer", { peerId });
  }
  // Web build — dial over the browser libp2p stack. Loaded lazily so
  // the libp2p chunk only fetches when a visit is attempted.
  const mod = await import("../libp2p/porch");
  return await mod.browserVisitListChannels(peerId);
}

/** Visit a peer's porch and page messages from one of their channels. */
export async function visitGetMessages(
  peerId: string,
  channelId: string,
  since: number | null,
  limit: number,
): Promise<ChannelMessage[]> {
  if (isTauri()) {
    return await invoke<ChannelMessage[]>("porch_visit_get_messages", {
      peerId,
      channelId,
      since,
      limit,
    });
  }
  const mod = await import("../libp2p/porch");
  return await mod.browserVisitGetMessages(peerId, channelId, since, limit);
}

/** Visit a peer's porch and post a message to one of their channels. */
export async function visitPostMessage(
  peerId: string,
  channelId: string,
  body: string,
): Promise<ChannelMessage> {
  if (isTauri()) {
    return await invoke<ChannelMessage>("porch_visit_post_message", {
      peerId,
      channelId,
      body,
    });
  }
  const mod = await import("../libp2p/porch");
  return await mod.browserVisitPostMessage(peerId, channelId, body);
}

// ---------------------------------------------------------------------------
// Phase B — knock-to-enter
// ---------------------------------------------------------------------------

/** Owner-side: list every pending knock across this install's channels.
 *  Native only — browsers don't host a porch. */
export async function porchPendingKnocks(): Promise<Knock[]> {
  if (!isTauri()) return [];
  return await invoke<Knock[]>("porch_pending_knocks");
}

/** Owner-side: accept a pending knock. Atomically grants the visitor
 *  `member` ACL on the channel. */
export async function porchAcceptKnock(knockId: string): Promise<Knock> {
  if (!isTauri()) throw new Error("porch_accept_knock is native-only");
  return await invoke<Knock>("porch_accept_knock", { knockId });
}

/** Owner-side: reject a pending knock. No ACL change. */
export async function porchRejectKnock(knockId: string): Promise<Knock> {
  if (!isTauri()) throw new Error("porch_reject_knock is native-only");
  return await invoke<Knock>("porch_reject_knock", { knockId });
}

/** Owner-side: mint a new channel on this install's porch. */
export async function porchCreateChannel(
  name: string,
  kind: ChannelKind,
  aclMode: AclMode,
): Promise<PorchChannel> {
  if (!isTauri()) throw new Error("porch_create_channel is native-only");
  return await invoke<PorchChannel>("porch_create_channel", {
    name,
    kind,
    aclMode,
  });
}

/** Owner-side: grant `member` on a channel. Idempotent. */
export async function porchGrantMember(
  channelId: string,
  peerId: string,
): Promise<void> {
  if (!isTauri()) throw new Error("porch_grant_member is native-only");
  await invoke<void>("porch_grant_member", { channelId, peerId });
}

/** Owner-side: revoke a channel ACL row. */
export async function porchRevokeMember(
  channelId: string,
  peerId: string,
): Promise<void> {
  if (!isTauri()) throw new Error("porch_revoke_member is native-only");
  await invoke<void>("porch_revoke_member", { channelId, peerId });
}

/** Visitor-side: knock on a paired peer's gated channel. Native + web. */
export async function porchVisitKnock(
  peerId: string,
  channelId: string,
  message: string | null,
): Promise<Knock> {
  if (isTauri()) {
    return await invoke<Knock>("porch_visit_knock", {
      peerId,
      channelId,
      message,
    });
  }
  const mod = await import("../libp2p/porch");
  return await mod.browserVisitKnock(peerId, channelId, message);
}

/** Visitor-side: poll their own current knock status on a channel. */
export async function porchVisitKnockStatus(
  peerId: string,
  channelId: string,
): Promise<Knock | null> {
  if (isTauri()) {
    return await invoke<Knock | null>("porch_visit_knock_status", {
      peerId,
      channelId,
    });
  }
  const mod = await import("../libp2p/porch");
  return await mod.browserVisitKnockStatus(peerId, channelId);
}

/** Visitor-side: withdraw a previously-filed knock. */
export async function porchVisitWithdrawKnock(
  peerId: string,
  knockId: string,
): Promise<Knock> {
  if (isTauri()) {
    return await invoke<Knock>("porch_visit_withdraw_knock", {
      peerId,
      knockId,
    });
  }
  const mod = await import("../libp2p/porch");
  return await mod.browserVisitWithdrawKnock(peerId, knockId);
}

// ---------------------------------------------------------------------------
// Phase C — per-channel theming + asset storage
// ---------------------------------------------------------------------------

/** Owner-side: read the theme stored for one of this install's
 *  channels. Returns the persisted theme or the default if the owner
 *  hasn't customized. Native only — browsers don't host a porch. */
export async function porchGetTheme(channelId: string): Promise<ChannelTheme> {
  if (!isTauri()) return defaultChannelTheme(channelId);
  return await invoke<ChannelTheme>("porch_get_theme", { channelId });
}

/** Owner-side: persist the given theme. Returns the server-stamped
 *  copy (with `updated_at` populated). */
export async function porchSetTheme(theme: ChannelTheme): Promise<ChannelTheme> {
  if (!isTauri()) throw new Error("porch_set_theme is native-only");
  return await invoke<ChannelTheme>("porch_set_theme", { theme });
}

/** Owner-side: upload an image asset for a channel. The renderer
 *  passes the file as standard-base64 (RFC 4648); the storage layer
 *  enforces a 5 MiB cap and a MIME allow-list (PNG/JPEG/WebP/GIF). */
export async function porchUploadAsset(
  channelId: string,
  mimeType: string,
  base64Bytes: string,
): Promise<PorchAsset> {
  if (!isTauri()) throw new Error("porch_upload_asset is native-only");
  return await invoke<PorchAsset>("porch_upload_asset", {
    channelId,
    mimeType,
    base64Bytes,
  });
}

/** Owner-side: list every asset uploaded for a channel. */
export async function porchListAssets(channelId: string): Promise<PorchAsset[]> {
  if (!isTauri()) return [];
  return await invoke<PorchAsset[]>("porch_list_assets", { channelId });
}

/** Visitor-side: fetch the theme set by the owner of a peer's
 *  channel. Native + web. */
export async function porchVisitGetTheme(
  peerId: string,
  channelId: string,
): Promise<ChannelTheme> {
  if (isTauri()) {
    return await invoke<ChannelTheme>("porch_visit_get_theme", {
      peerId,
      channelId,
    });
  }
  const mod = await import("../libp2p/porch");
  return await mod.browserVisitGetTheme(peerId, channelId);
}

/** Visitor-side: fetch raw bytes of an image asset off the peer's
 *  porch. Returns a Uint8Array of decoded bytes. Throws if the asset
 *  exceeds the 256 KiB inline cap (the visitor's UI should render a
 *  placeholder in that case). */
export async function porchVisitGetAssetBytes(
  peerId: string,
  assetId: string,
): Promise<Uint8Array> {
  if (isTauri()) {
    const raw = await invoke<number[] | Uint8Array>("porch_visit_get_asset_bytes", {
      peerId,
      assetId,
    });
    return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  }
  const mod = await import("../libp2p/porch");
  return await mod.browserVisitGetAssetBytes(peerId, assetId);
}

// ---------------------------------------------------------------------------
// Phase D — Obsidian channel: vault binding, browse, file reads
// ---------------------------------------------------------------------------

/** Phase D — kind discriminator on a single vault entry returned by
 *  ListVault. Mirrors Rust's `EntryKind`. */
export type EntryKind = "file" | "directory";

/** Phase D — one row inside a vault directory listing. */
export interface VaultEntry {
  /** Forward-slash-normalized path, relative to the effective root. */
  path: string;
  kind: EntryKind;
  /** Bytes for files; `null` for directories. */
  size: number | null;
  /** Unix milliseconds (file mtime), or `null`. */
  modified_at: number | null;
}

/** Phase D — obsidian binding row carried over the wire. The owner sets
 *  `vault_root` via the file-picker; `subfolder` optionally narrows the
 *  surface to a sub-tree. `follow_symlinks` defaults off — see the Rust
 *  module docs for the threat model. */
export interface ObsidianChannelConfig {
  channel_id: string;
  /** Absolute, canonicalized path. The renderer never opens this
   *  directly — it's surfaced for display only. */
  vault_root: string;
  /** Relative subfolder within the vault root, or `null`. */
  subfolder: string | null;
  follow_symlinks: boolean;
}

/** Phase D — `GetVaultFile` response. Tagged union; mirrors Rust's
 *  `VaultFileResponse`. `Inline` carries base64 bytes inline (under the
 *  256 KiB cap); `TooLarge` carries the metadata so the renderer can
 *  show a placeholder. */
export type VaultFileResponse =
  | {
      kind: "inline";
      path: string;
      mime_type: string;
      bytes_b64: string;
      size: number;
    }
  | {
      kind: "too_large";
      path: string;
      mime_type: string;
      size: number;
    };

/** Owner-side: bind a channel to a vault directory. Native only. */
export async function porchSetObsidianConfig(
  channelId: string,
  vaultRoot: string,
  subfolder: string | null,
  followSymlinks: boolean,
): Promise<ObsidianChannelConfig> {
  if (!isTauri()) {
    throw new Error("porch_set_obsidian_config is native-only");
  }
  return await invoke<ObsidianChannelConfig>("porch_set_obsidian_config", {
    channelId,
    vaultRoot,
    subfolder,
    followSymlinks,
  });
}

/** Owner-side: fetch the binding for a channel (or `null` if none). */
export async function porchGetObsidianConfig(
  channelId: string,
): Promise<ObsidianChannelConfig | null> {
  if (!isTauri()) return null;
  return await invoke<ObsidianChannelConfig | null>("porch_get_obsidian_config", {
    channelId,
  });
}

/** Owner-side: list a folder inside the host's own obsidian-bound
 *  channel. Skips the ACL check — the owner sees their own vault
 *  unconditionally. */
export async function porchListVault(
  channelId: string,
  path: string,
): Promise<VaultEntry[]> {
  if (!isTauri()) return [];
  return await invoke<VaultEntry[]>("porch_list_vault", { channelId, path });
}

/** Owner-side: read a single file out of the host's own
 *  obsidian-bound channel. */
export async function porchReadVaultFile(
  channelId: string,
  path: string,
): Promise<VaultFileResponse> {
  if (!isTauri()) throw new Error("porch_read_vault_file is native-only");
  return await invoke<VaultFileResponse>("porch_read_vault_file", {
    channelId,
    path,
  });
}

/** Visitor-side: list a folder inside a peer's obsidian-bound
 *  channel. Native + web. */
export async function porchVisitListVault(
  peerId: string,
  channelId: string,
  path: string,
): Promise<VaultEntry[]> {
  if (isTauri()) {
    return await invoke<VaultEntry[]>("porch_visit_list_vault", {
      peerId,
      channelId,
      path,
    });
  }
  const mod = await import("../libp2p/porch");
  return await mod.browserVisitListVault(peerId, channelId, path);
}

/** Visitor-side: fetch a single file from a peer's obsidian-bound
 *  channel. Returns the envelope so callers can render the
 *  "too_large" placeholder when needed. */
export async function porchVisitGetVaultFile(
  peerId: string,
  channelId: string,
  path: string,
): Promise<VaultFileResponse> {
  if (isTauri()) {
    return await invoke<VaultFileResponse>("porch_visit_get_vault_file", {
      peerId,
      channelId,
      path,
    });
  }
  const mod = await import("../libp2p/porch");
  return await mod.browserVisitGetVaultFile(peerId, channelId, path);
}

// ---------------------------------------------------------------------------
// Phase E — encrypted backup pipeline
// ---------------------------------------------------------------------------

/** Phase E — one configured backup target (a peer we push our backup
 *  to). Mirrors Rust's `BackupTarget`. */
export interface BackupTarget {
  peer_id: string;
  label: string | null;
  added_at: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_failure_reason: string | null;
}

/** Phase E — summary returned by `porch_backup_check_remote_info` and
 *  `porch_backup_list_received`. Mirrors Rust's `ReceivedBackupSummary`. */
export interface ReceivedBackupSummary {
  uploader_peer_id: string;
  schema_version: number;
  blob_size: number;
  blob_sha256: string;
  received_at: number;
}

/** Phase E — `porch_backup_restore_from` response. */
export interface RestoreResult {
  schema_version: number;
}

/** Add a backup target. Idempotent on `peerId` — re-adding updates the
 *  label. Native only — browsers don't host a porch. */
export async function porchBackupAddTarget(
  peerId: string,
  label: string | null,
): Promise<BackupTarget> {
  if (!isTauri()) throw new Error("porch_backup_add_target is native-only");
  return await invoke<BackupTarget>("porch_backup_add_target", {
    peerId,
    label,
  });
}

/** Remove a backup target. Throws on the web build, or if the peer
 *  wasn't on the list. */
export async function porchBackupRemoveTarget(peerId: string): Promise<void> {
  if (!isTauri()) throw new Error("porch_backup_remove_target is native-only");
  await invoke<void>("porch_backup_remove_target", { peerId });
}

/** List every configured backup target. Browsers return an empty list. */
export async function porchBackupListTargets(): Promise<BackupTarget[]> {
  if (!isTauri()) return [];
  return await invoke<BackupTarget[]>("porch_backup_list_targets");
}

/** Manually push a fresh backup to `peerId`. Updates the target's
 *  `last_success_at` / `last_failure_*` server-side. Native only. */
export async function porchBackupPushNow(peerId: string): Promise<void> {
  if (!isTauri()) throw new Error("porch_backup_push_now is native-only");
  await invoke<void>("porch_backup_push_now", { peerId });
}

/** Ask the backup peer what they're holding for us. Returns `null` if
 *  the peer isn't storing a backup for our peer-id yet. */
export async function porchBackupCheckRemoteInfo(
  peerId: string,
): Promise<ReceivedBackupSummary | null> {
  if (!isTauri()) return null;
  return await invoke<ReceivedBackupSummary | null>(
    "porch_backup_check_remote_info",
    { peerId },
  );
}

/** DESTRUCTIVE — pull the stored backup off `peerId`, decrypt with the
 *  local Stronghold seed, and OVERWRITE the local porch DB. The
 *  backend requires `confirm: true` as a guard against accidental
 *  invocation. */
export async function porchBackupRestoreFrom(
  peerId: string,
  confirm: boolean,
): Promise<RestoreResult> {
  if (!isTauri()) throw new Error("porch_backup_restore_from is native-only");
  return await invoke<RestoreResult>("porch_backup_restore_from", {
    peerId,
    confirm,
  });
}

/** List the uploaders we're currently storing backups for (our role as
 *  a backup-peer). */
export async function porchBackupListReceived(): Promise<ReceivedBackupSummary[]> {
  if (!isTauri()) return [];
  return await invoke<ReceivedBackupSummary[]>("porch_backup_list_received");
}
