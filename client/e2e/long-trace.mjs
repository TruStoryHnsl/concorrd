import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

page.on("console", (msg) => {
  const t = msg.text();
  if (t.startsWith("[trace]")) console.log(t);
});

await page.addInitScript(() => {
  const t0 = performance.now();
  const log = (tag, payload) => {
    const t = Math.round(performance.now() - t0);
    console.log(`[trace] +${String(t).padStart(6)}ms ${tag} ${JSON.stringify(payload)}`);
  };

  function attach(v, label) {
    let lastCt = -1;
    let lastUpdate = 0;
    ["play","pause","ended","seeking","seeked","waiting","stalled","abort","emptied","loadstart","loadeddata","canplay","ratechange","playing","suspend","error"].forEach((ev) => {
      v.addEventListener(ev, () => {
        log(`${label}:${ev}`, { ct: +v.currentTime.toFixed(3), paused: v.paused, hidden: v.classList.contains("boot-splash-anim-hidden") });
      });
    });
    v.addEventListener("timeupdate", () => {
      const now = performance.now();
      const ct = v.currentTime;
      // Detect time jumps backwards (ct decreased significantly)
      if (lastCt > 0 && ct < lastCt - 0.5) {
        log(`${label}:JUMP_BACK`, { from: +lastCt.toFixed(3), to: +ct.toFixed(3) });
      }
      lastCt = ct;
      if (now - lastUpdate < 500) return;
      lastUpdate = now;
      log(`${label}:tu`, { ct: +ct.toFixed(3), hidden: v.classList.contains("boot-splash-anim-hidden") });
    });
  }
  function watch() {
    const v = document.getElementById("boot-splash-anim");
    const a = document.getElementById("boot-splash-anim-a");
    const b = document.getElementById("boot-splash-anim-b");
    const splash = document.getElementById("boot-splash");
    if (splash && (v || (a && b))) {
      log("attach", { mode: v ? "single" : "ping-pong" });
      if (v) attach(v, "V");
      if (a) attach(a, "A");
      if (b) attach(b, "B");
      const logo = document.getElementById("boot-splash-logo");
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "attributes") log(`splash:attr`, { attr: m.attributeName, to: splash.getAttribute(m.attributeName) });
          if (m.type === "childList") log(`splash:children`, { added: Array.from(m.addedNodes).map((n) => n.nodeName), removed: Array.from(m.removedNodes).map((n) => n.nodeName) });
        }
      });
      mo.observe(splash, { attributes: true, attributeOldValue: true });
      if (logo) mo.observe(logo, { childList: true });
      return;
    }
    requestAnimationFrame(watch);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
});

await page.goto("http://localhost:8080/?nocache=" + Date.now(), { waitUntil: "domcontentloaded" });
await page.waitForTimeout(30000);
await browser.close();
