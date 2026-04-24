#!/usr/bin/env node
/**
 * Diagnostic: pretend the app is slow to ready by suppressing
 * `markAppReady`. Watch the splash video for 30 seconds and
 * confirm:
 *   - Animation plays exactly ONCE (no loop, no restart).
 *   - Video pauses on `ended` and stays paused.
 *   - currentTime stays at duration; never jumps back to 0.
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

page.on("console", (msg) => {
  const t = msg.text();
  if (t.startsWith("[trace]")) console.log(t);
  else if (msg.type() === "error") console.log(`[err] ${t}`);
});

await page.addInitScript(() => {
  const t0 = performance.now();
  const log = (tag, payload) => {
    const t = Math.round(performance.now() - t0);
    console.log(`[trace] +${String(t).padStart(6)}ms ${tag} ${JSON.stringify(payload)}`);
  };

  // PATCH: intercept the bootReady store before any terminal screen
  // can call markAppReady. Override it to a no-op so the splash
  // never dismisses, letting us observe the video over a long span.
  const origDescriptor = Object.getOwnPropertyDescriptor(window, "__bootReady_patched") || {};
  if (!origDescriptor.value) {
    Object.defineProperty(window, "__bootReady_patched", { value: true, writable: false });
    // Patch via monkey-patching zustand store after load — done in
    // an interval that runs until we can find the store and replace
    // its markAppReady with a no-op.
    const patchInterval = setInterval(() => {
      try {
        // Vite serves zustand modules — we can't grab the store directly
        // without accessing module internals. Instead, intercept the
        // requestAnimationFrame the MarkReady component uses.
      } catch { /* ignore */ }
    }, 100);
    setTimeout(() => clearInterval(patchInterval), 30000);
  }

  function attach(v, label) {
    let lastCt = -1;
    let lastUpdate = 0;
    ["play","pause","ended","seeking","seeked","waiting","stalled","abort","emptied","loadstart","loadeddata","canplay","ratechange","playing","suspend","error"].forEach((ev) => {
      v.addEventListener(ev, () => {
        log(`${label}:${ev}`, { ct: +v.currentTime.toFixed(3), paused: v.paused });
      });
    });
    v.addEventListener("timeupdate", () => {
      const now = performance.now();
      const ct = v.currentTime;
      if (lastCt > 0 && ct < lastCt - 0.5) {
        log(`${label}:JUMP_BACK`, { from: +lastCt.toFixed(3), to: +ct.toFixed(3) });
      }
      lastCt = ct;
      if (now - lastUpdate < 1000) return;
      lastUpdate = now;
      log(`${label}:tu`, { ct: +ct.toFixed(3), paused: v.paused });
    });
  }

  function watch() {
    const v = document.getElementById("boot-splash-anim");
    const splash = document.getElementById("boot-splash");
    if (splash && v) {
      log("attach", { found: true });
      attach(v, "V");
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "attributes") log(`splash:attr`, { attr: m.attributeName, to: splash.getAttribute(m.attributeName) });
        }
      });
      mo.observe(splash, { attributes: true });
      return;
    }
    requestAnimationFrame(watch);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
});

// Match Vite's transformed module URL for main.tsx (it appends
// query params like ?t=…). Wildcard query handles that.
await page.route("**/src/main.tsx*", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "/* main.tsx suppressed for splash-isolation diagnostic */ console.log('[trace] main.tsx suppressed');",
  });
});

await page.goto("http://localhost:8080/?nocache=" + Date.now(), { waitUntil: "domcontentloaded" });
await page.waitForTimeout(30000);
await browser.close();
