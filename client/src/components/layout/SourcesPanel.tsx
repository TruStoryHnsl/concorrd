/**
 * SourcesPanel — thin icon-only source switcher.
 *
 * Design: narrow dark column (w-14), square tiles per source,
 * no text labels. Each tile has a title tooltip. Active source
 * gets a white left-side pill indicator. Header: Explore. Footer:
 * Add Source below the registered source stack.
 *
 * Tile colors:
 *   concord / default → primary brand color, first letter
 *   matrix            → teal, "M"
 *   discord-bot       → Discord blurple (#5865F2), game controller icon
 *   discord-account   → Discord blurple (#5865F2), person icon
 */

import { useEffect, useState } from "react";
import { useSourcesStore, type ConcordSource } from "../../stores/sources";

function sourceTile(source: ConcordSource): {
  bg: string;
  icon: React.ReactNode;
  label: string;
} {
  const label = source.instanceName ?? source.host;
  switch (source.platform) {
    case "discord-bot":
      return {
        bg: "bg-[#5865F2]",
        icon: <span className="material-symbols-outlined text-white text-lg">videogame_asset</span>,
        label: `Discord Bridge — ${label}`,
      };
    case "discord-account":
      return {
        bg: "bg-[#5865F2]",
        icon: <span className="material-symbols-outlined text-white text-lg">person_play</span>,
        label: `Discord Account — ${label}`,
      };
    case "matrix":
      return {
        bg: "bg-teal-700",
        icon: <span className="text-white text-sm font-bold">M</span>,
        label: `Matrix — ${label}`,
      };
    default:
      return {
        bg: "bg-primary",
        icon: <span className="text-on-primary text-sm font-bold">{label.charAt(0).toUpperCase()}</span>,
        label,
      };
  }
}

export function SourcesPanel({
  onAddSource,
  onSourceSelect,
  onSourceOpen,
  onExplore,
}: {
  onAddSource: () => void;
  onSourceSelect?: (sourceId: string) => void;
  /** Called when a tile is clicked — opens the source browser for that source. */
  onSourceOpen?: (sourceId: string) => void;
  onExplore?: () => void;
}) {
  const sources = useSourcesStore((s) => s.sources);
  const toggleSource = useSourcesStore((s) => s.toggleSource);
  const [menu, setMenu] = useState<{ sourceId: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const handleClick = () => setMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", handleClick);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu]);

  const handleToggle = (id: string) => {
    toggleSource(id);
    onSourceSelect?.(id);
  };

  return (
    <div className="h-full w-full bg-surface flex flex-col items-center py-3 gap-0">
      <div className="flex-shrink-0 flex flex-col items-center gap-2 pb-2 pt-1">
        {onExplore && (
          <button
            onClick={onExplore}
            title="Explore"
            className="w-10 h-10 rounded-xl hover:rounded-2xl bg-surface-container-high hover:bg-surface-container-highest flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-all duration-150"
          >
            <span className="material-symbols-outlined text-xl">explore</span>
          </button>
        )}
      </div>

      {(onExplore || sources.length > 0) && (
        <div className="w-8 h-px bg-outline-variant/20 flex-shrink-0 my-1" />
      )}

      {/* Source tiles — scrollable, top-down */}
      <div className="flex-1 min-h-0 overflow-y-auto w-full flex flex-col items-center gap-2 py-1 scrollbar-none">
        {sources.map((source) => {
          const { bg, icon, label } = sourceTile(source);
          const isEnabled = source.enabled;
          return (
            <div
              key={source.id}
              className="relative w-full flex items-center justify-center flex-shrink-0"
            >
              {/* Active pill — white bar on the left edge */}
              <div
                className={`absolute left-0 w-1 rounded-r-full bg-white transition-all duration-150 ${
                  isEnabled ? "h-8 opacity-100" : "h-2 opacity-0 group-hover:opacity-60 group-hover:h-4"
                }`}
              />
              <button
                onClick={() => handleToggle(source.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setMenu({ sourceId: source.id, x: event.clientX, y: event.clientY });
                }}
                title={label}
                className={`group w-10 h-10 flex items-center justify-center transition-all duration-150 ${bg} ${
                  isEnabled
                    ? "rounded-2xl shadow-lg scale-100"
                    : "rounded-xl hover:rounded-2xl scale-95 hover:scale-100 opacity-50 hover:opacity-80 grayscale"
                }`}
              >
                {icon}
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex-shrink-0 pt-2">
        <button
          onClick={onAddSource}
          title="Add Source"
          className="w-10 h-10 rounded-xl hover:rounded-2xl bg-surface-container-high hover:bg-surface-container-highest flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-all duration-150"
        >
          <span className="material-symbols-outlined text-xl">add</span>
        </button>
      </div>

      {menu && (() => {
        const source = sources.find((entry) => entry.id === menu.sourceId);
        if (!source) return null;
        return (
          <div
            className="fixed inset-0 z-50"
            onClick={() => setMenu(null)}
          >
            <div
              className="absolute min-w-44 rounded-xl border border-outline-variant/20 bg-surface-container shadow-2xl p-1"
              style={{ left: menu.x, top: menu.y }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                onClick={() => {
                  onSourceOpen?.(source.id);
                  setMenu(null);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-on-surface hover:bg-surface-container-high transition-colors"
              >
                <span className="material-symbols-outlined text-base">open_in_new</span>
                Open source menu
              </button>
              <button
                onClick={() => {
                  handleToggle(source.id);
                  setMenu(null);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-on-surface hover:bg-surface-container-high transition-colors"
              >
                <span className="material-symbols-outlined text-base">
                  {source.enabled ? "visibility_off" : "visibility"}
                </span>
                {source.enabled ? "Disable source" : "Enable source"}
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
