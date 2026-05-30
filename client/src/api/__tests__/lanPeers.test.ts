/**
 * Vitest cases for the LAN-peers API wrapper.
 *
 * The wrapper listens for the Rust-emitted `peer_lan_discovered`
 * Tauri event and maintains an in-memory session-scoped list keyed by
 * peer_id. Tests here drive the event handler synthetically (no real
 * Tauri runtime) and assert:
 *   - listeners are called with the immediate snapshot on subscribe
 *   - dedup: the same peer_id never produces two cache entries
 *   - multiaddr union: re-announcements merge with the existing list
 *   - teardown removes the listener so it stops receiving updates
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

/**
 * Spin the microtask queue until a predicate holds or a generous
 * watchdog elapses. Used to wait for the dynamic `import()` inside
 * `ensureEventSubscription` to resolve and install the captured
 * handler. The polled predicate is intentionally cheap (a single
 * boolean check) so the loop adds negligible cost when the import
 * resolves immediately.
 */
async function waitForHandler(
  isInstalled: () => boolean,
  maxTicks = 200,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (isInstalled()) return;
    await Promise.resolve();
  }
  throw new Error("listen handler was not installed within the test budget");
}

// Hoist Tauri event mocks so they're installed before the SUT module
// runs its top-level dynamic import.
const { listenMock, unlistenMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  unlistenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

// Force the wrapper's `isTauri()` guard to return true so the
// event-subscription code path runs in tests. Without this the
// subscription would be skipped on jsdom and we couldn't exercise the
// upsert path.
vi.mock("../servitude", () => ({
  isTauri: () => true,
}));

import {
  subscribeToLanPeers,
  getLanPeers,
  __resetLanPeersForTests,
  type LanPeer,
} from "../lanPeers";

/**
 * Capture the event-handler callback the SUT passes to `listen` so
 * tests can drive synthetic mDNS announcements through it.
 */
type Handler = (event: {
  payload: { peer_id: string; multiaddrs: string[] };
}) => void;

function installListenStub(): {
  fire: Handler;
  waitForInstall: () => Promise<void>;
} {
  let captured: Handler | null = null;
  listenMock.mockImplementation((async (_name: string, cb: Handler) => {
    captured = cb;
    return unlistenMock;
  }) as never);
  return {
    fire: (event) => {
      if (!captured) {
        throw new Error("listen stub: handler not installed yet");
      }
      captured(event);
    },
    waitForInstall: () => waitForHandler(() => captured !== null),
  };
}

describe("lanPeers API wrapper", () => {
  beforeEach(() => {
    __resetLanPeersForTests();
    listenMock.mockReset();
    unlistenMock.mockReset();
  });

  it("listeners receive the immediate snapshot on subscribe", () => {
    installListenStub();
    const snapshots: LanPeer[][] = [];
    const unsub = subscribeToLanPeers((peers) => snapshots.push(peers));

    // First call must be the immediate empty snapshot.
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual([]);

    unsub();
  });

  it("dedupes by peer_id across repeat mDNS announcements", async () => {
    const stub = installListenStub();
    const snapshots: LanPeer[][] = [];
    const unsub = subscribeToLanPeers((peers) => snapshots.push(peers));

    // Let the dynamic import inside ensureEventSubscription resolve
    // so `listenMock` is actually called and the handler is captured.
    await stub.waitForInstall();

    const peerId = "12D3KooWLySgoqv8qgxuAwcVaW3R8dyFYvHTAJT6dnZxcf9PYG9W";
    // Two bursts for the same peer_id.
    stub.fire({
      payload: {
        peer_id: peerId,
        multiaddrs: ["/ip4/192.168.1.10/udp/4001/quic-v1"],
      },
    });
    stub.fire({
      payload: {
        peer_id: peerId,
        multiaddrs: ["/ip4/192.168.1.10/udp/4001/quic-v1"],
      },
    });

    const final = getLanPeers();
    expect(final).toHaveLength(1);
    expect(final[0].peerId).toBe(peerId);

    unsub();
  });

  it("unions multiaddrs across successive announcements without dropping known addrs", async () => {
    const stub = installListenStub();
    const snapshots: LanPeer[][] = [];
    const unsub = subscribeToLanPeers((peers) => snapshots.push(peers));
    await stub.waitForInstall();

    const peerId = "12D3KooWAPvtWRKcu3R6LknqqFvo8NcfYmHD3KARg44QruzR6mdn";

    stub.fire({
      payload: {
        peer_id: peerId,
        multiaddrs: ["/ip4/192.168.1.20/udp/4001/quic-v1"],
      },
    });
    stub.fire({
      payload: {
        peer_id: peerId,
        // Second announcement carries a different address; both must
        // survive the merge.
        multiaddrs: ["/ip4/192.168.1.20/tcp/4001"],
      },
    });

    const final = getLanPeers();
    expect(final).toHaveLength(1);
    const peer = final[0];
    expect(peer.peerId).toBe(peerId);
    expect(peer.multiaddrs).toEqual(
      expect.arrayContaining([
        "/ip4/192.168.1.20/udp/4001/quic-v1",
        "/ip4/192.168.1.20/tcp/4001",
      ]),
    );

    unsub();
  });

  it("multiple distinct peers each get their own entry", async () => {
    const stub = installListenStub();
    const snapshots: LanPeer[][] = [];
    const unsub = subscribeToLanPeers((peers) => snapshots.push(peers));
    await stub.waitForInstall();

    stub.fire({
      payload: {
        peer_id: "12D3KooWLySgoqv8qgxuAwcVaW3R8dyFYvHTAJT6dnZxcf9PYG9W",
        multiaddrs: ["/ip4/192.168.1.10/udp/4001/quic-v1"],
      },
    });
    stub.fire({
      payload: {
        peer_id: "12D3KooWAPvtWRKcu3R6LknqqFvo8NcfYmHD3KARg44QruzR6mdn",
        multiaddrs: ["/ip4/192.168.1.11/udp/4001/quic-v1"],
      },
    });

    const final = getLanPeers();
    expect(final).toHaveLength(2);
    expect(final.map((p) => p.peerId).sort()).toEqual(
      [
        "12D3KooWAPvtWRKcu3R6LknqqFvo8NcfYmHD3KARg44QruzR6mdn",
        "12D3KooWLySgoqv8qgxuAwcVaW3R8dyFYvHTAJT6dnZxcf9PYG9W",
      ].sort(),
    );

    unsub();
  });

  it("teardown stops further snapshot fanout", async () => {
    const stub = installListenStub();
    const snapshots: LanPeer[][] = [];
    const unsub = subscribeToLanPeers((peers) => snapshots.push(peers));
    await stub.waitForInstall();

    const before = snapshots.length;
    unsub();

    // A discovery after teardown must not deliver to the removed
    // listener (it CAN still update the module cache, but the snapshot
    // listener should not be called).
    stub.fire({
      payload: {
        peer_id: "12D3KooWL4y2JJGGoQpfYcjhR52aH7FgLPSG5jPL9YvYo9EvNCby",
        multiaddrs: ["/ip4/10.0.0.5/udp/4001/quic-v1"],
      },
    });

    expect(snapshots.length).toBe(before);
  });
});
