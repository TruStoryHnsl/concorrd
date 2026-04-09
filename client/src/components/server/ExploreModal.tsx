import { useCallback, useEffect, useState } from "react";
import type { IPublicRoomsChunkRoom } from "matrix-js-sdk";
import { useAuthStore } from "../../stores/auth";
import { useToastStore } from "../../stores/toast";
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

export function ExploreModal({ isOpen, onClose }: Props) {
  const client = useAuthStore((s) => s.client);
  const accessToken = useAuthStore((s) => s.accessToken);
  const addToast = useToastStore((s) => s.addToast);
  const [serversState, setServersState] = useState<ServersLoadState>({
    status: "idle",
  });
  const [view, setView] = useState<View>({ mode: "servers" });
  const [roomsState, setRoomsState] = useState<RoomsLoadState>({
    status: "loading",
  });
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);

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
      const entries = await listExploreServers(accessToken);
      setServersState({ status: "success", entries });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load federated servers";
      setServersState({ status: "error", message });
      addToast(message, "error");
    }
  }, [accessToken, addToast]);

  const loadRooms = useCallback(
    async (server: string) => {
      if (!client) {
        setRoomsState({ status: "error", message: "Not signed in" });
        return;
      }
      setRoomsState({ status: "loading" });
      try {
        const res = await client.publicRooms({ server, limit: 50 });
        setRoomsState({ status: "success", rooms: res.chunk });
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to load public rooms";
        setRoomsState({ status: "error", message });
        addToast(message, "error");
      }
    },
    [client, addToast],
  );

  // Refetch every time the modal opens. The list is small and
  // federation allowlists change rarely, so a fresh fetch per open
  // is the simplest correct behavior.
  useEffect(() => {
    if (isOpen) {
      setView({ mode: "servers" });
      loadServers();
    } else {
      setServersState({ status: "idle" });
    }
  }, [isOpen, loadServers]);

  const handleBrowseRooms = useCallback(
    (server: ExploreServerEntry) => {
      setView({ mode: "rooms", server });
      loadRooms(server.domain);
    },
    [loadRooms],
  );

  const handleBackToServers = useCallback(() => {
    setView({ mode: "servers" });
  }, []);

  const handleJoinRoom = useCallback(
    async (room: IPublicRoomsChunkRoom, server: string) => {
      if (!client) return;
      // Prefer the canonical alias when present — joining by alias means
      // matrix-js-sdk handles the via-server dance automatically. Fall back
      // to the room_id with an explicit viaServers hint for federation.
      const target = room.canonical_alias ?? room.room_id;
      setJoiningRoomId(room.room_id);
      try {
        await client.joinRoom(target, { viaServers: [server] });
        addToast(`Joined ${room.name ?? target}`, "success");
        onClose();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to join room";
        addToast(message, "error");
      } finally {
        setJoiningRoomId(null);
      }
    },
    [client, addToast, onClose],
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
          {view.mode === "servers" ? (
            <ServersBody
              state={serversState}
              onRetry={loadServers}
              onBrowseRooms={handleBrowseRooms}
            />
          ) : (
            <RoomsBody
              state={roomsState}
              onRetry={() => loadRooms(view.server.domain)}
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
