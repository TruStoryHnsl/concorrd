#!/usr/bin/env node
/**
 * Diagnostic: capture what's making the app load take 15-20s.
 * Records:
 *   - All network requests with their start time and duration
 *   - Console errors
 *   - When isAppReady fires (markAppReady call)
 *   - When the splash actually dismisses (data-state mutation)
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const t0 = Date.now();
const elapsed = () => Date.now() - t0;
const requests = [];
const errors = [];

page.on("request", (req) => {
  const startedAt = elapsed();
  req.__started = startedAt;
});
page.on("requestfinished", async (req) => {
  const startedAt = req.__started ?? 0;
  const ended = elapsed();
  const url = req.url();
  // Skip noisy WebSocket / data: / SDK
  if (url.startsWith("data:")) return;
  let resp = null;
  try { resp = await req.response(); } catch {}
  requests.push({
    method: req.method(),
    url: url.length > 120 ? url.slice(0, 117) + "..." : url,
    startedAt,
    duration: ended - startedAt,
    status: resp?.status() ?? null,
    type: req.resourceType(),
  });
});
page.on("requestfailed", (req) => {
  requests.push({
    method: req.method(),
    url: req.url().length > 120 ? req.url().slice(0, 117) + "..." : req.url(),
    startedAt: req.__started ?? 0,
    duration: elapsed() - (req.__started ?? 0),
    status: "FAILED",
    failure: req.failure()?.errorText,
    type: req.resourceType(),
  });
});
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push({ at: elapsed(), text: msg.text() });
});
page.on("pageerror", (err) => {
  errors.push({ at: elapsed(), text: `pageerror: ${err.message}` });
});

await page.addInitScript(() => {
  window.__events = [];
  const t0 = performance.now();
  const log = (tag) => window.__events.push({ at: Math.round(performance.now() - t0), tag });

  function watch() {
    const splash = document.getElementById("boot-splash");
    if (!splash) return requestAnimationFrame(watch);
    log("splash:found");
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "attributes") log(`splash:${m.attributeName}=${splash.getAttribute(m.attributeName)}`);
      }
    });
    mo.observe(splash, { attributes: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
});

await page.goto("http://localhost:8080/?nocache=" + Date.now(), { waitUntil: "load" });

// Wait until splash dismisses, or 30s max.
await page.waitForFunction(
  () => document.getElementById("boot-splash")?.classList.contains("boot-splash-retired"),
  { timeout: 30000 },
).catch(() => {});

const events = await page.evaluate(() => window.__events);
const totalLoad = elapsed();

// Sort + summarize
requests.sort((a, b) => a.startedAt - b.startedAt);
const slow = requests.filter((r) => r.duration > 200).sort((a, b) => b.duration - a.duration);

console.log(`\n=== Total wall time observed: ${totalLoad}ms ===\n`);
console.log("In-page splash timeline:");
events.slice(0, 20).forEach((e) => console.log(`  +${String(e.at).padStart(5)}ms  ${e.tag}`));

console.log(`\nTotal requests: ${requests.length}`);
console.log(`\nSlowest requests (>200ms):`);
slow.slice(0, 20).forEach((r) => {
  console.log(`  +${String(r.startedAt).padStart(5)}ms  ${String(r.duration).padStart(5)}ms  [${r.status}]  ${r.method} ${r.url} (${r.type})`);
});

if (errors.length) {
  console.log(`\nConsole errors (${errors.length}):`);
  errors.slice(0, 30).forEach((e) => console.log(`  +${String(e.at).padStart(5)}ms  ${e.text}`));
}

await browser.close();
