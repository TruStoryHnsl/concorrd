/**
 * Phase 9 — `node.ts` orchestration tests.
 *
 * These tests do NOT exercise the real js-libp2p stack — that work
 * lives in `identity.test.ts` (for the keypair half) and the
 * end-to-end Playwright session that lands in the Phase 9 follow-up
 * (for the wire half). Here we verify that `startBrowserNode` calls
 * its injected `createLibp2p` exactly once per start, dials every
 * bootstrap multiaddr it's given, and respects the singleton +
 * stop-then-restart contract.
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

  it("starts a node, returns it, and dials every bootstrap multiaddr", async () => {
    const stub = makeStubNode();
    const createFn = vi.fn().mockResolvedValue(stub);
    restoreCreate = __setCreateLibp2pForTests(createFn as never);

    const bootstraps = [
      "/dns4/bootstrap1.example/udp/4001/quic-v1/p2p/12D3KooWLySgoqv8qgxuAwcVaW3R8dyFYvHTAJT6dnZxcf9PYG9W",
      "/dns4/bootstrap2.example/udp/4001/quic-v1/p2p/12D3KooWAPvtWRKcu3R6LknqqFvo8NcfYmHD3KARg44QruzR6mdn",
    ];

    const handle = await startBrowserNode(bootstraps);

    expect(handle).toBe(stub);
    expect(getNode()).toBe(stub);
    expect(createFn).toHaveBeenCalledTimes(1);
    // Every bootstrap multiaddr must reach the dial path. Failures are
    // swallowed (they're best-effort) but the call MUST happen.
    expect(stub.dial).toHaveBeenCalledTimes(bootstraps.length);
  });

  it("calling start twice returns the same singleton without recreating the swarm", async () => {
    const stub = makeStubNode();
    const createFn = vi.fn().mockResolvedValue(stub);
    restoreCreate = __setCreateLibp2pForTests(createFn as never);

    const first = await startBrowserNode([]);
    const second = await startBrowserNode([]);

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

    const first = await startBrowserNode([]);
    expect(first).toBe(firstStub);

    await stopBrowserNode();
    expect(getNode()).toBeNull();
    expect(firstStub.stop).toHaveBeenCalledTimes(1);

    const second = await startBrowserNode([]);
    expect(second).toBe(secondStub);
    expect(second).not.toBe(first);
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it("swallows bootstrap dial failures so the swarm still comes up", async () => {
    const stub = {
      ...makeStubNode(),
      dial: vi.fn().mockRejectedValue(new Error("network unreachable")),
    };
    const createFn = vi.fn().mockResolvedValue(stub);
    restoreCreate = __setCreateLibp2pForTests(createFn as never);

    const handle = await startBrowserNode([
      "/dns4/bootstrap1.example/udp/4001/quic-v1/p2p/12D3KooWLySgoqv8qgxuAwcVaW3R8dyFYvHTAJT6dnZxcf9PYG9W",
    ]);

    expect(handle).toBe(stub);
    expect(getNode()).toBe(stub);
    expect(stub.dial).toHaveBeenCalledTimes(1);
  });
});
