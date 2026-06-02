/**
 * Extension surface manager (INS-036 W1 + W2 + W3 + W4).
 *
 * Replaces the original single-pane ExtensionEmbed with a surface manager
 * that can mount 1..N extension surfaces per session, per the structured
 * session model defined in docs/extensions/session-model.md.
 *
 * W2 adds: InputRouter permission enforcement — postMessage actions from iframes
 * are checked against the session mode + participant seat before being forwarded.
 *
 * W3 adds: "browser" surface type — sandboxed iframe with *.concord.app allowlist.
 *
 * W4 adds: Shell → extension SDK (outbound postMessage protocol).
 *   - concord:init      sent to each iframe on mount with session context
 *   - concord:surface_resize  sent via ResizeObserver when container dimensions change
 *   Participant join/leave and host_transfer messages are emitted by the caller
 *   via the useExtensionSession() hook (see docs/extensions/shell-api.md).
 *
 * Backward compatibility:
 *   - When no `surfaces` prop is provided (or it is empty), falls back to
 *     a single panel surface — visually identical to the original component.
 *   - The named re-export `ExtensionEmbed` keeps all existing import sites
 *     working without changes.
 *   - `mode` and `participantSeat` props are optional, defaulting to "shared"
 *     and "participant" for backward compat.
 *
 * Surface types:
 *   - `panel`      — persistent sidebar embed (original behavior)
 *   - `modal`      — floating overlay with a minimize/dismiss button
 *   - `browser`    — sandboxed web app (*.concord.app only, W3)
 *   - `pip`, `fullscreen`, `background` — fall back to panel with console warning
 */

import { useEffect, useRef } from "react";
import BrowserSurface from "./BrowserSurface";
import { check, type Mode, type Seat, type InputAction } from "./InputRouter";
import {
  postToFrame,
  buildInitMessage,
  buildSurfaceResizeMessage,
  buildStateEventMessage,
  buildPermissionDeniedMessage,
  isExtensionInboundMessage,
  manifestAllows,
  type ConcordInitPayload,
  type ConcordStateEventPayload,
  type ExtensionSendStateEventPayload,
} from "../../extensions/sdk";
import type { ExtensionSurface } from "../../stores/extension";

export interface SurfaceDescriptor {
  surface_id: string;
  type: "panel" | "modal" | "pip" | "fullscreen" | "background" | "browser";
  anchor: "left_sidebar" | "right_sidebar" | "bottom_bar" | "center" | "none";
  min_width_px?: number;
  min_height_px?: number;
  preferred_aspect?: string | null;
  z_index?: number;
}

/** Input accepted by the `surfaces` prop — either the layout-level
 *  `SurfaceDescriptor` (used by SDK / legacy callers) or the session-model
 *  `ExtensionSurface` coming straight from the store. The latter is normalized
 *  to the former by `toSurfaceDescriptor` before any rendering or SDK dispatch. */
export type SurfaceInput = SurfaceDescriptor | ExtensionSurface;

const VALID_ANCHORS: ReadonlyArray<SurfaceDescriptor["anchor"]> = [
  "left_sidebar",
  "right_sidebar",
  "bottom_bar",
  "center",
  "none",
];

/** Normalize a store-level `ExtensionSurface` into a layout `SurfaceDescriptor`.
 *  Pulls anchor / sizing hints out of the freeform `layout` record when present;
 *  otherwise falls back to a right-sidebar panel — same defaults as DEFAULT_SURFACE. */
export function toSurfaceDescriptor(s: SurfaceInput): SurfaceDescriptor {
  if ("type" in s) return s;
  const layout = (s.layout ?? {}) as Record<string, unknown>;
  const anchor = layout.anchor;
  const minW = layout.min_width_px;
  const minH = layout.min_height_px;
  const preferredAspect = layout.preferred_aspect;
  const zIndex = layout.z_index;
  return {
    surface_id: s.surface_id,
    type: "panel",
    anchor:
      typeof anchor === "string" && (VALID_ANCHORS as readonly string[]).includes(anchor)
        ? (anchor as SurfaceDescriptor["anchor"])
        : "right_sidebar",
    min_width_px: typeof minW === "number" ? minW : undefined,
    min_height_px: typeof minH === "number" ? minH : undefined,
    preferred_aspect:
      typeof preferredAspect === "string" || preferredAspect === null
        ? (preferredAspect as string | null)
        : undefined,
    z_index: typeof zIndex === "number" ? zIndex : undefined,
  };
}

