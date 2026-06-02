/**
 * Detection tests for the unified create-server flow (Feature F2).
 *
 * Each test mocks the `fetcher` option directly — there is no global
 * `fetch` patching, so concurrent tests can't trip over each other.
 * Empirical contract: each branch of `AddressKind` is exercised at
 * least once, including the precedence rule (Concord HTTP wins when
 * both well-knowns answer) and the network-tolerance rule (any
 * non-2xx, any thrown fetch → "absent").
 */

import { describe, it, expect } from "vitest";
import { detectAddressKind } from "../detectAddress";

function makeFetch(
  responses: Record<string, { status: number; body?: string; contentType?: string }>,
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = Object.keys(responses).find((path) => url.endsWith(path));
    if (!match) {
      return new Response("not registered", { status: 599 });
    }
    const spec = responses[match];
    const headers: Record<string, string> = {};
    if (spec.contentType) headers["content-type"] = spec.contentType;
    else headers["content-type"] = "application/json";
    return new Response(spec.body ?? "{}", {
      status: spec.status,
      headers,
    });
  }) as typeof fetch;
}

describe("detectAddressKind — static shape branches", () => {
  it("rejects empty input as invalid", async () => {
    const verdict = await detectAddressKind("   ");
    expect(verdict.kind).toBe("invalid");
  });

  it("rejects gibberish as invalid (single label)", async () => {
    const verdict = await detectAddressKind("notadomain");
    expect(verdict.kind).toBe("invalid");
  });

  it("rejects bare IPv4 as invalid", async () => {
    const verdict = await detectAddressKind("192.168.1.10");
    expect(verdict.kind).toBe("invalid");
  });

  it("identifies a peer-card deeplink", async () => {
    const verdict = await detectAddressKind("concord://peer/abc.def");
    expect(verdict).toEqual({
      kind: "concord-p2p",
      subkind: "peer-card-deeplink",
      raw: "concord://peer/abc.def",
    });
  });

  it("identifies a pair URL", async () => {
    const verdict = await detectAddressKind("concord+pair://v1/?d=abcdef");
    expect(verdict.kind).toBe("concord-p2p");
    if (verdict.kind === "concord-p2p") {
      expect(verdict.subkind).toBe("pair-url");
    }
  });

  it("identifies a multiaddr (/ip4/...)", async () => {
    const verdict = await detectAddressKind(
      "/ip4/192.168.1.1/tcp/4001/p2p/Qm123",
    );
    expect(verdict.kind).toBe("concord-p2p");
    if (verdict.kind === "concord-p2p") {
      expect(verdict.subkind).toBe("multiaddr");
    }
  });

  it("identifies a multiaddr (/dns4/...)", async () => {
    const verdict = await detectAddressKind(
      "/dns4/example.com/tcp/4001/wss/p2p/Qm123",
    );
    expect(verdict.kind).toBe("concord-p2p");
  });

  it("identifies a bare peer id (Qm... legacy multihash)", async () => {
    const verdict = await detectAddressKind(
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    );
    expect(verdict.kind).toBe("concord-p2p");
    if (verdict.kind === "concord-p2p") {
      expect(verdict.subkind).toBe("peer-id");
    }
  });

  it("identifies a bare peer id (12D3KooW... ed25519)", async () => {
    const verdict = await detectAddressKind(
      "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X",
    );
    expect(verdict.kind).toBe("concord-p2p");
    if (verdict.kind === "concord-p2p") {
      expect(verdict.subkind).toBe("peer-id");
    }
  });
});

describe("detectAddressKind — network probe branches", () => {
  it("Concord HTTP wins when both well-knowns answer", async () => {
    const fetcher = makeFetch({
      "/.well-known/concord/client": { status: 200, body: '{"api_base":"x"}' },
      "/.well-known/matrix/client": { status: 200, body: '{"m.homeserver":{"base_url":"x"}}' },
    });
    const verdict = await detectAddressKind("example.com", { fetcher });
    expect(verdict.kind).toBe("concord-http");
    if (verdict.kind === "concord-http") {
      expect(verdict.host).toBe("example.com");
    }
  });

  it("Matrix wins when only matrix well-known answers", async () => {
    const fetcher = makeFetch({
      "/.well-known/concord/client": { status: 404 },
      "/.well-known/matrix/client": { status: 200, body: '{"m.homeserver":{"base_url":"x"}}' },
    });
    const verdict = await detectAddressKind("matrix.org", { fetcher });
    expect(verdict.kind).toBe("matrix");
    if (verdict.kind === "matrix") {
      expect(verdict.host).toBe("matrix.org");
    }
  });

  it("Concord HTTP wins when only concord well-known answers", async () => {
    const fetcher = makeFetch({
      "/.well-known/concord/client": { status: 200, body: "{}" },
      "/.well-known/matrix/client": { status: 404 },
    });
    const verdict = await detectAddressKind("chat.example.com", { fetcher });
    expect(verdict.kind).toBe("concord-http");
  });

  it("returns unknown when both well-knowns 404", async () => {
    const fetcher = makeFetch({
      "/.well-known/concord/client": { status: 404 },
      "/.well-known/matrix/client": { status: 404 },
    });
    const verdict = await detectAddressKind("nothing.example.org", { fetcher });
    expect(verdict.kind).toBe("unknown");
    if (verdict.kind === "unknown") {
      expect(verdict.host).toBe("nothing.example.org");
      expect(verdict.detail).toContain("nothing.example.org");
    }
  });

  it("HTML 200 response counts as absent (not a well-known)", async () => {
    const fetcher = makeFetch({
      "/.well-known/concord/client": { status: 200, body: "<html></html>", contentType: "text/html" },
      "/.well-known/matrix/client": { status: 200, body: "<html></html>", contentType: "text/html" },
    });
    const verdict = await detectAddressKind("spa-fallback.example", { fetcher });
    expect(verdict.kind).toBe("unknown");
  });

  it("treats a thrown fetch as absent (network failure tolerant)", async () => {
    const fetcher = (async () => {
      throw new TypeError("network failure");
    }) as typeof fetch;
    const verdict = await detectAddressKind("unreachable.example", { fetcher });
    expect(verdict.kind).toBe("unknown");
  });

  it("strips https:// scheme before probing", async () => {
    let probedHost: string | null = null;
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      probedHost = new URL(url).host;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const verdict = await detectAddressKind("https://example.com/", { fetcher });
    expect(verdict.kind).toBe("concord-http");
    expect(probedHost).toBe("example.com");
  });

  it("emits progress phases in order", async () => {
    const phases: string[] = [];
    const fetcher = makeFetch({
      "/.well-known/concord/client": { status: 404 },
      "/.well-known/matrix/client": { status: 404 },
    });
    await detectAddressKind("example.org", {
      fetcher,
      onProgress: (phase) => phases.push(phase),
    });
    expect(phases[0]).toBe("inspect");
    expect(phases).toContain("probe-concord");
    expect(phases).toContain("probe-matrix");
  });
});
