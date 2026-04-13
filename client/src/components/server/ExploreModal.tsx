import { useCallback, useEffect, useState } from "react";
import type { IPublicRoomsChunkRoom } from "matrix-js-sdk";
import { useAuthStore } from "../../stores/auth";
import { useToastStore } from "../../stores/toast";
import { useSourcesStore, type ConcordSource } from "../../stores/sources";
import { listExploreServers } from "../../api/concord";
import type { ExploreServerEntry } from "../../api/concord";

interface Props {
  /**
   * Controls visibility. When false, the modal renders nothing.
   * Kept as an explicit prop (rather than relying on parent-side
   * conditional rendering) so the component can manage its own
   * fetch lifecycle via a `useEffect` keyed on `isOpen`.
   */
  isOpen: boolean;
  onClose: () => void;
}

type ServersLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; entries: ExploreServerEntry[] }
  | { status: "error"; message: string };

type RoomsLoadState =
  | { status: "loading" }
  | { status: "success"; rooms: IPublicRoomsChunkRoom[] }
  | { status: "error"; message: string };

// The modal has two mutually-exclusive views: the server list (default) and
// the public-rooms list for a specific federated server (drilled-into). A
// single top-level view state keeps transitions trivial — no routing, no
// nested modals.
type View =
  | { mode: "servers" }
  | { mode: "rooms"; server: ExploreServerEntry };

type ExploreDiagnostic = {
  title: string;
  summary: string;
  suggestions: string[];
};

function normalizeMatrixError(err: unknown): {
  message: string;
  errcode: string | null;
  statusCode: number | null;
} {
  if (!err || typeof err !== "object") {
    return {
      message: err instanceof Error ? err.message : "Unknown Matrix error",
      errcode: null,
      statusCode: null,
    };
  }

  const candidate = err as {
    message?: string;
    errcode?: string;
    data?: { errcode?: string; error?: string };
    httpStatus?: number;
    statusCode?: number;
  };

  return {
    message: candidate.data?.error || candidate.message || "Unknown Matrix error",
    errcode: candidate.errcode || candidate.data?.errcode || null,
    statusCode: candidate.statusCode || candidate.httpStatus || null,
  };
}

function buildDiagnostic({
  phase,
  server,
  source,
  error,
}: {
  phase: "browse" | "join";
  server: ExploreServerEntry;
  source?: ConcordSource;
  error: ReturnType<typeof normalizeMatrixError>;
}): ExploreDiagnostic {
  const text = `${error.errcode ?? ""} ${error.message}`.toLowerCase();
  const suggestions: string[] = [];
  let title = phase === "browse" ? "Couldn’t load public rooms" : "Join failed";
  let summary = error.message;

  if (error.errcode === "M_UNKNOWN_TOKEN" || text.includes("unknown token")) {
    title = "Your Matrix session expired";
    summary = "The current Concord session is no longer accepted by the homeserver.";
    suggestions.push("Sign out and sign back in.");
    suggestions.push("Retry after the session has resynced.");
  } else if (
    error.errcode === "M_GUEST_ACCESS_FORBIDDEN" ||
    text.includes("guest access") ||
    text.includes("guest users may not")
  ) {
    title = phase === "browse" ? "This server blocks guest browsing" : "Guests cannot join this room";
    summary = `${server.domain} requires a full Matrix account for this action.`;
    suggestions.push(`Use an actual Matrix account on ${server.domain} or another trusted homeserver.`);
    suggestions.push("If the room is invite-only, get an invite before retrying.");
  } else if (
    error.errcode === "M_FORBIDDEN" ||
    text.includes("forbidden") ||
    text.includes("invite") ||
    text.includes("join rule") ||
    text.includes("restricted")
  ) {
    title = phase === "browse" ? "Public room listing is restricted" : "This room rejected the join";
    summary = "The homeserver received the request but your account is not allowed through the room's join rules.";
    suggestions.push("Check whether the room is invite-only or space-restricted.");
    suggestions.push("Retry with an account that the remote homeserver recognizes.");
  } else if (
    error.errcode === "M_NOT_FOUND" ||
    text.includes("no known servers") ||
    text.includes("not found") ||
    text.includes("alias")
  ) {
    title = phase === "browse" ? "This server did not expose a room directory" : "Concord could not route the join";
    summary = "The room alias or federation path was not resolvable from the current account.";
    suggestions.push("Verify the room still exists and is federated with your current homeserver.");
    suggestions.push("Ask for a direct invite if the room was shared manually.");
  } else if (
    error.errcode === "M_LIMIT_EXCEEDED" ||
    text.includes("rate limit") ||
    text.includes("too many requests")
  ) {
    title = "The homeserver rate-limited the request";
    summary = "The remote server asked Concord to back off for a moment.";
    suggestions.push("Wait a few seconds and retry.");
  } else if (error.statusCode === 401 || error.statusCode === 403) {
    title = "The homeserver rejected the request";
    summary = "Authentication or permission checks failed before the request could complete.";
    suggestions.push("Verify that your current Matrix account is allowed to browse or join there.");
  } else if (error.statusCode === 502 || error.statusCode === 503 || text.includes("timeout")) {
    title = "The remote homeserver did not answer cleanly";
    summary = "This looks like a federation or availability problem on the remote side.";
    suggestions.push("Retry later.");
    suggestions.push("Test the same room from a regular Matrix client to confirm the remote server is healthy.");
  }

  if (source && !source.accessToken) {
    suggestions.push(
      `Source ${source.instanceName ?? source.host} is registered, but this browser does not hold a Matrix login for it yet. Cross-server joins still run through your current session.`,
    );
  }
  if (!source && phase === "join") {
    suggestions.push(`Add ${server.domain} as a source if you want Concord to track that homeserver explicitly.`);
  }

  return { title, summary, suggestions: Array.from(new Set(suggestions)) };
}

