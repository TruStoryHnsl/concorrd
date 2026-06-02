import { describe, expect, it } from "vitest";

import {
  decodeFromDeeplink,
  decodeFromQrPayload,
  encodeToDeeplink,
  encodeToQrPayload,
  type PeerCard,
} from "../peerCard";

const VALID_HEX_64 = "a".repeat(64);

const VALID_CARD: PeerCard = {
  peerId: "12D3KooWExamplePeerId",
  publicKeyHex: VALID_HEX_64,
  multiaddrs: [
    "/ip4/127.0.0.1/tcp/4001",
    "/ip4/127.0.0.1/udp/4002/quic-v1",
  ],
};

describe("encodeToDeeplink / decodeFromDeeplink — roundtrip", () => {
  it("a valid card roundtrips through encode -> decode unchanged", () => {
    const url = encodeToDeeplink(VALID_CARD);
    expect(url.startsWith("concord://peer/")).toBe(true);

    const result = decodeFromDeeplink(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.card).toEqual(VALID_CARD);
    }
  });

  it("encodeToQrPayload produces the same URL as encodeToDeeplink", () => {
    expect(encodeToQrPayload(VALID_CARD)).toBe(encodeToDeeplink(VALID_CARD));
  });

  it("decodeFromQrPayload accepts the same URL as decodeFromDeeplink", () => {
    const url = encodeToQrPayload(VALID_CARD);
    const a = decodeFromQrPayload(url);
    const b = decodeFromDeeplink(url);
    expect(a).toEqual(b);
  });

  it("encode strips any extra properties on the input object (defence-in-depth)", () => {
    const noisyCard = {
      ...VALID_CARD,
      // Hypothetical leak fields a future bug might attach to the card.
      privateKey: "DEADBEEF",
      seed: "should-never-leave",
    } as PeerCard & Record<string, unknown>;

    const url = encodeToDeeplink(noisyCard);

    // Decode again — the result MUST be just the public shape, no extras.
    const result = decodeFromDeeplink(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const keys = Object.keys(result.card).sort();
      expect(keys).toEqual(["multiaddrs", "peerId", "publicKeyHex"]);
      const serialized = JSON.stringify(result.card);
      expect(serialized).not.toContain("DEADBEEF");
      expect(serialized).not.toContain("should-never-leave");
    }
  });
});

describe("decodeFromDeeplink — malformed input returns { ok: false }", () => {
  it("never throws on non-string input — returns ok:false", () => {
    // @ts-expect-error — deliberately wrong type
    const result = decodeFromDeeplink(42);
    expect(result.ok).toBe(false);
  });

  it("rejects a URL with the wrong scheme", () => {
    const result = decodeFromDeeplink("https://example.com/peer/AAAA");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/concord:\/\/peer\//);
  });

  it("rejects a URL with the right scheme but empty payload", () => {
    const result = decodeFromDeeplink("concord://peer/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no payload/i);
  });

  it("rejects a URL whose payload is not valid base64url", () => {
    const result = decodeFromDeeplink("concord://peer/!!!not-base64!!!");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/base64url|json/i);
  });

  it("rejects a URL whose payload decodes to non-JSON", () => {
    // base64url("not json {{{") — a string that's valid base64url but not JSON.
    const garbage = btoa("not json {{{")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const result = decodeFromDeeplink("concord://peer/" + garbage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/json/i);
  });

  it("rejects a JSON payload whose top-level value is a primitive (not an object)", () => {
    const payload = btoa(JSON.stringify("just a string"))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const result = decodeFromDeeplink("concord://peer/" + payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/object/i);
  });

  it("rejects a JSON payload that is null", () => {
    const payload = btoa(JSON.stringify(null))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const result = decodeFromDeeplink("concord://peer/" + payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/object/i);
  });

  it("rejects a JSON payload that is an array (lacks required fields)", () => {
    // Arrays are technically objects in JS — they bypass the `typeof !==
    // "object"` guard but fail on the missing-peerId check, which is the
    // correct outcome (no valid card has an array shape).
    const payload = btoa(JSON.stringify(["array", "not", "object"]))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const result = decodeFromDeeplink("concord://peer/" + payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/peerId|object/i);
  });
});

describe("decodeFromDeeplink — field validation", () => {
  /** Helper to wrap an arbitrary object into the SCHEME + base64url
   *  form so each case can override exactly one field. */
  function pack(obj: unknown): string {
    const json = JSON.stringify(obj);
    const b64 = btoa(json)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return "concord://peer/" + b64;
  }

  it("rejects an empty peerId", () => {
    const result = decodeFromDeeplink(
      pack({ peerId: "", publicKeyHex: VALID_HEX_64, multiaddrs: ["/x"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/peerId/i);
  });

  it("rejects a missing peerId", () => {
    const result = decodeFromDeeplink(
      pack({ publicKeyHex: VALID_HEX_64, multiaddrs: ["/x"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/peerId/i);
  });

  it("rejects publicKeyHex with the wrong length", () => {
    const result = decodeFromDeeplink(
      pack({
        peerId: "12D3K",
        publicKeyHex: "abcd",
        multiaddrs: ["/ip4/127.0.0.1/tcp/4001"],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/64 hex/i);
  });

  it("rejects a non-hex publicKeyHex even at the right length", () => {
    const result = decodeFromDeeplink(
      pack({
        peerId: "12D3K",
        publicKeyHex: "z".repeat(64),
        multiaddrs: ["/ip4/127.0.0.1/tcp/4001"],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/hex/i);
  });

  it("rejects an empty multiaddrs array", () => {
    const result = decodeFromDeeplink(
      pack({
        peerId: "12D3K",
        publicKeyHex: VALID_HEX_64,
        multiaddrs: [],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/multiaddrs/i);
  });

  it("rejects multiaddrs that aren't all strings", () => {
    const result = decodeFromDeeplink(
      pack({
        peerId: "12D3K",
        publicKeyHex: VALID_HEX_64,
        multiaddrs: ["/ip4/127.0.0.1/tcp/4001", 99],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/multiaddrs/i);
  });

  it("rejects a multiaddrs entry that is an empty string", () => {
    const result = decodeFromDeeplink(
      pack({
        peerId: "12D3K",
        publicKeyHex: VALID_HEX_64,
        multiaddrs: ["/ip4/127.0.0.1/tcp/4001", ""],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/multiaddrs/i);
  });
});
