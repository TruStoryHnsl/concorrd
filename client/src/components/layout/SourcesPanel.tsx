/**
 * SourcesPanel — the leftmost panel on native apps (INS-020).
 *
 * Architecture (2026-04-11 spec):
 *
 *   ┌────────────────┐
 *   │ SOURCES        │  ← header
 *   ├────────────────┤
 *   │                │
 *   │  source row 1  │  ← list region (scrollable). Sources stack
 *   │  source row 2  │    from the BOTTOM, with the most-recent
 *   │  ...           │    addition adjacent to the footer.
 *   │                │
 *   │ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │  ← spacer (flex-grow)
 *   │                │
 *   │  + Add Source  │  ← always-visible footer tile
 *   │  Explore       │  ← always-visible footer tile
 *   └────────────────┘
 *
 * The footer tiles (`+ Add Source` and `Explore`) live in their own
 * container so they're always at the bottom of the column regardless
 * of whether the source list is empty or full. The spacer between
 * the list and the footer pushes the footer down on a tall column.
 *
 * The Explore tile used to live in the rooms (ChannelSidebar) column;
 * it was moved here per the user spec — federated rooms / Discord
 * rooms still stack from the bottom of the rooms column, but the
 * "browse the federation catalog" affordance is a Sources concern.
 *
 * The list region uses `flex-col-reverse` so the source array's
 * insertion order maps to bottom-up rendering: the first added source
 * is closest to the footer, the most-recent at the top of the list.
 * This matches the user's stated stacking direction.
 */

import { useSourcesStore, type ConcordSource } from "../../stores/sources";

export function SourcesPanel({
  onAddSource,
  onSourceSelect,
  onExplore,
}: {
  onAddSource: () => void;
  onSourceSelect?: (sourceId: string) => void;
  onExplore?: () => void;
}) {
  const sources = useSourcesStore((s) => s.sources);
  const toggleSource = useSourcesStore((s) => s.toggleSource);

  const statusDot = (source: ConcordSource) => {
    if (!source.enabled) return "bg-outline-variant/40";
    switch (source.status) {
      case "connected":
        return "bg-green-500";
      case "connecting":
        return "bg-yellow-500 animate-pulse";
      case "error":
        return "bg-red-500";
      default:
        return "bg-outline-variant";
    }
  };

  return (
    <div className="h-full bg-surface-container-low overflow-hidden flex flex-col">
      {/* Header */}
      <h3 className="text-xs font-label font-medium text-on-surface-variant uppercase tracking-widest px-5 pt-4 pb-2 flex-shrink-0">
        Sources
      </h3>

      {/* List region — scrollable, sources stack from bottom upward.
          `flex-col-reverse` so insertion order in the array maps to
          bottom-up rendering. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3">
        <div className="flex flex-col-reverse gap-2 py-2">
          {sources.map((source) => (
            <div
              key={source.id}
              className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all ${
                source.enabled
                  ? "bg-surface-container"
                  : "bg-surface-container/40 opacity-60"
              }`}
            >
              {/* Status dot */}
              <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${statusDot(source)}`} />

              {/* Instance info — tap to select */}
              <button
                onClick={() => onSourceSelect?.(source.id)}
                className="flex-1 min-w-0 text-left"
              >
                <div className={`text-sm font-headline font-semibold truncate ${
                  source.enabled ? "text-on-surface" : "text-on-surface-variant"
                }`}>
                  {source.instanceName || source.host}
                </div>
                <div className="text-xs text-on-surface-variant font-body truncate">
                  {source.host}
                </div>
              </button>

              {/* Toggle switch */}
              <button
                onClick={() => toggleSource(source.id)}
                title={source.enabled ? "Hide servers" : "Show servers"}
                className={`w-10 h-6 rounded-full flex-shrink-0 transition-colors relative ${
                  source.enabled ? "bg-primary" : "bg-outline-variant/40"
                }`}
              >
                <div
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${
                    source.enabled ? "translate-x-[18px]" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Footer — always visible at the bottom of the column.
          The `+ Add Source` and `Explore` tiles live here so a fresh
          launch with zero sources still presents both affordances,
          and so they remain reachable as the source list grows. */}
      <div className="flex-shrink-0 border-t border-outline-variant/10 px-3 py-3 space-y-2">
        <button
          onClick={onAddSource}
          className="w-full flex items-center gap-3 px-3 py-3 rounded-xl border border-dashed border-outline-variant/30 hover:border-primary/40 hover:bg-surface-container transition-colors text-on-surface-variant hover:text-on-surface active:scale-[0.98]"
        >
          <span className="material-symbols-outlined text-lg">add</span>
          <span className="text-sm font-label font-medium">Add Source</span>
        </button>

        {onExplore && (
          <button
            onClick={onExplore}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-surface-container hover:bg-surface-container-high transition-colors text-on-surface-variant hover:text-on-surface active:scale-[0.98]"
          >
            <span className="material-symbols-outlined text-lg">explore</span>
            <span className="text-sm font-label font-medium">Explore</span>
          </button>
        )}
      </div>
    </div>
  );
}
