/**
 * Phase 9 — peer store localStorage backend tests.
 *
 * Covers the four behaviors the browser P2P UI surface depends on:
 *
 *   1. `addFromCard` persists into localStorage and the next `load`
 *      observes the same record.
 *   2. `list` (via the public `load` + state read) returns the persisted
 *      records.
 *   3. `remove` deletes from localStorage and the next `load` sees the
 *      absence.
 *   4. Persistence survives a simulated "reload" — emptying the
 *      in-memory zustand state and re-reading from storage yields the
 *      previously-persisted record set.
 *
 * The Tauri API module is mocked so the suite never accidentally
 * exercises the native path. `isTauri()` is pinned to `false` for
 * every test so the store routes through the browser backend.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchKnownPeersMock,
  addPeerMock,
  removePeerMock,
  isTauriMock,
  listenMock,
} = vi.hoisted(() => ({
  fetchKnownPeersMock: vi.fn(),
  addPeerMock: vi.fn(),
  removePeerMock: vi.fn(),
  isTauriMock: vi.fn(),
  listenMock: vi.fn(),
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
import {
  BROWSER_PEER_STORE_KEY,
  __clearBrowserPeerStoreForTests,
} from "../peerStoreBrowser";
import type { PeerCard } from "../../api/peerStore";

const CARD_A: PeerCard = {
  peerId: "12D3KooWBrowserA",
  publicKeyHex: "a".repeat(64),
  multiaddrs: ["/ip4/127.0.0.1/tcp/4001"],
};

const CARD_B: PeerCard = {
  peerId: "12D3KooWBrowserB",
  publicKeyHex: "b".repeat(64),
  multiaddrs: ["/ip4/127.0.0.1/tcp/4002"],
};

describe("usePeerStore (browser localStorage backend)", () => {
  beforeEach(() => {
    fetchKnownPeersMock.mockReset();
    addPeerMock.mockReset();
    removePeerMock.mockReset();
    isTauriMock.mockReset();
    listenMock.mockReset();
    isTauriMock.mockReturnValue(false);

    __clearBrowserPeerStoreForTests();
    __resetPeerStoreEventSubscriptionForTests();
    usePeerStore.setState({
      knownPeers: [],
      isLoading: false,
      error: null,
    });
  });

  /**
   * Add → load: the record persisted by `addFromCard` is observable
   * through a subsequent `load()` call.
   */
  it("addFromCard persists; next load() returns the same peer", async () => {
    const added = await usePeerStore
      .getState()
      .addFromCard(CARD_A, "qr");

    expect(added).not.toBeNull();
    expect(added?.peerId).toBe(CARD_A.peerId);
    expect(added?.source).toBe("qr");
    // Tauri API never touched.
    expect(addPeerMock).not.toHaveBeenCalled();

    // Reset zustand state to simulate a fresh consumer that hasn't
    // observed the in-memory update yet, then load from storage.
    usePeerStore.setState({ knownPeers: [], isLoading: false, error: null });
    await usePeerStore.getState().load();

    const final = usePeerStore.getState();
    expect(final.knownPeers).toHaveLength(1);
    expect(final.knownPeers[0].peerId).toBe(CARD_A.peerId);
    expect(final.knownPeers[0].source).toBe("qr");
    expect(fetchKnownPeersMock).not.toHaveBeenCalled();
  });

  /**
   * load() returns every persisted record (list behavior).
   */
  it("load() returns all persisted peers in insertion order", async () => {
    await usePeerStore.getState().addFromCard(CARD_A, "qr");
    await usePeerStore.getState().addFromCard(CARD_B, "deeplink");

    // Wipe in-memory state and re-read.
    usePeerStore.setState({ knownPeers: [], isLoading: false, error: null });
    await usePeerStore.getState().load();

    const peers = usePeerStore.getState().knownPeers;
    expect(peers.map((p) => p.peerId)).toEqual([
      CARD_A.peerId,
      CARD_B.peerId,
    ]);
    expect(peers.map((p) => p.source)).toEqual(["qr", "deeplink"]);
  });

  /**
   * remove() deletes from storage; the next load() shows the absence.
   */
  it("remove() drops the record from storage", async () => {
    await usePeerStore.getState().addFromCard(CARD_A, "qr");
    await usePeerStore.getState().addFromCard(CARD_B, "deeplink");

    const removed = await usePeerStore.getState().remove(CARD_A.peerId);
    expect(removed).toBe(true);
    expect(removePeerMock).not.toHaveBeenCalled();

    // Fresh load proves storage actually changed (not just in-memory).
    usePeerStore.setState({ knownPeers: [], isLoading: false, error: null });
    await usePeerStore.getState().load();
    const peers = usePeerStore.getState().knownPeers;
    expect(peers.map((p) => p.peerId)).toEqual([CARD_B.peerId]);

    // Removing something that isn't there returns false but doesn't
    // crash, doesn't surface an error.
    const reRemove = await usePeerStore
      .getState()
      .remove("12D3KooWGhost");
    expect(reRemove).toBe(false);
    expect(usePeerStore.getState().error).toBeNull();
  });

  /**
   * Persistence-across-reload simulation: write via the zustand store,
   * then drop all in-memory state and re-read from `localStorage` raw.
   * Same envelope is observable through a fresh consumer.
   */
  it("persists across a simulated reload (re-reading from localStorage)", async () => {
    await usePeerStore.getState().addFromCard(CARD_A, "matrix_room");

    // Simulate a page reload by reading raw storage. The envelope must
    // have the version + peers shape.
    const raw = window.localStorage.getItem(BROWSER_PEER_STORE_KEY);
    expect(raw).not.toBeNull();
    const envelope = JSON.parse(raw as string);
    expect(envelope.version).toBe(1);
    expect(Array.isArray(envelope.peers)).toBe(true);
    expect(envelope.peers).toHaveLength(1);
    expect(envelope.peers[0].peerId).toBe(CARD_A.peerId);

    // And a fresh load() (after wiping in-memory state) rehydrates the
    // same record.
    usePeerStore.setState({ knownPeers: [], isLoading: false, error: null });
    await usePeerStore.getState().load();
    expect(usePeerStore.getState().knownPeers).toHaveLength(1);
    expect(usePeerStore.getState().knownPeers[0].peerId).toBe(
      CARD_A.peerId,
    );
  });
});
