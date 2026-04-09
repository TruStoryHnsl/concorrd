import { useCallback, useEffect, useState } from "react";
import { useAuthStore } from "../../stores/auth";
import { useServerStore } from "../../stores/server";
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

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; entries: ExploreServerEntry[] }
  | { status: "error"; message: string };

/**
 * Minimal public-room descriptor. Mirrors the fields we actually use from
 * matrix-js-sdk's `IPublicRoomsChunkRoom` so tests can mock this shape
 * without importing the full SDK type.
 */
export interface PublicRoomSummary {
  room_id: string;
  name?: string;
  topic?: string;
  canonical_alias?: string;
  num_joined_members: number;
}

type RoomsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; rooms: PublicRoomSummary[] }
  | { status: "error"; message: string };

export function ExploreModal({ isOpen, onClose }: Props) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const loadServers = useServerStore((s) => s.loadServers);
  const hydrateFederatedRooms = useServerStore((s) => s.hydrateFederatedRooms);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const setActiveChannel = useServerStore((s) => s.setActiveChannel);
  const addToast = useToastStore((s) => s.addToast);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  // The domain whose public-rooms directory is currently expanded, or null.
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null);
  // Per-domain cache of room directory responses so collapsing and re-expanding
  // the same entry does not re-trigger a federated directory fetch.
  const [roomsByDomain, setRoomsByDomain] = useState<
    Record<string, RoomsState>
  >({});
  // Set of room IDs/aliases whose join is currently in flight. Used to show
  // a per-room "Joining…" state and to disable the button so the user can't
  // fire a second join while the first is still working. Federation joins
  // against remote homeservers can take 20–30+ seconds (make_join → fast_join
  // → state fetch → event parsing), and without this the button looks idle
  // during the entire window and users double-click it.
  const [joiningTargets, setJoiningTargets] = useState<Set<string>>(
    () => new Set(),
  );

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

  const load = useCallback(async () => {
    if (!accessToken) {
      setState({ status: "error", message: "Not signed in" });
      return;
    }
    setState({ status: "loading" });
    try {
      const entries = await listExploreServers(accessToken);
      setState({ status: "success", entries });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load federated servers";
      setState({ status: "error", message });
      addToast(message, "error");
    }
  }, [accessToken, addToast]);

  // Refetch every time the modal opens. The list is small and
  // federation allowlists change rarely, so a fresh fetch per open
  // is the simplest correct behavior.
  useEffect(() => {
    if (isOpen) {
      load();
    } else {
      setState({ status: "idle" });
      setExpandedDomain(null);
      setRoomsByDomain({});
      setJoiningTargets(new Set());
    }
  }, [isOpen, load]);

  /**
   * Toggle the public-rooms directory for a given federated server. On first
   * expand we fetch via matrix-js-sdk's `publicRooms({server})` which the SDK
   * turns into `GET /_matrix/client/v3/publicRooms?server=<domain>` — the
   * homeserver then federates the request to the remote server's directory.
   *
   * The fetch uses the MatrixClient from the auth store rather than a new
   * fetch() call so the server-side auth token is reused automatically.
   */
  const toggleRooms = useCallback(
    async (domain: string) => {
      if (expandedDomain === domain) {
        setExpandedDomain(null);
        return;
      }
      setExpandedDomain(domain);
      // Only fetch once per domain per modal lifetime.
      if (roomsByDomain[domain]) return;

      const client = useAuthStore.getState().client;
      if (!client) {
        setRoomsByDomain((prev) => ({
          ...prev,
          [domain]: { status: "error", message: "Not signed in" },
        }));
        return;
      }
      setRoomsByDomain((prev) => ({ ...prev, [domain]: { status: "loading" } }));
      try {
        const response = await client.publicRooms({ server: domain, limit: 50 });
        const rooms: PublicRoomSummary[] = (response.chunk ?? []).map((r) => ({
          room_id: r.room_id,
          name: r.name,
          topic: r.topic,
          canonical_alias: r.canonical_alias,
          num_joined_members: r.num_joined_members,
        }));
        setRoomsByDomain((prev) => ({
          ...prev,
          [domain]: { status: "success", rooms },
        }));
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to load public rooms";
        setRoomsByDomain((prev) => ({
          ...prev,
          [domain]: { status: "error", message },
        }));
        addToast(message, "error");
      }
    },
    [addToast, expandedDomain, roomsByDomain],
  );

  const joinRoom = useCallback(
    async (roomIdOrAlias: string, domain: string) => {
      const client = useAuthStore.getState().client;
      if (!client) {
        addToast("Not signed in", "error");
        return;
      }
      // Guard against double-click — if the same target is already
      // joining, do nothing.
      if (joiningTargets.has(roomIdOrAlias)) return;

      setJoiningTargets((prev) => {
        const next = new Set(prev);
        next.add(roomIdOrAlias);
        return next;
      });

      try {
        // Pass the remote server as a via hint so the homeserver knows
        // which server to ask for the join. This is how joining a room
        // over federation works when the room is not yet in our local
        // state.
        //
        // matrix-js-sdk's `joinRoom` returns the joined Room object,
        // whose `.roomId` is the canonical matrix room id. Even when
        // `roomIdOrAlias` is an alias (e.g. `#welcome:mozilla.org`),
        // the resolved roomId is what Concord stores in
        // `Channel.matrix_room_id`, so that's the key we use for
        // sidebar navigation below.
        const joined = await client.joinRoom(roomIdOrAlias, {
          viaServers: [domain],
        });
        const joinedRoomId: string = joined?.roomId ?? roomIdOrAlias;

        // Walk the just-joined room's state for `m.space.parent`
        // hints and try to ALSO join the parent space. The user's
        // intent when clicking a room in Explore is "join this part
        // of the federated network", and in Matrix that usually
        // means the containing space, not a single loose room.
        // Joining the parent gives the classifier enough context to
        // group the clicked room (and any siblings the user also
        // joins later) as channels under a single space-shaped
        // sidebar entry — matching the user's mental model of
        // "one server per federated community".
        //
        // Best effort: failures are swallowed. If the parent space
        // is private, gone, or unreachable, the fallback Pass 2b
        // grouping inside hydrateFederatedRooms still collapses the
        // child under a synthetic entry named after the parent
        // domain. Either way the sidebar doesn't fragment.
        try {
          const joinedRoom =
            typeof (joined as { currentState?: unknown })?.currentState === "object"
              ? (joined as {
                  currentState: {
                    getStateEvents(t: string): Array<{
                      getStateKey(): string | undefined;
                    }>;
                  };
                })
              : null;
          const parentEvents =
            joinedRoom?.currentState?.getStateEvents("m.space.parent") ?? [];
          const parentIds: string[] = [];
          for (const ev of parentEvents) {
            const pid = ev.getStateKey?.();
            if (typeof pid === "string" && pid.length > 0) {
              parentIds.push(pid);
            }
          }
          for (const parentId of parentIds) {
            // Derive the via hint for the parent from its own
            // domain. Parent spaces can live on a different
            // homeserver than the child, but typically they're the
            // same; either way the domain component of the parent
            // roomId is a correct via hint.
            const colonIdx = parentId.lastIndexOf(":");
            const parentDomain =
              colonIdx >= 0 ? parentId.slice(colonIdx + 1) : domain;
            // Fire-and-forget — don't block the main join on the
            // parent join. If it fails we log and move on; the
            // hydrator fallback handles the grouping.
            client
              .joinRoom(parentId, { viaServers: [parentDomain] })
              .catch((err: unknown) => {
                // eslint-disable-next-line no-console
                console.warn(
                  `ExploreModal: parent-space join failed for ${parentId}:`,
                  err instanceof Error ? err.message : err,
                );
              });
          }
          // Give the SDK a moment to ingest the parent-join state
          // events before we hydrate — otherwise hydrateFederatedRooms
          // runs before the parent appears in client.getRooms() and
          // the Pass 2a classifier misses it, falling back to Pass 2b
          // naming which is less pretty.
          if (parentIds.length > 0) {
            await new Promise((r) => setTimeout(r, 600));
          }
        } catch (err) {
          // Non-fatal — the child-only path still works.
          // eslint-disable-next-line no-console
          console.warn("ExploreModal: parent-space lookup failed:", err);
        }

        // Refresh the Concord server list first (picks up any server
        // whose channel happens to include the joined room — e.g.
        // rejoining a room that Concord already manages).
        if (accessToken) {
          await loadServers(accessToken);
        }
        // Then refresh the federated-rooms wrappers so the joined
        // room appears as a synthetic server in the sidebar right
        // away. The Room event from matrix-js-sdk will ALSO fire
        // this shortly via useRooms → hydrateFederatedRooms, but
        // calling it explicitly here ensures the `servers` lookup
        // below finds the new entry without a race on the Matrix
        // client's internal state timing.
        hydrateFederatedRooms(client);

        const servers = useServerStore.getState().servers;
        const target = servers.find((s) =>
          s.channels.some((c) => c.matrix_room_id === joinedRoomId),
        );

        if (target) {
          const channel = target.channels.find(
            (c) => c.matrix_room_id === joinedRoomId,
          );
          setActiveServer(target.id);
          if (channel) {
            setActiveChannel(channel.matrix_room_id);
          }
          addToast(`Joined ${target.name}`, "success");
          onClose();
        } else {
          // Room joined on the Matrix side but hydrateFederatedRooms
          // couldn't find it — this would happen if the client's
          // sync state hasn't caught up yet (rare) OR the room is
          // being treated as a DM. Acknowledge the join explicitly;
          // the next sync tick should surface it in the sidebar.
          addToast(
            "Joined room — it should appear in the sidebar shortly.",
            "info",
          );
          onClose();
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to join room";
        addToast(message, "error");
      } finally {
        setJoiningTargets((prev) => {
          const next = new Set(prev);
          next.delete(roomIdOrAlias);
          return next;
        });
      }
    },
    [
      accessToken,
      addToast,
      hydrateFederatedRooms,
      joiningTargets,
      loadServers,
      onClose,
      setActiveChannel,
      setActiveServer,
    ],
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
        <div className="p-4 border-b border-outline-variant/15 flex items-center justify-between">
          <h2
            id="explore-modal-title"
            className="text-lg font-semibold text-on-surface"
          >
            Explore Federated Servers
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-on-surface-variant hover:text-on-surface transition-colors"
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
          <ExploreBody
            state={state}
            onRetry={load}
            expandedDomain={expandedDomain}
            roomsByDomain={roomsByDomain}
            onToggleRooms={toggleRooms}
            onJoinRoom={joinRoom}
            joiningTargets={joiningTargets}
          />
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

function ExploreBody({
  state,
  onRetry,
  expandedDomain,
  roomsByDomain,
  onToggleRooms,
  onJoinRoom,
  joiningTargets,
}: {
  state: LoadState;
  onRetry: () => void;
  expandedDomain: string | null;
  roomsByDomain: Record<string, RoomsState>;
  onToggleRooms: (domain: string) => void;
  onJoinRoom: (roomIdOrAlias: string, domain: string) => void;
  joiningTargets: Set<string>;
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
    <ul className="max-h-96 overflow-y-auto space-y-1">
      {state.entries.map((entry) => {
        const isExpanded = expandedDomain === entry.domain;
        const rooms = roomsByDomain[entry.domain];
        return (
          <li
            key={entry.domain}
            className="rounded bg-surface-container-low hover:bg-surface-container-high transition-colors"
          >
            <div className="flex items-center justify-between gap-3 px-3 py-2">
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
                aria-expanded={isExpanded}
                aria-controls={`explore-rooms-${entry.domain}`}
                onClick={() => onToggleRooms(entry.domain)}
                className="text-xs px-3 py-1 bg-surface-container-highest text-on-surface-variant hover:text-on-surface rounded transition-colors flex-shrink-0"
              >
                {isExpanded ? "Hide rooms" : "Browse public rooms"}
              </button>
            </div>
            {isExpanded && (
              <div
                id={`explore-rooms-${entry.domain}`}
                className="px-3 pb-3"
              >
                <PublicRoomsBody
                  rooms={rooms}
                  domain={entry.domain}
                  onJoin={onJoinRoom}
                  joiningTargets={joiningTargets}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PublicRoomsBody({
  rooms,
  domain,
  onJoin,
  joiningTargets,
}: {
  rooms: RoomsState | undefined;
  domain: string;
  onJoin: (roomIdOrAlias: string, domain: string) => void;
  joiningTargets: Set<string>;
}) {
  if (!rooms || rooms.status === "idle" || rooms.status === "loading") {
    return (
      <p
        className="text-xs text-on-surface-variant text-center py-3"
        role="status"
      >
        Loading rooms…
      </p>
    );
  }
  if (rooms.status === "error") {
    return (
      <p className="text-xs text-on-surface-variant/80 break-words py-2">
        {rooms.message}
      </p>
    );
  }
  if (rooms.rooms.length === 0) {
    return (
      <p className="text-xs text-on-surface-variant text-center py-3">
        No public rooms on this server.
      </p>
    );
  }
  return (
    <ul className="space-y-1 border-t border-outline-variant/10 pt-2">
      {rooms.rooms.map((room) => {
        const label = room.name || room.canonical_alias || room.room_id;
        const joinTarget = room.canonical_alias || room.room_id;
        const isJoining = joiningTargets.has(joinTarget);
        return (
          <li
            key={room.room_id}
            className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-surface-container-highest/50"
          >
            <div className="min-w-0">
              <p className="text-xs text-on-surface truncate">{label}</p>
              {room.topic && (
                <p className="text-[11px] text-on-surface-variant/70 truncate">
                  {room.topic}
                </p>
              )}
              <p className="text-[11px] text-on-surface-variant/60">
                {room.num_joined_members}{" "}
                {room.num_joined_members === 1 ? "member" : "members"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onJoin(joinTarget, domain)}
              disabled={isJoining}
              aria-busy={isJoining}
              data-testid={`explore-join-${room.room_id}`}
              className="text-[11px] px-2 py-1 primary-glow hover:brightness-110 text-on-surface rounded transition-colors flex-shrink-0 disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              {isJoining && (
                <span
                  className="inline-block w-3 h-3 border-[1.5px] border-on-surface/40 border-t-on-surface rounded-full animate-spin"
                  aria-hidden="true"
                />
              )}
              {isJoining ? "Joining…" : "Join"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
