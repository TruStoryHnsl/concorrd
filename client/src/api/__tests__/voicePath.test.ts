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

import * as servitudeApi from "../servitude";
import {
  selectVoicePath,
  type VoiceParticipant,
} from "../voicePath";

const isTauriMock = vi.mocked(servitudeApi.isTauri);

describe("selectVoicePath wrapper", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    isTauriMock.mockReset();
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
   * Web build short-circuits to SFU. The Tauri invoke path is
   * forbidden — browsers can't be libp2p mesh peers until Phase 9.
   */
  it("web build short-circuits to livekit_sfu without invoking the Tauri command", async () => {
    isTauriMock.mockReturnValue(false);

    const participants: VoiceParticipant[] = [
      { matrix_user_id: "@alice:example.org", peer_id: "12D3KooWAlice" },
      { matrix_user_id: "@bob:example.org", peer_id: "12D3KooWBob" },
    ];

    const result = await selectVoicePath(participants);

    expect(result).toEqual({
      path: "livekit_sfu",
      reason: "browser_or_web_build",
    });
    // The Tauri command must NOT have been invoked.
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
});