interface ExtensionSurfaceManagerProps {
  url: string;
  extensionName: string;
  hostUserId: string;
  isHost: boolean;
  onStop: () => void;
  /** Optional array of surfaces from the session model. Accepts either
   *  layout-level `SurfaceDescriptor`s (SDK / legacy callers) or store-level
   *  `ExtensionSurface`s straight from the session state; the latter are
   *  normalized internally via `toSurfaceDescriptor`.
   *  When absent or empty, a single panel surface is rendered. */
  surfaces?: SurfaceInput[];
  /**
   * Session interaction mode from the extension session model §2.2.
   * Defaults to "shared" for backward compat.
   */
  mode?: Mode;
  /**
   * Current participant's seat role from the session model §2.4.
   * Defaults to "participant" for backward compat.
   */
  participantSeat?: Seat;
  /**
   * W4: SDK init context. When provided, a concord:init message is posted to
   * each mounted iframe so extensions can read identity/session/seat without
   * any direct access to Concord internals.
   *
   * If absent, iframes are mounted without an init message (legacy behavior).
   */
  sdkInit?: Omit<ConcordInitPayload, "surfaces">;
  /**
   * INS-066 W5/W6/W7: extension manifest permissions array.
   * Used as the gate for concord:state_event delivery (W5) and
   * extension:send_state_event acceptance (W6). When absent, both are
   * fail-closed (no events forwarded; verbs denied with manifest_unknown).
   */
  manifestPermissions?: readonly string[];
  /**
   * INS-066 W5: the Matrix room ID the extension session is attached to.
   * Used as the source room for concord:state_event forwarding and the
   * default target for extension:send_state_event. When absent, neither
   * direction works (the shell logs a single warning and degrades).
   */
  roomId?: string;
  /**
   * INS-066 W5: subscribe to the Matrix room's incoming state/timeline
   * events. Called once on mount with a callback the room store should
   * invoke for each new event. Returns an unsubscribe function.
   *
   * Decoupled from any specific room store so this component stays
   * testable in isolation; the call site wires it up.
   */
  subscribeRoomEvents?: (
    handler: (ev: IncomingMatrixEvent) => void,
  ) => () => void;
  /**
   * INS-066 W6: callback invoked when an extension's
   * extension:send_state_event verb passes both gates (InputRouter +
   * manifest). The handler is responsible for actually emitting via the
   * room store / matrix-js-sdk client. Resolved value is ignored; reject
   * the promise to surface a backend error to the extension as a
   * permission_denied with reason="backend_error".
   */
  onSendStateEvent?: (
    args: { roomId: string; eventType: string; stateKey: string; content: Record<string, unknown> },
  ) => void | Promise<void>;
}

/** Shape of an incoming Matrix room event consumed by `subscribeRoomEvents`.
 *  Modelled after matrix-js-sdk MatrixEvent.toJSON() but kept minimal so
 *  the shell layer doesn't need to depend on the SDK type. */
export interface IncomingMatrixEvent {
  type: string;
  content: Record<string, unknown>;
  sender: string;
  origin_server_ts: number;
  state_key?: string;
}

/** Shortens a Matrix user ID to just the localpart (e.g. "@corr:server" → "corr"). */
function displayName(userId: string): string {
  return userId.split(":")[0].replace("@", "");
}

/** Default single-surface descriptor used when none are provided. */
const DEFAULT_SURFACE: SurfaceDescriptor = {
  surface_id: "__default__",
  type: "panel",
  anchor: "right_sidebar",
  z_index: 50,
};

