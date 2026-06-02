/**
 * INS-068 cross-instance public-rooms regression tests.
 *
 * Bug: `SourceServerBrowser` early-returned on
 * `source.platform !== "matrix"` in BOTH the auth-flows useEffect and
 * the `loadSourceDirectory` callback. Concord-instance sources are
 * added with `platform: "concord"`, so the federated
 * `client.publicRooms({server: <hostname>, limit: 50})` call NEVER
 * fired and the dialog rendered empty.
 *
 * Fix: skip only when `platform === "reticulum"` (Reticulum has no
 * Matrix room directory). Both Concord-instance sources AND vanilla
 * Matrix sources should reach the public-room directory call.
 *
 * Tests run at two layers:
 *   1. Static-source asserts on the gate text in ChatLayout.tsx so a
 *      future refactor that re-introduces a `platform !== "matrix"`
 *      early-return is caught at the literal source level. (This is
 *      the load-bearing fix point — the bug WAS that gate.)
 *   2. Runtime mount of `SourceServerBrowser` with a mocked
 *      `matrix-js-sdk` so we can observe the actual `publicRooms`
 *      call argument shape per platform. This is the user-perspective
 *      verification: with a concord-instance source, the federated
 *      `{server, limit}` arg is sent; with a reticulum source, no
 *      call is made at all.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import chatLayoutSource from "../ChatLayout.tsx?raw";
import { SourceServerBrowser } from "../ChatLayout";
import { useSourcesStore, type ConcordSource } from "../../../stores/sources";
import { useAuthStore } from "../../../stores/auth";

// ---------------------------------------------------------------------------
// Layer 1 — static source assertions
// ---------------------------------------------------------------------------

describe("SourceServerBrowser cross-instance gate (INS-068, static)", () => {
  it("does NOT early-return when platform !== \"matrix\" anywhere in loadSourceDirectory or auth-flows useEffect", () => {
    // The bug-prone strings. Either of these is fatal to cross-instance
    // visibility — pin them to fail explicitly if reintroduced.
    expect(chatLayoutSource).not.toMatch(/source\.platform\s*!==\s*"matrix"/);
    expect(chatLayoutSource).not.toMatch(/source\?\.platform\s*!==\s*"matrix"/);
  });

  it("gates only on the reticulum platform (the one network without a Matrix directory)", () => {
    expect(chatLayoutSource).toMatch(/platform\s*===\s*"reticulum"/);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — runtime mount with mocked matrix-js-sdk
// ---------------------------------------------------------------------------

const publicRoomsMock = vi.fn();
const createClientMock = vi.fn();

// Tag a fresh mock implementation for matrix-js-sdk that records
// `publicRooms` calls. We re-set inside beforeEach so call history is
// deterministic per test.
vi.mock("matrix-js-sdk", () => {
  return {
    createClient: (opts: unknown) => createClientMock(opts),
  };
});

// Stub the dynamic-import login-flows fetch so the auth-flows useEffect
// doesn't 404 against a real homeserver.
vi.mock("../../../api/matrix", () => ({
  fetchLoginFlows: vi.fn(async () => ["password" as const]),
  loginWithPasswordAtBaseUrl: vi.fn(),
  buildSsoRedirectUrl: vi.fn(() => "https://example.test/sso"),
}));

function buildSource(overrides: Partial<ConcordSource>): ConcordSource {
  return {
    id: "src_test",
    host: "concord.example.test",
    instanceName: "Example",
    inviteToken: "",
    apiBase: "https://concord.example.test/api",
    homeserverUrl: "https://concord.example.test",
    status: "connected",
    enabled: true,
    addedAt: new Date().toISOString(),
    platform: "concord",
    ...overrides,
  };
}

describe("SourceServerBrowser cross-instance gate (INS-068, runtime)", () => {
  beforeEach(() => {
    publicRoomsMock.mockReset();
    publicRoomsMock.mockResolvedValue({ chunk: [] });
    createClientMock.mockReset();
    createClientMock.mockReturnValue({ publicRooms: publicRoomsMock });

    useSourcesStore.setState({ sources: [], boundUserId: null });
    // The local user lives on a DIFFERENT domain than the source under
    // test — that path is what triggers the federated `{server, limit}`
    // arg shape (vs. the local-directory `{limit}` shape).
    useAuthStore.setState({
      userId: "@local:home.example.test",
      accessToken: null,
      client: null,
    } as never);
  });

  it("fires client.publicRooms({server: source.host, limit: 50}) for a concord-platform source on a different host", async () => {
    const source = buildSource({
      id: "src_concord_remote",
      host: "remote.example.test",
      platform: "concord",
      authFlows: ["password"],
    });
    useSourcesStore.setState({ sources: [source] });

    render(<SourceServerBrowser source={source} onClose={() => {}} />);

    await waitFor(() => {
      expect(publicRoomsMock).toHaveBeenCalledTimes(1);
    });
    expect(publicRoomsMock).toHaveBeenCalledWith({
      server: "remote.example.test",
      limit: 50,
    });
  });

  it("fires client.publicRooms for a matrix-platform source (regression)", async () => {
    const source = buildSource({
      id: "src_matrix",
      host: "matrix.example.test",
      platform: "matrix",
      authFlows: ["password"],
    });
    useSourcesStore.setState({ sources: [source] });

    render(<SourceServerBrowser source={source} onClose={() => {}} />);

    await waitFor(() => {
      expect(publicRoomsMock).toHaveBeenCalledTimes(1);
    });
    expect(publicRoomsMock).toHaveBeenCalledWith({
      server: "matrix.example.test",
      limit: 50,
    });
  });

  it("does NOT fire client.publicRooms for a reticulum source", async () => {
    const source = buildSource({
      id: "src_reticulum",
      host: "ret.example.test",
      platform: "reticulum",
      authFlows: ["password"],
    });
    useSourcesStore.setState({ sources: [source] });

    render(<SourceServerBrowser source={source} onClose={() => {}} />);

    // Give any pending microtasks a chance to flush. We're asserting the
    // negative case so a brief delay is necessary to avoid a green
    // result that's actually a race.
    await new Promise((r) => setTimeout(r, 30));
    expect(publicRoomsMock).not.toHaveBeenCalled();
  });
});
