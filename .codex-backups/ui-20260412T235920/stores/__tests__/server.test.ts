import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useServerStore,
  type FederatedRoomsClientLike,
  type FederatedRoomLike,
} from "../server";
import type { Server } from "../../api/concord";

/**
 * Unit tests for `useServerStore.hydrateFederatedRooms` — the loose-room
 * hydration logic that wraps joined-but-not-Concord-managed Matrix rooms
 * as synthetic Server entries so the sidebar can display them.
 *
 * All other store actions (loadServers, createServer, etc.) hit the
 * concord API and have their own integration-test surface; this file
 * focuses narrowly on the hydration algorithm's filter + merge rules.
 */

// Mock the concord API module so the store's other methods don't try
// to hit the network in tests that touch `loadServers`-adjacent state.
vi.mock("../../api/concord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/concord")>();
  return {
    ...actual,
    listServers: vi.fn().mockResolvedValue([]),
    getDefaultServer: vi.fn().mockResolvedValue({
      server_id: null,
      is_member: true,
      name: null,
      created_at: null,
      member_count: 0,
    }),
    joinServer: vi.fn().mockResolvedValue(undefined),
    rejoinServerRooms: vi.fn().mockResolvedValue({ joined: 0, failures: {} }),
  };
});

interface FakeRoomConfig {
  roomId: string;
  name?: string;
  membership?: string;
  dmInviter?: string | null;
  /**
   * Matrix room type. Set to `"m.space"` to mark this room as a
   * Matrix space (container for child rooms). Undefined / omitted
   * means a regular room.
   */
  type?: string;
  /**
   * For space rooms: the list of child room IDs this space
   * advertises via `m.space.child` state events. The helper below
   * synthesizes a getStateEvents() return value from this list.
   */
  spaceChildren?: string[];
}

/**
 * Build a Room-like object satisfying the {@link FederatedRoomLike}
 * shape. Individual tests override membership + dmInviter + type +
 * spaceChildren to exercise the classifier branches.
 */
function fakeRoom(config: FakeRoomConfig): FederatedRoomLike {
  const childStateEvents = (config.spaceChildren ?? []).map((childId) => ({
    getStateKey: () => childId,
  }));
  return {
    roomId: config.roomId,
    name: config.name,
    getMyMembership: () => config.membership ?? "join",
    getDMInviter: () => (config.dmInviter ?? null),
    getType: () => config.type,
    currentState: {
      getStateEvents: (eventType: string) => {
        if (eventType === "m.space.child") return childStateEvents;
        return [];
      },
    },
  };
}

/**
 * Build a FederatedRoomsClientLike stub whose `getRooms` returns the
 * given list and whose `getUserId` returns a stable tester identity.
 * Tests that exercise `leaveOrphanRooms` can inspect the leave mock
 * via the returned object.
 */
type LeaveFn = (roomId: string) => Promise<unknown>;
function fakeClient(
  rooms: ReturnType<typeof fakeRoom>[],
  overrides?: { leave?: LeaveFn },
): FederatedRoomsClientLike {
  return {
    getUserId: () => "@tester:example.org",
    getRooms: () => rooms,
    leave:
      overrides?.leave ??
      ((_roomId: string) => Promise.resolve()),
  };
}

/**
 * Minimal real Concord Server record used as a fixture. Only the
 * fields `hydrateFederatedRooms` reads (id, channels) are meaningful.
 */
function concordServer(
  id: string,
  channelRoomIds: string[],
): Server {
  return {
    id,
    name: `Concord ${id}`,
    icon_url: null,
    owner_id: "@owner:example.org",
    visibility: "private",
    abbreviation: null,
    media_uploads_enabled: false,
    channels: channelRoomIds.map((roomId, idx) => ({
      id: idx + 1,
      name: `channel-${idx}`,
      channel_type: "text",
      matrix_room_id: roomId,
      position: idx,
    })),
  };
}

