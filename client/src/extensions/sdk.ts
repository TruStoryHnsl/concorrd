/**
 * Concord Shell ↔ Extension postMessage SDK (INS-036 Wave 4).
 *
 * This module defines the outbound message protocol that the Concord shell
 * (ExtensionSurfaceManager) sends to extension iframes. Extensions listen for
 * these messages via window.addEventListener("message", handler) and use the
 * typed payload to drive their UI without any direct access to Concord internals.
 *
 * Protocol direction: Concord shell → iframe (window.postMessage).
 * The inbound direction (iframe → shell) is handled by InputRouter (W2).
 *
 * All messages share a common envelope:
 *   { type: "concord:<event>", payload: <typed payload>, version: 1 }
 *
 * Message types:
 *   concord:init             — sent once on iframe mount with full session context
 *   concord:participant_join — a participant joined the session
 *   concord:participant_leave — a participant left the session
 *   concord:host_transfer    — the host seat transferred to another participant
 *   concord:surface_resize   — the surface container was resized
 *
 * See docs/extensions/shell-api.md for the full specification.
 */

import type { Mode, Seat } from "../components/extension/InputRouter";
import type { SurfaceDescriptor } from "../components/extension/ExtensionEmbed";

/** Protocol version — bump when any payload shape changes in a breaking way. */
export const CONCORD_SDK_VERSION = 1;

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface ConcordInitPayload {
  /** UUIDv4 session identifier from the extension session model. */
  sessionId: string;
  /** Reverse-domain extension identifier, e.g. "com.concord.whiteboard". */
  extensionId: string;
  /** Interaction mode for this session. */
  mode: Mode;
  /** The Matrix user ID of the current participant (@user:server). */
  participantId: string;
  /** The seat role of the current participant in this session. */
  seat: Seat;
  /** All surface descriptors for this session. */
  surfaces: SurfaceDescriptor[];
}

export interface ConcordParticipantJoinPayload {
  /** Matrix user ID of the joining participant. */
  participantId: string;
  /** Their seat role in this session. */
  seat: Seat;
}

export interface ConcordParticipantLeavePayload {
  /** Matrix user ID of the leaving participant. */
  participantId: string;
}

export interface ConcordHostTransferPayload {
  /** Previous host's Matrix user ID. */
  previousHostId: string;
  /** New host's Matrix user ID. */
  newHostId: string;
  /** The new host's seat (always "host"). */
  newSeat: Seat;
}

export interface ConcordSurfaceResizePayload {
  /** The surface_id being resized. */
  surfaceId: string;
  /** New width in logical pixels. */
  widthPx: number;
  /** New height in logical pixels. */
  heightPx: number;
}

// ---------------------------------------------------------------------------
// Message envelope union
// ---------------------------------------------------------------------------

export type ConcordShellMessage =
  | { type: "concord:init"; payload: ConcordInitPayload; version: typeof CONCORD_SDK_VERSION }
  | { type: "concord:participant_join"; payload: ConcordParticipantJoinPayload; version: typeof CONCORD_SDK_VERSION }
  | { type: "concord:participant_leave"; payload: ConcordParticipantLeavePayload; version: typeof CONCORD_SDK_VERSION }
  | { type: "concord:host_transfer"; payload: ConcordHostTransferPayload; version: typeof CONCORD_SDK_VERSION }
  | { type: "concord:surface_resize"; payload: ConcordSurfaceResizePayload; version: typeof CONCORD_SDK_VERSION };

// ---------------------------------------------------------------------------
// Shell-side sender helpers (used by ExtensionSurfaceManager)
// ---------------------------------------------------------------------------

/**
 * Post a typed shell message to an iframe's contentWindow.
 * No-ops if the iframe or its contentWindow is not available.
 */
export function postToFrame(
  frame: HTMLIFrameElement | null | undefined,
  message: ConcordShellMessage,
): void {
  if (!frame?.contentWindow) return;
  frame.contentWindow.postMessage(message, "*");
}

/** Build a concord:init message envelope. */
export function buildInitMessage(payload: ConcordInitPayload): ConcordShellMessage {
  return { type: "concord:init", payload, version: CONCORD_SDK_VERSION };
}

/** Build a concord:participant_join message envelope. */
export function buildParticipantJoinMessage(
  payload: ConcordParticipantJoinPayload,
): ConcordShellMessage {
  return { type: "concord:participant_join", payload, version: CONCORD_SDK_VERSION };
}

/** Build a concord:participant_leave message envelope. */
export function buildParticipantLeaveMessage(
  payload: ConcordParticipantLeavePayload,
): ConcordShellMessage {
  return { type: "concord:participant_leave", payload, version: CONCORD_SDK_VERSION };
}

/** Build a concord:host_transfer message envelope. */
export function buildHostTransferMessage(
  payload: ConcordHostTransferPayload,
): ConcordShellMessage {
  return { type: "concord:host_transfer", payload, version: CONCORD_SDK_VERSION };
}

/** Build a concord:surface_resize message envelope. */
export function buildSurfaceResizeMessage(
  payload: ConcordSurfaceResizePayload,
): ConcordShellMessage {
  return { type: "concord:surface_resize", payload, version: CONCORD_SDK_VERSION };
}

// ---------------------------------------------------------------------------
// Extension-side receiver helper (used by extension authors)
// ---------------------------------------------------------------------------

/**
 * Type guard for ConcordShellMessage.
 * Extensions use this to filter incoming messages:
 *
 * ```ts
 * window.addEventListener("message", (e) => {
 *   if (!isConcordShellMessage(e.data)) return;
 *   if (e.data.type === "concord:init") { ... }
 * });
 * ```
 */
export function isConcordShellMessage(data: unknown): data is ConcordShellMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as Record<string, unknown>).type === "string" &&
    (data as Record<string, unknown>).type.toString().startsWith("concord:") &&
    (data as Record<string, unknown>).version === CONCORD_SDK_VERSION
  );
}
