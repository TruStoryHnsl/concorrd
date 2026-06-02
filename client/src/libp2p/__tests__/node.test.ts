/**
 * Phase 9 — `node.ts` orchestration tests.
 *
 * These tests do NOT exercise the real js-libp2p stack — that work
 * lives in `identity.test.ts` (for the keypair half) and the
 * end-to-end Playwright session that lands in the Phase 9 follow-up
 * (for the wire half). Here we verify that `startBrowserNode` calls
 * its injected `createLibp2p` exactly once per start, and respects
 * the singleton + stop-then-restart contract.
 *
 * 2026-05-29 architecture redirect: the previous bootstrap-dialing
 * assertions are gone. The browser swarm boots with zero peers known
 * and stays that way until the caller explicitly dials a Phase-5
 * peer card. The old `startBrowserNode(bootstraps)` signature no
 * longer exists.
 */
import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  __setCreateLibp2pForTests,
  startBrowserNode,
  stopBrowserNode,
  getNode,
} from "../node";
import { resetBrowserIdentity } from "../identity";

/** Minimal `Libp2p`-shaped stub we hand `startBrowserNode` via the seam. */
function makeStubNode() {
  return {
    dial: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    // dialProtocol / handle / etc. are not exercised by the orchestration
    // tests — leaving them off keeps the stub honest about what the
    // production code actually depends on.
  };
}

describe("startBrowserNode orchestration", () => {
  let restoreCreate: (() => void) | null = null;

  beforeEach(() => {
    resetBrowserIdentity();
  });

  afterEach(async () => {
    if (restoreCreate) {
      restoreCreate();
      restoreCreate = null;
    }
    await stopBrowserNode();
  });

  it("starts a node, returns it, and does NOT dial any peers automatically", async () => {
    const stub = makeStubNode();
    const createFn = vi.fn().mockResolvedValue(stub);
    restoreCreate = __setCreateLibp2pForTests(createFn as never);

    const handle = await startBrowserNode();

    expect(handle).toBe(stub);
    expect(getNode()).toBe(stub);
    expect(createFn).toHaveBeenCalledTimes(1);
    // Post-2026-05-29 redirect: no automatic dials. The browser swarm
    // waits for explicit Phase-5 peer-card driven dials.
    expect(stub.dial).not.toHaveBeenCalled();
  });

  it("calling start twice returns the same singleton without recreating the swarm", async () => {
    const stub = makeStubNode();
    const createFn = vi.fn().mockResolvedValue(stub);
    restoreCreate = __setCreateLibp2pForTests(createFn as never);

    const first = await startBrowserNode();
    const second = await startBrowserNode();

    expect(second).toBe(first);
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it("stop followed by start yields a fresh node", async () => {
    const firstStub = makeStubNode();
    const secondStub = makeStubNode();
    const createFn = vi
      .fn()
      .mockResolvedValueOnce(firstStub)
      .mockResolvedValueOnce(secondStub);
    restoreCreate = __setCreateLibp2pForTests(createFn as never);

    const first = await startBrowserNode();
    expect(first).toBe(firstStub);

    await stopBrowserNode();
    expect(getNode()).toBeNull();
    expect(firstStub.stop).toHaveBeenCalledTimes(1);

    const second = await startBrowserNode();
    expect(second).toBe(secondStub);
    expect(second).not.toBe(first);
    expect(createFn).toHaveBeenCalledTimes(2);
  });
});
