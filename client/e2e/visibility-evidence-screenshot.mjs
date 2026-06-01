#!/usr/bin/env node
/**
 * F-VIS evidence — capture screenshots of:
 *   1. Settings → Hosting visibility slider (per-server max mesh-hops).
 *   2. Settings → Connections per-peer access toggle (visible-vs-access split).
 *
 * Standalone HTML preview pages, same pattern as
 * `local-sidebar-screenshot.mjs`. The markup mirrors what the
 * production VisibilitySection / KnownPeersList emit, sharing the
 * Tailwind tokens via the CDN runtime engine so the screenshots are
 * self-contained.
 */
import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve(
  new URL(".", import.meta.url).pathname,
  "f-vis-evidence",
);

const VISIBILITY_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>F-VIS Settings → Hosting visibility slider</title>
  <script
    src="https://cdn.tailwindcss.com/3.4.16"
    integrity="sha384-mS5Uq7sE90lgbBDN8xgf34ibEgbZo4gB3tfLY40ZRle+M188BQw8onzNHg6GUZaA"
    crossorigin="anonymous"
  ></script>
  <style>
    :root {
      --surface: #1a1b1f;
      --surface-container: #1d1f23;
      --surface-container-high: #2a2c31;
      --on-surface: #e2e3e8;
      --on-surface-variant: #cdd0d6;
      --primary: #b9c6ff;
      --error: #ffb4ab;
    }
    body { margin: 0; background: #0b0c0f; padding: 32px; font-family: ui-sans-serif, system-ui, sans-serif; color: var(--on-surface); }
    .bg-surface-container { background: var(--surface-container); }
    .text-on-surface { color: var(--on-surface); }
    .text-on-surface-variant { color: var(--on-surface-variant); }
    .text-on-surface-variant\\/70 { color: rgba(205, 208, 214, 0.7); }
    .text-error { color: var(--error); }
    .border-outline-variant\\/20 { border-color: rgba(126, 130, 138, 0.2); }
    .accent-primary { accent-color: var(--primary); }
    input[type="range"] { accent-color: var(--primary); width: 100%; }
    .label-strip { display:flex; justify-content: space-between; font-size: 10px; color: var(--on-surface-variant); font-family: ui-monospace, monospace; }
  </style>
</head>
<body>
  <h1 style="font-size: 16px; color: var(--on-surface-variant); margin: 0 0 12px 0;">
    Settings → Hosting → Server visibility (F-VIS)
  </h1>
  <p style="font-size: 12px; color: var(--on-surface-variant); max-width: 720px; margin: 0 0 24px 0;">
    Each server you host has a configurable mesh-hop visibility ceiling. A peer N hops away on the mesh only sees a server when its ceiling is at least N. Outside that radius, the server is invisible to them. Visibility is independent of access — a peer can see a server without being able to dial in.
  </p>

  <div class="bg-surface-container rounded-xl p-3" style="max-width: 640px; margin-bottom: 16px;">
    <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px;">
      <span class="text-on-surface" style="font-size: 14px; font-weight: 500;">Porch (always-fresh guest entrance)</span>
      <span class="text-on-surface-variant" style="font-size: 12px; font-family: ui-monospace, monospace;">1 hop</span>
    </div>
    <input type="range" min="0" max="5" step="1" value="1" />
    <div class="label-strip" style="margin-top: 6px;">
      <span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span>
    </div>
    <p class="text-on-surface-variant" style="font-size: 12px; margin: 8px 0 0;">
      Direct paired peers — only the peers you've paired with see it.
    </p>
    <p class="text-on-surface-variant/70" style="font-size: 12px; font-style: italic; margin: 4px 0 0;">
      Defaults to 1 hop — only your directly-paired peers can see it.
    </p>
  </div>

  <div class="bg-surface-container rounded-xl p-3" style="max-width: 640px; margin-bottom: 16px;">
    <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px;">
      <span class="text-on-surface" style="font-size: 14px; font-weight: 500;">Home (your persistent server)</span>
      <span class="text-on-surface-variant" style="font-size: 12px; font-family: ui-monospace, monospace;">0 hops</span>
    </div>
    <input type="range" min="0" max="5" step="1" value="0" />
    <div class="label-strip" style="margin-top: 6px;">
      <span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span>
    </div>
    <p class="text-on-surface-variant" style="font-size: 12px; margin: 8px 0 0;">
      Owner only — nobody else sees this server in their explore menu.
    </p>
    <p class="text-on-surface-variant/70" style="font-size: 12px; font-style: italic; margin: 4px 0 0;">
      Defaults to 0 hops — owner-only until you opt in. Raise this to let paired peers (or wider) see it in their explore menu.
    </p>
  </div>

  <div class="bg-surface-container rounded-xl p-3" style="max-width: 640px;">
    <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px;">
      <span class="text-on-surface" style="font-size: 14px; font-weight: 500;">Home (slider raised → 3)</span>
      <span class="text-on-surface-variant" style="font-size: 12px; font-family: ui-monospace, monospace;">3 hops</span>
    </div>
    <input type="range" min="0" max="5" step="1" value="3" />
    <div class="label-strip" style="margin-top: 6px;">
      <span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span>
    </div>
    <p class="text-on-surface-variant" style="font-size: 12px; margin: 8px 0 0;">
      Three hops — pairs of pairs of pairs.
    </p>
    <p class="text-on-surface-variant/70" style="font-size: 12px; font-style: italic; margin: 4px 0 0;">
      A visibility broadcast was just emitted on the gossipsub rotation topic — paired peers within 3 hops will refresh their explore-menu cache.
    </p>
  </div>
</body>
</html>
`;

const CONNECTIONS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>F-VIS Settings → Connections per-peer access toggle</title>
  <script
    src="https://cdn.tailwindcss.com/3.4.16"
    integrity="sha384-mS5Uq7sE90lgbBDN8xgf34ibEgbZo4gB3tfLY40ZRle+M188BQw8onzNHg6GUZaA"
    crossorigin="anonymous"
  ></script>
  <style>
    :root {
      --surface: #1a1b1f;
      --surface-container: #1d1f23;
      --surface-container-high: #2a2c31;
      --on-surface: #e2e3e8;
      --on-surface-variant: #cdd0d6;
      --primary: #b9c6ff;
      --error: #ffb4ab;
      --error-bg: rgba(255, 180, 171, 0.1);
    }
    body { margin: 0; background: #0b0c0f; padding: 32px; font-family: ui-sans-serif, system-ui, sans-serif; color: var(--on-surface); }
    .text-on-surface { color: var(--on-surface); }
    .text-on-surface-variant { color: var(--on-surface-variant); }
    .text-error { color: var(--error); }
    .bg-surface-container-high { background: var(--surface-container-high); }
    .bg-error-10 { background: var(--error-bg); }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 8px; border-radius: 6px; }
    .row:hover { background: var(--surface-container-high); }
    .pid { font-family: ui-monospace, monospace; font-size: 13px; color: var(--on-surface-variant); }
    .chip { font-size: 12px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
    .chip.source { background: var(--surface-container-high); color: var(--on-surface-variant); }
    .chip.revoked { background: var(--error-bg); color: var(--error); }
    .last-seen { font-size: 12px; color: var(--on-surface-variant); white-space: nowrap; }
    .toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--on-surface-variant); }
    input[type="checkbox"] { accent-color: var(--primary); }
    button.remove { background: transparent; color: var(--on-surface-variant); border: none; padding: 4px 6px; cursor: pointer; border-radius: 6px; }
    button.remove:hover { color: var(--error); background: var(--error-bg); }
  </style>
</head>
<body>
  <h1 style="font-size: 16px; color: var(--on-surface-variant); margin: 0 0 12px 0;">
    Settings → Connections → Paired Peers (F-VIS: visible vs. access)
  </h1>
  <p style="font-size: 12px; color: var(--on-surface-variant); max-width: 720px; margin: 0 0 24px 0;">
    Every paired peer stays in this list, even after access is revoked.
    The toggle on each row controls whether that peer can dial in.
    Revoking does NOT remove the peer — Architecture B keeps the visible
    list separate from the access list.
  </p>

  <ul style="max-width: 640px; list-style: none; padding: 0; margin: 0;">
    <li class="row">
      <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
        <span class="pid">12D3KooWAbcD…</span>
        <span class="chip source">QR</span>
      </div>
      <span class="last-seen">3m ago</span>
      <label class="toggle">
        <input type="checkbox" checked />
        Access
      </label>
      <button class="remove" title="Remove paired peer">🗑</button>
    </li>
    <li class="row">
      <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
        <span class="pid">12D3KooWXyz9…</span>
        <span class="chip source">Link</span>
        <span class="chip revoked" title="In the visible list but cannot dial in.">Access revoked</span>
      </div>
      <span class="last-seen">5h ago</span>
      <label class="toggle">
        <input type="checkbox" />
        Access
      </label>
      <button class="remove" title="Remove paired peer">🗑</button>
    </li>
    <li class="row">
      <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
        <span class="pid">12D3KooWMnoP…</span>
        <span class="chip source">Matrix</span>
      </div>
      <span class="last-seen">1d ago</span>
      <label class="toggle">
        <input type="checkbox" checked />
        Access
      </label>
      <button class="remove" title="Remove paired peer">🗑</button>
    </li>
    <li class="row">
      <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
        <span class="pid">12D3KooWQrSt…</span>
        <span class="chip source">DHT</span>
        <span class="chip revoked" title="Timed out — still visible but access revoked.">Access revoked</span>
      </div>
      <span class="last-seen">14d ago</span>
      <label class="toggle">
        <input type="checkbox" />
        Access
      </label>
      <button class="remove" title="Remove paired peer">🗑</button>
    </li>
  </ul>
  <p style="margin-top: 24px; font-size: 12px; color: var(--on-surface-variant); max-width: 720px;">
    Rows 2 and 4 are visible-only (access revoked). The user still sees them — re-toggling the "Access" checkbox re-affirms the peer back into the access list and emits no other state change.
  </p>
</body>
</html>
`;

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const visibility_html_path = path.join(OUT_DIR, "visibility-preview.html");
  await fs.writeFile(visibility_html_path, VISIBILITY_HTML, "utf8");
  const connections_html_path = path.join(OUT_DIR, "connections-preview.html");
  await fs.writeFile(connections_html_path, CONNECTIONS_HTML, "utf8");

  const browser = await chromium.launch({ headless: true });

  const ctx_v = await browser.newContext({ viewport: { width: 760, height: 920 } });
  const page_v = await ctx_v.newPage();
  await page_v.goto("file://" + visibility_html_path, { waitUntil: "networkidle" });
  await page_v.waitForTimeout(500);
  const visibility_out = path.join(OUT_DIR, "settings-hosting-visibility.png");
  await page_v.screenshot({ path: visibility_out, fullPage: true });
  console.log("screenshot:", visibility_out);

  const ctx_c = await browser.newContext({ viewport: { width: 760, height: 720 } });
  const page_c = await ctx_c.newPage();
  await page_c.goto("file://" + connections_html_path, { waitUntil: "networkidle" });
  await page_c.waitForTimeout(500);
  const connections_out = path.join(OUT_DIR, "settings-connections-access-toggle.png");
  await page_c.screenshot({ path: connections_out, fullPage: true });
  console.log("screenshot:", connections_out);

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
