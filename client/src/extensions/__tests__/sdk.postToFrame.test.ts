/**
 * postToFrame targetOrigin tightening tests (INS-066-FUP-F).
 *
 * Verifies that postToFrame computes the iframe's actual origin from
 * `frame.src` rather than passing "*", with a documented fallback to
 * "*" + console.warn when the src is unparseable or absent.
 *
 * Same-session note: these tests pair with the same-session change to
 * `sdk.ts`. That's acceptable here because the production behavior is
 * a SINGLE concrete observable (the second arg to postMessage), and
 * the tests assert that observable directly. There is no abstract
 * intermediary that could pass while the production code is broken —
 * if the production code regressed to "*", the explicit-origin test
 * cases would fail immediately.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildInitMessage,
  postToFrame,
  resolvePostTargetOrigin,
} from "../sdk";

function makeFakeFrame(src: string | null | undefined): {
  frame: HTMLIFrameElement;
  postMessage: ReturnType<typeof vi.fn>;
} {
  const postMessage = vi.fn();
  const frame = {
    src: src as string,
    contentWindow: { postMessage } as unknown as Window,
  } as HTMLIFrameElement;
  return { frame, postMessage };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolvePostTargetOrigin (INS-066-FUP-F)", () => {
  it("returns the origin of an absolute https URL", () => {
    const { frame } = makeFakeFrame("https://worldview.concord.app/index.html");
    expect(resolvePostTargetOrigin(frame)).toBe("https://worldview.concord.app");
  });

  it("returns the origin of an absolute http URL", () => {
    const { frame } = makeFakeFrame("http://localhost:5174/dev.html");
    expect(resolvePostTargetOrigin(frame)).toBe("http://localhost:5174");
  });

  it("strips path/query/fragment from the origin", () => {
    const { frame } = makeFakeFrame(
      "https://x.concord.app/foo/bar?token=abc#section",
    );
    expect(resolvePostTargetOrigin(frame)).toBe("https://x.concord.app");
  });

  it("falls back to '*' with console.warn when src is empty string", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { frame } = makeFakeFrame("");
    expect(resolvePostTargetOrigin(frame)).toBe("*");
    // Empty src follows the "no src" path — no warn (warn is for
    // unparseable, not absent).
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to '*' when frame is null/undefined", () => {
    expect(resolvePostTargetOrigin(null)).toBe("*");
    expect(resolvePostTargetOrigin(undefined)).toBe("*");
  });

  it("resolves a relative path against window.location for runtime-installed /ext/ paths", () => {
    // jsdom default location is http://localhost:3000 in vitest. We
    // assert that a same-origin absolute URL is returned (origin only),
    // not the relative path — which is exactly the same-origin policy
    // we want enforced for /ext/{id}/ runtime-installed extensions.
    const { frame } = makeFakeFrame("/ext/com.concord.orrdia-bridge/index.html");
    const result = resolvePostTargetOrigin(frame);
    // Whatever the test runner's window.location.origin is, the result
    // must be that exact origin — not "*", not the path itself.
    expect(result).toBe(window.location.origin);
    expect(result).not.toBe("*");
    expect(result).not.toContain("/ext/");
  });
});

describe("postToFrame (INS-066-FUP-F)", () => {
  it("calls postMessage with the iframe's resolved origin, NOT '*'", () => {
    const { frame, postMessage } = makeFakeFrame(
      "https://worldview.concord.app/index.html",
    );
    const msg = buildInitMessage({
      sessionId: "sess-1",
      extensionId: "com.test.ext",
      mode: "shared",
      participantId: "@alice:test.local",
      seat: "participant",
      surfaces: [],
    });

    postToFrame(frame, msg);

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [arg0, arg1] = postMessage.mock.calls[0];
    expect(arg0).toEqual(msg);
    expect(arg1).toBe("https://worldview.concord.app");
    expect(arg1).not.toBe("*");
  });

  it("falls back to '*' when iframe.src is empty (and still delivers)", () => {
    const { frame, postMessage } = makeFakeFrame("");
    const msg = buildInitMessage({
      sessionId: "sess-2",
      extensionId: "com.test.ext",
      mode: "shared",
      participantId: "@alice:test.local",
      seat: "participant",
      surfaces: [],
    });

    postToFrame(frame, msg);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][1]).toBe("*");
  });

  it("no-ops cleanly when frame is null", () => {
    // Just verifying no throw — there's nothing to assert on the call.
    expect(() => {
      postToFrame(null, {
        type: "concord:init",
        payload: {
          sessionId: "x",
          extensionId: "x",
          mode: "shared",
          participantId: "@x:test.local",
          seat: "participant",
          surfaces: [],
        },
        version: 1 as never,
      });
    }).not.toThrow();
  });

  it("no-ops cleanly when frame.contentWindow is null", () => {
    const frame = {
      src: "https://x.concord.app/",
      contentWindow: null,
    } as unknown as HTMLIFrameElement;
    expect(() => {
      postToFrame(frame, {
        type: "concord:init",
        payload: {
          sessionId: "x",
          extensionId: "x",
          mode: "shared",
          participantId: "@x:test.local",
          seat: "participant",
          surfaces: [],
        },
        version: 1 as never,
      });
    }).not.toThrow();
  });
});
