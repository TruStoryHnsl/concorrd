/**
 * Browser-side counterpart of the Phase A porch protocol
 * (`/concord/porch/1.0.0`).
 *
 * Speaks the same wire format as the Rust handler in
 * `src-tauri/src/porch/protocol.rs`:
 *
 *   - 4-byte BIG-ENDIAN length prefix.
 *   - JSON envelope body (UTF-8).
 *   - 1 MiB cap (`MAX_ENVELOPE_BYTES`) — anything larger is rejected.
 *
 * Same framing convention as `client/src/libp2p/federation.ts` (which
 * speaks Matrix federation). The `lpStream` helper in `@libp2p/utils`
 * uses a varint prefix; this protocol uses a fixed 4-byte BE prefix,
 * so we hand-roll the framing for symmetry with Rust.
 */

import type { Libp2p, PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import {
  frameEnvelope,
  readLengthPrefixedEnvelope,
} from "./federation";

import type {
  ChannelMessage,
  ChannelTheme,
  Knock,
  PorchListChannelRow,
  VaultEntry,
  VaultFileResponse,
} from "../api/porch";

/** libp2p protocol id — MUST match the Rust `PORCH_PROTOCOL_ID`. */
export const CONCORD_PORCH_PROTOCOL = "/concord/porch/1.0.0";

/** 1 MiB cap — MUST match the Rust `MAX_ENVELOPE_BYTES`. */
export const MAX_ENVELOPE_BYTES = 1024 * 1024;

/** Wire shape of a porch request. Mirrors the Rust `PorchRequest`
 * with `#[serde(tag = "method", content = "params")]`. */
export type PorchRequest =
  | { method: "ListChannels"; params: null }
  | {
      method: "GetMessages";
      params: { channel_id: string; since: number | null; limit: number };
    }
  | { method: "PostMessage"; params: { channel_id: string; body: string } }
  // Phase B — knock-to-enter.
  | {
      method: "Knock";
      params: { channel_id: string; message: string | null };
    }
  | { method: "KnockStatus"; params: { channel_id: string } }
  | { method: "WithdrawKnock"; params: { knock_id: string } }
  // Phase C — per-channel theming + asset storage.
  | { method: "GetTheme"; params: { channel_id: string } }
  | { method: "GetAssetBytes"; params: { asset_id: string } }
  // Phase D — obsidian vault browsing + file reads.
  | { method: "ListVault"; params: { channel_id: string; path: string } }
  | { method: "GetVaultFile"; params: { channel_id: string; path: string } };

/** Phase C — `GetAssetBytes` response. Tagged union mirroring the
 *  Rust `AssetBytesResponse`. */
export type AssetBytesResponse =
  | {
      kind: "inline";
      asset_id: string;
      mime_type: string;
      bytes_b64: string;
    }
  | {
      kind: "too_large";
      asset_id: string;
      mime_type: string;
      bytes: number;
    };

/** Wire shape of a porch response. */
export interface PorchResponse {
  ok: boolean;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Send a single porch request to `peerId` and read the response.
 * Throws if the request body or response declaration exceeds the
 * 1 MiB cap, or if the stream closes mid-envelope.
 */
export async function sendPorchRequest(
  node: Libp2p,
  peerId: PeerId,
  request: PorchRequest,
): Promise<PorchResponse> {
  const stream = await node.dialProtocol(peerId, CONCORD_PORCH_PROTOCOL);
  try {
    const body = new TextEncoder().encode(JSON.stringify(request));
    if (body.length > MAX_ENVELOPE_BYTES) {
      throw new Error(
        `porch request envelope too large: ${body.length} > ${MAX_ENVELOPE_BYTES}`,
      );
    }
    const framed = frameEnvelope(body);
    stream.send(framed);
    const responseBytes = await readLengthPrefixedEnvelope(stream);
    return JSON.parse(
      new TextDecoder().decode(responseBytes),
    ) as PorchResponse;
  } finally {
    try {
      await stream.close();
    } catch {
      // Idempotent close.
    }
  }
}

/**
 * Convert a `PorchResponse` into a typed result, throwing on the
 * structured-error case. Mirrors the Rust `decode_or_error` helper.
 */
function unwrapResponse<T>(response: PorchResponse): T {
  if (response.ok) {
    if (response.result === undefined) {
      throw new Error("porch response missing result field");
    }
    return response.result as T;
  }
  const err = response.error ?? { code: 0, message: "unknown" };
  const error = new Error(`porch error ${err.code}: ${err.message}`);
  (error as Error & { code?: number }).code = err.code;
  throw error;
}

/**
 * Resolve the running browser libp2p node. Loads the lazy node module
 * so we don't pay the libp2p chunk cost until a visit is attempted.
 */
async function getRunningNode(): Promise<Libp2p> {
  const { getNode, startBrowserNode } = await import("./node");
  let node = getNode();
  if (!node) {
    // Caller didn't pre-boot the browser node; do it now. The lazy
    // chunk is already loaded since we just imported from
    // `./node`.
    node = await startBrowserNode();
  }
  return node;
}

/** Browser visitor: ListChannels.
 *
 *  Phase B: returns visibility-aware rows so the UI can render a
 *  Knock affordance for gated channels. */
export async function browserVisitListChannels(
  peerIdStr: string,
): Promise<PorchListChannelRow[]> {
  const node = await getRunningNode();
  const peerId = peerIdFromString(peerIdStr);
  const response = await sendPorchRequest(node, peerId, {
    method: "ListChannels",
    params: null,
  });
  return unwrapResponse<PorchListChannelRow[]>(response);
}

/** Browser visitor: GetMessages. */
export async function browserVisitGetMessages(
  peerIdStr: string,
  channelId: string,
  since: number | null,
  limit: number,
): Promise<ChannelMessage[]> {
  const node = await getRunningNode();
  const peerId = peerIdFromString(peerIdStr);
  const response = await sendPorchRequest(node, peerId, {
    method: "GetMessages",
    params: { channel_id: channelId, since, limit },
  });
  return unwrapResponse<ChannelMessage[]>(response);
}

/** Browser visitor: PostMessage. */
export async function browserVisitPostMessage(
  peerIdStr: string,
  channelId: string,
  body: string,
): Promise<ChannelMessage> {
  const node = await getRunningNode();
  const peerId = peerIdFromString(peerIdStr);
  const response = await sendPorchRequest(node, peerId, {
    method: "PostMessage",
    params: { channel_id: channelId, body },
  });
  return unwrapResponse<ChannelMessage>(response);
}

// ---------------------------------------------------------------------------
// Phase B — knock-to-enter
// ---------------------------------------------------------------------------

/** Browser visitor: Knock. */
export async function browserVisitKnock(
  peerIdStr: string,
  channelId: string,
  message: string | null,
): Promise<Knock> {
  const node = await getRunningNode();
  const peerId = peerIdFromString(peerIdStr);
  const response = await sendPorchRequest(node, peerId, {
    method: "Knock",
    params: { channel_id: channelId, message },
  });
  return unwrapResponse<Knock>(response);
}

/** Browser visitor: KnockStatus. */
export async function browserVisitKnockStatus(
  peerIdStr: string,
  channelId: string,
): Promise<Knock | null> {
  const node = await getRunningNode();
  const peerId = peerIdFromString(peerIdStr);
  const response = await sendPorchRequest(node, peerId, {
    method: "KnockStatus",
    params: { channel_id: channelId },
  });
  return unwrapResponse<Knock | null>(response);
}

/** Browser visitor: WithdrawKnock. */
export async function browserVisitWithdrawKnock(
  peerIdStr: string,
  knockId: string,
): Promise<Knock> {
  const node = await getRunningNode();
  const peerId = peerIdFromString(peerIdStr);
  const response = await sendPorchRequest(node, peerId, {
    method: "WithdrawKnock",
    params: { knock_id: knockId },
  });
  return unwrapResponse<Knock>(response);
}

// ---------------------------------------------------------------------------
// Phase C — per-channel theming + asset storage
// ---------------------------------------------------------------------------

/** Browser visitor: GetTheme. */
export async function browserVisitGetTheme(
  peerIdStr: string,
  channelId: string,
): Promise<ChannelTheme> {
  const node = await getRunningNode();
  const peerId = peerIdFromString(peerIdStr);
  const response = await sendPorchRequest(node, peerId, {
    method: "GetTheme",
    params: { channel_id: channelId },
  });
  return unwrapResponse<ChannelTheme>(response);
}

/** Browser visitor: GetAssetBytes.
 *
 *  Returns the decoded asset bytes inline (under the 256 KiB cap) or
 *  throws if the host signals "too_large" — the caller is responsible
 *  for rendering a placeholder when that happens.
 */
export async function browserVisitGetAssetBytes(
  peerIdStr: string,
  assetId: string,
): Promise<Uint8Array> {
  const node = await getRunningNode();
  const peerId = peerIdFromString(peerIdStr);
  const response = await sendPorchRequest(node, peerId, {
    method: "GetAssetBytes",
    params: { asset_id: assetId },
  });
  const payload = unwrapResponse<AssetBytesResponse>(response);
  if (payload.kind === "too_large") {
    throw new Error(
      `asset ${payload.asset_id} too large to preview inline: ${payload.bytes} bytes`,
    );
  }
  // Decode base64 → Uint8Array. atob is fine in the browser.
  const bin = atob(payload.bytes_b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Phase D — Obsidian vault browsing
// ---------------------------------------------------------------------------

/** Browser visitor: ListVault. Lists the contents of `path` inside a
 *  peer's obsidian-bound channel; `""` lists the effective root. */
export async function browserVisitListVault(
  peerIdStr: string,
  channelId: string,
  path: string,
): Promise<VaultEntry[]> {
  const node = await getRunningNode();
  const peerId = peerIdFromString(peerIdStr);
  const response = await sendPorchRequest(node, peerId, {
    method: "ListVault",
    params: { channel_id: channelId, path },
  });
  return unwrapResponse<VaultEntry[]>(response);
}

/** Browser visitor: GetVaultFile. Returns the decoded envelope —
 *  callers branch on `kind` to render either the inline bytes or a
 *  "too large" placeholder. */
export async function browserVisitGetVaultFile(
  peerIdStr: string,
  channelId: string,
  path: string,
): Promise<VaultFileResponse> {
  const node = await getRunningNode();
  const peerId = peerIdFromString(peerIdStr);
  const response = await sendPorchRequest(node, peerId, {
    method: "GetVaultFile",
    params: { channel_id: channelId, path },
  });
  return unwrapResponse<VaultFileResponse>(response);
}
