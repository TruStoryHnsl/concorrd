import { create } from "zustand";
import type { Server, Channel, ServerMember } from "../api/concord";
import {
  listServers,
  createServer as apiCreateServer,
  createChannel as apiCreateChannel,
  createInvite as apiCreateInvite,
  deleteServer as apiDeleteServer,
  deleteChannel as apiDeleteChannel,
  renameChannel as apiRenameChannel,
  leaveServer as apiLeaveServer,
  reorderChannels as apiReorderChannels,
  listMembers as apiListMembers,
  getDefaultServer,
  joinServer as apiJoinServer,
  rejoinServerRooms as apiRejoinServerRooms,
} from "../api/concord";
import { useToastStore } from "./toast";

/**
 * Synthetic server ID prefix used for federated (loose) rooms. Any
 * Server record whose `id` starts with this prefix is a client-only
 * wrapper around a joined Matrix room that isn't part of any
 * Concord-managed server. The prefix lets other code cheaply
 * distinguish real Concord servers from loose-room wrappers without
 * having to look at the `federated` flag — useful in persistence
 * layers and tests.
 */
const FEDERATED_SERVER_ID_PREFIX = "federated:";

/**
 * Minimal shape of a matrix-js-sdk MatrixClient that
 * `hydrateFederatedRooms` depends on. We don't import the full
 * matrix-js-sdk `MatrixClient` type here because it would pull a
 * heavy module graph into every consumer of this store; structural
 * typing is enough for the two methods we actually call.
 */
/**
 * Minimal Room-like shape the store's federation helpers rely on.
 * Structurally compatible with matrix-js-sdk's real `Room` type; the
 * optional space-related methods (`getType`, `currentState`) let the
 * store classify joined rooms as either spaces, space children, or
 * standalone rooms when building the sidebar.
 */
export interface FederatedRoomLike {
  roomId: string;
  name?: string;
  getMyMembership(): string | undefined;
  /**
   * matrix-js-sdk's real signature returns `string | undefined`;
   * keeping the widest compatible form here so the real Room type
   * is assignable to this structural slot without losing the
   * tests' ability to return explicit nulls.
   */
  getDMInviter?(): string | null | undefined;
  /**
   * Returns `"m.space"` for space rooms, `undefined` (or another
   * room type) for regular rooms. Optional in the interface so
   * test fixtures don't have to implement it — rooms without
   * `getType` are treated as regular rooms by the hydrator.
   */
  getType?(): string | undefined;
  /**
   * Subset of matrix-js-sdk's `RoomState` surface that the store
   * consumes. Only `getStateEvents` is needed, to read
   * `m.space.child` pointer events from a space room's state.
   */
  currentState?: {
    getStateEvents(eventType: string): ReadonlyArray<{
      getStateKey(): string | undefined;
    }>;
  };
}

export interface FederatedRoomsClientLike {
  getUserId(): string | null;
  getRooms(): ReadonlyArray<FederatedRoomLike>;
  /**
   * Leave a room on the Matrix side. Used by
   * `leaveOrphanRooms` to clean up ghosts left behind when a
   * Concord server was deleted without first kicking the
   * underlying Matrix rooms.
   */
  leave(roomId: string): Promise<unknown>;
}

interface ServerState {
  servers: Server[];
  activeServerId: string | null;
  activeChannelId: string | null; // matrix_room_id
  members: Record<string, ServerMember[]>; // keyed by server ID

