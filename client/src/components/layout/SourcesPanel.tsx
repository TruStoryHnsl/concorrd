/**
 * SourcesPanel — the leftmost panel on native apps (INS-020).
 *
 * Displays connected Concord instances ("sources") with toggle switches
 * to enable/disable their visibility in the server column. Includes the
 * Explore button for discovering new instances and an Add Source button.
 *
 * Sources are toggleable: tap the toggle to hide/show a source's servers
 * in the server sidebar. The server column is a filtered view of enabled
 * sources — toggle off = servers vanish instantly, toggle on = they return.
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
    <div className="h-full bg-surface-container-low overflow-y-auto overflow-x-hidden overscroll-y-auto p-4 flex flex-col">
      <h3 className="text-xs font-label font-medium text-on-surface-variant uppercase tracking-widest px-1 mb-4">
        Sources
      </h3>

      {sources.length === 0 ? (
        // Empty state — first-launch experience
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
          <span className="material-symbols-outlined text-5xl text-on-surface-variant/30 mb-4">
            hub
          </span>
          <h2 className="text-lg font-headline font-semibold text-on-surface mb-2">
            No sources connected
          </h2>
          <p className="text-sm text-on-surface-variant font-body mb-6 max-w-[280px]">
            Connect to a Concord instance to see servers, channels, and start chatting.
          </p>
          <button
            onClick={onAddSource}
            className="primary-glow text-on-primary px-6 py-3 rounded-xl font-headline font-semibold hover:brightness-110 shadow-lg shadow-primary/20 transition-all active:scale-95"
          >
            + Add Source
          </button>
        </div>
      ) : (
        // Connected sources list
        <div className="space-y-2 flex-1">
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

          {/* Add more sources */}
          <button
            onClick={onAddSource}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-xl border border-dashed border-outline-variant/30 hover:border-primary/40 hover:bg-surface-container transition-colors text-on-surface-variant hover:text-on-surface active:scale-[0.98]"
          >
            <span className="material-symbols-outlined text-lg">add</span>
            <span className="text-sm font-label font-medium">Add Source</span>
          </button>

          {/* Explore — discover new instances */}
          {onExplore && (
            <button
              onClick={onExplore}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-surface-container hover:bg-surface-container-high transition-colors text-on-surface-variant hover:text-on-surface active:scale-[0.98] mt-2"
            >
              <span className="material-symbols-outlined text-lg">explore</span>
              <span className="text-sm font-label font-medium">Explore</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
