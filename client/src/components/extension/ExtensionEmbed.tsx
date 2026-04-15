/**
 * Extension surface manager (INS-036 W1 + W2 + W3).
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

import { useEffect } from "react";
import BrowserSurface from "./BrowserSurface";
import { check, type Mode, type Seat, type InputAction } from "./InputRouter";

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
}: ExtensionSurfaceManagerProps) {
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
  if (sorted.length === 1) {
    const s = sorted[0];
    if (s.type === "modal") {
      return (
        <ModalSurface
          surface={s}
          url={url}
          extensionName={extensionName}
          hostUserId={hostUserId}
          isHost={isHost}
          onStop={onStop}
          isPrimary={true}
        />
      );
    }
    if (s.type === "browser") {
      return <BrowserSurface surface={s} src={url} title={extensionName} />;
    }
    if (s.type !== "panel") {
      console.warn(
        `[ExtensionSurfaceManager] surface type "${s.type}" not fully implemented; rendering as panel`,
      );
    }
    return (
      <SurfacePane
        surface={s}
        url={url}
        extensionName={extensionName}
        hostUserId={hostUserId}
        isHost={isHost}
        onStop={onStop}
        showHeader={true}
      />
    );
  }

  // Multi-surface path.
  return (
    <>
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
    </>
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
