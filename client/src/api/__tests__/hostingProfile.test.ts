import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// Hoist the Tauri-core invoke mock so it's installed before the
// SUT's dynamic import resolves. Same pattern as peerStore.test.ts.
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

// Mock the `isTauri()` detector so each test pins the environment
// explicitly. We import the original module to keep type re-exports
// resolving — only `isTauri` is stubbed.
vi.mock("../servitude", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../servitude")>();
  return {
    ...actual,
    isTauri: vi.fn(),
  };
});

import * as servitudeApi from "../servitude";
import {
  fetchHostingProfile,
  setHostingProfile,
  enableWebStack,
} from "../hostingProfile";

const isTauriMock = vi.mocked(servitudeApi.isTauri);

describe("hostingProfile wrapper", () => {
  let fetchOriginal: typeof globalThis.fetch | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
    isTauriMock.mockReset();
    fetchMock = vi.fn();
    fetchOriginal = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    if (fetchOriginal) {
      globalThis.fetch = fetchOriginal;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).fetch;
    }
  });

  // -------------------------------------------------------------
  // fetchHostingProfile
  // -------------------------------------------------------------

  it("fetchHostingProfile: native path calls get_servitude_profile Tauri command", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce("p2p_only");

    const result = await fetchHostingProfile();

    expect(invokeMock).toHaveBeenCalledWith("get_servitude_profile");
    expect(result).toEqual({
      profile: "p2p_only",
      // Native installs don't run a docker stack — always false.
      webStackRunning: false,
      lastChanged: null,
    });
    // HTTP transport must not be touched.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetchHostingProfile: web path hits /api/hosting/profile and transcribes snake_case -> camelCase", async () => {
    isTauriMock.mockReturnValue(false);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          profile: "web_first",
          web_stack_running: true,
          last_changed: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await fetchHostingProfile();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/hosting/profile");
    expect(result).toEqual({
      profile: "web_first",
      webStackRunning: true,
      lastChanged: null,
    });
    // Tauri command must NOT be invoked from the web path.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("fetchHostingProfile: web path raises a descriptive error on non-2xx", async () => {
    isTauriMock.mockReturnValue(false);
    fetchMock.mockResolvedValueOnce(
      new Response("internal explosion", { status: 500 }),
    );

    await expect(fetchHostingProfile()).rejects.toThrow(/500/);
  });

  // -------------------------------------------------------------
  // setHostingProfile
  // -------------------------------------------------------------

  it("setHostingProfile: native path invokes set_servitude_profile with the profile", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce(undefined);

    await setHostingProfile("web_first");

    expect(invokeMock).toHaveBeenCalledWith("set_servitude_profile", {
      profile: "web_first",
    });
  });

  it("setHostingProfile: web build rejects with an explanatory error", async () => {
    isTauriMock.mockReturnValue(false);

    await expect(setHostingProfile("p2p_only")).rejects.toThrow(
      /CONCORD_PROFILE/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------
  // enableWebStack
  // -------------------------------------------------------------

  it("enableWebStack: POSTs to /api/hosting/profile/enable_web_stack and transcribes the response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          profile: "web_first",
          web_stack_running: true,
          voice: { healthy: true, turn_configured: true },
          started_services: ["id-conduwuit", "id-livekit"],
          already_running_services: ["id-docker-socket-proxy"],
          message: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await enableWebStack();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/hosting/profile/enable_web_stack");
    expect((init as RequestInit).method).toBe("POST");
    expect(result.profile).toBe("web_first");
    expect(result.webStackRunning).toBe(true);
    expect(result.startedServices).toEqual([
      "id-conduwuit",
      "id-livekit",
    ]);
    expect(result.alreadyRunningServices).toEqual([
      "id-docker-socket-proxy",
    ]);
    expect(result.voice).toEqual({
      healthy: true,
      turn_configured: true,
    });
    expect(result.message).toBeNull();
  });
});
