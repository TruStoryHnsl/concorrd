/**
 * State-event roundtrip integration test (INS-066 W5+W6+W8).
 *
 * Exercises the shell ↔ iframe message contract end-to-end at the
 * React-component level:
 *
 *  1. Outbound (W5): a synthetic Matrix room event is dispatched into
 *     the room subscription. The shell should forward it to the iframe
 *     IFF the manifest grants state_events / matrix.read.
 *  2. Inbound (W6): the iframe's window posts an
 *     extension:send_state_event verb. The shell should call
 *     onSendStateEvent on allow, post back permission_denied on deny.
 *
 * No real Matrix server, no real network. All collaborators are mocked.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ExtensionSurfaceManager from "../../components/extension/ExtensionEmbed";
import type { IncomingMatrixEvent } from "../../components/extension/ExtensionEmbed";
import { CONCORD_SDK_VERSION } from "../sdk";

beforeEach(() => {
  cleanup();
});

interface RoomEventBus {
  emit: (ev: IncomingMatrixEvent) => void;
  subscribe: (handler: (ev: IncomingMatrixEvent) => void) => () => void;
}

function makeBus(): RoomEventBus {
  let handler: ((ev: IncomingMatrixEvent) => void) | null = null;
  return {
    emit: (ev) => {
      if (handler) handler(ev);
    },
    subscribe: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
  };
}

const COMMON_PROPS = {
  url: "/ext/com.concord.test/index.html",
  extensionName: "Test Ext",
  hostUserId: "@host:test.local",
  isHost: true,
  onStop: () => {},
};

const SDK_INIT = {
  sessionId: "sess-1",
  extensionId: "com.concord.test",
  mode: "shared" as const,
  participantId: "@host:test.local",
  seat: "host" as const,
};

function findIframe(): HTMLIFrameElement {
  // The component renders one iframe per surface; with the default
  // single-panel surface the manager renders exactly one.
  const f = document.querySelector("iframe");
  if (!f) throw new Error("no iframe rendered");
  return f as HTMLIFrameElement;
}

describe("INS-066 W5 — concord:state_event forwarding", () => {
  it("forwards Matrix events to the iframe when manifest allows", () => {
    const bus = makeBus();
    render(
      <ExtensionSurfaceManager
        {...COMMON_PROPS}
        sdkInit={SDK_INIT}
        manifestPermissions={["state_events"]}
        roomId="!room:test.local"
        subscribeRoomEvents={bus.subscribe}
      />,
    );

    const iframe = findIframe();
    // Make contentWindow.postMessage observable. Swap in a fresh spy.
    const post = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage: post },
      configurable: true,
    });

    act(() => {
      bus.emit({
        type: "com.concord.foo.state",
        content: { hello: "world" },
        sender: "@alice:test.local",
        origin_server_ts: 1700000000000,
        state_key: "k",
      });
    });

    // Should have at least one state_event (in addition to any init/resize).
    const stateEventCalls = post.mock.calls.filter(
      ([m]) => m && m.type === "concord:state_event",
    );
    expect(stateEventCalls).toHaveLength(1);
    expect(stateEventCalls[0][0]).toMatchObject({
      type: "concord:state_event",
      version: CONCORD_SDK_VERSION,
      payload: {
        roomId: "!room:test.local",
        eventType: "com.concord.foo.state",
        sender: "@alice:test.local",
        stateKey: "k",
      },
    });
  });

  it("does NOT forward when manifest lacks state_events / matrix.read", () => {
    const bus = makeBus();
    render(
      <ExtensionSurfaceManager
        {...COMMON_PROPS}
        sdkInit={SDK_INIT}
        manifestPermissions={["fetch:external"]}
        roomId="!room:test.local"
        subscribeRoomEvents={bus.subscribe}
      />,
    );

    const iframe = findIframe();
    const post = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage: post },
      configurable: true,
    });

    act(() => {
      bus.emit({
        type: "m.room.message",
        content: { body: "hi" },
        sender: "@a:t",
        origin_server_ts: 1,
      });
    });

    const stateEventCalls = post.mock.calls.filter(
      ([m]) => m && m.type === "concord:state_event",
    );
    expect(stateEventCalls).toHaveLength(0);
  });

  it("does NOT forward when manifest is undefined (fail-closed)", () => {
    const bus = makeBus();
    render(
      <ExtensionSurfaceManager
        {...COMMON_PROPS}
        sdkInit={SDK_INIT}
        roomId="!room:test.local"
        subscribeRoomEvents={bus.subscribe}
      />,
    );
    const iframe = findIframe();
    const post = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage: post },
      configurable: true,
    });
    act(() => {
      bus.emit({ type: "m.x", content: {}, sender: "@a:t", origin_server_ts: 1 });
    });
    expect(post.mock.calls.filter(([m]) => m?.type === "concord:state_event")).toHaveLength(0);
  });
});

describe("INS-066 W6 — extension:send_state_event handling", () => {
  // The inbound message handler is registered on `window`; we synthesise
  // a MessageEvent and dispatch it. event.source is set to a stub Window
  // so the shell can post back permission_denied replies.

  function dispatchInbound(payload: unknown, sourceCallback: (m: unknown) => void) {
    const fakeSource: Pick<Window, "postMessage"> = {
      postMessage: ((m: unknown) => sourceCallback(m)) as Window["postMessage"],
    };
    const ev = new MessageEvent("message", {
      data: payload,
      source: fakeSource as unknown as MessageEventSource,
    });
    window.dispatchEvent(ev);
  }

  it("emits via onSendStateEvent on allow", () => {
    const onSend = vi.fn();
    render(
      <ExtensionSurfaceManager
        {...COMMON_PROPS}
        sdkInit={SDK_INIT}
        manifestPermissions={["state_events"]}
        roomId="!room:test.local"
        onSendStateEvent={onSend}
      />,
    );

    const replies: unknown[] = [];
    dispatchInbound(
      {
        type: "extension:send_state_event",
        payload: {
          eventType: "com.concord.test.queue",
          stateKey: "main",
          content: { tracks: [1, 2, 3] },
        },
        version: CONCORD_SDK_VERSION,
      },
      (m) => replies.push(m),
    );

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({
      roomId: "!room:test.local",
      eventType: "com.concord.test.queue",
      stateKey: "main",
      content: { tracks: [1, 2, 3] },
    });
    expect(replies).toEqual([]); // no permission_denied posted back
  });

  it("denies + posts back permission_denied when manifest is missing perm", () => {
    const onSend = vi.fn();
    render(
      <ExtensionSurfaceManager
        {...COMMON_PROPS}
        sdkInit={SDK_INIT}
        manifestPermissions={["fetch:external"]}
        roomId="!room:test.local"
        onSendStateEvent={onSend}
      />,
    );

    const replies: unknown[] = [];
    dispatchInbound(
      {
        type: "extension:send_state_event",
        payload: { eventType: "x", content: {} },
        version: CONCORD_SDK_VERSION,
      },
      (m) => replies.push(m),
    );

    expect(onSend).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      type: "concord:permission_denied",
      payload: { action: "extension:send_state_event", reason: "manifest_missing_permission" },
      version: CONCORD_SDK_VERSION,
    });
  });

  it("denies when InputRouter blocks (observer in shared mode)", () => {
    const onSend = vi.fn();
    render(
      <ExtensionSurfaceManager
        {...COMMON_PROPS}
        sdkInit={{ ...SDK_INIT, seat: "observer" }}
        participantSeat="observer"
        manifestPermissions={["state_events"]}
        roomId="!room:test.local"
        onSendStateEvent={onSend}
      />,
    );

    const replies: unknown[] = [];
    dispatchInbound(
      {
        type: "extension:send_state_event",
        payload: { eventType: "x", content: {} },
        version: CONCORD_SDK_VERSION,
      },
      (m) => replies.push(m),
    );

    expect(onSend).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      type: "concord:permission_denied",
      payload: { reason: "session_role_forbidden" },
    });
  });

  it("rejects cross-room sends", () => {
    const onSend = vi.fn();
    render(
      <ExtensionSurfaceManager
        {...COMMON_PROPS}
        sdkInit={SDK_INIT}
        manifestPermissions={["state_events"]}
        roomId="!room:test.local"
        onSendStateEvent={onSend}
      />,
    );
    const replies: unknown[] = [];
    dispatchInbound(
      {
        type: "extension:send_state_event",
        payload: {
          roomId: "!other:test.local",
          eventType: "x",
          content: {},
        },
        version: CONCORD_SDK_VERSION,
      },
      (m) => replies.push(m),
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(replies[0]).toMatchObject({
      payload: { reason: "session_role_forbidden", detail: "cross_room" },
    });
  });

  it("rejects malformed payload", () => {
    const onSend = vi.fn();
    render(
      <ExtensionSurfaceManager
        {...COMMON_PROPS}
        sdkInit={SDK_INIT}
        manifestPermissions={["state_events"]}
        roomId="!room:test.local"
        onSendStateEvent={onSend}
      />,
    );
    const replies: unknown[] = [];
    dispatchInbound(
      {
        type: "extension:send_state_event",
        payload: { eventType: 123, content: null },
        version: CONCORD_SDK_VERSION,
      },
      (m) => replies.push(m),
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(replies[0]).toMatchObject({
      payload: { reason: "invalid_payload" },
    });
  });
});

// =====================================================================
// Cold-reader negative coverage (INS-066-FUP-D)
// ---------------------------------------------------------------------
// The cases above all stub iframe.contentWindow.postMessage with a
// vi.fn(). That stub silently records the message regardless of the
// `targetOrigin` argument. The targetOrigin contract is unit-tested
// directly in `sdk.postToFrame.test.ts` (delivered alongside FUP-F),
// where the second arg is asserted explicitly.
//
// The negative case below pins the W6 permission-denied reply
// channel: a denied verb must surface the canonical envelope to the
// source window, not silently drop. Without this assertion, a
// regression that swallowed the `event.source.postMessage` call
// would leave extensions waiting forever on a verb the shell quietly
// ignored.
// =====================================================================

describe("INS-066-FUP-D — permission_denied reply is delivered, not dropped", () => {
  it("emits permission_denied to the source window when manifest lacks the perm", () => {
    const replies: Array<[unknown, string]> = [];
    const onSend = vi.fn();
    render(
      <ExtensionSurfaceManager
        {...COMMON_PROPS}
        sdkInit={SDK_INIT}
        manifestPermissions={["fetch:external"]}
        roomId="!room:test.local"
        onSendStateEvent={onSend}
      />,
    );

    const fakeSource: Pick<Window, "postMessage"> = {
      postMessage: ((m: unknown, targetOrigin?: string) =>
        replies.push([m, targetOrigin ?? ""])) as Window["postMessage"],
    };
    const ev = new MessageEvent("message", {
      data: {
        type: "extension:send_state_event",
        payload: { eventType: "x", content: {} },
        version: CONCORD_SDK_VERSION,
      },
      source: fakeSource as unknown as MessageEventSource,
    });
    window.dispatchEvent(ev);

    expect(onSend).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0][0]).toMatchObject({
      type: "concord:permission_denied",
      payload: { reason: "manifest_missing_permission" },
    });
  });
});
