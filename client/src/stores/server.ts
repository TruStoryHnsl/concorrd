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
export interface FederatedRoomsClientLike {
  getUserId(): string | null;
  getRooms(): ReadonlyArray<{
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
  }>;
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
    // Derive the local homeserver domain from the user id ("@corr:concorrd.com"
    // -> "concorrd.com"). Any joined room whose id shares this suffix lives on
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
    // (mozilla.org, matrix.org, friend.example.com) and therefore never
    // match the local domain.
    const localDomain = userId.includes(":") ? userId.split(":")[1] : "";

    const synthetic: Server[] = [];
    for (const room of client.getRooms()) {
      if (room.getMyMembership() !== "join") continue;
      if (managed.has(room.roomId)) continue;
      // DMs live in a separate sidebar section — the DM store handles
      // them. getDMInviter() returns the inviter's mxid when the room
      // was originally tagged as direct via m.direct account data.
      if (room.getDMInviter?.()) continue;

      // Skip anything on the local homeserver — see the localDomain
      // comment above. Room ids are formatted `!opaqueId:domain`,
      // so splitting on the last colon gives us the hosting domain.
      if (localDomain && room.roomId.endsWith(`:${localDomain}`)) {
        continue;
      }

      const name = room.name || room.roomId;
      synthetic.push({
        id: `${FEDERATED_SERVER_ID_PREFIX}${room.roomId}`,
        name,
        icon_url: null,
        owner_id: userId,
        visibility: "public",
        abbreviation: name.charAt(0).toUpperCase() || "#",
        media_uploads_enabled: false,
        channels: [
          {
            // id=0 is a sentinel for synthetic channels — they don't
            // have a concord-api primary key. No UI code relies on id
            // being non-zero; room identity lives in matrix_room_id.
            id: 0,
            name,
            channel_type: "text",
            matrix_room_id: room.roomId,
            position: 0,
          },
        ],
        federated: true,
      });
    }

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
    await apiDeleteServer(serverId, accessToken);
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
