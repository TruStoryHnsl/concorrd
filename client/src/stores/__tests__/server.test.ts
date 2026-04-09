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

describe("useServerStore.hydrateFederatedRooms", () => {
  beforeEach(() => {
    useServerStore.setState({
      servers: [],
      activeServerId: null,
      activeChannelId: null,
      members: {},
    });
  });

  it("no-op when the client has no joined rooms", () => {
    useServerStore.getState().hydrateFederatedRooms(fakeClient([]));
    expect(useServerStore.getState().servers).toEqual([]);
  });

  it("collapses multiple joined rooms on the same federated homeserver into ONE synthetic server with each room as a channel", () => {
    // Two rooms on the same host → ONE sidebar tile labelled
    // after the host, each room a channel under it. This is the
    // homeserver-based grouping strategy (Pass 3b) that the
    // classifier falls back to when no Matrix spaces or
    // m.space.parent hints are available.
    const rooms = [
      fakeRoom({ roomId: "!a:remote.example", name: "Alpha" }),
      fakeRoom({ roomId: "!b:remote.example", name: "Bravo" }),
    ];
    useServerStore.getState().hydrateFederatedRooms(fakeClient(rooms));

    const servers = useServerStore.getState().servers;
    expect(servers).toHaveLength(1);
    const host = servers[0];
    expect(host.federated).toBe(true);
    expect(host.id).toBe("federated:homeserver:remote.example");
    expect(host.name).toBe("remote.example");
    // Channels are sorted alphabetically by name for stable order
    // across sync ticks — "Alpha" before "Bravo".
    expect(host.channels).toHaveLength(2);
    expect(host.channels.map((c) => c.matrix_room_id)).toEqual([
      "!a:remote.example",
      "!b:remote.example",
    ]);
    expect(host.channels.map((c) => c.name)).toEqual(["Alpha", "Bravo"]);
  });

  it("creates separate synthetic servers for rooms on different homeservers", () => {
    const rooms = [
      fakeRoom({ roomId: "!a:mozilla.org", name: "Alpha" }),
      fakeRoom({ roomId: "!b:matrix.org", name: "Bravo" }),
    ];
    useServerStore.getState().hydrateFederatedRooms(fakeClient(rooms));

    const servers = useServerStore.getState().servers;
    expect(servers).toHaveLength(2);
    const ids = servers.map((s) => s.id).sort();
    expect(ids).toEqual([
      "federated:homeserver:matrix.org",
      "federated:homeserver:mozilla.org",
    ]);
  });

  it("skips rooms whose membership is not 'join' (invites, bans, leaves)", () => {
    const rooms = [
      fakeRoom({ roomId: "!invited:remote.example", membership: "invite" }),
      fakeRoom({ roomId: "!left:remote.example", membership: "leave" }),
      fakeRoom({ roomId: "!banned:remote.example", membership: "ban" }),
      fakeRoom({ roomId: "!joined:remote.example", membership: "join" }),
    ];
    useServerStore.getState().hydrateFederatedRooms(fakeClient(rooms));

    const servers = useServerStore.getState().servers;
    expect(servers).toHaveLength(1);
    // Only the joined room survives — the host group has exactly
    // one channel.
    expect(servers[0].channels).toHaveLength(1);
    expect(servers[0].channels[0].matrix_room_id).toBe("!joined:remote.example");
  });

  it("skips DM rooms (getDMInviter returns a user id)", () => {
    const rooms = [
      fakeRoom({
        roomId: "!dm:remote.example",
        dmInviter: "@friend:remote.example",
      }),
      fakeRoom({ roomId: "!public:remote.example", dmInviter: null }),
    ];
    useServerStore.getState().hydrateFederatedRooms(fakeClient(rooms));

    const servers = useServerStore.getState().servers;
    expect(servers).toHaveLength(1);
    expect(servers[0].channels[0].matrix_room_id).toBe("!public:remote.example");
  });

  it("skips rooms that are already channels of a Concord-managed server", () => {
    // Pre-seed a real Concord server whose channel is the same room
    // the client reports as joined. hydrateFederatedRooms must NOT
    // create a duplicate federated wrapper for it.
    useServerStore.setState({
      servers: [concordServer("srv-1", ["!managed:local.example"])],
      activeServerId: null,
      activeChannelId: null,
      members: {},
    });

    const rooms = [
      fakeRoom({ roomId: "!managed:local.example", name: "Managed" }),
      fakeRoom({ roomId: "!loose:remote.example", name: "Loose" }),
    ];
    useServerStore.getState().hydrateFederatedRooms(fakeClient(rooms));

    const servers = useServerStore.getState().servers;
    expect(servers).toHaveLength(2);
    // The Concord server is preserved untouched...
    expect(servers[0].id).toBe("srv-1");
    expect(servers[0].federated).toBeUndefined();
    // ...and the un-managed remote room lives under its host
    // group (Pass 3b homeserver bucket).
    expect(servers[1].id).toBe("federated:homeserver:remote.example");
    expect(servers[1].federated).toBe(true);
    expect(servers[1].channels[0].matrix_room_id).toBe("!loose:remote.example");
  });

  it("is idempotent — repeated calls replace stale federated entries rather than accumulating", () => {
    // First call: two rooms on the same host → one synthetic
    // server with two channels.
    useServerStore.getState().hydrateFederatedRooms(
      fakeClient([
        fakeRoom({ roomId: "!a:remote.example", name: "A" }),
        fakeRoom({ roomId: "!b:remote.example", name: "B" }),
      ]),
    );
    {
      const first = useServerStore.getState().servers;
      expect(first).toHaveLength(1);
      expect(first[0].channels).toHaveLength(2);
    }

    // Second call: only ONE room remains joined (user left the
    // other). The store must drop the stale "!b" channel from
    // the host group — not keep both the new and old state
    // merged together.
    useServerStore.getState().hydrateFederatedRooms(
      fakeClient([fakeRoom({ roomId: "!a:remote.example", name: "A" })]),
    );
    const servers = useServerStore.getState().servers;
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe("federated:homeserver:remote.example");
    expect(servers[0].channels).toHaveLength(1);
    expect(servers[0].channels[0].matrix_room_id).toBe("!a:remote.example");
  });

  it("preserves Concord servers across repeated hydration calls", () => {
    useServerStore.setState({
      servers: [concordServer("srv-persistent", ["!managed:local.example"])],
      activeServerId: null,
      activeChannelId: null,
      members: {},
    });

    useServerStore.getState().hydrateFederatedRooms(
      fakeClient([fakeRoom({ roomId: "!loose:remote.example" })]),
    );
    useServerStore.getState().hydrateFederatedRooms(
      fakeClient([fakeRoom({ roomId: "!loose:remote.example" })]),
    );

    const servers = useServerStore.getState().servers;
    expect(servers.filter((s) => s.id === "srv-persistent")).toHaveLength(1);
    expect(servers.filter((s) => s.federated)).toHaveLength(1);
  });

  it("skips orphan rooms on the local homeserver (deleted-server ghosts)", () => {
    // Scenario: the user deleted a Concord server in the database,
    // but the underlying Matrix rooms were never kicked, so the
    // matrix-js-sdk client still thinks the user is joined to them.
    // Before the local-domain filter, these ghosts would flood the
    // sidebar with synthetic federated entries on every hydration
    // call. After the filter, they are dropped silently.
    //
    // The fake client's `getUserId` returns "@tester:example.org", so
    // any room ending in `:example.org` is considered local.
    const rooms = [
      // Local orphan — should be filtered
      fakeRoom({ roomId: "!ghost1:example.org", name: "Deleted Server 1" }),
      fakeRoom({ roomId: "!ghost2:example.org", name: "Deleted Server 2" }),
      // Real federated room on a remote homeserver — should appear
      fakeRoom({ roomId: "!real:mozilla.org", name: "Mozilla General" }),
      // Another federated room on a different remote
      fakeRoom({ roomId: "!real:friend.example.com", name: "Friend's Room" }),
    ];
    useServerStore.getState().hydrateFederatedRooms(fakeClient(rooms));

    const servers = useServerStore.getState().servers;
    expect(servers).toHaveLength(2);
    const ids = servers.map((s) => s.id).sort();
    expect(ids).toEqual([
      "federated:homeserver:friend.example.com",
      "federated:homeserver:mozilla.org",
    ]);
    // Critically, neither ghost made it into any channel list.
    // @tester:example.org is the local homeserver, so *.example.org
    // entries are filtered out before grouping.
    for (const srv of servers) {
      for (const ch of srv.channels) {
        expect(ch.matrix_room_id).not.toMatch(/:example\.org$/);
      }
    }
  });

  it("falls back to the room id as the channel name when the room has no name", () => {
    const rooms = [fakeRoom({ roomId: "!unnamed:remote.example", name: undefined })];
    useServerStore.getState().hydrateFederatedRooms(fakeClient(rooms));

    const servers = useServerStore.getState().servers;
    expect(servers).toHaveLength(1);
    // Host group takes its name from the domain, not from the
    // channel, so "remote.example" not "!unnamed:remote.example".
    expect(servers[0].name).toBe("remote.example");
    expect(servers[0].abbreviation).toBe("R");
    // But the channel inside falls back to the room id.
    expect(servers[0].channels[0].name).toBe("!unnamed:remote.example");
  });

  it("collapses a space + its joined children into ONE synthetic server with the children as channels", () => {
    // Simulate joining Mozilla's space: one m.space room with three
    // child rooms (#firefox, #rust, #servo). Before the space-aware
    // classifier, this would render as FOUR sidebar entries (the
    // space itself + each child as its own "server"). After the
    // classifier, it should collapse into ONE synthetic server named
    // after the space with three channels under it.
    const rooms = [
      fakeRoom({
        roomId: "!mozspace:mozilla.org",
        name: "Mozilla",
        type: "m.space",
        spaceChildren: [
          "!firefox:mozilla.org",
          "!rust:mozilla.org",
          "!servo:mozilla.org",
        ],
      }),
      fakeRoom({ roomId: "!firefox:mozilla.org", name: "Firefox" }),
      fakeRoom({ roomId: "!rust:mozilla.org", name: "Rust" }),
      fakeRoom({ roomId: "!servo:mozilla.org", name: "Servo" }),
    ];
    useServerStore.getState().hydrateFederatedRooms(fakeClient(rooms));

    const servers = useServerStore.getState().servers;
    expect(servers).toHaveLength(1);
    const space = servers[0];
    expect(space.id).toBe("federated:!mozspace:mozilla.org");
    expect(space.name).toBe("Mozilla");
    expect(space.federated).toBe(true);
    expect(space.channels).toHaveLength(3);
    expect(space.channels.map((c) => c.name)).toEqual([
      "Firefox",
      "Rust",
      "Servo",
    ]);
    expect(space.channels.map((c) => c.matrix_room_id)).toEqual([
      "!firefox:mozilla.org",
      "!rust:mozilla.org",
      "!servo:mozilla.org",
    ]);
    // Positions are monotonic so ChannelSidebar can render them in
    // the intended order.
    expect(space.channels.map((c) => c.position)).toEqual([0, 1, 2]);
  });

  it("skips a space whose child rooms the user isn't joined to", () => {
    // User joined the container but none of the child rooms — an
    // empty space wrapper in the sidebar would be confusing. The
    // hydrator must skip these entirely.
    const rooms = [
      fakeRoom({
        roomId: "!emptyspace:remote.example",
        name: "Empty Space",
        type: "m.space",
        spaceChildren: [
          "!child1:remote.example",
          "!child2:remote.example",
        ],
      }),
      // The child rooms are referenced in m.space.child but the user
      // hasn't joined them — they don't appear in getRooms().
    ];
    useServerStore.getState().hydrateFederatedRooms(fakeClient(rooms));

    const servers = useServerStore.getState().servers;
    expect(servers).toHaveLength(0);
  });

  it("renders a space with only SOME joined children and drops the non-joined ones", () => {
    const rooms = [
      fakeRoom({
        roomId: "!space:remote.example",
        name: "Partial Space",
        type: "m.space",
        spaceChildren: [
          "!joined1:remote.example",
          "!notjoined:remote.example",
          "!joined2:remote.example",
        ],
      }),
      fakeRoom({ roomId: "!joined1:remote.example", name: "Channel A" }),
      fakeRoom({ roomId: "!joined2:remote.example", name: "Channel B" }),
      // !notjoined:remote.example is referenced in m.space.child but
      // not in the joined-rooms list — user isn't a member.
    ];
    useServerStore.getState().hydrateFederatedRooms(fakeClient(rooms));

    const servers = useServerStore.getState().servers;
    expect(servers).toHaveLength(1);
    expect(servers[0].channels).toHaveLength(2);
    expect(servers[0].channels.map((c) => c.name)).toEqual([
      "Channel A",
      "Channel B",
    ]);
  });

  it("does NOT double-render a child room as both a space channel and a standalone entry", () => {
    // A room that's both in getRooms() AND listed as a space.child
    // must appear exactly once, under its parent space.
    const rooms = [
      fakeRoom({
        roomId: "!parent:remote.example",
        name: "Parent Space",
        type: "m.space",
        spaceChildren: ["!child:remote.example"],
      }),
      fakeRoom({ roomId: "!child:remote.example", name: "Child Room" }),
    ];
    useServerStore.getState().hydrateFederatedRooms(fakeClient(rooms));

    const servers = useServerStore.getState().servers;
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe("federated:!parent:remote.example");
    // The child is NOT ALSO rendered as a top-level federated entry.
    const hasStandaloneChild = servers.some(
      (s) => s.id === "federated:!child:remote.example",
    );
    expect(hasStandaloneChild).toBe(false);
  });

  it("renders a standalone room that is NOT a child of any joined space under its host group", () => {
    const rooms = [
      fakeRoom({
        roomId: "!space:remote.example",
        name: "Space",
        type: "m.space",
        spaceChildren: ["!child:remote.example"],
      }),
      fakeRoom({ roomId: "!child:remote.example", name: "Child" }),
      // Independent room not in any space, on a different host.
      fakeRoom({ roomId: "!loose:other.example", name: "Loose Room" }),
    ];
    useServerStore.getState().hydrateFederatedRooms(fakeClient(rooms));

    const servers = useServerStore.getState().servers;
    // The space gives us one synthetic entry (Pass 3a), the
    // loose room on a different host gives us another (Pass 3b
    // homeserver group).
    expect(servers).toHaveLength(2);
    expect(servers.map((s) => s.id).sort()).toEqual([
      "federated:!space:remote.example",
      "federated:homeserver:other.example",
    ]);
  });
});

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
      fakeRoom({ roomId: "!fed:mozilla.org" }),
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
      fakeRoom({ roomId: "!moz:mozilla.org" }),
      fakeRoom({ roomId: "!matrix:matrix.org" }),
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
