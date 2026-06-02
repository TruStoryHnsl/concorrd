import { describe, expect, it } from "vitest";
import {
  CONCORD_SDK_VERSION,
  buildStateEventMessage,
  buildPermissionDeniedMessage,
  isConcordShellMessage,
  isExtensionInboundMessage,
  manifestAllows,
} from "../sdk";

describe("INS-066 W5 — concord:state_event message", () => {
  it("buildStateEventMessage produces the canonical envelope", () => {
    const msg = buildStateEventMessage({
      roomId: "!abc:test.local",
      eventType: "com.concord.foo.state",
      content: { x: 1 },
      sender: "@alice:test.local",
      originServerTs: 1700000000000,
    });
    expect(msg).toEqual({
      type: "concord:state_event",
      payload: {
        roomId: "!abc:test.local",
        eventType: "com.concord.foo.state",
        content: { x: 1 },
        sender: "@alice:test.local",
        originServerTs: 1700000000000,
      },
      version: CONCORD_SDK_VERSION,
    });
  });

  it("isConcordShellMessage accepts state_event envelopes", () => {
    const msg = buildStateEventMessage({
      roomId: "!r:t",
      eventType: "m.room.message",
      content: {},
      sender: "@u:t",
      originServerTs: 1,
    });
    expect(isConcordShellMessage(msg)).toBe(true);
  });

  it("isConcordShellMessage rejects bare extension envelopes", () => {
    expect(
      isConcordShellMessage({
        type: "extension:send_state_event",
        payload: { eventType: "x", content: {} },
        version: CONCORD_SDK_VERSION,
      }),
    ).toBe(false);
  });
});

describe("INS-066 W6 — extension:send_state_event + permission_denied", () => {
  it("isExtensionInboundMessage accepts well-formed verbs", () => {
    expect(
      isExtensionInboundMessage({
        type: "extension:send_state_event",
        payload: { eventType: "x", content: {} },
        version: CONCORD_SDK_VERSION,
      }),
    ).toBe(true);
  });

  it("isExtensionInboundMessage rejects shell-side messages", () => {
    expect(
      isExtensionInboundMessage({
        type: "concord:state_event",
        payload: {},
        version: CONCORD_SDK_VERSION,
      }),
    ).toBe(false);
  });

  it("isExtensionInboundMessage rejects malformed envelopes", () => {
    expect(isExtensionInboundMessage(null)).toBe(false);
    expect(isExtensionInboundMessage("hi")).toBe(false);
    expect(
      isExtensionInboundMessage({ type: "extension:foo", version: 1 }),
    ).toBe(false); // missing payload
    expect(
      isExtensionInboundMessage({
        type: "extension:foo",
        payload: {},
        version: 999,
      }),
    ).toBe(false); // wrong version
  });

  it("buildPermissionDeniedMessage produces the canonical envelope", () => {
    const msg = buildPermissionDeniedMessage({
      action: "extension:send_state_event",
      reason: "manifest_missing_permission",
      detail: "state_events|matrix.send",
    });
    expect(msg).toEqual({
      type: "concord:permission_denied",
      payload: {
        action: "extension:send_state_event",
        reason: "manifest_missing_permission",
        detail: "state_events|matrix.send",
      },
      version: CONCORD_SDK_VERSION,
    });
  });
});

describe("manifestAllows", () => {
  it("matches when any anyOf permission is present", () => {
    expect(manifestAllows(["state_events"], ["state_events", "matrix.read"])).toBe(true);
    expect(manifestAllows(["matrix.read"], ["state_events", "matrix.read"])).toBe(true);
  });

  it("fails closed when manifest is undefined", () => {
    expect(manifestAllows(undefined, ["state_events"])).toBe(false);
  });

  it("fails closed when manifest is empty", () => {
    expect(manifestAllows([], ["state_events"])).toBe(false);
  });

  it("does not match unrelated permissions", () => {
    expect(manifestAllows(["fetch:external"], ["state_events", "matrix.read"])).toBe(false);
  });
});
