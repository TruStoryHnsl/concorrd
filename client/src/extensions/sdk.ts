/**
 * Concord Shell ↔ Extension postMessage SDK (INS-036 Wave 4 + INS-066 W5/W6).
 *
 * This module defines BOTH directions of the postMessage protocol:
 *   - Outbound (shell → iframe): `concord:*` messages. These tell the
 *     extension about session/lifecycle events (init, participant
 *     join/leave, host_transfer, surface_resize, state_event).
 *   - Inbound  (iframe → shell): `extension:*` messages. These let the
 *     extension request things from the shell (currently
 *     extension:send_state_event for emitting Matrix room state).
 *
 * Outbound envelope:
 *   { type: "concord:<event>", payload: <typed payload>, version: 1 }
 * Inbound envelope:
 *   { type: "extension:<verb>", payload: <typed payload>, version: 1 }
 *
 * Outbound (shell → iframe) message types:
 *   concord:init               — sent once on iframe mount with session context
 *   concord:participant_join   — a participant joined the session
 *   concord:participant_leave  — a participant left the session
 *   concord:host_transfer      — the host seat transferred to another participant
 *   concord:surface_resize     — the surface container was resized
 *   concord:state_event        — a Matrix room state event was observed and
 *                                forwarded to the extension (INS-066 W5)
 *   concord:permission_denied  — the extension's last verb was rejected
 *                                (INS-066 W6)
 *
 * Inbound (iframe → shell) verbs:
 *   extension:send_state_event — request the shell emit a Matrix state
 *                                event on behalf of the extension (W6)
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

/** A Matrix room state event forwarded to the extension (INS-066 W5).
 *
 * The shell observes the Matrix client's incoming events for the active
 * room and forwards each one as a `concord:state_event` IFF the
 * extension's manifest permissions include `state_events` or
 * `matrix.read`. Extensions without those permissions never see this
 * message — the gate is enforced shell-side, not in the extension. */
export interface ConcordStateEventPayload {
  /** Matrix room ID where the event originated. */
  roomId: string;
  /** Matrix event type (e.g. `m.room.message`, `com.concord.foo.state`). */
  eventType: string;
  /** Opaque event content. Shape depends on `eventType`; the shell forwards
   *  the raw object without interpretation. */
  content: Record<string, unknown>;
  /** Matrix user ID of the event sender. */
  sender: string;
  /** Origin server timestamp in milliseconds since epoch. */
  originServerTs: number;
  /** Optional state_key for state events. Absent on message events. */
  stateKey?: string;
}

