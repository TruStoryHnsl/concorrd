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

import { useState } from "react";
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
  const [activeId, setActiveId] = useState<string | null>(
    sources.length > 0 ? sources[0].id : null,
  );

  const handleSelect = (id: string) => {
    setActiveId(id);
    onSourceSelect?.(id);
    onSourceOpen?.(id);
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
          const isActive = activeId === source.id;
          return (
            <div
              key={source.id}
              className="relative w-full flex items-center justify-center flex-shrink-0"
            >
              {/* Active pill — white bar on the left edge */}
              <div
                className={`absolute left-0 w-1 rounded-r-full bg-white transition-all duration-150 ${
                  isActive ? "h-8 opacity-100" : "h-2 opacity-0 group-hover:opacity-60 group-hover:h-4"
                }`}
              />
              <button
                onClick={() => handleSelect(source.id)}
                title={label}
                className={`group w-10 h-10 flex items-center justify-center transition-all duration-150 ${bg} ${
                  isActive
                    ? "rounded-2xl shadow-lg scale-100"
                    : "rounded-xl hover:rounded-2xl scale-95 hover:scale-100 opacity-80 hover:opacity-100"
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
    </div>
  );
}