/** Shared iframe + header for a single panel-type surface. */
function SurfacePane({
  surface,
  url,
  extensionName,
  hostUserId,
  isHost,
  onStop,
  showHeader,
}: {
  surface: SurfaceDescriptor;
  url: string;
  extensionName: string;
  hostUserId: string;
  isHost: boolean;
  onStop: () => void;
  showHeader: boolean;
}) {
  return (
    <div className="flex flex-col h-full min-h-0 bg-surface">
      {showHeader && (
        <div className="h-10 flex items-center justify-between px-3 bg-surface-container-low border-b border-outline-variant/20 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="material-symbols-outlined text-base text-primary">
              extension
            </span>
            <span className="text-sm font-headline font-semibold truncate text-on-surface">
              {extensionName}
            </span>
            <span className="text-xs text-on-surface-variant font-label truncate">
              hosted by {displayName(hostUserId)}
            </span>
          </div>
          {isHost && (
            <button
              onClick={onStop}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-label text-error hover:bg-error/10 transition-colors flex-shrink-0"
            >
              <span className="material-symbols-outlined text-sm">stop</span>
              Stop
            </button>
          )}
        </div>
      )}

      <iframe
        key={surface.surface_id}
        src={url}
        sandbox="allow-scripts allow-same-origin"
        className="flex-1 w-full border-0 min-h-0"
        title={extensionName}
        style={surface.min_width_px ? { minWidth: surface.min_width_px } : undefined}
      />
    </div>
  );
}

/** Modal overlay surface (floating, dismissible). */
function ModalSurface({
  surface,
  url,
  extensionName,
  hostUserId,
  isHost,
  onStop,
  isPrimary,
}: {
  surface: SurfaceDescriptor;
  url: string;
  extensionName: string;
  hostUserId: string;
  isHost: boolean;
  onStop: () => void;
  isPrimary: boolean;
}) {
  const minW = surface.min_width_px ?? 480;
  const minH = surface.min_height_px ?? 320;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/40"
      style={{ zIndex: surface.z_index ?? 100 }}
    >
      <div
        className="relative flex flex-col rounded-xl overflow-hidden shadow-2xl border border-outline-variant/20 bg-surface"
        style={{ minWidth: minW, minHeight: minH, width: minW, height: minH }}
      >
        <div className="h-10 flex items-center justify-between px-3 bg-surface-container-low border-b border-outline-variant/20 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="material-symbols-outlined text-base text-primary">
              extension
            </span>
            <span className="text-sm font-headline font-semibold truncate text-on-surface">
              {extensionName}
            </span>
            <span className="text-xs text-on-surface-variant font-label truncate">
              hosted by {displayName(hostUserId)}
            </span>
          </div>
          {isPrimary && isHost && (
            <button
              onClick={onStop}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-label text-error hover:bg-error/10 transition-colors flex-shrink-0"
            >
              <span className="material-symbols-outlined text-sm">stop</span>
              Stop
            </button>
          )}
        </div>

        <iframe
          key={surface.surface_id}
          src={url}
          sandbox="allow-scripts allow-same-origin"
          className="flex-1 w-full border-0 min-h-0"
          title={extensionName}
        />
      </div>
    </div>
  );
}

