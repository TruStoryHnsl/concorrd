/**
 * LocalServerSidebar — the server-column for the active local source.
 *
 * Per the 2026-06-01 CONSOLIDATED ARCHITECTURE filing in
 * `instructions_inbox.md`, the local source contains TWO intrinsic
 * default servers — both rendered here as tiles:
 *
 *   1. **Porch** — ephemeral guest doorman. Always labelled "porch"
 *      (not renamable). Gray-accented tile. The channels exposed by
 *      this tile come from the in-memory porch store (F1a parallel
 *      PR; until that lands, the porch tile is inert).
 *   2. **Home** — persistent local data layer (channels, voice rooms,
 *      apps, custom UI). Default label `"home"`; renamable via
 *      `home_set_server_name`. Primary-accented tile. Backed today
 *      by the existing porch SQLite (`src-tauri/src/porch/db.rs`);
 *      the module + file rename from `porch` → `home` is a follow-up
 *      PR (documented in `home_meta` migration v8).
 *
 * Future user-created persistent servers will append below these two
 * intrinsic entries — the JSX is already a list to make that simple.
 */

import { memo, useEffect } from "react";
import { useHomeServerNameStore } from "../../stores/homeServerName";
import { useLocalServerSelectionStore } from "../../stores/localServerSelection";

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
  const homeName = useHomeServerNameStore((s) => s.name);
  const loadHomeName = useHomeServerNameStore((s) => s.load);
  const active = useLocalServerSelectionStore((s) => s.active);
  const setActive = useLocalServerSelectionStore((s) => s.setActive);

  // Hydrate the home-server name on first mount — `load()` is
  // idempotent and a no-op on web. ChatLayout also calls this on
  // first mount so the tile is correct from first paint even if a
  // different code path reaches the sidebar first.
  useEffect(() => {
    void loadHomeName();
  }, [loadHomeName]);

  const homeLabel = homeName.trim() || "home";
  const porchLabel = "porch";

  const handleSelect = (next: "porch" | "home") => {
    setActive(next);
    onServerSelect?.();
  };

  const tiles = [
    {
      key: "porch" as const,
      label: porchLabel,
      testId: "local-server-tile-porch",
      // The porch is intentionally LOW-attention — gray surface, not
      // primary glow — because it's the always-fresh guest doorman,
      // not the user's primary surface.
      activeClass:
        "bg-surface-container-highest text-on-surface ring-2 ring-on-surface-variant/40",
      restClass:
        "bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface",
      mobileActiveRowClass: "bg-surface-container-highest/60",
    },
    {
      key: "home" as const,
      label: homeLabel,
      testId: "local-server-tile-home",
      // The home tile is the user's PRIMARY local surface — same
      // primary-glow treatment a Matrix server tile gets when active
      // in ServerSidebar.
      activeClass: "primary-glow text-on-primary",
      restClass:
        "bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface",
      mobileActiveRowClass: "bg-primary/10",
    },
  ];

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
          {tiles.map((t) => {
            const isActive = active === t.key;
            const abbreviation = t.label.charAt(0).toUpperCase();
            return (
              <button
                key={t.key}
                type="button"
                data-testid={t.testId}
                data-active={isActive}
                onClick={() => handleSelect(t.key)}
                title={t.label}
                className={`btn-press w-full flex items-center gap-3 px-3 py-1.5 rounded-xl transition-all ${
                  isActive ? t.mobileActiveRowClass : ""
                }`}
              >
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm font-headline font-bold flex-shrink-0 ${
                    isActive ? t.activeClass : t.restClass
                  }`}
                >
                  {abbreviation}
                </div>
                <span
                  className={`truncate font-body font-medium ${
                    isActive ? "text-on-surface" : "text-on-surface-variant"
                  }`}
                >
                  {t.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // Desktop: icon column. Width and padding match ServerSidebar's
  // `w-[51px] pr-[3px]` outer + inner `py-3 flex flex-col items-center
  // gap-2`. Each tile is the same `w-12 h-12 rounded-xl` shape
  // ServerSidebar applies to native servers.
  return (
    <div className="w-[51px] pr-[3px] bg-surface" style={{ height: "100%" }}>
      <div className="h-full overflow-y-auto overflow-x-hidden py-3 flex flex-col items-center gap-2 [&>*]:shrink-0">
        {tiles.map((t) => {
          const isActive = active === t.key;
          const abbreviation = t.label.charAt(0).toUpperCase();
          return (
            <div key={t.key} className="relative group">
              <button
                type="button"
                data-testid={t.testId}
                data-active={isActive}
                onClick={() => handleSelect(t.key)}
                title={t.label}
                aria-label={t.label}
                className={`btn-press w-12 h-12 flex items-center justify-center text-sm font-headline font-bold transition-all rounded-xl ${
                  isActive ? t.activeClass : t.restClass
                }`}
              >
                {abbreviation}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
});
