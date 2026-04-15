/**
 * INS-026 — End-to-end federation smoke test.
 *
 * Probes the deployed Concord instance's public Matrix federation endpoints
 * to verify bidirectional federation is reachable from the public internet.
 *
 * These are real HTTP probes against the deployed server — NOT unit tests.
 * The test suite skips itself when the CONCORD_SMOKE_ENDPOINT env var is
 * absent so CI runs that don't have network access pass cleanly.
 *
 * Usage (run from client/ directory):
 *   CONCORD_SMOKE_ENDPOINT=concorrd.com npx vitest run src/__tests__/federation.smoke.test.ts
 *
 * The env var value is the bare hostname (no scheme, no trailing slash).
 */

import { describe, test, expect } from "vitest";

// Vitest exposes env vars via import.meta.env when running under Vite.
// Fall back to process.env for environments that don't inject import.meta.env.
const ENDPOINT: string | undefined =
  (import.meta.env as Record<string, string | undefined>)["CONCORD_SMOKE_ENDPOINT"] ??
  (typeof process !== "undefined" ? process.env["CONCORD_SMOKE_ENDPOINT"] : undefined);

const RUN_SMOKE = !!ENDPOINT;

/**
 * Probe a URL and return the parsed JSON, or throw with status/body.
 */
async function probe(base: string, path: string): Promise<Record<string, unknown>> {
  const url = `${base}${path}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "ConcordFederationSmokeTest/1.0" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`${url} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

// When env var is absent, add a single placeholder so the file always has
// at least one passing test and doesn't cause a "no tests found" exit.
if (!RUN_SMOKE) {
  test("federation smoke skipped — set CONCORD_SMOKE_ENDPOINT=<hostname> to run", () => {
    expect(ENDPOINT).toBeUndefined();
  });
}

describe.skipIf(!RUN_SMOKE)("INS-026 federation smoke", () => {
  const base = `https://${ENDPOINT}`;

  test("/.well-known/matrix/server returns {m.server}", async () => {
    const json = await probe(base, "/.well-known/matrix/server");
    expect(typeof json["m.server"]).toBe("string");
    expect((json["m.server"] as string).length).toBeGreaterThan(0);
  }, 15_000);

  test("/_matrix/key/v2/server returns signed server keys", async () => {
    const json = await probe(base, "/_matrix/key/v2/server");
    // Shape: { server_name: string, verify_keys: { [keyId]: { key: string } } }
    expect(typeof json["server_name"]).toBe("string");
    expect(json["verify_keys"]).toBeDefined();
    const keys = json["verify_keys"] as Record<string, unknown>;
    expect(Object.keys(keys).length).toBeGreaterThan(0);
  }, 15_000);

  test("/_matrix/federation/v1/version returns server info", async () => {
    const json = await probe(base, "/_matrix/federation/v1/version");
    // Shape: { server: { name: string, version: string } }
    const server = json["server"] as Record<string, unknown> | undefined;
    expect(server).toBeDefined();
    expect(typeof server?.["name"]).toBe("string");
  }, 15_000);

  test("/.well-known/concord/client returns Concord-specific endpoints", async () => {
    const json = await probe(base, "/.well-known/concord/client");
    // Must include api_base (required field from INS-027 well-known spec).
    expect(typeof json["api_base"]).toBe("string");
    const apiBase = json["api_base"] as string;
    expect(apiBase.startsWith("https://")).toBe(true);
  }, 15_000);
});