export default function ExtensionSurfaceManager({
  url,
  extensionName,
  hostUserId,
  isHost,
  onStop,
  surfaces,
  mode = "shared",
  participantSeat = "participant",
  sdkInit,
  manifestPermissions,
  roomId,
  subscribeRoomEvents,
  onSendStateEvent,
}: ExtensionSurfaceManagerProps) {
  // W4: Container ref for SDK message targeting and ResizeObserver.
  const containerRef = useRef<HTMLDivElement>(null);

  // Normalize the union input down to SurfaceDescriptor[] once so every
  // downstream path (SDK init payload, ResizeObserver, render) sees a single
  // shape. Both the layout-level descriptor and the session-model surface
  // carry enough info for rendering; the normalizer defaults missing fields.
  const normalizedSurfaces: SurfaceDescriptor[] | undefined = surfaces?.map(
    toSurfaceDescriptor,
  );

  // W4: Send concord:init to all iframes in the container on mount.
  // Deferred 100 ms so the iframes have time to load their srcdoc/src before
  // they can receive postMessage events.
  useEffect(() => {
    if (!sdkInit) return;
    const activeSurfs =
      normalizedSurfaces && normalizedSurfaces.length > 0
        ? normalizedSurfaces
        : [DEFAULT_SURFACE];
    const payload: ConcordInitPayload = { ...sdkInit, surfaces: activeSurfs };
    const msg = buildInitMessage(payload);
    const timer = setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;
      const frames = container.querySelectorAll<HTMLIFrameElement>("iframe");
      frames.forEach((frame) => postToFrame(frame, msg));
    }, 100);
    return () => clearTimeout(timer);
  // Re-send on session/identity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkInit?.sessionId, sdkInit?.participantId, sdkInit?.seat, mode]);

  // W4: ResizeObserver — send concord:surface_resize when the container size changes.
  useEffect(() => {
    if (!sdkInit) return;
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        // Use the first matching surface_id or the default.
        const activeSurfs =
          normalizedSurfaces && normalizedSurfaces.length > 0
            ? normalizedSurfaces
            : [DEFAULT_SURFACE];
        activeSurfs.forEach((s) => {
          const msg = buildSurfaceResizeMessage({
            surfaceId: s.surface_id,
            widthPx: Math.round(width),
            heightPx: Math.round(height),
          });
          const frames = container.querySelectorAll<HTMLIFrameElement>("iframe");
          frames.forEach((frame) => postToFrame(frame, msg));
        });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkInit?.sessionId]);

  // W2: InputRouter — intercept postMessage actions from extension iframes and
  // enforce session mode + seat permissions before forwarding.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      // Only handle structured extension action messages.
      if (
        !event.data ||
        typeof event.data !== "object" ||
        event.data.type !== "extension_action"
      ) {
        return;
      }
      const action = event.data.action as InputAction;
      const allowed = check(mode, participantSeat, action, event.data.permissions ?? undefined);
      if (!allowed) {
        console.warn(
          "[InputRouter] blocked action",
          action,
          "for seat",
          participantSeat,
          "in mode",
          mode,
        );
        return;
      }
      // Reflect allowed action back to the originating frame so the extension
      // knows its action was accepted by the host.
      if (event.source && "postMessage" in event.source) {
        (event.source as Window).postMessage(
          { type: "extension_action_ack", action, allowed: true },
          "*",
        );
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [mode, participantSeat]);

  // INS-066 W5: forward Matrix room events to mounted extension iframes
  // as `concord:state_event`, gated by manifest permissions
  // (state_events OR matrix.read). When the manifest doesn't declare
  // either, the extension never sees these events. Fail-closed by
  // design — silently drops the subscription rather than throwing.
  useEffect(() => {
    if (!subscribeRoomEvents || !roomId) return;
    if (!manifestAllows(manifestPermissions, ["state_events", "matrix.read"])) return;

    const unsub = subscribeRoomEvents((ev) => {
      const container = containerRef.current;
      if (!container) return;
      const payload: ConcordStateEventPayload = {
        roomId,
        eventType: ev.type,
        content: ev.content,
        sender: ev.sender,
        originServerTs: ev.origin_server_ts,
        ...(ev.state_key !== undefined ? { stateKey: ev.state_key } : {}),
      };
      const msg = buildStateEventMessage(payload);
      const frames = container.querySelectorAll<HTMLIFrameElement>("iframe");
      frames.forEach((frame) => postToFrame(frame, msg));
    });
    return unsub;
  }, [subscribeRoomEvents, roomId, manifestPermissions]);

  // INS-066 W6: handle inbound `extension:send_state_event` verbs.
  // Two gates: (a) InputRouter check on (mode, seat, send_state_events),
  // and (b) manifest permission must contain state_events or matrix.send.
  // Both must pass; otherwise post back a structured
  // `concord:permission_denied` to the originating iframe so the
  // extension can react. On allow, the shell calls `onSendStateEvent` —
  // the host (room store) is responsible for the actual emit.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (!isExtensionInboundMessage(event.data)) return;
      if (event.data.type !== "extension:send_state_event") return;

      const payload = event.data.payload as ExtensionSendStateEventPayload;
      const replyTo = event.source as Window | null;
      const reply = (
        reason: string,
        detail?: string,
      ) => {
        if (!replyTo || !("postMessage" in replyTo)) return;
        replyTo.postMessage(
          buildPermissionDeniedMessage({
            action: "extension:send_state_event",
            reason,
            ...(detail !== undefined ? { detail } : {}),
          }),
          "*",
        );
      };

      // Gate 0: payload sanity.
      if (
        !payload ||
        typeof payload.eventType !== "string" ||
        typeof payload.content !== "object" ||
        payload.content === null
      ) {
        reply("invalid_payload");
        return;
      }

      // Gate 0.5: cross-room forbidden. If the extension supplied a
      // roomId different from the session room, reject.
      const targetRoom = payload.roomId ?? roomId;
      if (!targetRoom) {
        reply("invalid_payload", "no_room");
        return;
      }
      if (payload.roomId && roomId && payload.roomId !== roomId) {
        reply("session_role_forbidden", "cross_room");
        return;
      }

      // Gate 1: InputRouter.
      if (!check(mode, participantSeat, "send_state_events")) {
        reply("session_role_forbidden");
        return;
      }

      // Gate 2: manifest permission.
      if (!manifestPermissions) {
        reply("manifest_unknown");
        return;
      }
      if (!manifestAllows(manifestPermissions, ["state_events", "matrix.send"])) {
        reply("manifest_missing_permission", "state_events|matrix.send");
        return;
      }

      // Allowed — emit via the host. We don't await the result here so
      // the message handler stays synchronous; if the emit rejects, the
      // host is expected to log and the extension simply doesn't see
      // the event reflected back.
      try {
        const r = onSendStateEvent?.({
          roomId: targetRoom,
          eventType: payload.eventType,
          stateKey: payload.stateKey ?? "",
          content: payload.content,
        });
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((err) => {
            console.warn("[ExtensionSurfaceManager] send_state_event backend error", err);
            reply("backend_error", String(err));
          });
        }
      } catch (err) {
        console.warn("[ExtensionSurfaceManager] send_state_event threw", err);
        reply("backend_error", String(err));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [mode, participantSeat, manifestPermissions, roomId, onSendStateEvent]);

  // Normalize: empty/absent → single default panel surface.
  const activeSurfaces =
    normalizedSurfaces && normalizedSurfaces.length > 0
      ? normalizedSurfaces
      : [DEFAULT_SURFACE];

  // Sort by z_index ascending so index 0 is the "primary" (lowest z / first).
  const sorted = [...activeSurfaces].sort(
    (a, b) => (a.z_index ?? 0) - (b.z_index ?? 0),
  );

  // Single-surface fast path — zero visual regression.
  // W4: All paths are wrapped in containerRef for SDK message targeting.
  if (sorted.length === 1) {
    const s = sorted[0];
    if (s.type === "modal") {
      return (
        <div ref={containerRef} className="contents">
          <ModalSurface
            surface={s}
            url={url}
            extensionName={extensionName}
            hostUserId={hostUserId}
            isHost={isHost}
            onStop={onStop}
            isPrimary={true}
          />
        </div>
      );
    }
    if (s.type === "browser") {
      return (
        <div ref={containerRef} className="contents">
          <BrowserSurface surface={s} src={url} title={extensionName} />
        </div>
      );
    }
    if (s.type !== "panel") {
      console.warn(
        `[ExtensionSurfaceManager] surface type "${s.type}" not fully implemented; rendering as panel`,
      );
    }
    return (
      <div ref={containerRef} className="flex flex-col h-full min-h-0">
        <SurfacePane
          surface={s}
          url={url}
          extensionName={extensionName}
          hostUserId={hostUserId}
          isHost={isHost}
          onStop={onStop}
          showHeader={true}
        />
      </div>
    );
  }

  // Multi-surface path.
  return (
    <div ref={containerRef} className="contents">
      {sorted.map((s, idx) => {
        const isPrimary = idx === 0;

        if (s.type === "modal") {
          return (
            <ModalSurface
              key={s.surface_id}
              surface={s}
              url={url}
              extensionName={extensionName}
              hostUserId={hostUserId}
              isHost={isHost}
              onStop={onStop}
              isPrimary={isPrimary}
            />
          );
        }

        if (s.type === "browser") {
          return (
            <div
              key={s.surface_id}
              className="flex flex-col min-h-0"
              style={{
                zIndex: s.z_index,
                minWidth: s.min_width_px,
                minHeight: s.min_height_px,
              }}
            >
              <BrowserSurface surface={s} src={url} title={extensionName} />
            </div>
          );
        }

        if (s.type !== "panel") {
          console.warn(
            `[ExtensionSurfaceManager] surface type "${s.type}" not fully implemented; rendering as panel`,
          );
        }

        return (
          <div
            key={s.surface_id}
            className="flex flex-col min-h-0"
            style={{
              zIndex: s.z_index,
              minWidth: s.min_width_px,
              minHeight: s.min_height_px,
            }}
          >
            <SurfacePane
              surface={s}
              url={url}
              extensionName={extensionName}
              hostUserId={hostUserId}
              isHost={isHost}
              onStop={onStop}
              showHeader={isPrimary}
            />
          </div>
        );
      })}
    </div>
  );
}