// NOTE (2026-04-11): the entire `useServerStore.hydrateFederatedRooms`
// suite that used to live here (~360 lines of cases) was deleted
// alongside the Pass 3b homeserver-grouping and the
// federatedInstances store. Those tests were written against the
// old behavior (federated homeservers collapsed into synthetic
// sidebar tiles) which no longer exists — the 2026-04-11
// architecture rule says federated homeservers are their own
// Sources and must never be auto-surfaced as tiles.
//
// New tests for the restructured hydrator (local-domain bridge
// spaces only, everything else silently dropped) MUST be written
// in a different session than the one that shipped the hydrator
// rewrite, per the MANDATORY testing rule in
// `/home/corr/projects/CLAUDE.md`. Until then, this area has zero
// coverage — flag it in the follow-up session.

describe("useServerStore.leaveOrphanRooms", () => {
  beforeEach(() => {
    useServerStore.setState({
      servers: [],
      activeServerId: null,
      activeChannelId: null,
      members: {},
    });
  });

  it("leaves all local-homeserver rooms that aren't Concord-managed", async () => {
    // Seed a real Concord server whose channel owns one room.
    useServerStore.setState({
      servers: [concordServer("srv-1", ["!managed:example.org"])],
      activeServerId: null,
      activeChannelId: null,
      members: {},
    });

    const rooms = [
      // Managed — NOT an orphan, leave() must NOT be called
      fakeRoom({ roomId: "!managed:example.org" }),
      // Local orphan 1 — leave() must be called
      fakeRoom({ roomId: "!ghost1:example.org" }),
      // Local orphan 2 — leave() must be called
      fakeRoom({ roomId: "!ghost2:example.org" }),
      // Federated — NOT local, leave() must NOT be called
      fakeRoom({ roomId: "!fed:remote.example" }),
      // DM — leave() must NOT be called
      fakeRoom({ roomId: "!dm:example.org", dmInviter: "@f:example.org" }),
      // Invited but not joined — leave() must NOT be called
      fakeRoom({ roomId: "!invited:example.org", membership: "invite" }),
    ];
    const leave = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient(rooms, { leave });

    const left = await useServerStore.getState().leaveOrphanRooms(client);

    expect(left).toEqual(["!ghost1:example.org", "!ghost2:example.org"]);
    expect(leave).toHaveBeenCalledTimes(2);
    expect(leave).toHaveBeenCalledWith("!ghost1:example.org");
    expect(leave).toHaveBeenCalledWith("!ghost2:example.org");
  });

  it("skips federated rooms on remote homeservers", async () => {
    const rooms = [
      fakeRoom({ roomId: "!one:remote.example" }),
      fakeRoom({ roomId: "!two:other.example" }),
      fakeRoom({ roomId: "!friend:friend.example.com" }),
    ];
    const leave = vi.fn().mockResolvedValue(undefined);

    const left = await useServerStore
      .getState()
      .leaveOrphanRooms(fakeClient(rooms, { leave }));

    expect(left).toEqual([]);
    expect(leave).not.toHaveBeenCalled();
  });

  it("continues on per-room leave failures and returns only successful leaves", async () => {
    const rooms = [
      fakeRoom({ roomId: "!a:example.org" }),
      fakeRoom({ roomId: "!b:example.org" }),
      fakeRoom({ roomId: "!c:example.org" }),
    ];
    const leave = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce(undefined);

    const left = await useServerStore
      .getState()
      .leaveOrphanRooms(fakeClient(rooms, { leave }));

    expect(left).toEqual(["!a:example.org", "!c:example.org"]);
    expect(leave).toHaveBeenCalledTimes(3);
  });

  it("no-ops when the client has no orphans", async () => {
    const leave = vi.fn().mockResolvedValue(undefined);
    const left = await useServerStore
      .getState()
      .leaveOrphanRooms(fakeClient([], { leave }));
    expect(left).toEqual([]);
    expect(leave).not.toHaveBeenCalled();
  });
});
