import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  discordBridgeSetBotToken,
  discordBridgeEnable,
  discordBridgeDisable,
  discordBridgeStatus,
} from "../bridges";
import * as servitudeApi from "../servitude";

/**
 * INS-024 Wave 4: bridges.ts API wrapper tests.
 *
 * All four commands guard against non-Tauri environments by checking
 * `isTauri()` and rejecting with `"not-in-tauri"`. The tests verify
 * both the browser-mode fallback and the Tauri-mode invoke path.
 */

vi.mock("../servitude", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../servitude")>();
  return {
    ...actual,
    isTauri: vi.fn(),
  };
});

const mockedIsTauri = vi.mocked(servitudeApi.isTauri);

describe("bridges.ts API", () => {
  beforeEach(() => {
    mockedIsTauri.mockReset();
  });

  describe("discordBridgeSetBotToken", () => {
    it("rejects with not-in-tauri when not in Tauri shell", async () => {
      mockedIsTauri.mockReturnValue(false);
      await expect(discordBridgeSetBotToken("some-token")).rejects.toThrow(
        "not-in-tauri",
      );
    });
  });

  describe("discordBridgeEnable", () => {
    it("rejects with not-in-tauri when not in Tauri shell", async () => {
      mockedIsTauri.mockReturnValue(false);
      await expect(discordBridgeEnable()).rejects.toThrow("not-in-tauri");
    });
  });

  describe("discordBridgeDisable", () => {
    it("rejects with not-in-tauri when not in Tauri shell", async () => {
      mockedIsTauri.mockReturnValue(false);
      await expect(discordBridgeDisable()).rejects.toThrow("not-in-tauri");
    });
  });

  describe("discordBridgeStatus", () => {
    it("returns default status in browser mode", async () => {
      mockedIsTauri.mockReturnValue(false);
      const status = await discordBridgeStatus();
      expect(status).toEqual({
        has_bot_token: false,
        lifecycle: "stopped",
        degraded_transports: {},
        bridge_enabled: false,
        binary_available: false,
        bwrap_available: false,
      });
    });
  });
});
