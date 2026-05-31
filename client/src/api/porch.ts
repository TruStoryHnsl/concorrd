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
