import { describe, expect, it } from "vitest";
import floatingVideoTilesSource from "../FloatingVideoTiles.tsx?raw";
import voiceChannelSource from "../VoiceChannel.tsx?raw";
import voiceStoreSource from "../../../stores/voice.ts?raw";
import serverStoreSource from "../../../stores/server.ts?raw";
import dmStoreSource from "../../../stores/dm.ts?raw";
import settingsStoreSource from "../../../stores/settings.ts?raw";
import appSource from "../../../App.tsx?raw";

/**
 * Tester-owned verification suite for Issue E (floating video tiles,
 * 2026-04-18). Authored in a SEPARATE worktree
 * (test/floating-video-tiles-verify-c41b) by a cold reader, NOT by the
 * same context that wrote the feature — per the project's written-in-blood
 * test-authoring rule. These tests are not a substitute for the full
 * Playwright user journey (see "NOT OBSERVED" section below); they lock
 * in the structural invariants that a Playwright run can then rely on,
 * and they cross-check that the component's store dependencies still
 * exist on the branches we're testing against.
 *
 * WHAT THIS VERIFIES
 * ==================
 *   A. FloatingVideoTiles is mounted inside the same LiveKitRoom that
 *      VoiceChannel.tsx uses — so their hook subscriptions share a
 *      connection and there's no risk of a second LiveKit session being
 *      spun up in the background.
 *   B. Every store selector the component reaches into actually exists
 *      on the branch's stores. If any of these go missing, shouldFloat
 *      silently becomes incorrect (e.g. activeChannelId === undefined
 *      === voiceChannelId === null would falsely say "viewing the
 *      channel" on a fresh login).
 *   C. The render-gate composition is complete: every term
 *      (voiceConnected, voiceChannelId, hasVideo, viewingVoiceChannel,
 *      dismissedForChannelId) appears in the shouldFloat expression.
 *   D. VoiceChannel's docked-video grid is gated the OPPOSITE way —
 *      it renders when the user IS viewing the channel. The two
 *      components are mutually exclusive by construction, so the user
 *      never sees a double-attached tile even for a single frame.
 *
 * WHAT IS NOT OBSERVED (flagged for human QA / future Playwright run)
 * ===================================================================
 *   - The actual visual appearance of the overlay (position, z-index
 *     stacking with toasts, VoiceConnectionBar etc.).
 *   - End-to-end network behaviour: the LiveKit track resubscribe
 *     path when the component remounts on route change.
 *   - Docking animation / absence-of-jank when returning to channel.
 *   - Behaviour on tab close / page refresh (should be handled by the
 *     existing auto-reconnect path in App.tsx voice reconnect flow —
 *     untouched by this feature).
 *   - Mobile layout: fixed positioning against bottom sheet / mobile
 *     keyboard could collide.
 *
 * Report each of those observed-or-not in the PM's Phase-7 report.
 */

