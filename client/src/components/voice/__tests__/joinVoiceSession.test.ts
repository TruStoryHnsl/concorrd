/**
 * Phase 8 follow-up — `joinVoiceSession` mesh-vs-LiveKit branch tests.
 *
 * Two cases:
 *
 *   1. When the path selector returns `libp2p_mesh`, the join flow
 *      calls `invoke("voice_mesh_join", ...)` and short-circuits
 *      before fetching a LiveKit token.
 *   2. When mesh join throws, the LiveKit fallback path is exercised
 *      (existing behavior — preserved by this PR).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../../../api/voicePath", () => ({
  selectVoicePath: vi.fn(),
}));

const { getVoiceTokenMock } = vi.hoisted(() => ({
  getVoiceTokenMock: vi.fn(),
}));

vi.mock("../../../api/livekit", () => ({
  getVoiceToken: getVoiceTokenMock,
}));

vi.mock("../../../api/serverUrl", () => ({
  getHomeserverUrl: vi.fn(() => "http://example.test"),
}));

vi.mock("../../../voice/noiseGate", () => ({
  buildMicTrackConstraints: vi.fn(() => true),
}));

vi.mock("../../../stores/serverConfig", () => ({
  useServerConfigStore: {
    getState: () => ({ config: null }),
  },
}));

vi.mock("../../../stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      preferredInputDeviceId: undefined,
      masterInputVolume: 1,
      inputNoiseGateEnabled: false,
      inputNoiseGateThresholdDb: -50,
    }),
  },
}));

const voiceStoreState = {
  beginConnectAttempt: vi.fn(() => true),
  setConnectionState: vi.fn(),
  connect: vi.fn(),
};

vi.mock("../../../stores/voice", () => ({
  useVoiceStore: {
    getState: () => voiceStoreState,
  },
}));

import * as voicePathApi from "../../../api/voicePath";
import { joinVoiceSession } from "../joinVoiceSession";

const selectVoicePathMock = vi.mocked(voicePathApi.selectVoicePath);

describe("joinVoiceSession mesh-mode branching", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    selectVoicePathMock.mockReset();
    getVoiceTokenMock.mockReset();
    voiceStoreState.beginConnectAttempt.mockReset();
    voiceStoreState.beginConnectAttempt.mockReturnValue(true);
    voiceStoreState.connect.mockReset();
    voiceStoreState.setConnectionState.mockReset();
    // Suppress getUserMedia path — joinVoiceSession only tries it
    // when mediaDevices exists.
    (globalThis as unknown as { navigator: { mediaDevices: unknown } }).navigator =
      {
        mediaDevices: undefined,
      } as unknown as Navigator;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("when selector returns libp2p_mesh, invokes voice_mesh_join and skips LiveKit", async () => {
    selectVoicePathMock.mockResolvedValueOnce({
      path: "libp2p_mesh",
      reason: "all_native_under_cap",
    });
    invokeMock.mockResolvedValueOnce(undefined);

    await joinVoiceSession({
      roomId: "!room:concord.test",
      channelName: "general voice",
      serverId: "server-1",
      accessToken: "access-token",
    });

    expect(invokeMock).toHaveBeenCalledWith("voice_mesh_join", expect.any(Object));
    expect(getVoiceTokenMock).not.toHaveBeenCalled();
    expect(voiceStoreState.connect).toHaveBeenCalled();
    const connectCall = voiceStoreState.connect.mock.calls[0]?.[0] as {
      transport?: string;
    };
    expect(connectCall.transport).toBe("libp2p_mesh");
  });

  it("when mesh-join throws, falls back to LiveKit", async () => {
    selectVoicePathMock.mockResolvedValueOnce({
      path: "libp2p_mesh",
      reason: "all_native_under_cap",
    });
    invokeMock.mockRejectedValueOnce(new Error("voice_mesh_join unregistered"));
    getVoiceTokenMock.mockResolvedValueOnce({
      token: "livekit-tok",
      livekit_url: "wss://lk.example/",
      ice_servers: [],
    });

    await joinVoiceSession({
      roomId: "!room:concord.test",
      channelName: "general voice",
      serverId: "server-1",
      accessToken: "access-token",
    });

    expect(invokeMock).toHaveBeenCalledWith("voice_mesh_join", expect.any(Object));
    expect(getVoiceTokenMock).toHaveBeenCalled();
    // The most recent connect() call carries LiveKit transport (the
    // first call's failure path threw before reaching connect).
    const allConnectCalls = voiceStoreState.connect.mock.calls;
    expect(allConnectCalls.length).toBeGreaterThan(0);
    const lastCall = allConnectCalls[allConnectCalls.length - 1]?.[0] as {
      transport?: string;
      token: string;
    };
    expect(lastCall.transport).toBeUndefined();
    expect(lastCall.token).toBe("livekit-tok");
  });

  it("when selector returns livekit_sfu, uses LiveKit directly", async () => {
    selectVoicePathMock.mockResolvedValueOnce({
      path: "livekit_sfu",
      reason: "above_cap_8",
    });
    getVoiceTokenMock.mockResolvedValueOnce({
      token: "livekit-tok",
      livekit_url: "wss://lk.example/",
      ice_servers: [],
    });

    await joinVoiceSession({
      roomId: "!room:concord.test",
      channelName: "general voice",
      serverId: "server-1",
      accessToken: "access-token",
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(getVoiceTokenMock).toHaveBeenCalled();
  });
});
