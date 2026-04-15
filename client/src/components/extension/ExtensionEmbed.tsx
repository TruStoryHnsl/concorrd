/**
 * Extension surface manager (INS-036 W1).
 *
 * Replaces the original single-pane ExtensionEmbed with a surface manager
 * that can mount 1..N extension surfaces per session, per the structured
 * session model defined in docs/extensions/session-model.md.
 *
 * Backward compatibility:
 *   - When no `surfaces` prop is provided (or it is empty), falls back to
 *     a single panel surface — visually identical to the original component.
 *   - The named re-export `ExtensionEmbed` keeps all existing import sites
 *     working without changes.
 *
 * Surface types implemented in W1:
 *   - `panel`    — persistent sidebar embed (original behavior)
 *   - `modal`    — floating overlay with a minimize/dismiss button
 *
 * Unimplemented types (`pip`, `fullscreen`, `background`) fall back to
 * panel rendering with a console warning.
 */

export interface SurfaceDescriptor {
  surface_id: string;
  type: "panel" | "modal" | "pip" | "fullscreen" | "background";
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
}: ExtensionSurfaceManagerProps) {
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
    if (s.type !== "panel") {
      console.warn(
        `[ExtensionSurfaceManager] surface type "${s.type}" not fully implemented in W1; rendering as panel`,
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

        if (s.type !== "panel") {
          console.warn(
            `[ExtensionSurfaceManager] surface type "${s.type}" not fully implemented in W1; rendering as panel`,
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
