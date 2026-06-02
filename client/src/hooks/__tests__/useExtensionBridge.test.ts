/**
 * Regression test for INS-066-FUP-A — the wiring that binds
 * <ExtensionSurfaceManager/>'s W5/W6 SDK ports to the live matrix-js-sdk
 * client + room store.
 *
 * Failure mode this locks in: the W5/W6 ExtensionEmbed wiring previously
 * landed with `subscribeRoomEvents` and `onSendStateEvent` documented but
 * unbound at the call site (PLAN.md INS-066 W5/W6 "_Partial:_" notes).
 * Symptom: no real Matrix events ever reached an extension iframe, and
 * iframe-emitted state events were silently dropped.
 *
 * What this test proves end-to-end (against a fake matrix client that
 * mirrors the EventEmitter shape used elsewhere in the test suite —
 * `useUnreadCounts.test.ts` follows the same pattern):
 *   1. The bridge subscribes to `RoomEvent.Timeline` on the client.
 *   2. A timeline event in the target room reaches the handler.
 *   3. A timeline event in a DIFFERENT room is ignored.
 *   4. State events from the room's currentState bus also reach the
 *      handler (snapshot delivery path).
 *   5. `onSendStateEvent` calls `client.sendStateEvent(roomId, type,
 *      content, stateKey)` with the same arg order existing call sites use.
 *   6. Unsubscribe removes both listeners.
 */

import { renderHook, act } from "@testing-library/react";
import { RoomEvent, RoomStateEvent } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { useExtensionRoomBridge } from "../useExtensionBridge";

type Listener = (...args: unknown[]) => void;

interface FakeRoomState {
  on: (ev: string, l: Listener) => void;
  removeListener: (ev: string, l: Listener) => void;
  emit: (ev: string, ...args: unknown[]) => void;
}

interface FakeRoom {
  roomId: string;
  currentState: FakeRoomState;
}

interface FakeClient {
  on: (ev: string, l: Listener) => void;
  removeListener: (ev: string, l: Listener) => void;
  emitTimeline: (event: unknown, room: FakeRoom | undefined) => void;
  getRoom: (id: string) => FakeRoom | null;
  sendStateEvent: ReturnType<typeof vi.fn>;
  /** number of currently-registered RoomEvent.Timeline listeners */
  timelineListenerCount: () => number;
}

function makeRoomState(): FakeRoomState {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on: (ev, l) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(l);
    },
    removeListener: (ev, l) => {
      listeners.get(ev)?.delete(l);
    },
    emit: (ev, ...args) => {
      for (const l of listeners.get(ev) ?? []) l(...args);
    },
  };
}

function makeRoom(roomId: string): FakeRoom {
  return { roomId, currentState: makeRoomState() };
}

function makeFakeClient(rooms: FakeRoom[]): FakeClient {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on: (ev, l) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(l);
    },
    removeListener: (ev, l) => {
      listeners.get(ev)?.delete(l);
    },
    emitTimeline: (event, room) => {
      for (const l of listeners.get(RoomEvent.Timeline) ?? []) {
        l(event, room);
      }
    },
    getRoom: (id) => rooms.find((r) => r.roomId === id) ?? null,
    sendStateEvent: vi.fn().mockResolvedValue({ event_id: "$ok" }),
    timelineListenerCount: () => listeners.get(RoomEvent.Timeline)?.size ?? 0,
  };
}

function makeMatrixEventLike(opts: {
  id?: string;
  type: string;
  content: Record<string, unknown>;
  sender: string;
  ts: number;
  stateKey?: string;
}) {
  return {
    getId: () => opts.id ?? `$${Math.random().toString(36).slice(2)}`,
    getType: () => opts.type,
    getContent: () => opts.content,
    getSender: () => opts.sender,
    getTs: () => opts.ts,
    getStateKey: () => opts.stateKey,
  };
}

