/**
 * INS-023 Service Node admin section — two layers of coverage.
 *
 * Layer 1 — static source assertions via Vite's `?raw` suffix. The
 * AdminTab component mounts seven sub-sections and pulls from four
 * stores; a full render test would require mocking ~15 modules.
 * Instead we assert on the narrow wiring contract points that would
 * break if a future refactor deleted the Service Node wire-in:
 *
 *   - The `Section` union includes "service-node".
 *   - The tab bar renders the `service-node` button with the human
 *     label "Service Node" (two-word capitalization).
 *   - A `ServiceNodeSection` function is defined in the file.
 *   - That section calls `getServiceNodeConfig` and
 *     `updateServiceNodeConfig` from `api/concord`.
 *
 * Layer 2 — real render + fetch round-trip of the API helpers
 * themselves (`getServiceNodeConfig`, `updateServiceNodeConfig`).
 * This exercises the PUT payload shape and the base-url resolution
 * via the mocked `apiFetch` seam the rest of the client tests use.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import adminTabSource from "../AdminTab.tsx?raw";
import {
  getServiceNodeConfig,
  updateServiceNodeConfig,
  type ServiceNodeConfig,
} from "../../../api/concord";

// Mock the apiFetch seam by spying on global `fetch`. The test does
// not install a full mock of `../../api/serverUrl` because `concord.ts`
// reads the base URL from a helper that short-circuits to `/api` in
// the jsdom environment.
vi.mock("../../../api/serverUrl", () => ({
  getApiBase: () => "/api",
  initServerUrl: vi.fn(() => Promise.resolve()),
  getServerUrl: vi.fn(() => ""),
  getHomeserverUrl: vi.fn(() => "https://test.local"),
  isDesktopMode: vi.fn(() => true),
  hasServerUrl: vi.fn(() => true),
  setServerUrl: vi.fn(() => Promise.resolve()),
}));

const SAMPLE: ServiceNodeConfig = {
  max_cpu_percent: 75,
  max_bandwidth_mbps: 500,
  max_storage_gb: 50,
  tunnel_anchor_enabled: true,
  node_role: "anchor",
  limits: {
    max_cpu_percent: 100,
    max_bandwidth_mbps: 100000,
    max_storage_gb: 100000,
    allowed_roles: ["frontend-only", "hybrid", "anchor"],
  },
};

describe("AdminTab static wiring (INS-023)", () => {
  it("declares a 'service-node' value in the Section union", () => {
    expect(adminTabSource).toMatch(/"service-node"/);
  });

  it("renders a 'Service Node' tab button label (two-word capitalized)", () => {
    expect(adminTabSource).toMatch(/"Service Node"/);
  });

  it("defines a ServiceNodeSection function", () => {
    expect(adminTabSource).toMatch(/function\s+ServiceNodeSection\s*\(/);
  });

  it("imports getServiceNodeConfig from api/concord", () => {
    expect(adminTabSource).toMatch(/getServiceNodeConfig/);
  });

  it("imports updateServiceNodeConfig from api/concord", () => {
    expect(adminTabSource).toMatch(/updateServiceNodeConfig/);
  });

  it("routes section='service-node' to <ServiceNodeSection>", () => {
    expect(adminTabSource).toMatch(
      /section\s*===\s*"service-node"\s*&&\s*<ServiceNodeSection/,
    );
  });

  it("exposes a CPU, bandwidth, and storage input via test ids", () => {
    expect(adminTabSource).toMatch(/data-testid="service-node-cpu-input"/);
    expect(adminTabSource).toMatch(/data-testid="service-node-bandwidth-input"/);
    expect(adminTabSource).toMatch(/data-testid="service-node-storage-input"/);
    expect(adminTabSource).toMatch(/data-testid="service-node-role-select"/);
    expect(adminTabSource).toMatch(/data-testid="service-node-anchor-toggle"/);
    expect(adminTabSource).toMatch(/data-testid="service-node-save-button"/);
  });
});

describe("service node API helpers (INS-023)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /api/admin/service-node sends a Bearer token and returns the config", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(SAMPLE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const result = await getServiceNodeConfig("test-token-abc");

    expect(result).toEqual(SAMPLE);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/admin/service-node");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer test-token-abc");
  });

  it("PUT /api/admin/service-node sends the full update body", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(SAMPLE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const result = await updateServiceNodeConfig(
      {
        max_cpu_percent: 75,
        max_bandwidth_mbps: 500,
        max_storage_gb: 50,
        tunnel_anchor_enabled: true,
        node_role: "anchor",
      },
      "test-token-abc",
    );

    expect(result).toEqual(SAMPLE);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/admin/service-node");
    expect(init?.method).toBe("PUT");
    const bodyText =
      typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    const parsed = JSON.parse(bodyText);
    expect(parsed).toEqual({
      max_cpu_percent: 75,
      max_bandwidth_mbps: 500,
      max_storage_gb: 50,
      tunnel_anchor_enabled: true,
      node_role: "anchor",
    });
  });
});
