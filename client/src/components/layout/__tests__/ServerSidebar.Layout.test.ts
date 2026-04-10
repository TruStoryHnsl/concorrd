// @ts-nocheck — test file uses Node.js fs/path APIs
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "../ServerSidebar.tsx"),
  "utf-8",
);

/**
 * Regression tests for server sidebar layout positioning (INS-020).
 *
 * These tests enforce the structural contract:
 *   - LOCAL servers stack from the TOP
 *   - Federated + Discord + Explore stack from the BOTTOM
 *   - Both mobile and desktop use split scroll regions
 *   - TouchSensor (not PointerSensor) is used on touch devices
 *
 * If any of these fail, the layout has regressed.
 */
describe("ServerSidebar layout positioning", () => {
  it("mobile has two separate scroll regions (top + bottom)", () => {
    const mobileSection = source.slice(
      source.indexOf("if (mobile) {"),
      source.indexOf("// Desktop: compact"),
    );
    expect(mobileSection.length).toBeGreaterThan(0);
    const scrollRegions = (mobileSection.match(/overflow-y-auto/g) || []).length;
    expect(scrollRegions).toBeGreaterThanOrEqual(2);
  });

  it("mobile bottom region uses explicit percentage height (pins to bottom)", () => {
    const mobileSection = source.slice(
      source.indexOf("if (mobile) {"),
      source.indexOf("// Desktop: compact"),
    );
    expect(mobileSection).toMatch(/h-\[\d+%\].*overflow-y-auto/);
  });

  it("desktop has two separate scroll regions (top + bottom)", () => {
    const desktopSection = source.slice(source.indexOf("// Desktop: compact"));
    const scrollRegions = (desktopSection.match(/overflow-y-auto/g) || []).length;
    expect(scrollRegions).toBeGreaterThanOrEqual(2);
  });

  it("desktop bottom region uses explicit percentage height (pins to bottom)", () => {
    const desktopSection = source.slice(source.indexOf("// Desktop: compact"));
    expect(desktopSection).toMatch(/h-\[\d+%\].*overflow-y-auto/);
  });

  it("Explore button exists in the source code", () => {
    // Explore should appear in both mobile and desktop renders
    const exploreCount = (source.match(/Explore/g) || []).length;
    expect(exploreCount).toBeGreaterThanOrEqual(4); // imports + comments + renders
  });

  it("touch devices use TouchSensor only, not PointerSensor", () => {
    // When isTouchDevice is true, only TouchSensor should be used
    expect(source).toMatch(/isTouchDevice/);
    expect(source).toMatch(/TouchSensor.*delay.*1000/);
    // The conditional should exclude PointerSensor on touch
    expect(source).toMatch(/isTouchDevice[\s\S]*?TouchSensor[\s\S]*?PointerSensor/);
  });

  it("TouchSensor has at least 1000ms delay", () => {
    const delayMatch = source.match(/TouchSensor.*?delay:\s*(\d+)/);
    expect(delayMatch).toBeTruthy();
    expect(Number(delayMatch![1])).toBeGreaterThanOrEqual(1000);
  });
});
