import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks for SUT deps — pattern matches identity.test.ts.
const {
  fetchKnownPeersMock,
  addPeerMock,
  removePeerMock,
  isTauriMock,
  listenMock,
  capturedListeners,
} = vi.hoisted(() => ({
  fetchKnownPeersMock: vi.fn(),
  addPeerMock: vi.fn(),
  removePeerMock: vi.fn(),
  isTauriMock: vi.fn(),
  listenMock: vi.fn(),
  capturedListeners: {} as Record<
    string,
    ((event: { payload: unknown }) => void) | undefined
  >,
}));

vi.mock("../../api/peerStore", () => ({
  fetchKnownPeers: fetchKnownPeersMock,
  addPeer: addPeerMock,
  removePeer: removePeerMock,
}));

vi.mock("../../api/servitude", () => ({
  isTauri: isTauriMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

import {
  usePeerStore,
  __resetPeerStoreEventSubscriptionForTests,
} from "../peerStore";
import type { KnownPeer } from "../../api/peerStore";

const SAMPLE_PEER: KnownPeer = {
  peerId: "12D3KooWSample",
  publicKeyHex: "a".repeat(64),
  multiaddrs: ["/ip4/127.0.0.1/tcp/4001"],
  source: "qr",
  firstSeen: "2026-05-27T12:00:00Z",
  lastSeen: "2026-05-27T13:00:00Z",
  accessGranted: true,
  lastAccessGrantAt: null,
};

const SAMPLE_PEER_2: KnownPeer = {
  peerId: "12D3KooWSample2",
  publicKeyHex: "b".repeat(64),
  multiaddrs: ["/ip4/127.0.0.1/tcp/4002"],
  source: "deeplink",
  firstSeen: "2026-05-27T14:00:00Z",
  lastSeen: "2026-05-27T14:30:00Z",
  accessGranted: true,
  lastAccessGrantAt: null,
};

/** Wait until both peer_paired listeners have registered. The store's
 *  `ensureEventSubscription` does an async `import()` followed by two
 *  `await listen(...)` calls; that's enough microtasks that we can't
 *  reliably flush via N `Promise.resolve()` spins from JSDOM. Polling
 *  with a 5ms setTimeout cadence settles cleanly. */
async function waitForListeners(deadlineMs = 2000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (
      typeof capturedListeners["peer_paired"] === "function" &&
      typeof capturedListeners["peer_paired_error"] === "function"
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `listeners never registered: ${JSON.stringify({
      peer_paired: typeof capturedListeners["peer_paired"],
      peer_paired_error: typeof capturedListeners["peer_paired_error"],
    })}`,
  );
}

/** Flush microtasks — used after firing an event handler so the
 *  fire-and-forget `void load()` inside it can resolve. */
async function flush(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

describe("usePeerStore", () => {
  beforeEach(() => {
    fetchKnownPeersMock.mockReset();
    addPeerMock.mockReset();
    removePeerMock.mockReset();
    isTauriMock.mockReset();
    listenMock.mockReset();
    // Reset captured listener handlers between tests.
    for (const k of Object.keys(capturedListeners)) {
      delete capturedListeners[k];
    }
    // Default listener mock: capture per-event handler so tests can
    // fire it directly. Returns a stub unlistener.
    listenMock.mockImplementation(
      async (eventName: string, handler: (e: { payload: unknown }) => void) => {
        capturedListeners[eventName] = handler;
        return () => {
          delete capturedListeners[eventName];
        };
      },
    );
    // Reset module-scoped subscription state so each test attaches a
    // fresh listener.
    __resetPeerStoreEventSubscriptionForTests();
    // Reset zustand state.
    usePeerStore.setState({
      knownPeers: [],
      isLoading: false,
      error: null,
    });
  });

  /**
   * Happy path: under Tauri, `load()` flips `isLoading` while in flight
   * and commits the fetched list on success.
   */
  it("load() success: transitions isLoading then commits peers", async () => {
    isTauriMock.mockReturnValue(true);

    let loadingObserved = false;
    fetchKnownPeersMock.mockImplementation(async () => {
      const snapshot = usePeerStore.getState();
      loadingObserved =
        snapshot.isLoading === true &&
        snapshot.knownPeers.length === 0 &&
        snapshot.error === null;
      return [SAMPLE_PEER, SAMPLE_PEER_2];
    });

    await usePeerStore.getState().load();

    expect(loadingObserved).toBe(true);
    const final = usePeerStore.getState();
    expect(final.isLoading).toBe(false);
    expect(final.error).toBeNull();
    expect(final.knownPeers).toEqual([SAMPLE_PEER, SAMPLE_PEER_2]);
  });

  /**
   * Failure path: under Tauri, the fetch rejects — error captured,
   * isLoading cleared.
   */
  it("load() failure: captures error and clears isLoading", async () => {
    isTauriMock.mockReturnValue(true);
    fetchKnownPeersMock.mockRejectedValueOnce(new Error("disk read failed"));

    await usePeerStore.getState().load();

    const final = usePeerStore.getState();
    expect(final.isLoading).toBe(false);
    expect(final.error).toBe("disk read failed");
  });

  /**
   * Web build path (Phase 9 — browser P2P UI surface): never calls the
   * Tauri API, reads from the localStorage-backed browser store. The
   * old "native-only sentinel" behavior is gone — the browser store
   * actually services the call.
   */
  it("load() in a web build: reads from localStorage backend, never calls Tauri API", async () => {
    isTauriMock.mockReturnValue(false);
    // Empty storage = empty list, error cleared (not the legacy sentinel).
    window.localStorage.removeItem("concord:browser:peer-store");

    await usePeerStore.getState().load();

    const final = usePeerStore.getState();
    expect(final.isLoading).toBe(false);
    expect(final.error).toBeNull();
    expect(final.knownPeers).toEqual([]);
    expect(fetchKnownPeersMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
  });

  /**
   * addFromCard happy path: returns the added peer, triggers a refresh.
   */
  it("addFromCard() success: returns added peer, refreshes via load()", async () => {
    isTauriMock.mockReturnValue(true);
    addPeerMock.mockResolvedValueOnce(SAMPLE_PEER);
    // First call from `addFromCard -> load -> fetchKnownPeers`.
    fetchKnownPeersMock.mockResolvedValueOnce([SAMPLE_PEER]);

    const result = await usePeerStore
      .getState()
      .addFromCard(
        {
          peerId: SAMPLE_PEER.peerId,
          publicKeyHex: SAMPLE_PEER.publicKeyHex,
          multiaddrs: SAMPLE_PEER.multiaddrs,
        },
        "qr",
      );

    expect(result).toEqual(SAMPLE_PEER);
    expect(addPeerMock).toHaveBeenCalledWith(
      {
        peerId: SAMPLE_PEER.peerId,
        publicKeyHex: SAMPLE_PEER.publicKeyHex,
        multiaddrs: SAMPLE_PEER.multiaddrs,
      },
      "qr",
    );
    // Refresh ran.
    expect(fetchKnownPeersMock).toHaveBeenCalledTimes(1);
    const final = usePeerStore.getState();
    expect(final.knownPeers).toEqual([SAMPLE_PEER]);
  });

  /**
   * addFromCard failure: returns null, captures error, no refresh.
   */
  it("addFromCard() failure: returns null and records error", async () => {
    isTauriMock.mockReturnValue(true);
    addPeerMock.mockRejectedValueOnce(new Error("backend rejected"));

    const result = await usePeerStore.getState().addFromCard(
      {
        peerId: "12D3K",
        publicKeyHex: "c".repeat(64),
        multiaddrs: ["/ip4/127.0.0.1/tcp/4001"],
      },
      "qr",
    );

    expect(result).toBeNull();
    expect(usePeerStore.getState().error).toBe("backend rejected");
    expect(fetchKnownPeersMock).not.toHaveBeenCalled();
  });

  /**
   * addFromCard in a web build (Phase 9 — browser P2P UI surface):
   * routes through the localStorage backend, never calls the Tauri API,
   * returns the locally-persisted KnownPeer.
   */
  it("addFromCard() in a web build: persists via localStorage, never calls Tauri API", async () => {
    isTauriMock.mockReturnValue(false);
    window.localStorage.removeItem("concord:browser:peer-store");

    const result = await usePeerStore.getState().addFromCard(
      {
        peerId: "12D3KWebPeer",
        publicKeyHex: "d".repeat(64),
        multiaddrs: ["/ip4/127.0.0.1/tcp/4001"],
      },
      "qr",
    );

    expect(result).not.toBeNull();
    expect(result?.peerId).toBe("12D3KWebPeer");
    expect(usePeerStore.getState().error).toBeNull();
    expect(addPeerMock).not.toHaveBeenCalled();
  });

  /**
   * remove() happy path: optimistically prunes from local state.
   */
  it("remove() success: optimistic local prune", async () => {
    isTauriMock.mockReturnValue(true);
    // Seed two peers.
    usePeerStore.setState({
      knownPeers: [SAMPLE_PEER, SAMPLE_PEER_2],
      isLoading: false,
      error: null,
    });
    removePeerMock.mockResolvedValueOnce(true);

    const ok = await usePeerStore.getState().remove(SAMPLE_PEER.peerId);

    expect(ok).toBe(true);
    expect(removePeerMock).toHaveBeenCalledWith(SAMPLE_PEER.peerId);
    expect(usePeerStore.getState().knownPeers).toEqual([SAMPLE_PEER_2]);
  });

  it("remove() returns false when backend reports nothing matched", async () => {
    isTauriMock.mockReturnValue(true);
    usePeerStore.setState({
      knownPeers: [SAMPLE_PEER],
      isLoading: false,
      error: null,
    });
    removePeerMock.mockResolvedValueOnce(false);

    const ok = await usePeerStore.getState().remove("nonexistent");
    expect(ok).toBe(false);
    // Local state unchanged because backend said nothing was removed.
    expect(usePeerStore.getState().knownPeers).toEqual([SAMPLE_PEER]);
  });

  /**
   * peer_paired event triggers a refresh.
   */
  it("'peer_paired' event triggers a refresh via load()", async () => {
    isTauriMock.mockReturnValue(true);
    fetchKnownPeersMock.mockResolvedValueOnce([]);

    await usePeerStore.getState().load();
    await waitForListeners();

    expect(capturedListeners["peer_paired"]).toBeTypeOf("function");
    expect(capturedListeners["peer_paired_error"]).toBeTypeOf("function");

    // Next load() (triggered by the event) returns the new list.
    fetchKnownPeersMock.mockResolvedValueOnce([SAMPLE_PEER]);

    capturedListeners["peer_paired"]!({ payload: { peerId: SAMPLE_PEER.peerId } });
    await flush();

    expect(usePeerStore.getState().knownPeers).toEqual([SAMPLE_PEER]);
  });

  /**
   * peer_paired_error event surfaces the message into the store error.
   */
  it("'peer_paired_error' event sets error on the store", async () => {
    isTauriMock.mockReturnValue(true);
    fetchKnownPeersMock.mockResolvedValueOnce([]);

    await usePeerStore.getState().load();
    await waitForListeners();

    expect(capturedListeners["peer_paired_error"]).toBeTypeOf("function");

    capturedListeners["peer_paired_error"]!({
      payload: { stage: "validate", message: "bad public key" },
    });

    expect(usePeerStore.getState().error).toBe("validate: bad public key");
  });
});
