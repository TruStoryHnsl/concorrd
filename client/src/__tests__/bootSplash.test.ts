import { describe, expect, it } from "vitest";
import {
  getBootSplashWaitingLabel,
  handoffBootSplash,
  showBootSplash,
} from "../bootSplash";

describe("bootSplash helpers", () => {
  it("formats the waiting label with the provided host", () => {
    expect(getBootSplashWaitingLabel("concorrd.com")).toBe("Waiting for concorrd.com");
  });

  it("shows the dormant boot splash immediately with host status", () => {
    document.body.innerHTML = `
      <div id="boot-splash" data-state="handoff">
        <div id="boot-splash-status">Loading…</div>
      </div>
    `;

    showBootSplash("Waiting for concorrd.com");

    expect(document.getElementById("boot-splash")?.getAttribute("data-state")).toBe("visible");
    expect(document.getElementById("boot-splash-status")?.textContent).toBe("Waiting for concorrd.com");
  });

  it("marks the bootstrap splash as handed off after React mounts", () => {
    document.body.innerHTML = `<div id="boot-splash" data-state="visible"></div>`;

    handoffBootSplash();

    expect(document.getElementById("boot-splash")?.getAttribute("data-state")).toBe("handoff");
  });
});
