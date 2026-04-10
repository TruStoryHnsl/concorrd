import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  discoverHomeserver,
  DnsResolutionError,
  JsonParseError,
  InvalidUrlError,
  HttpServerError,
} from "../wellKnown";

// These tests intentionally stub `global.fetch` rather than touching
// the network. The helper is meant to be a pure function of fetch, so
// the test matrix covers the contract it has with its caller, not any
// real host. Mocks are reset between every test to avoid state bleed
// (vitest doesn't auto-restore a global patched in beforeEach).

/**
 * Build a `Response`-shaped object that the fetch stub can return.
 * Using a plain object + `vi.fn()` rather than the real `Response`
 * class keeps the setup light; the helper only calls `.status`,
 * `.ok`, and `.json()`.
 */
const jsonHeaders = { get: (k: string) => k === "content-type" ? "application/json" : null };

function jsonResponse(
  status: number,
  body: unknown,
) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: jsonHeaders,
    json: async () => body,
  };
}

function notFound() {
  return {
    status: 404,
    ok: false,
    headers: jsonHeaders,
    json: async () => ({}),
  };
}

function malformed() {
  return {
    status: 200,
    ok: true,
    headers: jsonHeaders,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  };
}

describe("discoverHomeserver", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Happy path: both well-knowns return valid JSON. The helper should
   * copy every advertised field into HomeserverConfig verbatim.
   */
  it("returns a full config when both well-knowns are present and valid", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/.well-known/matrix/client")) {
        return jsonResponse(200, {
          "m.homeserver": { base_url: "https://matrix.example.org" },
          "m.identity_server": { base_url: "https://identity.example.org" },
        });
      }
      if (url.endsWith("/.well-known/concord/client")) {
        return jsonResponse(200, {
          api_base: "https://api.example.org/api",
          livekit_url: "wss://livekit.example.org",
          instance_name: "Example Concord",
          features: ["chat", "voice"],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const config = await discoverHomeserver("example.org");

    expect(config).toEqual({
      host: "example.org",
      homeserver_url: "https://matrix.example.org",
      api_base: "https://api.example.org/api",
      identity_server_url: "https://identity.example.org",
      livekit_url: "wss://livekit.example.org",
      instance_name: "Example Concord",
      features: ["chat", "voice"],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  /**
   * Matrix well-known present, Concord well-known absent. The fallback
   * rule says api_base = `https://<host>/api`, so the user can still
   * complete discovery against a vanilla Matrix homeserver that doesn't
   * know about Concord.
   */
  it("falls back to https://<host>/api when the Concord well-known is absent", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/.well-known/matrix/client")) {
        return jsonResponse(200, {
          "m.homeserver": { base_url: "https://matrix.example.org" },
        });
      }
      if (url.endsWith("/.well-known/concord/client")) {
        return notFound();
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const config = await discoverHomeserver("example.org");

    expect(config.homeserver_url).toBe("https://matrix.example.org");
    expect(config.api_base).toBe("https://example.org/api");
    expect(config.instance_name).toBeUndefined();
    expect(config.livekit_url).toBeUndefined();
    expect(config.features).toBeUndefined();
  });

  /**
   * Both well-knowns absent. The full Matrix + Concord fallback chain
   * should activate: homeserver_url = `https://<host>` and api_base =
   * `https://<host>/api`.
   */
  it("falls back fully when both well-knowns are absent", async () => {
    fetchSpy.mockImplementation(async () => notFound());

    const config = await discoverHomeserver("example.org");

    expect(config).toEqual({
      host: "example.org",
      homeserver_url: "https://example.org",
      api_base: "https://example.org/api",
      identity_server_url: undefined,
      livekit_url: undefined,
      instance_name: undefined,
      features: undefined,
    });
  });

  /**
   * A well-known that returns 200 but with malformed JSON must raise
   * JsonParseError, not silently fall through to the defaults — the
   * host is actively broken and the user should see that.
   */
  it("raises JsonParseError on malformed JSON", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/.well-known/matrix/client")) {
        return malformed();
      }
      return notFound();
    });

    await expect(discoverHomeserver("example.org")).rejects.toBeInstanceOf(
      JsonParseError,
    );
  });

  /**
   * Non-HTTPS URL rejected. This is the downgrade-attack guard: if a
   * malicious or misconfigured well-known advertises `http://`, the
   * helper must refuse rather than quietly tunnel the client onto an
   * insecure endpoint.
   */
  it("rejects plain http:// URLs in the Matrix well-known", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/.well-known/matrix/client")) {
        return jsonResponse(200, {
          "m.homeserver": { base_url: "http://insecure.example.org" },
        });
      }
      return notFound();
    });

    await expect(discoverHomeserver("example.org")).rejects.toBeInstanceOf(
      InvalidUrlError,
    );
  });

  it("rejects plain http:// URLs in the Concord well-known", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/.well-known/matrix/client")) {
        return notFound();
      }
      return jsonResponse(200, {
        api_base: "http://insecure.example.org/api",
      });
    });

    await expect(discoverHomeserver("example.org")).rejects.toBeInstanceOf(
      InvalidUrlError,
    );
  });

  /**
   * Network-level failure (DNS, connection refused, abort). The helper
   * translates the underlying TypeError into a targeted DnsResolutionError
   * so the UI can render "host not reachable" rather than a raw fetch
   * error string.
   */
  it("raises DnsResolutionError when fetch throws", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new TypeError("NetworkError when attempting to fetch resource.");
    });

    await expect(discoverHomeserver("does-not-exist.invalid")).rejects.toBeInstanceOf(
      DnsResolutionError,
    );
  });

  /**
   * 5xx on a well-known is a hard error — the host is reachable but
   * broken. We surface it distinctly so the UI can tell the user
   * "that server is having problems" rather than "not found".
   */
  it("raises HttpServerError on 5xx responses", async () => {
    fetchSpy.mockImplementation(async () => ({
      status: 503,
      ok: false,
      json: async () => ({}),
    }));

    await expect(discoverHomeserver("example.org")).rejects.toBeInstanceOf(
      HttpServerError,
    );
  });
});