  loadServers: (accessToken: string) => Promise<void>;
  /**
   * Populate (or refresh) the synthetic Server records that wrap
   * joined Matrix rooms outside any Concord-managed server. Callers:
   *
   *   - `useMatrix` on every sync and membership change, so the
   *     sidebar reflects rooms as they're joined/left.
   *   - `ExploreModal` after a successful `client.joinRoom`, so the
   *     newly joined room appears immediately without waiting for
   *     the next sync tick.
   *
   * Idempotent — existing federated entries are replaced wholesale,
   * real Concord servers are left untouched.
   */
  hydrateFederatedRooms: (client: FederatedRoomsClientLike) => void;
  /**
   * Identify and leave "orphan" rooms — Matrix rooms on the local
   * homeserver the user is still joined to but which aren't part of
   * any Concord-managed Server. These are ghosts left behind when a
   * Concord server was deleted in the database without first
   * leaving the underlying Matrix rooms, and they clutter a
   * Matrix-level room list indefinitely.
   *
   * Returns the list of roomIds that were successfully left.
   * Callers should guard this with a localStorage flag so it runs
   * at most once per user per browser — we don't want to
   * repeatedly leave rooms on every sync.
   */
  leaveOrphanRooms: (
    client: FederatedRoomsClientLike,
  ) => Promise<string[]>;
  createServer: (
    name: string,
    accessToken: string,
    options?: { visibility?: string; abbreviation?: string },
  ) => Promise<Server>;
  createChannel: (
    serverId: string,
    name: string,
    channelType: string,
    accessToken: string,
  ) => Promise<Channel>;
  createInvite: (serverId: string, accessToken: string) => Promise<string>;
  deleteServer: (serverId: string, accessToken: string) => Promise<void>;
  deleteChannel: (
    serverId: string,
    channelId: number,
    accessToken: string,
  ) => Promise<void>;
  renameChannel: (
    serverId: string,
    channelId: number,
    name: string,
    accessToken: string,
  ) => Promise<void>;
  reorderChannels: (
    serverId: string,
    channelIds: number[],
    accessToken: string,
  ) => Promise<void>;
  leaveServer: (serverId: string, accessToken: string) => Promise<void>;
  setActiveServer: (serverId: string) => void;
  setActiveChannel: (matrixRoomId: string) => void;
  loadMembers: (serverId: string, accessToken: string) => Promise<void>;
  updateServer: (serverId: string, updates: Partial<Server>) => void;
  /**
   * Ensure a synthetic Discord guild server exists in the store and
   * navigate to it + the given channel. If the guild server already
   * exists, the channel is added if missing. Returns the server ID.
   */
  ensureDiscordGuild: (guild: {
    guildId: string;
    guildName: string;
    channel: { roomId: string; name: string };
  }) => string;

  activeServer: () => Server | undefined;
  activeChannel: () => Channel | undefined;
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  activeServerId: null,
  activeChannelId: null,
  members: {},

