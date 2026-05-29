import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// Hoist the Tauri-core invoke mock so it's installed before the SUT's
// dynamic import resolves. Same pattern as hostingProfile.test.ts.
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

// Mock the `isTauri()` detector so each test pins the environment
// explicitly without having to mutate `window`.
vi.mock("../servitude", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../servitude")>();
  return {
    ...actual,
    isTauri: vi.fn(),
  };
});

// Mock `getNode()` so each browser-path test pins the libp2p
// availability explicitly. The real `node.ts` is exercised in
// `libp2p/__tests__/node.test.ts`.
vi.mock("../../libp2p/node", () => ({
  getNode: vi.fn(),
}));

import * as servitudeApi from "../servitude";
import * as nodeApi from "../../libp2p/node";
import {
  selectVoicePath,
  type VoiceParticipant,
} from "../voicePath";

const isTauriMock = vi.mocked(servitudeApi.isTauri);
const getNodeMock = vi.mocked(nodeApi.getNode);

describe("selectVoicePath wrapper", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    isTauriMock.mockReset();
    getNodeMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Native build, 3 mesh-eligible participants. The wrapper must
   * pass the participant list through verbatim and surface the
   * Rust-side reason verbatim.
   */
  it("native build with three native participants selects libp2p_mesh", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce({
      path: "libp2p_mesh",
      reason: "all_native_under_cap",
    });

    const participants: VoiceParticipant[] = [
      { matrix_user_id: "@alice:example.org", peer_id: "12D3KooWAlice" },
      { matrix_user_id: "@bob:example.org", peer_id: "12D3KooWBob" },
      { matrix_user_id: "@carol:example.org", peer_id: "12D3KooWCarol" },
    ];

    const result = await selectVoicePath(participants);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("select_voice_path", {
      participants,
    });
    expect(result).toEqual({
      path: "libp2p_mesh",
      reason: "all_native_under_cap",
    });
  });

  /**
   * Web build, no libp2p node yet. The browser falls back to SFU
   * with the Phase 9 `browser_libp2p_not_running` reason, and the
   * Tauri invoke path is forbidden — there's no native runtime to
   * ask.
   */
  it("web build without a libp2p node returns livekit_sfu, no Tauri call", async () => {
    isTauriMock.mockReturnValue(false);
    getNodeMock.mockReturnValue(null);

    const participants: VoiceParticipant[] = [
      { matrix_user_id: "@alice:example.org", peer_id: "12D3KooWAlice" },
      { matrix_user_id: "@bob:example.org", peer_id: "12D3KooWBob" },
    ];

    const result = await selectVoicePath(participants);

    expect(result).toEqual({
      path: "livekit_sfu",
      reason: "browser_libp2p_not_running",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  /**
   * Native build with a single web-only participant — the Rust side
   * returns SFU + web-only reason; the wrapper passes both through.
   */
  it("native build with one web-only participant returns livekit_sfu", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce({
      path: "livekit_sfu",
      reason: "web_only_participant_present",
    });

    const participants: VoiceParticipant[] = [
      { matrix_user_id: "@alice:example.org", peer_id: "12D3KooWAlice" },
      { matrix_user_id: "@bob:example.org", peer_id: "12D3KooWBob" },
      { matrix_user_id: "@web-user:example.org", peer_id: null },
    ];

    const result = await selectVoicePath(participants);

    expect(invokeMock).toHaveBeenCalledWith("select_voice_path", {
      participants,
    });
    expect(result).toEqual({
      path: "livekit_sfu",
      reason: "web_only_participant_present",
    });
  });

  /**
   * If the Tauri invocation rejects (command unregistered on an
   * older native build, unexpected Rust error, etc), the wrapper
   * MUST fall back to LiveKit so the voice flow keeps working.
   * The reason string surfaces the underlying failure shape.
   */
  it("falls back to livekit_sfu when the Tauri invoke rejects", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockRejectedValueOnce(
      new Error("invoke select_voice_path not registered"),
    );

    const participants: VoiceParticipant[] = [
      { matrix_user_id: "@alice:example.org", peer_id: "12D3KooWAlice" },
      { matrix_user_id: "@bob:example.org", peer_id: "12D3KooWBob" },
    ];

    const result = await selectVoicePath(participants);

    expect(result.path).toBe("livekit_sfu");
    expect(result.reason).toContain("select_voice_path_error");
    expect(result.reason).toContain("not registered");
  });

  // ---- Phase 9: browser libp2p selector cases ----

  /**
   * Browser build with a running libp2p node and three native
   * participants — the browser is now mesh-eligible per Phase 9.
   * No Tauri invocation; the selector is replicated locally.
   */
  it("browser with libp2p node + 3 known peers selects libp2p_mesh", async () => {
    isTauriMock.mockReturnValue(false);
    // Any truthy object; the selector only checks `getNode() !== null`.
    getNodeMock.mockReturnValue({} as never);

    const participants: VoiceParticipant[] = [
      { matrix_user_id: "@alice:example.org", peer_id: "12D3KooWAlice" },
      { matrix_user_id: "@bob:example.org", peer_id: "12D3KooWBob" },
      { matrix_user_id: "@carol:example.org", peer_id: "12D3KooWCarol" },
    ];

    const result = await selectVoicePath(participants);

    expect(result).toEqual({
      path: "libp2p_mesh",
      reason: "all_native_under_cap",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  /**
   * Browser build with a running libp2p node but 9 participants —
   * mesh cap is 8, so SFU.
   */
  it("browser with libp2p node + 9 participants falls back to livekit_sfu (cap)", async () => {
    isTauriMock.mockReturnValue(false);
    getNodeMock.mockReturnValue({} as never);

    const participants: VoiceParticipant[] = Array.from(
      { length: 9 },
      (_, i) => ({
        matrix_user_id: `@user${i}:example.org`,
        peer_id: `12D3KooWPeer${i}`,
      }),
    );

    const result = await selectVoicePath(participants);

    expect(result).toEqual({
      path: "livekit_sfu",
      reason: "above_cap_8",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  /**
   * Browser build with a running libp2p node but one web-only
   * participant — SFU, same as the native selector's
   * `web_only_participant_present` branch.
   */
  it("browser with libp2p node + one web-only participant returns livekit_sfu", async () => {
    isTauriMock.mockReturnValue(false);
    getNodeMock.mockReturnValue({} as never);

    const participants: VoiceParticipant[] = [
      { matrix_user_id: "@alice:example.org", peer_id: "12D3KooWAlice" },
      { matrix_user_id: "@bob:example.org", peer_id: "12D3KooWBob" },
      { matrix_user_id: "@web:example.org", peer_id: null },
    ];

    const result = await selectVoicePath(participants);

    expect(result).toEqual({
      path: "livekit_sfu",
      reason: "web_only_participant_present",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
