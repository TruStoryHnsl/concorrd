import { describe, expect, it, vi, beforeEach } from "vitest";

// Hoisted mock for `@tauri-apps/api/core`. The wrapper does a dynamic
// `import("@tauri-apps/api/core")` so we need the mock installed BEFORE
// the SUT is imported — `vi.hoisted` is the canonical way to give a
// top-level `vi.mock` factory access to a shared spy. Same pattern as
// `peerIdentity.test.ts`.
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

// Import the SUT AFTER `vi.mock` so the dynamic import resolves to the
// stub.
import { fetchPeerSwarmStatus } from "../peerSwarm";

describe("fetchPeerSwarmStatus", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  /**
   * Happy path: backend returns the snake_case payload, the wrapper
   * transcribes it to camelCase, and consumers get the documented shape.
   * Asserts EXACTLY the four keys defined in `SwarmStatus` are present —
   * mirrors the explicit-field-by-field-copy guard in the implementation.
   */
  it("converts the snake_case backend response to camelCase with exactly the public surface", async () => {
    invokeMock.mockResolvedValueOnce({
      our_peer_id: "12D3KooWBoreaLisAcceptablePeerIdShapeHere",
      our_multiaddrs: [
        "/ip4/127.0.0.1/udp/45123/quic-v1",
        "/ip4/127.0.0.1/tcp/45124",
      ],
      peer_count: 3,
      last_event: "peers: 3",
    });

    const result = await fetchPeerSwarmStatus();

    expect(result).toEqual({
      ourPeerId: "12D3KooWBoreaLisAcceptablePeerIdShapeHere",
      ourMultiaddrs: [
        "/ip4/127.0.0.1/udp/45123/quic-v1",
        "/ip4/127.0.0.1/tcp/45124",
      ],
      peerCount: 3,
      lastEvent: "peers: 3",
    });
    expect(Object.keys(result).sort()).toEqual([
      "lastEvent",
      "ourMultiaddrs",
      "ourPeerId",
      "peerCount",
    ]);
    expect(invokeMock).toHaveBeenCalledWith("peer_swarm_status");
  });

  /**
   * Failure path: `invoke` rejects (e.g. backend command unregistered,
   * libp2p runtime not yet started). The wrapper must propagate the
   * rejection untouched so callers can decide how to render the error.
   */
  it("propagates rejections from invoke", async () => {
    invokeMock.mockRejectedValueOnce(new Error("swarm cache poisoned"));

    await expect(fetchPeerSwarmStatus()).rejects.toThrow(
      /swarm cache poisoned/,
    );
  });

  /**
   * Negative shape test — defence-in-depth. Even if the backend ever
   * accidentally leaked a `private_key`-shaped field (or a `seed`, or
   * `sk`, etc.), the explicit field-by-field copy in
   * `fetchPeerSwarmStatus` must drop it silently rather than propagate
   * it into TS-land. The returned object must have EXACTLY the four
   * keys defined in `SwarmStatus`.
   */
  it("drops extra fields including hypothetical private/seed/sk leaks", async () => {
    invokeMock.mockResolvedValueOnce({
      our_peer_id: "12D3KooWBoreaLis",
      our_multiaddrs: ["/ip4/127.0.0.1/tcp/45124"],
      peer_count: 1,
      last_event: null,
      // Hypothetical future-leak fields that MUST be dropped.
      private_key: "DEADBEEFDEADBEEFDEADBEEFDEADBEEF",
      private_key_hex: "ABCDEF0011223344",
      secret: "shhh",
      sk: "00112233",
      seed: "totally-not-a-key",
    });

    const result = await fetchPeerSwarmStatus();
    const keys = Object.keys(result).sort();

    expect(keys).toEqual([
      "lastEvent",
      "ourMultiaddrs",
      "ourPeerId",
      "peerCount",
    ]);
    expect(keys).not.toContain("privateKey");
    expect(keys).not.toContain("private_key");
    expect(keys).not.toContain("privateKeyHex");
    expect(keys).not.toContain("secret");
    expect(keys).not.toContain("sk");
    expect(keys).not.toContain("seed");

    // None of the leaked sensitive values appear as any value either.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("DEADBEEF");
    expect(serialized).not.toContain("ABCDEF0011223344");
    expect(serialized).not.toContain("shhh");
    expect(serialized).not.toContain("totally-not-a-key");
  });
});