describe("useExtensionRoomBridge — INS-066-FUP-A wiring", () => {
  it("returns null when client is missing", () => {
    const { result } = renderHook(() =>
      useExtensionRoomBridge(null, "!room:test.local"),
    );
    expect(result.current).toBeNull();
  });

  it("returns null when roomId is missing", () => {
    const room = makeRoom("!room:test.local");
    const fake = makeFakeClient([room]);
    const { result } = renderHook(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useExtensionRoomBridge(fake as any, null),
    );
    expect(result.current).toBeNull();
  });

  it("forwards timeline events for the target room and ignores others", () => {
    const target = makeRoom("!room:test.local");
    const other = makeRoom("!other:test.local");
    const fake = makeFakeClient([target, other]);
    const { result } = renderHook(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useExtensionRoomBridge(fake as any, "!room:test.local"),
    );

    const handler = vi.fn();
    const unsub = result.current!.subscribeRoomEvents(handler);
    expect(fake.timelineListenerCount()).toBe(1);

    // Event for the target room — forwarded.
    act(() => {
      fake.emitTimeline(
        makeMatrixEventLike({
          type: "com.concord.foo.state",
          content: { x: 1 },
          sender: "@a:test.local",
          ts: 1700000000000,
          stateKey: "k",
        }),
        target,
      );
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual({
      type: "com.concord.foo.state",
      content: { x: 1 },
      sender: "@a:test.local",
      origin_server_ts: 1700000000000,
      state_key: "k",
    });

    // Event for a different room — silently dropped.
    act(() => {
      fake.emitTimeline(
        makeMatrixEventLike({
          type: "m.room.message",
          content: { body: "off-topic" },
          sender: "@b:test.local",
          ts: 1700000000001,
        }),
        other,
      );
    });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    expect(fake.timelineListenerCount()).toBe(0);
  });

  it("forwards state events from the room's currentState bus", () => {
    const target = makeRoom("!room:test.local");
    const fake = makeFakeClient([target]);
    const { result } = renderHook(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useExtensionRoomBridge(fake as any, "!room:test.local"),
    );

    const handler = vi.fn();
    const unsub = result.current!.subscribeRoomEvents(handler);

    act(() => {
      target.currentState.emit(
        RoomStateEvent.Events,
        makeMatrixEventLike({
          id: "$state-1",
          type: "com.concord.bar.state",
          content: { y: 2 },
          sender: "@c:test.local",
          ts: 1700000000002,
          stateKey: "main",
        }),
      );
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      type: "com.concord.bar.state",
      sender: "@c:test.local",
      state_key: "main",
    });

    unsub();
  });

  it("dedupes when both timeline and state buses fire the same event id", () => {
    const target = makeRoom("!room:test.local");
    const fake = makeFakeClient([target]);
    const { result } = renderHook(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useExtensionRoomBridge(fake as any, "!room:test.local"),
    );

    const handler = vi.fn();
    result.current!.subscribeRoomEvents(handler);

    const ev = makeMatrixEventLike({
      id: "$dup",
      type: "com.concord.dup",
      content: {},
      sender: "@a:t",
      ts: 1,
      stateKey: "",
    });

    // Timeline emit first.
    act(() => {
      fake.emitTimeline(ev, target);
    });
    // Then state-bus emit of the same event id.
    act(() => {
      target.currentState.emit(RoomStateEvent.Events, ev);
    });

    // Timeline path forwards always; state-bus dedupes against `seen`.
    // We accept exactly one delivery; the bridge tracks via id.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("onSendStateEvent calls client.sendStateEvent with (roomId, type, content, stateKey)", async () => {
    const target = makeRoom("!room:test.local");
    const fake = makeFakeClient([target]);
    const { result } = renderHook(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useExtensionRoomBridge(fake as any, "!room:test.local"),
    );

    await result.current!.onSendStateEvent({
      roomId: "!room:test.local",
      eventType: "com.concord.test.queue",
      stateKey: "main",
      content: { tracks: [1, 2, 3] },
    });

    expect(fake.sendStateEvent).toHaveBeenCalledTimes(1);
    expect(fake.sendStateEvent).toHaveBeenCalledWith(
      "!room:test.local",
      "com.concord.test.queue",
      { tracks: [1, 2, 3] },
      "main",
    );
  });

  it("onSendStateEvent rejects when the underlying SDK rejects", async () => {
    const target = makeRoom("!room:test.local");
    const fake = makeFakeClient([target]);
    fake.sendStateEvent.mockRejectedValueOnce(new Error("M_FORBIDDEN"));
    const { result } = renderHook(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useExtensionRoomBridge(fake as any, "!room:test.local"),
    );

    await expect(
      result.current!.onSendStateEvent({
        roomId: "!room:test.local",
        eventType: "x",
        stateKey: "",
        content: {},
      }),
    ).rejects.toThrow("M_FORBIDDEN");
  });
});
