import { act, renderHook } from "@testing-library/react";
import { RoomEvent } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSendReadReceipt, useUnreadCounts } from "../useUnreadCounts";
import { useAuthStore } from "../../stores/auth";

function createFakeClient(opts?: {
  rooms?: ReturnType<typeof createFakeRoom>[];
  /** Override the timeline for the synthetic "!dm:test.local" room used by
   *  receipt-sender tests. Defaults to a single message-shaped event so
   *  baseline tests that assert receipts fire still work unchanged. */
  timeline?: { getId: () => string; getType: () => string }[];
}) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const lastEvent = { getId: () => "$event-1", getType: () => "m.room.message" };
  const events = opts?.timeline ?? [lastEvent];
  const room = {
    roomId: "!dm:test.local",
    getLiveTimeline: () => ({
      getEvents: () => events,
    }),
  };

  return {
    lastEvent,
    getRoom: vi.fn(() => room),
    getRooms: vi.fn(() => opts?.rooms ?? []),
    setRoomReadMarkers: vi.fn().mockResolvedValue({}),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    }),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    emitTimeline(roomId: string) {
      for (const listener of listeners.get(RoomEvent.Timeline) ?? []) {
        listener({}, { roomId }, false, false, { liveEvent: true });
      }
    },
  };
}

interface FakeEventInit {
  id: string;
  type?: string;
  sender?: string;
  body?: string;
  mentions?: string[];
}

function fakeEvent(init: FakeEventInit) {
  const content: Record<string, unknown> = {};
  if (init.body) content.body = init.body;
  if (init.mentions) content["m.mentions"] = { user_ids: init.mentions };
  return {
    getId: () => init.id,
    getType: () => init.type ?? "m.room.message",
    getSender: () => init.sender ?? "@other:test.local",
    getContent: () => content,
  };
}

function createFakeRoom(opts: {
  roomId: string;
  events: ReturnType<typeof fakeEvent>[];
  /** event ID the user has read up to — anything strictly newer in `events`
   *  counts as unread. */
  readUpTo?: string | null;
}) {
  const readUpTo = opts.readUpTo ?? null;
  const indexOfRead = readUpTo
    ? opts.events.findIndex((e) => e.getId() === readUpTo)
    : -1;
  return {
    roomId: opts.roomId,
    getLiveTimeline: () => ({ getEvents: () => opts.events }),
    hasUserReadEvent: (_userId: string, eventId: string) => {
      const idx = opts.events.findIndex((e) => e.getId() === eventId);
      return idx >= 0 && idx <= indexOfRead;
    },
  };
}

describe("useSendReadReceipt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAuthStore.setState({
      client: null,
      userId: "@tester:test.local",
      accessToken: "token",
      isLoggedIn: true,
      isLoading: false,
      syncing: false,
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    useAuthStore.setState({
      client: null,
      userId: null,
      accessToken: null,
      isLoggedIn: false,
      isLoading: false,
      syncing: false,
    });
  });

  it("advances room read markers on room switch", async () => {
    const client = createFakeClient();
    useAuthStore.setState({ client: client as never });

    renderHook(() => useSendReadReceipt("!dm:test.local"));

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(client.setRoomReadMarkers).toHaveBeenCalledWith(
      "!dm:test.local",
      "$event-1",
      client.lastEvent,
    );
  });

  it("advances room read markers for live events while the room is visible", async () => {
    const client = createFakeClient();
    useAuthStore.setState({ client: client as never });

    renderHook(() => useSendReadReceipt("!dm:test.local"));
    client.setRoomReadMarkers.mockClear();

    await act(async () => {
      client.emitTimeline("!dm:test.local");
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(client.setRoomReadMarkers).toHaveBeenCalledWith(
      "!dm:test.local",
      "$event-1",
      client.lastEvent,
    );
  });

  it("does NOT send a receipt anchored on a state event when the timeline has no message-shaped events", async () => {
    // App-channels (v0.7.2+) and freshly-synced lazy-load rooms can land
    // with a sparse initial timeline containing only state events
    // (m.room.create, m.room.member, m.room.power_levels, ...). The
    // earlier fallback anchored the receipt on whatever was at the tail,
    // including state events, which the homeserver ignored for unread
    // purposes — so the badge stayed lit forever. The fix is to NOT
    // send a receipt at all when there's nothing message-shaped to anchor
    // on; computeUnreadForRoom returns 0 in that case so no badge is lit.
    const client = createFakeClient({
      timeline: [
        { getId: () => "$create", getType: () => "m.room.create" },
        { getId: () => "$member", getType: () => "m.room.member" },
        { getId: () => "$power", getType: () => "m.room.power_levels" },
      ],
    });
    useAuthStore.setState({ client: client as never });

    renderHook(() => useSendReadReceipt("!dm:test.local"));

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(client.setRoomReadMarkers).not.toHaveBeenCalled();
  });

  it("anchors the receipt on the most recent message-shaped event when the tail is a state event", async () => {
    // Real-world rooms accumulate state events (e.g. profile updates,
    // member changes) AFTER the most recent message. The receipt must
    // anchor on the message — not the state-event tail — or the server
    // won't acknowledge it for unread purposes.
    const messageEvent = { getId: () => "$msg-7", getType: () => "m.room.message" };
    const client = createFakeClient({
      timeline: [
        { getId: () => "$msg-6", getType: () => "m.room.message" },
        messageEvent,
        { getId: () => "$tail-state", getType: () => "m.room.member" },
      ],
    });
    useAuthStore.setState({ client: client as never });

    renderHook(() => useSendReadReceipt("!dm:test.local"));

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(client.setRoomReadMarkers).toHaveBeenCalledWith(
      "!dm:test.local",
      "$msg-7",
      messageEvent,
    );
  });
});

