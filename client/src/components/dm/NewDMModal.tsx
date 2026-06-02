import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useAuthStore } from "../../stores/auth";
import { useDMStore } from "../../stores/dm";
import { useToastStore } from "../../stores/toast";
import { useSourcesStore, type ConcordSource } from "../../stores/sources";
import { BringingUpSplash } from "../BringingUpSplash";
import { searchMatrixDirectory, type MatrixDirectoryUser } from "../../api/matrix";
import { Avatar } from "../ui/Avatar";

interface Props {
  onClose: () => void;
}

/**
 * Aggregated row used to render results — combines a `MatrixDirectoryUser`
 * with the source it came from so the UI can group / disambiguate.
 */
interface AggregatedUser extends MatrixDirectoryUser {
  sourceId: string;
  sourceName: string;
  /** Homeserver domain (e.g. `matrix.org`) — second-line subtitle. */
  homeserverDomain: string;
}

/**
 * Sources we can search for users in. Excludes:
 *  - Sources missing `accessToken` / `userId` (not authed yet).
 *  - Sources in `error` / `disconnected` status (don't hammer broken homeservers).
 *  - Reticulum sources (no Matrix directory).
 */
function selectSearchableSources(sources: ConcordSource[]): ConcordSource[] {
  return sources.filter((s) => {
    if (!s.accessToken || !s.userId) return false;
    if (s.status !== "connected") return false;
    if (s.platform === "reticulum") return false;
    if (!s.homeserverUrl) return false;
    return true;
  });
}

function deriveHomeserverDomain(source: ConcordSource): string {
  try {
    return new URL(source.homeserverUrl).host;
  } catch {
    return source.homeserverUrl;
  }
}

