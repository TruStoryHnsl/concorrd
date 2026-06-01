import { describe, expect, it, vi, beforeEach } from "vitest";

// Hoisted invoke mock — same pattern as `peerStore.test.ts`. The SUT
// reads `invoke` from `@tauri-apps/api/core` at module load, so the
// mock must be installed BEFORE we import the SUT.
const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn().mockReturnValue(true),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

// Mock `isTauri` so we can flip between native and web behavior per
// test without prodding the global `window` object.
vi.mock("../servitude", () => ({
  isTauri: isTauriMock,
}));

// Hoisted mock for the lazy `../libp2p/porch` module so the web-build
// dispatch tests don't actually pull in `js-libp2p`. The dynamic
// `import()` inside `visitPeer` resolves to this stub.
const browserVisitListChannelsMock = vi.fn();
const browserVisitGetMessagesMock = vi.fn();
const browserVisitPostMessageMock = vi.fn();

vi.mock("../../libp2p/porch", () => ({
  browserVisitListChannels: browserVisitListChannelsMock,
  browserVisitGetMessages: browserVisitGetMessagesMock,
  browserVisitPostMessage: browserVisitPostMessageMock,
}));

import {
  listMyChannels,
  visitPeer,
  visitGetMessages,
  visitPostMessage,
  type PorchChannel,
} from "../porch";

const sampleChannel: PorchChannel = {
  id: "porch-default",
  name: "Porch",
  kind: "porch",
  acl_mode: "open",
  created_at: 1717000000000,
};

describe("porch API wrapper", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    browserVisitListChannelsMock.mockReset();
    browserVisitGetMessagesMock.mockReset();
    browserVisitPostMessageMock.mockReset();
    isTauriMock.mockReturnValue(true);
  });

  // --------------------------------------------------------------------
  // (1) Native dispatch — listMyChannels invokes the Tauri command.
  // --------------------------------------------------------------------
  it("listMyChannels (native): invokes the Tauri command and returns the list", async () => {
    invokeMock.mockResolvedValueOnce([sampleChannel]);
    const result = await listMyChannels();
    expect(invokeMock).toHaveBeenCalledWith("porch_list_my_channels");
    expect(result).toEqual([sampleChannel]);
  });

  // --------------------------------------------------------------------
  // (2) Web dispatch — visitPeer dials over libp2p and parses the result.
  // --------------------------------------------------------------------
  it("visitPeer (web): dials via the browser libp2p module and returns the parsed channel list", async () => {
    isTauriMock.mockReturnValue(false);
    browserVisitListChannelsMock.mockResolvedValueOnce([sampleChannel]);

    const result = await visitPeer("12D3KooWPeer");

    expect(invokeMock).not.toHaveBeenCalled();
    expect(browserVisitListChannelsMock).toHaveBeenCalledWith("12D3KooWPeer");
    expect(result).toEqual([sampleChannel]);
  });

  // --------------------------------------------------------------------
  // (3) Web dispatch with libp2p down — visitPeer rejects with the
  //     underlying error from the lazy module, so the store/UI can
  //     surface it.
  // --------------------------------------------------------------------
  it("visitPeer (web, libp2p down): propagates the rejection without falling back to invoke", async () => {
    isTauriMock.mockReturnValue(false);
    browserVisitListChannelsMock.mockRejectedValueOnce(
      new Error("browser_libp2p_not_running"),
    );

    await expect(visitPeer("12D3KooWPeer")).rejects.toThrow(
      /browser_libp2p_not_running/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  // Additional happy-path checks so the wrapper's three visit
  // commands all wire to the right side based on `isTauri()`.

  it("visitPeer (native): invokes porch_visit_peer with peerId in params", async () => {
    invokeMock.mockResolvedValueOnce([sampleChannel]);
    const result = await visitPeer("12D3KooWPeer");
    expect(invokeMock).toHaveBeenCalledWith("porch_visit_peer", {
      peerId: "12D3KooWPeer",
    });
    expect(result).toEqual([sampleChannel]);
    expect(browserVisitListChannelsMock).not.toHaveBeenCalled();
  });

  it("visitGetMessages (native): forwards channel_id + since + limit to the command", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await visitGetMessages("12D3", "porch-default", 42, 50);
    expect(invokeMock).toHaveBeenCalledWith("porch_visit_get_messages", {
      peerId: "12D3",
      channelId: "porch-default",
      since: 42,
      limit: 50,
    });
  });

  it("visitPostMessage (web): goes through the lazy browser module", async () => {
    isTauriMock.mockReturnValue(false);
    browserVisitPostMessageMock.mockResolvedValueOnce({
      id: "01HXXXXXXXXXXXXXXXXXXXXXXX",
      channel_id: "porch-default",
      author_peer_id: "12D3Self",
      body: "hi",
      created_at: 1717000000000,
    });

    const result = await visitPostMessage("12D3Target", "porch-default", "hi");
    expect(browserVisitPostMessageMock).toHaveBeenCalledWith(
      "12D3Target",
      "porch-default",
      "hi",
    );
    expect(result.body).toBe("hi");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Feature F3 — multi-hop read-only history access-mode helper
// ===========================================================================

import {
  accessModeFromHistory,
  type PorchHistoryResult,
} from "../porch";

describe("porch F3 — access mode derivation", () => {
  it("returns 'live' for a direct paired peer (hops === 0)", () => {
    const history: PorchHistoryResult = { messages: [], hops: 0 };
    const mode = accessModeFromHistory(history);
    expect(mode.kind).toBe("live");
  });

  it("returns 'read_only' with the friend-of-a-friend tooltip for hops > 0", () => {
    const history: PorchHistoryResult = { messages: [], hops: 2 };
    const mode = accessModeFromHistory(history);
    expect(mode.kind).toBe("read_only");
    if (mode.kind === "read_only") {
      expect(mode.reason).toMatch(/friend-of-a-friend/);
      // The tooltip explicitly tells the user how to unlock posting
      // — matches the F3 spec wording.
      expect(mode.reason).toMatch(/direct invite/);
    }
  });
});
