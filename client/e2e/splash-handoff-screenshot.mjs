#!/usr/bin/env node
/**
 * Diagnostic: capture a screenshot AT the moment the boot-splash
 * hands off, to confirm the underlying UI has actually rendered.
 * Verifies the fix: splash should never dismiss into a blank.
 */
import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";

const url = process.argv[2] || "http://localhost:8080/?nocache=" + Date.now();
const OUT_DIR = path.resolve(new URL(".", import.meta.url).pathname, "splash-evidence");

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  // Snapshot at three time points + at the handoff event itself.
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Take a snapshot every 200ms for the first 3 seconds AND
  // capture the moment data-state changes.
  await page.evaluate(() => {
    window.__handoffT = null;
    window.__terminalAtHandoff = null;
    const splash = document.getElementById("boot-splash");
    if (!splash) return;
    const mo = new MutationObserver(() => {
      if (splash.getAttribute("data-state") === "handoff" && window.__handoffT === null) {
        window.__handoffT = performance.now();
        // Capture which terminal screen elements are present.
        window.__terminalAtHandoff = {
          dockerFirstBoot: !!document.querySelector("[data-testid='docker-first-boot-screen']") || !!document.querySelector("button:has-text('Host')") || /Host this device/.test(document.body.innerText),
          serverPicker: /Server picker|Pick a server|Connect to/i.test(document.body.innerText),
          loginForm: !!document.querySelector("input[type='password']"),
          chatLayout: !!document.querySelector("[data-testid='chat-layout']") || /channels/i.test(document.body.innerText),
          bodyText: document.body.innerText.slice(0, 500),
        };
      }
    });
    mo.observe(splash, { attributes: true });
  });

  // Capture screenshots at intervals.
  const snapshots = [];
  for (let t = 200; t <= 3000; t += 400) {
    await page.waitForTimeout(t === 200 ? 200 : 400);
    const file = path.join(OUT_DIR, `t-${String(t).padStart(4, "0")}ms.png`);
    await page.screenshot({ path: file, fullPage: false });
    const state = await page.evaluate(() => ({
      data_state: document.getElementById("boot-splash")?.getAttribute("data-state"),
      retired: document.getElementById("boot-splash")?.classList.contains("boot-splash-retired"),
      handoffT: window.__handoffT,
      terminalAtHandoff: window.__terminalAtHandoff,
      visibleBody: document.body.innerText.slice(0, 200),
    }));
    snapshots.push({ t, file: path.basename(file), ...state });
  }

  console.log(JSON.stringify(snapshots, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