// Named re-export for backward compat — existing import sites use `ExtensionEmbed`.
export { ExtensionSurfaceManager as ExtensionEmbed };

// =============================================================================
// Migration helper (INS-036 W5 — §5 migration path)
// =============================================================================

/** A legacy com.concord.extension Matrix room state event. */
export interface LegacyExtensionEvent {
  type: "com.concord.extension";
  /** state_key is the extension_id in the legacy format */
  state_key: string;
  /** Matrix user ID of the event sender */
  sender: string;
  /** Opaque blob — may contain a "src" field used as the iframe URL */
  content: Record<string, unknown>;
}

/** A structured com.concord.extension.session Matrix room state event. */
export interface SessionEvent {
  type: "com.concord.extension.session";
  /** state_key is the session_id */
  state_key: string;
  content: {
    session_id: string;
    extension_id: string;
    mode: "shared";
    version: string;
    created_at: number;
    created_by: string;
    surfaces: SurfaceDescriptor[];
    participants: Array<{
      user_id: string;
      seat: "host";
      joined_at: number;
      surface_id: null;
    }>;
    launch_descriptor: {
      loader: "iframe";
      src: string;
      integrity: string;
      csp_overrides: never[];
      initial_state_event_type: string;
      capabilities_required: never[];
      capabilities_optional: never[];
    };
    input_permissions: Record<string, string[]>;
    metadata: Record<string, unknown>;
  };
}

