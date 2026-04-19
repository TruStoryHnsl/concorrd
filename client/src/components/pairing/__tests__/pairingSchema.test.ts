import { describe, it, expect } from "vitest";
import {
  decodePairingPayload,
  encodePairingPayload,
  PairingDecodeError,
  PAIRING_URL_PREFIX,
} from "../pairingSchema";
import type { HomeserverConfig } from "../../../api/wellKnown";

/**
 * INS-022 tester responsibilities (written-in-blood rules):
 *
 *   - No abstract-value tests — each assertion checks a concrete
 *     user-observable behavior: "the guest's pairing screen writes this
 *     homeserver URL into the serverConfig store", "an http:// QR is
 *     rejected", etc.
 *
 *   - The encoder/decoder round-trip test uses real host/url values
 *     that a user would actually encounter in the wild (concordchat.net
 *     public default from INS-051). It does NOT use the operator's
 *     personal instance domain — that remains a secret per
 *     feedback_concorrd_domain_is_secret memory rule.
 */

describe("pairingSchema encode/decode (INS-022 QR pairing wire format)", () => {
  it("round-trips a minimal payload with only the required fields", () => {
    const source: Pick<HomeserverConfig, "host" | "homeserver_url" | "api_base"> = {
      host: "concordchat.net",
      homeserver_url: "https://concordchat.net",
      api_base: "https://concordchat.net/api",
    };
    const url = encodePairingPayload(source);
    expect(url.startsWith(PAIRING_URL_PREFIX)).toBe(true);

    const decoded = decodePairingPayload(url);
    expect(decoded.host).toBe("concordchat.net");
    expect(decoded.homeserver_url).toBe("https://concordchat.net");
    expect(decoded.api_base).toBe("https://concordchat.net/api");
    expect(decoded.server_name).toBeUndefined();
    expect(decoded.livekit_url).toBeUndefined();
    expect(decoded.instance_name).toBeUndefined();
  });

  it("round-trips a fully-populated payload including livekit + instance_name", () => {
    const source = {
      host: "concordchat.net",
      homeserver_url: "https://matrix.concordchat.net",
      api_base: "https://api.concordchat.net",
      server_name: "concordchat.net",
      livekit_url: "wss://livekit.concordchat.net",
      instance_name: "Concord Public",
    };
    const url = encodePairingPayload(source);
    const decoded = decodePairingPayload(url);
    expect(decoded).toMatchObject(source);
  });

  it("strips unknown/sensitive fields so TURN credentials cannot leak via QR", () => {
    // The encoder type signature bars these at compile time; pass via
    // a deliberate cast to prove the RUNTIME behavior doesn't smuggle
    // them through either.
    const overSharing = {
      host: "concordchat.net",
      homeserver_url: "https://concordchat.net",
      api_base: "https://concordchat.net/api",
      features: ["voice", "bridges"],
      turn_servers: [
        { urls: "turns:turn.concordchat.net:5349", credential: "SECRET" },
      ],
    } as unknown as Pick<HomeserverConfig, "host" | "homeserver_url" | "api_base">;
    const url = encodePairingPayload(overSharing);

    // URL payload must not contain "SECRET" or "turn" strings.
    expect(url).not.toMatch(/SECRET/);
    expect(url).not.toMatch(/turn\./i);

    const decoded = decodePairingPayload(url);
    expect((decoded as unknown as { features?: unknown }).features).toBeUndefined();
    expect(decoded.turn_servers).toBeUndefined();
  });

  it("rejects http:// (downgrade attack) on homeserver_url", () => {
    // Build a payload the encoder wouldn't produce, decode it directly.
    const malicious = `${PAIRING_URL_PREFIX}${btoa(
      JSON.stringify({
        v: 1,
        host: "evil.example",
        homeserver_url: "http://evil.example",
        api_base: "https://evil.example/api",
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "")}`;

    expect(() => decodePairingPayload(malicious)).toThrow(PairingDecodeError);
  });

  it("rejects unknown schema versions", () => {
    const futureVersion = `${PAIRING_URL_PREFIX}${btoa(
      JSON.stringify({
        v: 99,
        host: "x",
        homeserver_url: "https://x",
        api_base: "https://x/api",
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "")}`;

    expect(() => decodePairingPayload(futureVersion)).toThrow(/version/);
  });

  it("rejects malformed payloads cleanly", () => {
    expect(() => decodePairingPayload("")).toThrow(PairingDecodeError);
    expect(() => decodePairingPayload("not-a-pairing-url")).toThrow(PairingDecodeError);
    expect(() => decodePairingPayload(`${PAIRING_URL_PREFIX}!!!not-base64!!!`)).toThrow(
      PairingDecodeError,
    );
  });

  it("accepts a bare base64url payload (fallback path for manual paste)", () => {
    const source = {
      host: "concordchat.net",
      homeserver_url: "https://concordchat.net",
      api_base: "https://concordchat.net/api",
    };
    const url = encodePairingPayload(source);
    const bare = url.slice(PAIRING_URL_PREFIX.length);
    const decoded = decodePairingPayload(bare);
    expect(decoded.host).toBe(source.host);
  });
});
