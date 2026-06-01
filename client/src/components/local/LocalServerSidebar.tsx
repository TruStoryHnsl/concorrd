/**
 * LocalServerSidebar — the server-column for the active local source.
 *
 * Visual contract: identical to the Matrix `ServerSidebar` (icon column,
 * vertical stack of rounded-square tiles). The porch is the first
 * server; additional user-created local servers append below. The
 * Phase A backend only exposes one local "server" — the porch — so we
 * render exactly that tile and treat it as always-active.
 *
 * This is the source-kind-aware companion to ServerSidebar (option (b)
 * from the porch-as-source design choices). It does NOT synthesize a
 * Matrix room object; it reads `usePorchStore` directly and styles its
 * tile with the same Tailwind classes the Matrix sidebar uses so the
 * user sees the same visual primitive.
 */

import { memo } from "react";
import { useInstanceNameStore } from "../../stores/instanceName";

interface LocalServerSidebarProps {
  /** Mobile pass-through — switches from icon column to row list. */
  mobile?: boolean;
  /** Fires when a server tile is clicked. Mobile uses this to advance
   *  the scroll-strip to the channels panel. */
  onServerSelect?: () => void;
}

export const LocalServerSidebar = memo(function LocalServerSidebar({
  mobile = false,
  onServerSelect,
}: LocalServerSidebarProps) {
  const instanceName = useInstanceNameStore((s) => s.name);
  // The porch is always the first local "server". Its display name is
  // the user's vanity instance label when set; otherwise the literal
  // "porch" so the user can recognize the default landing pad.
  const porchLabel = instanceName.trim() || "porch";
  const abbreviation = porchLabel.charAt(0).toUpperCase();

  if (mobile) {
    // Mobile: row list. Mirrors the structure ServerSidebar uses for
    // its mobile branch (px-3 padding, rounded-xl rows, primary-glow
    // when active).
    return (
      <div className="h-full bg-surface-container-low overflow-y-auto overflow-x-hidden overscroll-y-auto p-3 flex flex-col">
        <h3 className="text-xs font-label font-medium text-on-surface-variant uppercase tracking-widest px-2 mb-3">
          Local Servers
        </h3>
        <div className="space-y-0.5">
          <button
            type="button"
            data-testid="local-server-tile-porch"
            onClick={() => onServerSelect?.()}
            title={porchLabel}
            className="btn-press w-full flex items-center gap-3 px-3 py-1.5 rounded-xl bg-primary/10 text-primary transition-all"
          >
            <div className="w-10 h-10 rounded-xl primary-glow text-on-primary flex items-center justify-center text-sm font-headline font-bold flex-shrink-0">
              {abbreviation}
            </div>
            <span className="truncate font-body font-medium">{porchLabel}</span>
          </button>
        </div>
      </div>
    );
  }

  // Desktop: icon column. Width and padding match ServerSidebar's
  // `w-[51px] pr-[3px]` outer + inner `py-3 flex flex-col items-center
  // gap-2`. The porch tile uses the same `w-12 h-12 rounded-xl
  // primary-glow` shape ServerSidebar applies to an active native
  // server.
  return (
    <div className="w-[51px] pr-[3px] bg-surface" style={{ height: "100%" }}>
      <div className="h-full overflow-y-auto overflow-x-hidden py-3 flex flex-col items-center gap-2 [&>*]:shrink-0">
        <div className="relative group">
          <button
            type="button"
            data-testid="local-server-tile-porch"
            onClick={() => onServerSelect?.()}
            title={porchLabel}
            aria-label={porchLabel}
            className="btn-press w-12 h-12 flex items-center justify-center text-sm font-headline font-bold transition-all primary-glow text-on-primary rounded-xl"
          >
            {abbreviation}
          </button>
        </div>
      </div>
    </div>
  );
});