export function ExploreModal({ isOpen, onClose }: Props) {
  const client = useAuthStore((s) => s.client);
  const accessToken = useAuthStore((s) => s.accessToken);
  const addToast = useToastStore((s) => s.addToast);
  const sources = useSourcesStore((s) => s.sources);
  const [serversState, setServersState] = useState<ServersLoadState>({
    status: "idle",
  });
  const [view, setView] = useState<View>({ mode: "servers" });
  const [roomsState, setRoomsState] = useState<RoomsLoadState>({
    status: "loading",
  });
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<ExploreDiagnostic | null>(null);

  // Close on Escape — mirrors the convention used by NewServerModal /
  // InviteModal so keyboard behavior stays consistent across the app.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const loadServers = useCallback(async () => {
    if (!accessToken) {
      setServersState({ status: "error", message: "Not signed in" });
      return;
    }
    setServersState({ status: "loading" });
    try {
      const apiEntries = await listExploreServers(accessToken);
      // Merge connected sources into the server list. Sources are Concord
      // instances the user has added — they're browseable Matrix homeservers
      // even if they don't appear in the local federation allowlist.
      const sourceDomains = new Set(apiEntries.map((e) => e.domain.toLowerCase()));
      const sourceEntries: ExploreServerEntry[] = sources
        .filter((s) => s.enabled && !sourceDomains.has(s.host.toLowerCase()))
        .map((s) => ({
          domain: s.host,
          name: s.instanceName ?? s.host,
          description: "Connected source",
        }));
      setServersState({ status: "success", entries: [...sourceEntries, ...apiEntries] });
    } catch (err) {
      // API failed — fall back to just showing sources
      const sourceEntries: ExploreServerEntry[] = sources
        .filter((s) => s.enabled)
        .map((s) => ({
          domain: s.host,
          name: s.instanceName ?? s.host,
          description: "Connected source",
        }));
      if (sourceEntries.length > 0) {
        setServersState({ status: "success", entries: sourceEntries });
      } else {
        const message =
          err instanceof Error ? err.message : "Failed to load federated servers";
        setServersState({ status: "error", message });
        addToast(message, "error");
      }
    }
  }, [accessToken, addToast, sources]);

  const loadRooms = useCallback(
    async (server: ExploreServerEntry) => {
      if (!client) {
        setRoomsState({ status: "error", message: "Not signed in" });
        return;
      }
      setRoomsState({ status: "loading" });
      setDiagnostic(null);
      try {
        const res = await client.publicRooms({ server: server.domain, limit: 50 });
        setRoomsState({ status: "success", rooms: res.chunk });
      } catch (err) {
        const normalized = normalizeMatrixError(err);
        const source = sources.find((entry) => entry.host.toLowerCase() === server.domain.toLowerCase());
        const message = normalized.message || "Failed to load public rooms";
        setRoomsState({ status: "error", message });
        setDiagnostic(
          buildDiagnostic({
            phase: "browse",
            server,
            source,
            error: normalized,
          }),
        );
        addToast(message, "error");
      }
    },
    [client, addToast, sources],
  );

  // Refetch every time the modal opens. The list is small and
  // federation allowlists change rarely, so a fresh fetch per open
  // is the simplest correct behavior.
  useEffect(() => {
    if (isOpen) {
      setView({ mode: "servers" });
      setDiagnostic(null);
      loadServers();
    } else {
      setServersState({ status: "idle" });
      setDiagnostic(null);
    }
  }, [isOpen, loadServers]);

  const handleBrowseRooms = useCallback(
    (server: ExploreServerEntry) => {
      setView({ mode: "rooms", server });
      setDiagnostic(null);
      loadRooms(server);
    },
    [loadRooms],
  );

  const handleBackToServers = useCallback(() => {
    setView({ mode: "servers" });
    setDiagnostic(null);
  }, []);

  const handleJoinRoom = useCallback(
    async (room: IPublicRoomsChunkRoom, server: string) => {
      if (!client) return;
      // Prefer the canonical alias when present — joining by alias means
      // matrix-js-sdk handles the via-server dance automatically. Fall back
      // to the room_id with an explicit viaServers hint for federation.
      const target = room.canonical_alias ?? room.room_id;
      setJoiningRoomId(room.room_id);
      setDiagnostic(null);
      try {
        await client.joinRoom(target, { viaServers: [server] });
        addToast(`Joined ${room.name ?? target}`, "success");
        onClose();
      } catch (err) {
        const normalized = normalizeMatrixError(err);
        const source = sources.find((entry) => entry.host.toLowerCase() === server.toLowerCase());
        const message = normalized.message || "Failed to join room";
        setDiagnostic(
          buildDiagnostic({
            phase: "join",
            server: {
              domain: server,
              name: server,
              description: source ? "Connected source" : null,
            },
            source,
            error: normalized,
          }),
        );
        addToast(message, "error");
      } finally {
        setJoiningRoomId(null);
      }
    },
    [client, addToast, onClose, sources],
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="explore-modal-title"
    >
      <div className="bg-surface-container rounded-lg w-full max-w-md border border-outline-variant/15 shadow-xl">
        <div className="p-4 border-b border-outline-variant/15 flex items-center justify-between gap-2">
          <div className="min-w-0 flex items-center gap-2">
            {view.mode === "rooms" && (
              <button
                type="button"
                onClick={handleBackToServers}
                aria-label="Back to servers"
                className="text-on-surface-variant hover:text-on-surface transition-colors flex-shrink-0"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
              </button>
            )}
            <h2
              id="explore-modal-title"
              className="text-lg font-semibold text-on-surface truncate"
            >
              {view.mode === "servers"
                ? "Explore Federated Servers"
                : `Public Rooms on ${view.server.name ?? view.server.domain}`}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-on-surface-variant hover:text-on-surface transition-colors flex-shrink-0"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="p-4">
          {diagnostic && <DiagnosticPanel diagnostic={diagnostic} />}
          {view.mode === "servers" ? (
            <ServersBody
              state={serversState}
              onRetry={loadServers}
              onBrowseRooms={handleBrowseRooms}
            />
          ) : (
            <RoomsBody
              state={roomsState}
              onRetry={() => loadRooms(view.server)}
              onJoin={(room) => handleJoinRoom(room, view.server.domain)}
              joiningRoomId={joiningRoomId}
            />
          )}
        </div>

        <div className="px-4 pb-4">
          <button
            onClick={onClose}
            className="w-full py-2 text-sm text-on-surface-variant hover:text-on-surface transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function DiagnosticPanel({ diagnostic }: { diagnostic: ExploreDiagnostic }) {
  return (
    <div className="mb-4 rounded-lg border border-error/20 bg-error/10 px-4 py-3">
      <p className="text-sm font-semibold text-on-surface">{diagnostic.title}</p>
      <p className="mt-1 text-xs text-on-surface-variant">{diagnostic.summary}</p>
      {diagnostic.suggestions.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-on-surface-variant">
          {diagnostic.suggestions.map((suggestion) => (
            <li key={suggestion}>• {suggestion}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ServersBody({
  state,
  onRetry,
  onBrowseRooms,
}: {
  state: ServersLoadState;
  onRetry: () => void;
  onBrowseRooms: (server: ExploreServerEntry) => void;
}) {
  if (state.status === "loading" || state.status === "idle") {
    return (
      <p
        className="text-on-surface-variant text-sm text-center py-8"
        role="status"
      >
        Loading…
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="space-y-3 py-4 text-center">
        <p className="text-sm text-on-surface-variant">
          Couldn&apos;t load federated servers.
        </p>
        <p className="text-xs text-on-surface-variant/70 break-words">
          {state.message}
        </p>
        <button
          onClick={onRetry}
          className="text-xs px-3 py-1.5 primary-glow hover:brightness-110 text-on-surface rounded transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (state.entries.length === 0) {
    return (
      <p className="text-on-surface-variant text-sm text-center py-8">
        No federated servers yet.
      </p>
    );
  }

  return (
    <ul className="max-h-72 overflow-y-auto space-y-1">
      {state.entries.map((entry) => (
        <li
          key={entry.domain}
          className="flex items-center justify-between gap-3 px-3 py-2 rounded bg-surface-container-low hover:bg-surface-container-high transition-colors"
        >
          <div className="min-w-0">
            <p className="text-sm text-on-surface truncate">{entry.name}</p>
            {entry.name !== entry.domain && (
              <p className="text-xs text-on-surface-variant truncate">
                {entry.domain}
              </p>
            )}
            {entry.description && (
              <p className="text-xs text-on-surface-variant/80 truncate">
                {entry.description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onBrowseRooms(entry)}
            className="text-xs px-3 py-1 bg-surface-container-highest text-on-surface-variant hover:text-on-surface rounded transition-colors flex-shrink-0"
          >
            Browse public rooms
          </button>
        </li>
      ))}
    </ul>
  );
}

function RoomsBody({
  state,
  onRetry,
  onJoin,
  joiningRoomId,
}: {
  state: RoomsLoadState;
  onRetry: () => void;
  onJoin: (room: IPublicRoomsChunkRoom) => void;
  joiningRoomId: string | null;
}) {
  if (state.status === "loading") {
    return (
      <p
        className="text-on-surface-variant text-sm text-center py-8"
        role="status"
      >
        Loading public rooms…
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="space-y-3 py-4 text-center">
        <p className="text-sm text-on-surface-variant">
          Couldn&apos;t load public rooms.
        </p>
        <p className="text-xs text-on-surface-variant/70 break-words">
          {state.message}
        </p>
        <button
          onClick={onRetry}
          className="text-xs px-3 py-1.5 primary-glow hover:brightness-110 text-on-surface rounded transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (state.rooms.length === 0) {
    return (
      <p className="text-on-surface-variant text-sm text-center py-8">
        No public rooms on this server.
      </p>
    );
  }

  return (
    <ul className="max-h-72 overflow-y-auto space-y-1">
      {state.rooms.map((room) => {
        const label = room.name ?? room.canonical_alias ?? room.room_id;
        const isJoining = joiningRoomId === room.room_id;
        return (
          <li
            key={room.room_id}
            className="flex items-start justify-between gap-3 px-3 py-2 rounded bg-surface-container-low hover:bg-surface-container-high transition-colors"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-on-surface truncate">{label}</p>
              {room.canonical_alias && room.canonical_alias !== label && (
                <p className="text-xs text-on-surface-variant truncate">
                  {room.canonical_alias}
                </p>
              )}
              {room.topic && (
                <p className="text-xs text-on-surface-variant/80 line-clamp-2">
                  {room.topic}
                </p>
              )}
              <p className="text-[10px] text-on-surface-variant/60 mt-0.5">
                {room.num_joined_members}{" "}
                {room.num_joined_members === 1 ? "member" : "members"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onJoin(room)}
              disabled={isJoining || joiningRoomId !== null}
              className="text-xs px-3 py-1 bg-primary/80 hover:bg-primary text-on-primary disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors flex-shrink-0"
            >
              {isJoining ? "Joining…" : "Join"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