  hydrateFederatedRooms: (client) => {
    const { servers } = get();
    // Keep real Concord servers as-is, drop previous federated wrappers —
    // we rebuild them from scratch from the current Matrix client state
    // so leaves / joins are reflected correctly without merge bookkeeping.
    const concordServers = servers.filter(
      (s) => !s.id.startsWith(FEDERATED_SERVER_ID_PREFIX),
    );

    // Build the set of matrix_room_ids already owned by a Concord server
    // so we don't double-render them as loose rooms.
    const managed = new Set<string>();
    for (const srv of concordServers) {
      for (const ch of srv.channels) {
        managed.add(ch.matrix_room_id);
      }
    }

    const userId = client.getUserId() ?? "";
    // Derive the local homeserver domain from the user id ("@user:chat.example.com"
    // -> "chat.example.com"). Any joined room whose id shares this suffix lives on
    // the local homeserver and is, by definition, NOT federated. Such rooms
    // fall into two categories:
    //
    //   1. Concord-managed rooms (filtered out above via `managed`).
    //   2. Orphans left behind when a Concord server was deleted in the
    //      database without first leaving the underlying Matrix rooms.
    //
    // Category 2 used to flood the sidebar with dozens of ghost entries
    // after the first successful federated-room join, because matrix-js-sdk
    // still considers the user "joined" to them. We filter them out here
    // by domain suffix: federated rooms live on OTHER homeservers
    // (remote.example, other.example, friend.example.com) and therefore never
    // match the local domain.
    const localDomain = userId.includes(":") ? userId.split(":")[1] : "";

    // -----------------------------------------------------------------
    // Pass 1: classify every joined federated room as either a SPACE
    // (Matrix room type `m.space`) or a regular room. Spaces in Matrix
    // are the container unit for groups of related rooms — Mozilla's
    // "Mozilla" space contains #firefox, #rust, #servo, etc., each as
    // its own child room. Before this pass, hydrateFederatedRooms was
    // rendering each child room as its own sidebar entry, which
    // flooded the UI with "servers" that were really just channels of
    // the same space. Now we collapse spaces into a single Concord
    // "server" whose channels ARE the space's children, matching how
    // Matrix itself models the hierarchy.
    // -----------------------------------------------------------------
    const joinedFederated: FederatedRoomLike[] = [];
    for (const room of client.getRooms()) {
      if (room.getMyMembership() !== "join") continue;
      if (managed.has(room.roomId)) continue;
      if (room.getDMInviter?.()) continue;
      if (localDomain && room.roomId.endsWith(`:${localDomain}`)) {
        // Local-domain rooms are normally filtered out (they're either
        // Concord-managed or orphans from deleted servers). BUT bridge-
        // created rooms (Discord guilds via mautrix-discord) also live
        // on the local domain — they're Matrix rooms created by the
        // bridge process on the embedded homeserver. Detect them by
        // checking for space membership: bridge guilds are spaces, and
        // bridge channels declare a space parent.
        const isSpace = room.getType?.() === "m.space";
        const hasSpaceParent =
          (room.currentState?.getStateEvents("m.space.parent") ?? []).length > 0;
        if (!isSpace && !hasSpaceParent) continue;
      }
      joinedFederated.push(room);
    }

    const spaces: FederatedRoomLike[] = [];
    const regularRooms: FederatedRoomLike[] = [];
    for (const room of joinedFederated) {
      if (room.getType?.() === "m.space") {
        spaces.push(room);
      } else {
        regularRooms.push(room);
      }
    }

    // DIAGNOSTIC (INS-028 follow-up): dump what the classifier sees
    // into the console on every hydration. Helps diagnose "my
    // Mozilla space shows as five separate tiles" bug reports by
    // surfacing what matrix-js-sdk is actually reporting for those
    // rooms — crucially, whether the rooms carry m.space.parent
    // state events that the grouping logic can work with.
    //
    // Gated behind the `concord_debug_federated` localStorage flag so
    // it stays OFF in production. Commercial-scope hygiene: room IDs
    // and names are personal metadata — we don't want them appearing
    // in DevTools during a bug-report screenshare. To turn the
    // diagnostic on in your own browser, open DevTools and run:
    //
    //     localStorage.setItem('concord_debug_federated', '1')
    //
    // then refresh. Clear it with `localStorage.removeItem(...)` when
    // you're done investigating.
    if (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("concord_debug_federated")
    ) {
      // eslint-disable-next-line no-console
      console.groupCollapsed(
        `[concord] hydrateFederatedRooms — ${joinedFederated.length} joined federated rooms, ${spaces.length} spaces, ${regularRooms.length} regular`,
      );
      try {
        for (const room of joinedFederated) {
          const parentEvents =
            room.currentState?.getStateEvents("m.space.parent") ?? [];
          const parentIds = parentEvents
            .map((e) => e.getStateKey?.())
            .filter((id): id is string => typeof id === "string" && id.length > 0);
          const childEvents =
            room.currentState?.getStateEvents("m.space.child") ?? [];
          const childIds = childEvents
            .map((e) => e.getStateKey?.())
            .filter((id): id is string => typeof id === "string" && id.length > 0);
          // eslint-disable-next-line no-console
          console.log("[concord] room", {
            roomId: room.roomId,
            name: room.name,
            type: room.getType?.() ?? "(regular)",
            parents: parentIds,
            children: childIds,
          });
        }
      } finally {
        // eslint-disable-next-line no-console
        console.groupEnd();
      }
    }

    // -----------------------------------------------------------------
    // Pass 2a: read `m.space.child` state events from each JOINED
    // space so we know which federated rooms belong where.
    // -----------------------------------------------------------------
    const roomById = new Map<string, FederatedRoomLike>();
    for (const room of joinedFederated) {
      roomById.set(room.roomId, room);
    }

    // Parent-space-id -> array of child room ids. Populated from BOTH
    // the downward m.space.child pointers on joined spaces AND the
    // upward m.space.parent pointers on regular rooms — see Pass 2b
    // for the latter. This dual-direction walk is what lets Concord
    // collapse the Mozilla space's children into one sidebar entry
    // even when the user joined the children directly via the Explore
    // menu and was never a member of the Mozilla space itself.
    const parentIdToChildren = new Map<string, string[]>();
    const parentIdToName = new Map<string, string>();
    const childrenOfSpaces = new Set<string>();

    for (const space of spaces) {
      const childEvents = space.currentState?.getStateEvents("m.space.child") ?? [];
      const childIds: string[] = [];
      for (const event of childEvents) {
        const childId = event.getStateKey?.();
        if (typeof childId === "string" && childId.length > 0) {
          childIds.push(childId);
          childrenOfSpaces.add(childId);
        }
      }
      parentIdToChildren.set(space.roomId, childIds);
      // Joined space's own name wins for the sidebar label when we have it.
      if (space.name) parentIdToName.set(space.roomId, space.name);
    }

    // -----------------------------------------------------------------
    // Pass 2b: walk regular rooms for `m.space.parent` hints. Each
    // regular room can declare "I belong to parent space !foo:host"
    // via one or more `m.space.parent` state events whose state_key
    // is the parent space's room id. When multiple regular rooms
    // point at the same parent id, we group them together under a
    // single synthetic server — even if the parent space itself is
    // NOT in client.getRooms() (the user joined the children
    // directly via Explore, never joined the container).
    //
    // When multiple parents are advertised for the same room, we
    // take the first one — Matrix allows multi-parenting but the
    // sidebar can only show a room in one place at a time.
    // -----------------------------------------------------------------
    const roomToParentId = new Map<string, string>();
    for (const room of regularRooms) {
      if (childrenOfSpaces.has(room.roomId)) continue; // already placed
      const parentEvents =
        room.currentState?.getStateEvents("m.space.parent") ?? [];
      for (const event of parentEvents) {
        const parentId = event.getStateKey?.();
        if (typeof parentId === "string" && parentId.length > 0) {
          roomToParentId.set(room.roomId, parentId);
          childrenOfSpaces.add(room.roomId);
          const existing = parentIdToChildren.get(parentId) ?? [];
          existing.push(room.roomId);
          parentIdToChildren.set(parentId, existing);
          break; // first parent wins
        }
      }
    }

    // -----------------------------------------------------------------
    // Pass 3: build synthetic Server records.
    //
    // Grouping strategy:
    //
    //   (a) Matrix SPACE grouping (from Pass 2a joined-space walk
    //       and Pass 2b m.space.parent hints) — if rooms have
    //       explicit space metadata, honour it. One tile per
    //       parent space, children as channels.
    //
    //   (b) HOMESERVER grouping for every remaining room — rooms
    //       that survived without being placed under a space
    //       collapse into one synthetic server per unique
    //       homeserver domain. All rooms on remote.example become
    //       channels under a single "remote.example" tile; all rooms
    //       on other.example become channels under a single
    //       "other.example" tile. Matches the user's mental model
    //       of "one federated instance = one sidebar server",
    //       which is the right default for the very common case
    //       where a Matrix host publishes its public rooms as a
    //       flat list without declaring any spaces (like Mozilla).
    //
    // Empty parents (zero joined children) are skipped entirely so
    // the sidebar never shows a dangling container. The
    // placedRoomIds set tracks which rooms have already been
    // assigned so Pass 3b doesn't double-render them under both
    // a space AND a homeserver group.
    // -----------------------------------------------------------------
    const synthetic: Server[] = [];
    const placedRoomIds = new Set<string>();

    // --- Pass 3a: LOCAL-DOMAIN space-based grouping only -------------
    //
    // Only synthesise tiles for spaces whose parent roomId lives on
    // the LOCAL homeserver (`:${localDomain}`). The only code path
    // that currently creates local-domain spaces is the Discord
    // bridge — mautrix-discord builds one `m.space` per guild on the
    // embedded homeserver, with each guild channel as a child room.
    // Those spaces are tied to the active source's own bridge
    // infrastructure, so they belong to the source and are allowed
    // to render as tiles.
    //
    // Any space whose parent is on a DIFFERENT homeserver (another
    // Matrix instance, another Concord instance, etc.) is skipped — it
    // would be a federated space, and federated entities do not
    // surface as server tiles under the 2026-04-11 architecture
    // rule.
    for (const [parentId, childIds] of parentIdToChildren) {
      // Hard gate: local homeserver only.
      if (!localDomain || !parentId.endsWith(`:${localDomain}`)) continue;

      // Skip bridge organizational spaces ("Discord", "Direct Messages")
      // that are top-level containers, not actual guild channels.
      const spaceName = parentIdToName.get(parentId) ?? "";
      if (spaceName === "Discord" || spaceName === "Direct Messages") continue;

      // Dedupe child ids while preserving insertion order —
      // m.space.child + m.space.parent walks can both point at the
      // same room, and we only want to render it once per space.
      const seen = new Set<string>();
      const orderedChildIds = childIds.filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      const channels: Channel[] = [];
      let position = 0;
      for (const childId of orderedChildIds) {
        const childRoom = roomById.get(childId);
        if (!childRoom) continue; // user isn't joined to this child
        // Children must also live on the local domain to be counted
        // as channels of this bridge tile. Bridge guild channels
        // always share the homeserver with their parent space, so
        // this filter is a no-op for valid bridge data but prevents
        // a cross-homeserver m.space.child pointer from sneaking
        // federated state back into the rail.
        if (!childId.endsWith(`:${localDomain}`)) continue;
        const channelName = childRoom.name || childId;
        channels.push({
          // id=0 + unique position is a sentinel for synthetic channels.
          // No UI code keys off `Channel.id` for federated entries;
          // identity lives in `matrix_room_id`.
          id: 0,
          name: channelName,
          channel_type: "text",
          matrix_room_id: childId,
          position,
        });
        placedRoomIds.add(childId);
        position++;
      }
      // Skip empty parents — container with no joined children.
      if (channels.length === 0) continue;

      // Name resolution: prefer the joined-space's own name, fall
      // back to stripping the local suffix off the parent id. We
      // never fall back to the raw hostname here because that'd
      // leak the local homeserver's hostname as a visible label —
      // and the hostname for a Tauri native build could be something
      // like `localhost:8765` which makes no sense as a user-facing
      // tile name.
      const joinedSpaceName = parentIdToName.get(parentId);
      const name = joinedSpaceName ?? "Bridge";

      // Detect Discord bridge: local-domain spaces are bridge-created
      // (Concord itself doesn't use Matrix spaces — it uses the API).
      // Currently Discord is the only bridge, so local-domain space =
      // Discord guild. Refine this if more bridges are added.
      const isLocalSpace =
        localDomain && parentId.endsWith(`:${localDomain}`);

      synthetic.push({
        id: `${FEDERATED_SERVER_ID_PREFIX}${parentId}`,
        name,
        icon_url: null,
        owner_id: userId,
        visibility: "public",
        abbreviation: isLocalSpace ? "D" : name.charAt(0).toUpperCase() || "#",
        media_uploads_enabled: false,
        channels,
        federated: true,
        ...(isLocalSpace && { bridgeType: "discord" as const }),
      });
    }

    // NOTE (2026-04-11 restructure): the previous "Pass 3b" collapsed
    // every loose federated room into a synthetic tile grouped by its
    // homeserver domain — so if the user's Matrix account happened to
    // be a member of a room on a remote homeserver (via plain
    // Matrix federation, not through Concord's Sources flow), a tile
    // for that homeserver would appear in the server rail. That was
    // wrong under the architecture rule: a Source is the unit of
    // "connection to another Concord/Matrix instance", and server
    // tiles must only surface things the user joined THROUGH an
    // active source's UI. Matrix federation is a network-layer
    // concern; it should not create sidebar tiles on its own.
    //
    // The entire Pass 3b block has been removed. The federated-
    // instance catalog (`client/src/stores/federatedInstances.ts`)
    // was its only consumer and has been deleted. Any rooms that
    // previously would have landed in homeserver-grouped tiles now
    // silently do not appear in the sidebar — they still exist in
    // the Matrix sync state and can be reached via DMs or through
    // a future Matrix-as-Source flow, but they are no longer
    // promoted to the rail.
    //
    // Pass 3a (space-based grouping) is also tightened: we now only
    // synthesise tiles for spaces whose roomId lives on the LOCAL
    // homeserver domain. The only code path that currently produces
    // local-domain spaces is the Discord bridge (mautrix-discord
    // creates an `m.space` per guild on the embedded homeserver,
    // with channel rooms as its children). Federated spaces on
    // other homeservers are treated the same as any other federated
    // room now: not rendered as a tile.

    set({ servers: [...concordServers, ...synthetic] });
  },

