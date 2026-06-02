import { describe, expect, it, vi, beforeEach } from "vitest";

// Hoisted mock for `@tauri-apps/api/core`. The wrapper does a dynamic
// `import("@tauri-apps/api/core")` so we need the mock installed BEFORE the
// SUT is imported — `vi.hoisted` is the canonical way to give a top-level
// `vi.mock` factory access to a shared spy.
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

// Import the SUT AFTER `vi.mock` so the dynamic import resolves to the stub.
import { fetchPeerIdentity } from "../peerIdentity";

describe("fetchPeerIdentity", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  /**
   * Happy path: backend returns the snake_case payload, the wrapper
   * transcribes it to camelCase, and consumers get the documented shape.
   */
  it("converts the snake_case backend response to camelCase", async () => {
    invokeMock.mockResolvedValueOnce({
      public_key_hex: "abcdef1234567890",
      fingerprint: "VLR5W3JFIMKR2RZWNDDBLE2T5OL57FKK",
    });

    const result = await fetchPeerIdentity();

    expect(result).toEqual({
      publicKeyHex: "abcdef1234567890",
      fingerprint: "VLR5W3JFIMKR2RZWNDDBLE2T5OL57FKK",
    });
    expect(invokeMock).toHaveBeenCalledWith("peer_identity");
  });

  /**
   * Negative shape test: the returned object must have EXACTLY two keys
   * (`publicKeyHex`, `fingerprint`) — no leftovers, no accidental leak of
   * a private-key field. This is the consumer-side defence-in-depth: even
   * if a future backend bug ever returned `private_key_hex` / `seed` / `sk`,
   * the explicit field-by-field copy in `fetchPeerIdentity` must drop it
   * silently rather than propagate it.
   */
  it("returns exactly the public surface — no private/seed/sk fields", async () => {
    invokeMock.mockResolvedValueOnce({
      public_key_hex: "abcdef1234567890",
      fingerprint: "VLR5W3JFIMKR2RZWNDDBLE2T5OL57FKK",
      // Hypothetical future-leak fields that MUST be dropped.
      private_key_hex: "DEADBEEFDEADBEEFDEADBEEFDEADBEEF",
      secret: "shhh",
      sk: "00112233",
      seed: "totally-not-a-key",
    });

    const result = await fetchPeerIdentity();
    const keys = Object.keys(result).sort();

    expect(keys).toEqual(["fingerprint", "publicKeyHex"]);
    expect(keys).not.toContain("privateKeyHex");
    expect(keys).not.toContain("private_key_hex");
    expect(keys).not.toContain("secret");
    expect(keys).not.toContain("sk");
    expect(keys).not.toContain("seed");
    // And none of the leaked sensitive values appear as any value either.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("DEADBEEF");
    expect(serialized).not.toContain("shhh");
    expect(serialized).not.toContain("totally-not-a-key");
  });

  /**
   * Failure path: `invoke` rejects (e.g. backend command unregistered,
   * Stronghold unlock failed). The wrapper must propagate the rejection
   * untouched so callers can decide how to render the error.
   */
  it("propagates rejections from invoke", async () => {
    invokeMock.mockRejectedValueOnce(new Error("stronghold unlock failed"));

    await expect(fetchPeerIdentity()).rejects.toThrow(
      /stronghold unlock failed/,
    );
  });
});
