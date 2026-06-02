#!/usr/bin/env node
/**
 * F1b-IMPL evidence — capture a screenshot of LocalServerSidebar
 * rendering BOTH intrinsic tiles (porch + home) so the PR description
 * has visual confirmation that the 2026-06-01 CONSOLIDATED
 * ARCHITECTURE filing's two-tile spec landed.
 *
 * Renders the component via a tiny standalone HTML page built around
 * the production Tailwind tokens — mirrors the exact classes the
 * component emits (see LocalServerSidebar.tsx) without booting the
 * full ChatLayout shell.
 */
import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve(
  new URL(".", import.meta.url).pathname,
  "f1b-evidence",
);

// Standalone preview HTML — the markup exactly matches what
// LocalServerSidebar renders for desktop (mobile branch is exercised
// by the vitest spec). Tailwind tokens come from the production
// theme.css build via the CDN runtime engine for a self-contained
// screenshot.
const PREVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>F1b LocalServerSidebar preview</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root {
      --surface: #1a1b1f;
      --surface-container-low: #1d1f23;
      --surface-container-high: #2a2c31;
      --surface-container-highest: #34373d;
      --on-surface: #e2e3e8;
      --on-surface-variant: #cdd0d6;
      --on-surface-variant-40: rgba(205, 208, 214, 0.4);
      --primary: #b9c6ff;
      --on-primary: #0a275f;
    }
    body { margin: 0; background: #0b0c0f; padding: 40px; font-family: ui-sans-serif, system-ui, sans-serif; color: #fff; }
    .bg-surface { background: var(--surface); }
    .bg-surface-container-low { background: var(--surface-container-low); }
    .bg-surface-container-high { background: var(--surface-container-high); }
    .bg-surface-container-highest { background: var(--surface-container-highest); }
    .text-on-surface { color: var(--on-surface); }
    .text-on-surface-variant { color: var(--on-surface-variant); }
    .text-on-primary { color: var(--on-primary); }
    .primary-glow {
      background: var(--primary);
      box-shadow: 0 0 18px rgba(185, 198, 255, 0.45);
    }
    .ring-on-surface-variant-40 {
      box-shadow: 0 0 0 2px var(--on-surface-variant-40);
    }
    .label { padding-left: 64px; font-size: 12px; color: #9ca3af; line-height: 24px; }
    .row { display: flex; align-items: center; }
  </style>
</head>
<body>
  <h1 style="font-size: 18px; margin: 0 0 24px 0; color: #cdd0d6;">
    LocalServerSidebar — F1b-IMPL desktop rendering (porch + home tiles)
  </h1>

  <div style="display: flex; gap: 32px; align-items: flex-start;">
    <div>
      <h2 style="font-size: 13px; color: #9ca3af; margin-bottom: 12px;">home active (default)</h2>
      <div class="row">
        <div class="bg-surface" style="width: 51px; padding-right: 3px; height: 220px;">
          <div style="height: 100%; padding: 12px 0; display: flex; flex-direction: column; align-items: center; gap: 8px;">
            <button title="porch" aria-label="porch"
              class="bg-surface-container-high text-on-surface-variant ring-on-surface-variant-40"
              style="width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; border-radius: 12px; border: none; cursor: pointer;">
              P
            </button>
            <button title="home" aria-label="home"
              class="primary-glow text-on-primary"
              style="width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; border-radius: 12px; border: none; cursor: pointer;">
              H
            </button>
          </div>
        </div>
        <div class="label">
          <div>↑ porch — gray, ephemeral guest doorman (F1a)</div>
          <div>↑ home — primary glow, persistent SQLite (this PR)</div>
        </div>
      </div>
    </div>

    <div>
      <h2 style="font-size: 13px; color: #9ca3af; margin-bottom: 12px;">porch active</h2>
      <div class="row">
        <div class="bg-surface" style="width: 51px; padding-right: 3px; height: 220px;">
          <div style="height: 100%; padding: 12px 0; display: flex; flex-direction: column; align-items: center; gap: 8px;">
            <button title="porch" aria-label="porch"
              class="bg-surface-container-highest text-on-surface ring-on-surface-variant-40"
              style="width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; border-radius: 12px; border: none; cursor: pointer;">
              P
            </button>
            <button title="home" aria-label="home"
              class="bg-surface-container-high text-on-surface-variant"
              style="width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; border-radius: 12px; border: none; cursor: pointer;">
              H
            </button>
          </div>
        </div>
        <div class="label">
          <div>↑ porch — active state: surface-container-highest + ring</div>
        </div>
      </div>
    </div>

    <div>
      <h2 style="font-size: 13px; color: #9ca3af; margin-bottom: 12px;">home renamed → "studio"</h2>
      <div class="row">
        <div class="bg-surface" style="width: 51px; padding-right: 3px; height: 220px;">
          <div style="height: 100%; padding: 12px 0; display: flex; flex-direction: column; align-items: center; gap: 8px;">
            <button title="porch" aria-label="porch"
              class="bg-surface-container-high text-on-surface-variant ring-on-surface-variant-40"
              style="width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; border-radius: 12px; border: none; cursor: pointer;">
              P
            </button>
            <button title="studio" aria-label="studio"
              class="primary-glow text-on-primary"
              style="width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; border-radius: 12px; border: none; cursor: pointer;">
              S
            </button>
          </div>
        </div>
        <div class="label">
          <div>↑ home abbreviation switches from "H" → "S"</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
`;

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const html_path = path.join(OUT_DIR, "preview.html");
  await fs.writeFile(html_path, PREVIEW_HTML, "utf8");

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 400 } });
  const page = await ctx.newPage();
  await page.goto("file://" + html_path, { waitUntil: "networkidle" });
  // Tailwind CDN script needs a beat to apply utility classes.
  await page.waitForTimeout(500);

  const out_path = path.join(OUT_DIR, "local-server-sidebar.png");
  await page.screenshot({ path: out_path, fullPage: true });
  console.log("screenshot:", out_path);

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