/** Sent back to an extension after a denied verb (INS-066 W6). */
export interface ConcordPermissionDeniedPayload {
  /** The verb name that was denied (e.g. `extension:send_state_event`). */
  action: string;
  /** Human-readable reason. Stable identifiers preferred:
   *  - "manifest_missing_permission"   — manifest didn't request the perm
   *  - "session_role_forbidden"        — InputRouter rejected the seat/mode
   *  - "manifest_unknown"              — shell has no manifest for this ext
   *  - "invalid_payload"               — payload shape was wrong
   */
  reason: string;
  /** Optional extra context (e.g. the missing permission name). */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Message envelope union (outbound: shell → iframe)
// ---------------------------------------------------------------------------

export type ConcordShellMessage =
  | { type: "concord:init"; payload: ConcordInitPayload; version: typeof CONCORD_SDK_VERSION }
  | { type: "concord:participant_join"; payload: ConcordParticipantJoinPayload; version: typeof CONCORD_SDK_VERSION }
  | { type: "concord:participant_leave"; payload: ConcordParticipantLeavePayload; version: typeof CONCORD_SDK_VERSION }
  | { type: "concord:host_transfer"; payload: ConcordHostTransferPayload; version: typeof CONCORD_SDK_VERSION }
  | { type: "concord:surface_resize"; payload: ConcordSurfaceResizePayload; version: typeof CONCORD_SDK_VERSION }
  | { type: "concord:state_event"; payload: ConcordStateEventPayload; version: typeof CONCORD_SDK_VERSION }
  | { type: "concord:permission_denied"; payload: ConcordPermissionDeniedPayload; version: typeof CONCORD_SDK_VERSION };

// ---------------------------------------------------------------------------
// Inbound (iframe → shell) verbs
// ---------------------------------------------------------------------------

/** Payload for `extension:send_state_event` (INS-066 W6).
 *
 * The extension requests that the shell emit a Matrix state event on its
 * behalf. The shell checks (a) InputRouter session/seat permission for
 * `send_state_events`, and (b) the manifest declared `state_events` or
 * `matrix.send` permission. Both gates must pass; otherwise a
 * `concord:permission_denied` is posted back. */
export interface ExtensionSendStateEventPayload {
  /** Optional Matrix room ID. When omitted, the shell uses the active
   *  room for the current session. Extensions are NOT allowed to send
   *  to arbitrary rooms — providing a room_id different from the
   *  current session's room is rejected. */
  roomId?: string;
  /** Matrix event type to emit, e.g. `com.concord.orrdia-bridge.queue`. */
  eventType: string;
  /** State key. Optional — defaults to empty string. */
  stateKey?: string;
  /** Event content. */
  content: Record<string, unknown>;
}

export type ExtensionInboundMessage = {
  type: "extension:send_state_event";
  payload: ExtensionSendStateEventPayload;
  version: typeof CONCORD_SDK_VERSION;
};

// ---------------------------------------------------------------------------
// Shell-side sender helpers (used by ExtensionSurfaceManager)
// ---------------------------------------------------------------------------

/**
 * Resolve the safe `targetOrigin` for a postMessage call to an iframe.
 *
 * The browser uses `targetOrigin` to decide whether the receiving
 * window's origin is the one we expected. Passing "*" is correct ONLY
 * when we don't care who reads the message. The SDK envelopes carry
 * Matrix event content (state events, permission errors, identity-bearing
 * init payloads), so we must scope to the iframe's actual origin.
 *
 * Failure mode: the iframe may have `frame.src` unset (newly mounted),
 * a non-parseable URL, or a `srcdoc`-style frame whose origin is the
 * shell's. In those cases we fall back to "*" with a warning so the
 * SDK message still arrives — silently failing to deliver would be
 * worse than the leak risk. Production runtime-installed extensions
 * always have a parseable absolute URL via the StaticFiles mount.
 */
export function resolvePostTargetOrigin(
  frame: HTMLIFrameElement | null | undefined,
): string {
  const src = frame?.src;
  if (!src) return "*";
  try {
    return new URL(src, typeof window !== "undefined" ? window.location.href : undefined).origin;
  } catch {
    if (typeof console !== "undefined" && console.warn) {
      console.warn(
        "[concord/sdk] postToFrame: could not parse iframe.src as URL, " +
          "falling back to targetOrigin '*'. src=",
        src,
      );
    }
    return "*";
  }
}

/**
 * Post a typed shell message to an iframe's contentWindow.
 * No-ops if the iframe or its contentWindow is not available.
 *
 * INS-066-FUP-F: tightened from `"*"` to the iframe's actual origin.
 * For runtime-installed `/ext/{id}/` extensions this is the shell's own
 * origin (same-origin), so the change is functionally a no-op there.
 * For hosted `*.concord.app` extensions and any future third-party
 * catalog hosts it prevents leaking Matrix event content to whatever
 * arbitrary origin the iframe might be navigated to.
 */
export function postToFrame(
  frame: HTMLIFrameElement | null | undefined,
  message: ConcordShellMessage,
): void {
  if (!frame?.contentWindow) return;
  const targetOrigin = resolvePostTargetOrigin(frame);
  frame.contentWindow.postMessage(message, targetOrigin);
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

/** Build a concord:state_event message envelope (INS-066 W5). */
export function buildStateEventMessage(
  payload: ConcordStateEventPayload,
): ConcordShellMessage {
  return { type: "concord:state_event", payload, version: CONCORD_SDK_VERSION };
}

/** Build a concord:permission_denied message envelope (INS-066 W6). */
export function buildPermissionDeniedMessage(
  payload: ConcordPermissionDeniedPayload,
): ConcordShellMessage {
  return { type: "concord:permission_denied", payload, version: CONCORD_SDK_VERSION };
}

// ---------------------------------------------------------------------------
// Inbound message helpers (used by the shell to validate iframe messages)
// ---------------------------------------------------------------------------

/** Type guard for inbound `extension:*` verbs (INS-066 W6).
 *
 * Used by the ExtensionSurfaceManager message handler to filter the
 * structured-verb subset of inbound postMessages from a typo'd or
 * legacy `extension_action` envelope. */
export function isExtensionInboundMessage(
  data: unknown,
): data is ExtensionInboundMessage {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.type === "string" &&
    d.type.startsWith("extension:") &&
    d.version === CONCORD_SDK_VERSION &&
    typeof d.payload === "object" &&
    d.payload !== null
  );
}

/** Manifest-permission gate used by both directions (INS-066 W5/W6).
 *
 * Returns true when the extension's manifest permissions array contains
 * any of the listed gate-permissions. The shell uses this to filter
 * outbound `concord:state_event` (gate: state_events or matrix.read)
 * and to gate inbound `extension:send_state_event` (gate: state_events
 * or matrix.send). When the manifest is unknown (no entry in the
 * installed-extensions registry), this returns false — fail closed. */
export function manifestAllows(
  manifestPermissions: readonly string[] | undefined,
  anyOf: readonly string[],
): boolean {
  if (!manifestPermissions) return false;
  for (const p of anyOf) {
    if (manifestPermissions.includes(p)) return true;
  }
  return false;
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
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.type === "string" &&
    d.type.startsWith("concord:") &&
    d.version === CONCORD_SDK_VERSION
  );
}
