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
  type ConcordInitPayload,
} from "../../extensions/sdk";

export interface SurfaceDescriptor {
  surface_id: string;
  type: "panel" | "modal" | "pip" | "fullscreen" | "background" | "browser";
  anchor: "left_sidebar" | "right_sidebar" | "bottom_bar" | "center" | "none";
  min_width_px?: number;
  min_height_px?: number;
  preferred_aspect?: string | null;
  z_index?: number;
}

interface ExtensionSurfaceManagerProps {
  url: string;
  extensionName: string;
  hostUserId: string;
  isHost: boolean;
  onStop: () => void;
  /** Optional array of surface descriptors from the session model.
   *  When absent or empty, a single panel surface is rendered. */
  surfaces?: SurfaceDescriptor[];
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
}: ExtensionSurfaceManagerProps) {
  // W4: Container ref for SDK message targeting and ResizeObserver.
  const containerRef = useRef<HTMLDivElement>(null);

  // W4: Send concord:init to all iframes in the container on mount.
  // Deferred 100 ms so the iframes have time to load their srcdoc/src before
  // they can receive postMessage events.
  useEffect(() => {
    if (!sdkInit) return;
    const activeSurfs = surfaces && surfaces.length > 0 ? surfaces : [DEFAULT_SURFACE];
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
        const activeSurfs = surfaces && surfaces.length > 0 ? surfaces : [DEFAULT_SURFACE];
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

  // Normalize: empty/absent → single default panel surface.
  const activeSurfaces =
    surfaces && surfaces.length > 0 ? surfaces : [DEFAULT_SURFACE];

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
