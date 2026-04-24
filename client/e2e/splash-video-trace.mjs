#!/usr/bin/env node
/**
 * Diagnostic: capture every event the boot-splash <video> elements
 * fire over a 12-second window from cold load. Goal — empirically
 * identify what causes the "starts playing and then resets" symptom
 * the user is reporting.
 *
 * Captures: play, pause, ended, seeking, seeked, timeupdate
 * (sampled), waiting, stalled, abort, emptied, loadstart,
 * loadeddata, canplay, canplaythrough, ratechange, error.
 * Also captures DOM mutations on #boot-splash and the video
 * elements themselves so any external interference is visible.
 *
 * Usage:
 *   node e2e/splash-video-trace.mjs [chromium|firefox] [URL]
 */
import { chromium, firefox } from "playwright";

const browserArg = process.argv[2] || "chromium";
const url = process.argv[3] || "http://localhost:8080/";
const launcher = browserArg === "firefox" ? firefox : chromium;

const VIDEO_EVENTS = [
  "play", "pause", "ended", "seeking", "seeked",
  "waiting", "stalled", "abort", "emptied",
  "loadstart", "loadeddata", "canplay", "canplaythrough",
  "ratechange", "playing", "suspend", "error",
];

(async () => {
  const browser = await launcher.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  // Forward console messages so we see the in-page log lines.
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.startsWith("[trace]")) console.log(text);
  });

  // Inject the tracer BEFORE navigation so it's installed before
  // the splash markup is parsed.
  await page.addInitScript((events) => {
    const t0 = performance.now();
    const log = (tag, payload) => {
      const t = Math.round(performance.now() - t0);
      console.log(`[trace] +${String(t).padStart(5)}ms ${tag} ${JSON.stringify(payload)}`);
    };

    function attachVideoTracer(v, label) {
      events.forEach((ev) => {
        v.addEventListener(ev, () => {
          log(`video:${label}:${ev}`, {
            ct: +v.currentTime.toFixed(3),
            paused: v.paused,
            hidden: v.classList.contains("boot-splash-anim-hidden"),
            readyState: v.readyState,
          });
        });
      });
      // Sampled timeupdate every ~250ms (otherwise it floods).
      let lastUpdate = 0;
      v.addEventListener("timeupdate", () => {
        const now = performance.now();
        if (now - lastUpdate < 250) return;
        lastUpdate = now;
        log(`video:${label}:timeupdate`, {
          ct: +v.currentTime.toFixed(3),
          paused: v.paused,
          hidden: v.classList.contains("boot-splash-anim-hidden"),
        });
      });
    }

    function attachMutationTracer(node, label) {
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "attributes") {
            log(`mutate:${label}:attr`, {
              attr: m.attributeName,
              from: m.oldValue,
              to: node.getAttribute(m.attributeName),
            });
          } else if (m.type === "childList") {
            log(`mutate:${label}:children`, {
              added: Array.from(m.addedNodes).map((n) => n.nodeName),
              removed: Array.from(m.removedNodes).map((n) => n.nodeName),
            });
          }
        }
      });
      mo.observe(node, {
        attributes: true,
        attributeOldValue: true,
        childList: true,
      });
    }

    // Wait until the splash is in the DOM, then attach.
    const waitFor = () => {
      const a = document.getElementById("boot-splash-anim-a");
      const b = document.getElementById("boot-splash-anim-b");
      const splash = document.getElementById("boot-splash");
      if (a && b && splash) {
        log("attach", { found: true });
        attachVideoTracer(a, "A");
        attachVideoTracer(b, "B");
        attachMutationTracer(a, "A");
        attachMutationTracer(b, "B");
        attachMutationTracer(splash, "splash");
        return;
      }
      requestAnimationFrame(waitFor);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", waitFor);
    } else {
      waitFor();
    }
  }, VIDEO_EVENTS);

  await page.goto(url, { waitUntil: "domcontentloaded" });
  // Watch for 12 seconds — covers nearly two loops of a 6.25s clip.
  await page.waitForTimeout(12000);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