describe("[TESTER] FloatingVideoTiles — structural + dependency cross-checks", () => {
  describe("A. mount context", () => {
    it("mounts inside the App.tsx LiveKitRoom (sibling of CustomAudioRenderer)", () => {
      // The structural assertion: FloatingVideoTiles must appear INSIDE
      // the LiveKitRoom's children, not outside. If a refactor ever moves
      // it outside LiveKitRoom, useTracks will throw at mount and the
      // whole app will crash when voice is joined.
      const livekitRoomMatch = appSource.match(
        /<LiveKitRoom[\s\S]*?>([\s\S]*?)<\/LiveKitRoom>/,
      );
      expect(livekitRoomMatch, "App.tsx must contain a <LiveKitRoom>...</LiveKitRoom>").not.toBeNull();
      const children = livekitRoomMatch![1];
      expect(children).toContain("<FloatingVideoTiles />");
      expect(children).toContain("<CustomAudioRenderer />");
    });
  });

  describe("B. store dependencies exist on the branch", () => {
    it("useVoiceStore exposes connected + channelId + serverId", () => {
      // These three selectors are what shouldFloat keys off of. If the
      // voice store refactored any of them away, the component would
      // silently always show or always hide.
      expect(voiceStoreSource).toContain("connected: boolean;");
      expect(voiceStoreSource).toContain("channelId: string | null");
      expect(voiceStoreSource).toContain("serverId: string | null");
    });

    it("useServerStore exposes activeServerId + activeChannelId + setters", () => {
      expect(serverStoreSource).toContain("activeServerId: string | null;");
      expect(serverStoreSource).toContain("activeChannelId: string | null;");
      expect(serverStoreSource).toContain("setActiveServer: (serverId: string) => void;");
      expect(serverStoreSource).toContain("setActiveChannel: (matrixRoomId: string) => void;");
    });

    it("useDMStore exposes dmActive + setDMActive", () => {
      expect(dmStoreSource).toContain("dmActive: boolean;");
      expect(dmStoreSource).toContain("setDMActive: (active: boolean) => void;");
    });

    it("useSettingsStore exposes settingsOpen / serverSettingsId / closeSettings / closeServerSettings", () => {
      expect(settingsStoreSource).toContain("settingsOpen");
      expect(settingsStoreSource).toContain("serverSettingsId");
      expect(settingsStoreSource).toContain("closeSettings");
      expect(settingsStoreSource).toContain("closeServerSettings");
    });
  });

  describe("C. render-gate completeness", () => {
    it("shouldFloat composes all five terms in the documented order", () => {
      // Locks in the exact composition so any future edit has to either
      // keep every term or update this test explicitly (and document
      // why). Matters because dropping a term either double-renders (if
      // viewingVoiceChannel is dropped) or renders forever after dismiss
      // (if dismissedForChannelId is dropped).
      const shouldFloatBlock = floatingVideoTilesSource.match(
        /const shouldFloat =\s*([\s\S]*?);/,
      );
      expect(shouldFloatBlock, "shouldFloat assignment must exist").not.toBeNull();
      const expr = shouldFloatBlock![1];
      expect(expr).toMatch(/voiceConnected/);
      expect(expr).toMatch(/voiceChannelId !== null/);
      expect(expr).toMatch(/hasVideo/);
      expect(expr).toMatch(/!viewingVoiceChannel/);
      expect(expr).toMatch(/dismissedForChannelId !== voiceChannelId/);
    });

    it("viewingVoiceChannel correctly requires server-id match AND channel-id match", () => {
      // This is the subtle one. A user who joined voice on server A
      // channel 1 and is now looking at server B channel 1 (same id by
      // chance — Matrix room ids are globally unique but synthetic ids
      // could collide) must still see the float. The composition must
      // compare BOTH activeServerId and activeChannelId.
      const viewingBlock = floatingVideoTilesSource.match(
        /const viewingVoiceChannel =\s*([\s\S]*?);/,
      );
      expect(viewingBlock).not.toBeNull();
      const expr = viewingBlock![1];
      expect(expr).toContain("voiceChannelId !== null");
      expect(expr).toContain("!dmActive");
      expect(expr).toContain("!settingsOpen");
      expect(expr).toContain("!serverSettingsId");
      expect(expr).toContain("activeChannelId === voiceChannelId");
      expect(expr).toContain("serverStoreActiveServerId === activeServerId");
    });
  });

  describe("D. mutual-exclusion with VoiceChannel docked grid", () => {
    it("VoiceChannel's camera/screen grid only renders when the user is on the voice channel UI", () => {
      // The VoiceChannel component already short-circuits to a join
      // screen when voice isn't connected to THIS room. That path ends
      // with `return <VoiceRoomUI .../>;` — VoiceRoomUI is what owns the
      // docked tiles. Because VoiceRoomUI only mounts when the user's
      // ChatLayout route is the voice channel, its tiles and the
      // FloatingVideoTiles tiles are mutually exclusive.
      expect(voiceChannelSource).toContain(
        "if (!voiceConnected || voiceChannelId !== roomId)",
      );
      expect(voiceChannelSource).toContain("return <VoiceRoomUI");
    });
  });

  describe("E. navigation handler does not cross the streams with other overlays", () => {
    it("handleReturn closes DM, settings, and server-settings overlays before routing", () => {
      // Without these, clicking Return from within Settings would route
      // the underlying chat pane to the voice channel but leave Settings
      // covering it — the user would tap Return and see no change.
      expect(floatingVideoTilesSource).toMatch(
        /handleReturn[\s\S]*?closeSettings\(\)[\s\S]*?closeServerSettings\(\)[\s\S]*?setDMActive\(false\)[\s\S]*?setActiveServer[\s\S]*?setActiveChannel/,
      );
    });
  });
});
