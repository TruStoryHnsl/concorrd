/**
 * SourcesPanel — the leftmost panel on native mobile apps.
 *
 * Displays connected Concord instances ("sources") and a + button to add
 * new ones. This panel only appears on native builds (Tauri iOS/Android/
 * desktop) — the web client skips it because its single instance IS the
 * source.
 *
 * Each source tile shows:
 *  - Instance name (or hostname fallback)
 *  - Connection status dot (green=connected, yellow=connecting, red=error)
 *  - Number of servers available through this source
 *
 * The + button opens the AddSourceFlow (domain + invite token → validate
 * → login → connected).
 */

import { useSourcesStore, type ConcordSource } from "../../stores/sources";

export function SourcesPanel({
  onAddSource,
  onSourceSelect,
}: {
  onAddSource: () => void;
  onSourceSelect?: (sourceId: string) => void;
}) {
  const sources = useSourcesStore((s) => s.sources);

  const statusDot = (status: ConcordSource["status"]) => {
    switch (status) {
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
            <button
              key={source.id}
              onClick={() => onSourceSelect?.(source.id)}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-surface-container hover:bg-surface-container-high transition-colors text-left active:scale-[0.98]"
            >
              {/* Status dot */}
              <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${statusDot(source.status)}`} />

              {/* Instance info */}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-headline font-semibold text-on-surface truncate">
                  {source.instanceName || source.host}
                </div>
                <div className="text-xs text-on-surface-variant font-body truncate">
                  {source.host}
                </div>
              </div>

              {/* Status badge */}
              {source.status === "error" && (
                <span className="text-xs text-error font-label">Error</span>
              )}
            </button>
          ))}

          {/* Add more sources */}
          <button
            onClick={onAddSource}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-xl border border-dashed border-outline-variant/30 hover:border-primary/40 hover:bg-surface-container transition-colors text-on-surface-variant hover:text-on-surface active:scale-[0.98]"
          >
            <span className="material-symbols-outlined text-lg">add</span>
            <span className="text-sm font-label font-medium">Add Source</span>
          </button>
        </div>
      )}
    </div>
  );
}