export function NewDMModal({ onClose }: Props) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const startDM = useDMStore((s) => s.startDM);
  const addToast = useToastStore((s) => s.addToast);
  const sources = useSourcesStore((s) => s.sources);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AggregatedUser[]>([]);
  const [perSourceErrors, setPerSourceErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);

  // Keep a ref to the latest in-flight search so older requests can be
  // discarded when the user types fast.
  const searchSeq = useRef(0);

  const searchableSources = useMemo(
    () => selectSearchableSources(sources),
    [sources],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const runSearch = useCallback(
    async (term: string) => {
      const mySeq = ++searchSeq.current;
      if (searchableSources.length === 0) {
        setResults([]);
        setPerSourceErrors({});
        return;
      }
      setLoading(true);
      const settled = await Promise.allSettled(
        searchableSources.map(async (src) => {
          // Privacy floor: never query a source the user is NOT a member of.
          // `status: "connected"` already gates this — disconnected/error
          // sources are filtered upstream. Empty search_term returns the
          // homeserver's top results (Matrix spec allows this), which is
          // what most homeservers will surface as "publicly discoverable".
          const { results, limited } = await searchMatrixDirectory(
            src.homeserverUrl,
            src.accessToken!,
            term,
            10,
          );
          return {
            src,
            results,
            limited,
          };
        }),
      );
      // Drop result if a newer search has started in the meantime.
      if (mySeq !== searchSeq.current) return;

      const seenUserIds = new Set<string>();
      const aggregated: AggregatedUser[] = [];
      const errors: Record<string, string> = {};

      for (let i = 0; i < settled.length; i++) {
        const item = settled[i];
        const src = searchableSources[i];
        if (item.status === "rejected") {
          errors[src.id] =
            item.reason instanceof Error
              ? item.reason.message
              : String(item.reason);
          continue;
        }
        for (const user of item.value.results) {
          // Skip self (the user's own ID on this source).
          if (user.user_id === src.userId) continue;
          // Dedupe by user_id across sources. First source wins; remaining
          // sources only contribute users not already added. (Most users
          // only appear in one homeserver's directory anyway.)
          if (seenUserIds.has(user.user_id)) continue;
          seenUserIds.add(user.user_id);
          aggregated.push({
            ...user,
            sourceId: src.id,
            sourceName: src.instanceName ?? src.host,
            homeserverDomain: deriveHomeserverDomain(src),
          });
        }
      }

      setResults(aggregated);
      setPerSourceErrors(errors);
      setLoading(false);
    },
    [searchableSources],
  );

  // Debounced search — refetch 250ms after the last keystroke. Empty
  // query also fires (most homeservers return the directory's top users
  // when given an empty term — better UX than a blank modal at open).
  useEffect(() => {
    const timer = setTimeout(() => {
      void runSearch(query.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  const handleSelect = async (userId: string) => {
    // DM creation still uses the user's primary Concord-API access token —
    // the per-source tokens are scoped to the directory search above. The
    // existing useDMStore.startDM flow expects the user's global token.
    if (!accessToken) {
      addToast("Sign in to start a DM");
      return;
    }
    setStarting(userId);
    try {
      await startDM(userId, accessToken);
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to start DM");
    } finally {
      setStarting(null);
    }
  };

  // Group results by source for the rendered list. Sources with zero hits
  // are omitted from the headers but their per-source errors still surface.
  const groupedResults = useMemo(() => {
    const map = new Map<string, AggregatedUser[]>();
    for (const user of results) {
      const arr = map.get(user.sourceId) ?? [];
      arr.push(user);
      map.set(user.sourceId, arr);
    }
    return Array.from(map.entries()).map(([sourceId, users]) => ({
      sourceId,
      sourceName: users[0]?.sourceName ?? sourceId,
      homeserverDomain: users[0]?.homeserverDomain ?? "",
      users,
    }));
  }, [results]);

  const hasAnyResult = results.length > 0;
  const hasErrors = Object.keys(perSourceErrors).length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface-container rounded-lg w-full max-w-md border border-outline-variant/15 shadow-xl">
        <div className="p-4 border-b border-outline-variant/15">
          <h3 className="text-sm font-headline font-bold text-on-surface mb-3">
            New Message
          </h3>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search across your connected sources..."
            autoFocus
            data-testid="new-dm-search"
            className="w-full px-3 py-2 bg-surface border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
          {searchableSources.length === 0 && (
            <p className="mt-2 text-xs text-on-surface-variant">
              Connect to a Concord or Matrix source first to search for people.
            </p>
          )}
        </div>

        <div className="max-h-72 overflow-y-auto p-2" data-testid="new-dm-results">
          {loading ? (
            <p className="text-on-surface-variant text-sm text-center py-4">
              Searching {searchableSources.length} source
              {searchableSources.length === 1 ? "" : "s"}…
            </p>
          ) : !hasAnyResult && searchableSources.length > 0 ? (
            <p className="text-on-surface-variant text-sm text-center py-4">
              {query.trim() ? "No users found" : "Type a name to search"}
            </p>
          ) : (
            groupedResults.map((group) => (
              <div key={group.sourceId} className="mb-2 last:mb-0">
                <p className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-on-surface-variant/70 font-label">
                  {group.sourceName}{" "}
                  <span className="text-on-surface-variant/50">
                    · {group.homeserverDomain}
                  </span>
                </p>
                {group.users.map((user) => (
                  <button
                    key={`${group.sourceId}:${user.user_id}`}
                    onClick={() => handleSelect(user.user_id)}
                    disabled={starting === user.user_id}
                    className="btn-press w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-container-high transition-colors disabled:opacity-50"
                  >
                    <Avatar userId={user.user_id} size="md" showPresence />
                    <div className="text-left min-w-0 flex-1">
                      <p className="text-sm font-body font-medium text-on-surface truncate">
                        {user.display_name ||
                          user.user_id.split(":")[0].replace("@", "")}
                      </p>
                      <p className="text-xs text-on-surface-variant truncate">
                        {user.user_id}
                      </p>
                    </div>
                    {starting === user.user_id && (
                      <BringingUpSplash size="inline" />
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
          {hasErrors && (
            <p className="text-xs text-on-surface-variant/60 text-center py-2">
              Some sources couldn't be searched
              {Object.keys(perSourceErrors).length === searchableSources.length
                ? " (all unreachable)"
                : ""}
              .
            </p>
          )}
        </div>

        <div className="px-4 pb-4 pt-2">
          <button
            onClick={onClose}
            className="w-full py-2 text-sm text-on-surface-variant hover:text-on-surface transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