/**
 * Migrate a legacy `com.concord.extension` event to the structured session model
 * (INS-036 §5 migration path, session-model.md §5).
 *
 * Produces a `com.concord.extension.session` event with:
 * - mode: "shared" (legacy sessions had no mode concept)
 * - created_by: legacy.sender
 * - A single default panel surface (right_sidebar)
 * - The legacy sender promoted to host seat
 * - src extracted from legacy.content.src if present, otherwise ""
 * - metadata = legacy.content minus the "src" field
 */
export function migrateToSessionModel(legacy: LegacyExtensionEvent): SessionEvent {
  const sessionId = crypto.randomUUID();
  const now = Date.now();

  const { src, ...restContent } = legacy.content;
  const srcStr = typeof src === "string" ? src : "";

  const defaultSurface: SurfaceDescriptor = {
    surface_id: crypto.randomUUID(),
    type: "panel",
    anchor: "right_sidebar",
    z_index: 50,
  };

  return {
    type: "com.concord.extension.session",
    state_key: sessionId,
    content: {
      session_id: sessionId,
      extension_id: legacy.state_key,
      mode: "shared",
      version: "0.0.0",
      created_at: now,
      created_by: legacy.sender,
      surfaces: [defaultSurface],
      participants: [
        {
          user_id: legacy.sender,
          seat: "host",
          joined_at: now,
          surface_id: null,
        },
      ],
      launch_descriptor: {
        loader: "iframe",
        src: srcStr,
        integrity: "",
        csp_overrides: [] as never[],
        initial_state_event_type: `com.concord.${legacy.state_key}.state`,
        capabilities_required: [] as never[],
        capabilities_optional: [] as never[],
      },
      input_permissions: {
        send_state_events: ["host", "participant"],
        send_to_device: ["host", "participant"],
        react: ["host", "participant", "observer"],
        pointer_events: ["host", "participant"],
        admin_commands: ["host"],
      },
      metadata: restContent,
    },
  };
}
