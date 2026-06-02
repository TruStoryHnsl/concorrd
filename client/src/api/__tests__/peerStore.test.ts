import { describe, expect, it, vi, beforeEach } from "vitest";

// Hoisted mock for `@tauri-apps/api/core`. The wrapper does a top-level
// `import { invoke } ...` so the mock must be installed BEFORE the SUT
// is imported — same pattern as `peerIdentity.test.ts`.
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  fetchKnownPeers,
  addPeer,
  removePeer,
  type KnownPeer,
  type PeerCard,
} from "../peerStore";

describe("peerStore API wrapper", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  /**
   * Happy path for `fetchKnownPeers`: the backend returns its raw
   * camelCase shape with the Rust enum's PascalCase `source`, and the
   * wrapper converts every source to lowercase snake_case.
   */
  it("fetchKnownPeers converts source PascalCase -> snake_case across all four variants", async () => {
    const sourcesIn = ["Qr", "Deeplink", "MatrixRoom", "Dht"] as const;
    const expectedSources = ["qr", "deeplink", "matrix_room", "dht"] as const;

    invokeMock.mockResolvedValueOnce(
      sourcesIn.map((source, i) => ({
        peerId: `12D3KooW${source}Example${i}`,
        publicKeyHex: "a".repeat(64),
        multiaddrs: ["/ip4/127.0.0.1/tcp/4001"],
        source,
        firstSeen: "2026-05-27T12:00:00Z",
        lastSeen: "2026-05-27T13:00:00Z",
      })),
    );

    const result = await fetchKnownPeers();

    expect(invokeMock).toHaveBeenCalledWith("peer_store_list");
    expect(result).toHaveLength(4);
    for (let i = 0; i < expectedSources.length; i++) {
      expect(result[i].source).toBe(expectedSources[i]);
      expect(result[i].peerId).toBe(`12D3KooW${sourcesIn[i]}Example${i}`);
      expect(result[i].multiaddrs).toEqual(["/ip4/127.0.0.1/tcp/4001"]);
      expect(result[i].firstSeen).toBe("2026-05-27T12:00:00Z");
      expect(result[i].lastSeen).toBe("2026-05-27T13:00:00Z");
    }
  });

  /**
   * Negative shape test — defence-in-depth. Even if the backend ever
   * accidentally leaked a `private_key` / `seed` / `sk` field, the
   * explicit field-by-field copy in `fromRaw` must drop it.
   */
  it("fetchKnownPeers drops extra fields including hypothetical secret leaks", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        peerId: "12D3KooWAbcd",
        publicKeyHex: "b".repeat(64),
        multiaddrs: ["/ip4/127.0.0.1/tcp/4001"],
        source: "Qr",
        firstSeen: "2026-05-27T12:00:00Z",
        lastSeen: "2026-05-27T13:00:00Z",
        // Hypothetical future-leak fields:
        private_key: "DEADBEEFDEADBEEF",
        privateKey: "DEADBEEFDEADBEEF",
        seed: "totally-not-a-key",
        sk: "00112233",
        secret: "shhh",
      },
    ]);

    const result = await fetchKnownPeers();
    expect(result).toHaveLength(1);
    const keys = Object.keys(result[0]).sort();
    expect(keys).toEqual([
      // F-VIS — accessGranted + lastAccessGrantAt are part of the
      // documented public shape now (Architecture B visible-vs-access
      // split). Defaults to true + null when the backend payload omits
      // them.
      "accessGranted",
      "firstSeen",
      "lastAccessGrantAt",
      "lastSeen",
      "multiaddrs",
      "peerId",
      "publicKeyHex",
      "source",
    ]);
    const serialized = JSON.stringify(result[0]);
    expect(serialized).not.toContain("DEADBEEF");
    expect(serialized).not.toContain("totally-not-a-key");
    expect(serialized).not.toContain("shhh");
  });

  /**
   * Unknown source variant — the wrapper falls back to "dht" rather
   * than fabricating one of the four declared variants. This is the
   * forwards-compat seatbelt for a future backend enum extension.
   */
  it("fetchKnownPeers falls back to 'dht' on an unknown source variant", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        peerId: "12D3KooWAbcd",
        publicKeyHex: "c".repeat(64),
        multiaddrs: ["/ip4/127.0.0.1/tcp/4001"],
        // Deliberately invalid variant — invoke mock accepts unknown
        // so the wire shape can vary; the wrapper must downgrade.
        source: "FutureExtension",
        firstSeen: "2026-05-27T12:00:00Z",
        lastSeen: "2026-05-27T13:00:00Z",
      },
    ]);

    const result = await fetchKnownPeers();
    expect(result[0].source).toBe("dht");
  });

  /**
   * Happy path for `addPeer`: the wrapper passes the camelCase input
   * shape with a lowercase `source` and returns the parsed response.
   */
  it("addPeer round-trips a card through invoke with the lowercase source", async () => {
    const card: PeerCard = {
      peerId: "12D3KooWNewPeer",
      publicKeyHex: "d".repeat(64),
      multiaddrs: ["/ip4/127.0.0.1/tcp/4001", "/ip4/127.0.0.1/udp/4002/quic-v1"],
    };

    invokeMock.mockResolvedValueOnce({
      peerId: card.peerId,
      publicKeyHex: card.publicKeyHex,
      multiaddrs: card.multiaddrs,
      source: "MatrixRoom",
      firstSeen: "2026-05-27T12:00:00Z",
      lastSeen: "2026-05-27T13:00:00Z",
    });

    const result = await addPeer(card, "matrix_room");

    expect(invokeMock).toHaveBeenCalledWith("peer_store_add", {
      peerId: card.peerId,
      publicKeyHex: card.publicKeyHex,
      multiaddrs: card.multiaddrs,
      source: "matrix_room",
    });
    expect(result.source).toBe("matrix_room");
    expect(result.peerId).toBe(card.peerId);
  });

  /**
   * Happy path for `removePeer`: returns the backend's boolean verbatim.
   */
  it("removePeer returns the backend's boolean (true)", async () => {
    invokeMock.mockResolvedValueOnce(true);
    const ok = await removePeer("12D3KooWGone");
    expect(invokeMock).toHaveBeenCalledWith("peer_store_remove", {
      peerId: "12D3KooWGone",
    });
    expect(ok).toBe(true);
  });

  it("removePeer returns false when the backend reports nothing matched", async () => {
    invokeMock.mockResolvedValueOnce(false);
    const ok = await removePeer("12D3KooWMissing");
    expect(ok).toBe(false);
  });

  /**
   * Failure path: invoke rejection must propagate untouched so the
   * caller (store) can capture the message.
   */
  it("propagates rejection from invoke on fetchKnownPeers", async () => {
    invokeMock.mockRejectedValueOnce(new Error("peer store sealed"));
    await expect(fetchKnownPeers()).rejects.toThrow(/peer store sealed/);
  });

  it("propagates rejection from invoke on addPeer", async () => {
    invokeMock.mockRejectedValueOnce(new Error("invalid peer id"));
    const card: PeerCard = {
      peerId: "x",
      publicKeyHex: "e".repeat(64),
      multiaddrs: ["/ip4/127.0.0.1/tcp/4001"],
    };
    await expect(addPeer(card, "qr")).rejects.toThrow(/invalid peer id/);
  });

  it("propagates rejection from invoke on removePeer", async () => {
    invokeMock.mockRejectedValueOnce(new Error("disk full"));
    await expect(removePeer("anything")).rejects.toThrow(/disk full/);
  });

  /**
   * Negative-shape check on the returned object — exactly the documented
   * keys, no more. Catches an accidental field leak from a future
   * raw-shape extension.
   */
  it("fetchKnownPeers returns objects with exactly the documented key set", async () => {
    const expectedKeys = [
      // F-VIS — see comment in earlier test.
      "accessGranted",
      "firstSeen",
      "lastAccessGrantAt",
      "lastSeen",
      "multiaddrs",
      "peerId",
      "publicKeyHex",
      "source",
    ];
    invokeMock.mockResolvedValueOnce([
      {
        peerId: "12D3KooWAbcd",
        publicKeyHex: "f".repeat(64),
        multiaddrs: ["/ip4/127.0.0.1/tcp/4001"],
        source: "Qr",
        firstSeen: "2026-05-27T12:00:00Z",
        lastSeen: "2026-05-27T13:00:00Z",
      },
    ]);
    const result = await fetchKnownPeers();
    expect(Object.keys(result[0]).sort()).toEqual(expectedKeys);
  });

  // Sanity assertion the test file is well-typed; pure compile-time
  // check that the public `KnownPeer` shape matches what we assert above.
  it("KnownPeer type ergonomics: object literal with the public shape compiles", () => {
    const peer: KnownPeer = {
      peerId: "12D3KooWAbcd",
      publicKeyHex: "0".repeat(64),
      multiaddrs: ["/ip4/127.0.0.1/tcp/4001"],
      source: "qr",
      firstSeen: "2026-05-27T12:00:00Z",
      lastSeen: "2026-05-27T13:00:00Z",
      accessGranted: true,
      lastAccessGrantAt: null,
    };
    expect(peer.source).toBe("qr");
  });
});
