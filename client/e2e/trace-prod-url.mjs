import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  // Force-disable any HTTP cache so we see what fresh requests get.
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();
page.on("console", (msg) => {
  const t = msg.text();
  if (t.startsWith("[trace]") || msg.type() === "error") {
    console.log(`[${msg.type()}] ${t.slice(0, 300)}`);
  }
});
page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

await page.addInitScript(() => {
  const t0 = performance.now();
  const log = (tag, p) => console.log(`[trace] +${String(Math.round(performance.now()-t0)).padStart(6)}ms ${tag} ${JSON.stringify(p)}`);
  function watch() {
    const v = document.getElementById("boot-splash-anim");
    const splash = document.getElementById("boot-splash");
    if (!splash || !v) return requestAnimationFrame(watch);
    log("attach", { hasV: !!v, count: document.querySelectorAll("video").length });
    let lastCt = -1;
    ["play","pause","ended","loadstart","emptied","seeking","seeked","abort"].forEach(ev =>
      v.addEventListener(ev, () => log(`V:${ev}`, { ct: +v.currentTime.toFixed(2) })));
    v.addEventListener("timeupdate", () => {
      if (lastCt > 0 && v.currentTime < lastCt - 0.5) log("V:JUMPBACK", { from: +lastCt.toFixed(2), to: +v.currentTime.toFixed(2) });
      lastCt = v.currentTime;
    });
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "attributes") log("splash:attr", { attr: m.attributeName, to: splash.getAttribute(m.attributeName) });
        if (m.type === "childList") log("logo:children", { added: [...m.addedNodes].map(n=>n.nodeName), removed: [...m.removedNodes].map(n=>n.nodeName) });
      }
    }).observe(splash, { attributes: true, subtree: false });
    const logo = document.getElementById("boot-splash-logo");
    if (logo) new MutationObserver((muts) => {
      for (const m of muts) if (m.type === "childList") log("logo:children", { added: [...m.addedNodes].map(n=>n.nodeName), removed: [...m.removedNodes].map(n=>n.nodeName) });
    }).observe(logo, { childList: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
});

await page.goto("https://dev.concorrd.com/?nocache=" + Date.now(), { waitUntil: "domcontentloaded" });
await page.waitForTimeout(45000);
await browser.close();