describe("useUnreadCounts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAuthStore.setState({
      client: null,
      userId: "@tester:test.local",
      accessToken: "token",
      isLoggedIn: true,
      isLoading: false,
      syncing: false,
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    useAuthStore.setState({
      client: null,
      userId: null,
      accessToken: null,
      isLoggedIn: false,
      isLoading: false,
      syncing: false,
    });
  });

  it("counts only events newer than the user's read receipt", () => {
    const room = createFakeRoom({
      roomId: "!a:test.local",
      events: [
        fakeEvent({ id: "$1" }),
        fakeEvent({ id: "$2" }),
        fakeEvent({ id: "$3" }),
        fakeEvent({ id: "$4" }),
      ],
      readUpTo: "$2",
    });
    const client = createFakeClient({ rooms: [room as never] });
    useAuthStore.setState({ client: client as never });

    const { result } = renderHook(() => useUnreadCounts());

    expect(result.current.get("!a:test.local")).toBe(2);
  });

  it("returns zero unread when the user has read the latest event", () => {
    const room = createFakeRoom({
      roomId: "!a:test.local",
      events: [fakeEvent({ id: "$1" }), fakeEvent({ id: "$2" })],
      readUpTo: "$2",
    });
    const client = createFakeClient({ rooms: [room as never] });
    useAuthStore.setState({ client: client as never });

    const { result } = renderHook(() => useUnreadCounts());

    expect(result.current.has("!a:test.local")).toBe(false);
  });

  it("ignores the user's own messages when computing unread", () => {
    const room = createFakeRoom({
      roomId: "!a:test.local",
      events: [
        fakeEvent({ id: "$1", sender: "@tester:test.local" }),
        fakeEvent({ id: "$2", sender: "@tester:test.local" }),
      ],
      readUpTo: null,
    });
    const client = createFakeClient({ rooms: [room as never] });
    useAuthStore.setState({ client: client as never });

    const { result } = renderHook(() => useUnreadCounts());

    expect(result.current.has("!a:test.local")).toBe(false);
  });

  it("ignores non-message event types (state, reactions, redactions)", () => {
    const room = createFakeRoom({
      roomId: "!a:test.local",
      events: [
        fakeEvent({ id: "$1", type: "m.room.member" }),
        fakeEvent({ id: "$2", type: "m.reaction" }),
        fakeEvent({ id: "$3", type: "m.room.redaction" }),
      ],
      readUpTo: null,
    });
    const client = createFakeClient({ rooms: [room as never] });
    useAuthStore.setState({ client: client as never });

    const { result } = renderHook(() => useUnreadCounts());

    expect(result.current.has("!a:test.local")).toBe(false);
  });
});
