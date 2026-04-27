import { beforeEach, describe, expect, it } from "vitest";
import { useAuthStore } from "../auth";
import {
  clearPendingVoiceSession,
  getPendingVoiceSession,
  useVoiceStore,
} from "../voice";

describe("useVoiceStore session persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    useAuthStore.setState({
      client: null,
      userId: "@tester:example.concordchat.net",
      accessToken: "token",
      isLoggedIn: true,
      isLoading: false,
      syncing: false,
    });
    useVoiceStore.setState({
      connected: false,
      connectionState: "disconnected",
      reconnectAttempt: 0,
      token: null,
      livekitUrl: null,
      iceServers: [],
      serverId: null,
      serverName: null,
      channelId: null,
      channelName: null,
      roomName: null,
      returnChannelId: null,
      returnChannelName: null,
      micGranted: false,
      statsSessionId: null,
    });
  });

  it("persists the full reconnect context for the current user", () => {
    useVoiceStore.getState().connect({
      token: "lk-token",
      livekitUrl: "wss://livekit.example.concordchat.net/livekit/",
      iceServers: [],
      serverId: "server-test-1",
      serverName: "Concord Testers",
      channelId: "!0HioYNQoSymZ0kG1pO:example.concordchat.net",
      channelName: "voice-ops",
      roomName: "!0HioYNQoSymZ0kG1pO:example.concordchat.net",
      returnChannelId: "!general:example.concordchat.net",
      returnChannelName: "general",
      micGranted: true,
    });

    expect(getPendingVoiceSession()).toEqual({
      serverId: "server-test-1",
      serverName: "Concord Testers",
      channelId: "!0HioYNQoSymZ0kG1pO:example.concordchat.net",
      channelName: "voice-ops",
      roomName: "!0HioYNQoSymZ0kG1pO:example.concordchat.net",
      returnChannelId: "!general:example.concordchat.net",
      returnChannelName: "general",
    });
  });

  it("clears the persisted reconnect context on explicit disconnect", () => {
    useVoiceStore.getState().connect({
      token: "lk-token",
      livekitUrl: "wss://livekit.example.concordchat.net/livekit/",
      iceServers: [],
      serverId: "srv_1",
      serverName: "Concord",
      channelId: "!voice:example.concordchat.net",
      channelName: "voice",
      roomName: "!voice:example.concordchat.net",
      returnChannelId: "!general:example.concordchat.net",
      returnChannelName: "general",
      micGranted: true,
    });

    useVoiceStore.getState().disconnect();

    expect(getPendingVoiceSession()).toBeNull();
  });

  it("can clear a stale session payload directly", () => {
    window.localStorage.setItem(
      "concord_voice_session:@tester:example.concordchat.net",
      JSON.stringify({
        serverId: "srv_1",
        channelId: "!voice:example.concordchat.net",
        channelName: "voice",
        roomName: "!voice:example.concordchat.net",
      }),
    );

    clearPendingVoiceSession();

    expect(getPendingVoiceSession()).toBeNull();
  });
});
