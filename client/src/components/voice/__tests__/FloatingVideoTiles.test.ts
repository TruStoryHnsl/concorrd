import { describe, expect, it } from "vitest";
import floatingVideoTilesSource from "../FloatingVideoTiles.tsx?raw";
import appSource from "../../../App.tsx?raw";

/**
 * Smoke tests for Issue E (floating picture-in-picture tiles, 2026-04-18).
 *
 * The full interactive coverage (join voice → navigate away → verify
 * float appears → return → verify dock) is owned by the separate Tester
 * agent working against the actual running app. These tests lock in the
 * structural invariants that the Tester relies on:
 *
 *   1. FloatingVideoTiles is mounted INSIDE LiveKitRoom in App.tsx so the
 *      LiveKit hooks it uses (useTracks etc.) have a room context.
 *   2. It lives as a sibling of CustomAudioRenderer — not wrapped in any
 *      conditional that would unmount it when the voice view unmounts.
 *   3. It gates rendering on being connected to voice AND NOT currently
 *      viewing the voice channel — i.e. it floats only when needed.
 *   4. It exposes stable data-testids the Tester's Playwright script
 *      can latch onto: floating-video-tiles, floating-video-return,
 *      floating-video-close.
 *   5. It logs [floating-video] events so traces capture lifecycle
 *      transitions deterministically.
 */
describe("FloatingVideoTiles — structural invariants for Issue E", () => {
  it("is imported and rendered inside LiveKitRoom in App.tsx", () => {
    expect(appSource).toContain(
      'import { FloatingVideoTiles } from "./components/voice/FloatingVideoTiles";',
    );
    // Must be a sibling of CustomAudioRenderer inside LiveKitRoom — any
    // other placement means it won't have a room context.
    expect(appSource).toMatch(/<CustomAudioRenderer \/>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<FloatingVideoTiles \/>/);
  });

  it("gates rendering on shouldFloat (connected + has video + not viewing the channel)", () => {
    // The component returns null when !shouldFloat. The shouldFloat
    // composition is the key correctness boundary — if any of these go
    // missing the overlay will either never appear or will double-render
    // over the docked tiles.
    expect(floatingVideoTilesSource).toContain("if (!shouldFloat) return null;");
    expect(floatingVideoTilesSource).toContain("voiceConnected &&");
    expect(floatingVideoTilesSource).toContain("voiceChannelId !== null &&");
    expect(floatingVideoTilesSource).toContain("hasVideo &&");
    expect(floatingVideoTilesSource).toContain("!viewingVoiceChannel &&");
    expect(floatingVideoTilesSource).toContain("dismissedForChannelId !== voiceChannelId");
  });

  it("exposes stable test IDs for the Playwright tester", () => {
    expect(floatingVideoTilesSource).toContain('data-testid="floating-video-tiles"');
    expect(floatingVideoTilesSource).toContain('data-testid="floating-video-return"');
    expect(floatingVideoTilesSource).toContain('data-testid="floating-video-close"');
  });

  it("logs lifecycle transitions under the [floating-video] tag", () => {
    expect(floatingVideoTilesSource).toContain('console.info("[floating-video] transition"');
    expect(floatingVideoTilesSource).toContain('console.info("[floating-video] return-to-channel"');
    expect(floatingVideoTilesSource).toContain('console.info("[floating-video] dismiss"');
  });

  it("filters to active, unmuted publications before rendering a tile", () => {
    // Rendering a muted publication produces a black tile that lingers
    // after the user toggles their camera off. The filter below is why
    // toggling camera off makes the float disappear.
    expect(floatingVideoTilesSource).toContain(
      "t.publication && !t.publication.isMuted && t.publication.track",
    );
  });
});