  leaveOrphanRooms: async (client) => {
    const { servers } = get();
    // Only compute orphans against real Concord servers — we do NOT
    // want to leave the rooms that back our own synthetic federated
    // wrappers, since those are legitimately joined federated rooms.
    const concordServers = servers.filter(
      (s) => !s.id.startsWith(FEDERATED_SERVER_ID_PREFIX),
    );

    const managed = new Set<string>();
    for (const srv of concordServers) {
      for (const ch of srv.channels) {
        managed.add(ch.matrix_room_id);
      }
    }

    const userId = client.getUserId() ?? "";
    if (!userId.includes(":")) return [];
    const localDomain = userId.split(":")[1];

    const toLeave: string[] = [];
    for (const room of client.getRooms()) {
      if (room.getMyMembership() !== "join") continue;
      if (managed.has(room.roomId)) continue;
      if (room.getDMInviter?.()) continue;
      // Orphan definition: joined, not Concord-managed, not a DM,
      // AND lives on the LOCAL homeserver. Federated rooms live on
      // other homeservers and must NOT be leaved by this pass.
      if (!room.roomId.endsWith(`:${localDomain}`)) continue;
      // Bridge rooms (spaces and their children) live on the local
      // domain but must NOT be cleaned up — they're managed by the
      // bridge, not Concord. Skip them.
      const isSpace = room.getType?.() === "m.space";
      const hasSpaceParent =
        (room.currentState?.getStateEvents("m.space.parent") ?? []).length > 0;
      if (isSpace || hasSpaceParent) continue;
      toLeave.push(room.roomId);
    }

    const succeeded: string[] = [];
    for (const roomId of toLeave) {
      try {
        await client.leave(roomId);
        succeeded.push(roomId);
      } catch (err) {
        // Best-effort — log and move on. A failure to leave one
        // ghost shouldn't abort the whole cleanup pass.
        // eslint-disable-next-line no-console
        console.warn(
          `leaveOrphanRooms: failed to leave ${roomId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return succeeded;
  },

  loadServers: async (accessToken) => {
    let servers: Server[];
    try {
      servers = await listServers(accessToken);
    } catch (err) {
      useToastStore.getState().addToast(
        err instanceof Error ? err.message : "Failed to load servers",
      );
      return;
    }

    // Server-side auto-joins the lobby if needed, but if user somehow
    // still has zero servers, try the explicit join as a fallback
    if (servers.length === 0) {
      try {
        const defaultInfo = await getDefaultServer(accessToken);
        if (defaultInfo.server_id && !defaultInfo.is_member) {
          await apiJoinServer(defaultInfo.server_id, accessToken);
          servers = await listServers(accessToken);
        }
      } catch {
        // Default server may not exist — that's fine
      }
    }

    // Preserve any previously-hydrated federated (loose) room wrappers
    // so `loadServers` doesn't wipe them from the sidebar while we're
    // just refreshing the Concord-managed entries. The next
    // `hydrateFederatedRooms` pass (fired on Matrix client sync or
    // explicitly by ExploreModal after a join) will refresh the
    // federated list.
    const existingFederated = get().servers.filter((s) =>
      s.id.startsWith(FEDERATED_SERVER_ID_PREFIX),
    );
    set({ servers: [...servers, ...existingFederated] });

    // Background reconciliation: ensure the user's Matrix membership covers
    // every channel of every server they belong to. This catches the case
    // where a channel was created before the auto-invite code shipped and
    // existing members never got invited to the underlying Matrix room.
    // Idempotent: /rejoin calls /join on each room and silently no-ops if
    // already joined. Fire-and-forget to keep loadServers fast. Skip
    // federated wrappers — their "channels" aren't Concord-managed and
    // concord-api has no server row to rejoin against.
    for (const srv of servers) {
      apiRejoinServerRooms(srv.id, accessToken).catch(() => {
        // Best-effort — failures here just leave the user in the prior state
      });
    }

    // Auto-select: land in the lobby's #welcome channel by default
    const { activeServerId } = get();
    if (!activeServerId && servers.length > 0) {
      // Find the lobby (first server, which is oldest by created_at)
      const lobby = servers[0];
      // Prefer #welcome channel, fall back to first channel
      const welcomeChannel = lobby.channels.find((ch) => ch.name === "welcome");
      const targetChannel = welcomeChannel ?? lobby.channels[0];
      set({
        activeServerId: lobby.id,
        activeChannelId: targetChannel?.matrix_room_id ?? null,
      });
    }
  },

  createServer: async (name, accessToken, options) => {
    const server = await apiCreateServer(name, accessToken, options);
    set((s) => ({
      servers: [...s.servers, server],
      activeServerId: server.id,
      activeChannelId: server.channels[0]?.matrix_room_id ?? null,
    }));
    return server;
  },

  createChannel: async (serverId, name, channelType, accessToken) => {
    const channel = await apiCreateChannel(
      serverId,
      name,
      channelType,
      accessToken,
    );
    set((s) => ({
      servers: s.servers.map((srv) =>
        srv.id === serverId
          ? { ...srv, channels: [...srv.channels, channel] }
          : srv,
      ),
    }));
    return channel;
  },

  createInvite: async (serverId, accessToken) => {
    const invite = await apiCreateInvite(serverId, accessToken);
    return invite.token;
  },

  deleteServer: async (serverId, accessToken) => {
    // Synthetic servers (Discord guilds, federated) have no API record —
    // just remove from client state without hitting the API.
    const isSynthetic = serverId.startsWith(FEDERATED_SERVER_ID_PREFIX);
    if (!isSynthetic) {
      await apiDeleteServer(serverId, accessToken);
    }
    const { servers, activeServerId } = get();
    const remaining = servers.filter((s) => s.id !== serverId);
    const newActive = activeServerId === serverId ? remaining[0] ?? null : null;
    set({
      servers: remaining,
      ...(activeServerId === serverId && {
        activeServerId: newActive?.id ?? null,
        activeChannelId: newActive?.channels[0]?.matrix_room_id ?? null,
      }),
    });
  },

  deleteChannel: async (serverId, channelId, accessToken) => {
    await apiDeleteChannel(serverId, channelId, accessToken);
    set((s) => {
      const servers = s.servers.map((srv) =>
        srv.id === serverId
          ? { ...srv, channels: srv.channels.filter((c) => c.id !== channelId) }
          : srv,
      );
      // If the deleted channel was active, switch to first available
      const activeServer = servers.find((srv) => srv.id === serverId);
      const wasActive = s.activeChannelId && activeServer?.channels.every(
        (c) => c.matrix_room_id !== s.activeChannelId,
      );
      return {
        servers,
        ...(wasActive && {
          activeChannelId: activeServer?.channels[0]?.matrix_room_id ?? null,
        }),
      };
    });
  },

  renameChannel: async (serverId, channelId, name, accessToken) => {
    const updated = await apiRenameChannel(serverId, channelId, name, accessToken);
    set((s) => ({
      servers: s.servers.map((srv) =>
        srv.id === serverId
          ? {
              ...srv,
              channels: srv.channels.map((c) =>
                c.id === channelId ? { ...c, name: updated.name } : c,
              ),
            }
          : srv,
      ),
    }));
  },

  reorderChannels: async (serverId, channelIds, accessToken) => {
    // Snapshot previous channel order so we can roll back on API failure.
    const prevServers = get().servers;
    const prevServer = prevServers.find((s) => s.id === serverId);
    if (!prevServer) return;

    // Optimistic reorder: sort the server's channels by the index each ID
    // appears at in `channelIds`. Any channel not mentioned (e.g. a voice
    // channel when we're only reordering text channels) keeps its original
    // relative order at the end of the list, so partial reorders are safe.
    const indexMap = new Map<number, number>();
    channelIds.forEach((id, idx) => indexMap.set(id, idx));
    const reordered = [...prevServer.channels].sort((a, b) => {
      const ai = indexMap.has(a.id) ? indexMap.get(a.id)! : Number.MAX_SAFE_INTEGER;
      const bi = indexMap.has(b.id) ? indexMap.get(b.id)! : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      // Stable fallback for un-mentioned channels: preserve original order
      return prevServer.channels.indexOf(a) - prevServer.channels.indexOf(b);
    });

    set((s) => ({
      servers: s.servers.map((srv) =>
        srv.id === serverId ? { ...srv, channels: reordered } : srv,
      ),
    }));

    try {
      await apiReorderChannels(serverId, channelIds, accessToken);
    } catch (err) {
      // Roll back the optimistic reorder and surface the error.
      set({ servers: prevServers });
      useToastStore.getState().addToast(
        err instanceof Error ? err.message : "Failed to reorder channels",
      );
      throw err;
    }
  },

  leaveServer: async (serverId, accessToken) => {
    await apiLeaveServer(serverId, accessToken);
    const { servers, activeServerId } = get();
    const remaining = servers.filter((s) => s.id !== serverId);
    const newActive = activeServerId === serverId ? remaining[0] ?? null : null;
    set({
      servers: remaining,
      ...(activeServerId === serverId && {
        activeServerId: newActive?.id ?? null,
        activeChannelId: newActive?.channels[0]?.matrix_room_id ?? null,
      }),
    });
  },

  loadMembers: async (serverId, accessToken) => {
    try {
      const members = await apiListMembers(serverId, accessToken);
      set((s) => ({ members: { ...s.members, [serverId]: members } }));
    } catch {
      // silent fail — members list is supplementary
    }
  },

  updateServer: (serverId, updates) => {
    set((s) => ({
      servers: s.servers.map((srv) =>
        srv.id === serverId ? { ...srv, ...updates } : srv,
      ),
    }));
  },

  setActiveServer: (serverId) => {
    const server = get().servers.find((s) => s.id === serverId);
    set({
      activeServerId: serverId,
      activeChannelId: server?.channels[0]?.matrix_room_id ?? null,
    });
  },

  setActiveChannel: (matrixRoomId) => {
    set({ activeChannelId: matrixRoomId });
  },

  ensureDiscordGuild: ({ guildId, guildName, channel }) => {
    const serverId = `${FEDERATED_SERVER_ID_PREFIX}discord_${guildId}`;
    const { servers } = get();
    const existing = servers.find((s) => s.id === serverId);

    if (existing) {
      const hasChannel = existing.channels.some(
        (c) => c.matrix_room_id === channel.roomId,
      );
      const betterName =
        guildName &&
        !guildName.startsWith("Guild ") &&
        existing.name.startsWith("Guild ");
      if (!hasChannel || betterName) {
        set({
          servers: servers.map((s) =>
            s.id === serverId
              ? {
                  ...s,
                  ...(betterName ? { name: guildName } : {}),
                  channels: hasChannel
                    ? s.channels
                    : [
                        ...s.channels,
                        {
                          id: 0,
                          name: channel.name,
                          channel_type: "text",
                          matrix_room_id: channel.roomId,
                          position: s.channels.length,
                        },
                      ],
                }
              : s,
          ),
        });
      }
    } else {
      // Create Discord guild as a non-federated server so it persists
      // across hydrateFederatedRooms syncs (which wipe all federated entries).
      const userId = servers[0]?.owner_id ?? "";
      set({
        servers: [
          ...servers,
          {
            id: serverId,
            name: guildName,
            icon_url: null,
            owner_id: userId,
            visibility: "public",
            abbreviation: null,
            media_uploads_enabled: false,
            channels: [
              {
                id: 0,
                name: channel.name,
                channel_type: "text",
                matrix_room_id: channel.roomId,
                position: 0,
              },
            ],
            bridgeType: "discord" as const,
          },
        ],
      });
    }

    // Navigate
    set({ activeServerId: serverId, activeChannelId: channel.roomId });
    return serverId;
  },

  activeServer: () => {
    const { servers, activeServerId } = get();
    return servers.find((s) => s.id === activeServerId);
  },

  activeChannel: () => {
    const server = get().activeServer();
    if (!server) return undefined;
    return server.channels.find(
      (c) => c.matrix_room_id === get().activeChannelId,
    );
  },
}));
