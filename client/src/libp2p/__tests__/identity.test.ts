import { describe, expect, it, beforeEach } from "vitest";
import {
  getBrowserIdentity,
  resetBrowserIdentity,
} from "../identity";

describe("browser libp2p identity", () => {
  beforeEach(() => {
    resetBrowserIdentity();
  });

  it("returns the same cached identity on repeat calls", async () => {
    const first = await getBrowserIdentity();
    const second = await getBrowserIdentity();
    expect(second.peerId).toBe(first.peerId);
    expect(second.publicKeyHex).toBe(first.publicKeyHex);
    // The private-key object reference must be the same — re-deriving
    // it would invalidate any open libp2p stream signed with the
    // previous key for this tab.
    expect(second.privateKey).toBe(first.privateKey);
  });

  it("regenerates a fresh identity after reset (different PeerId)", async () => {
    const first = await getBrowserIdentity();
    resetBrowserIdentity();
    const second = await getBrowserIdentity();
    expect(second.peerId).not.toBe(first.peerId);
    expect(second.publicKeyHex).not.toBe(first.publicKeyHex);
  });

  it("publicKeyHex is 64 hex chars (raw Ed25519 public key)", async () => {
    const identity = await getBrowserIdentity();
    expect(identity.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });
});
