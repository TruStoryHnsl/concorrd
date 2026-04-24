import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warning") errors.push({ type: msg.type(), text: msg.text() });
});
page.on("pageerror", (err) => errors.push({ type: "pageerror", text: err.message + (err.stack ? "\n" + err.stack.split("\n").slice(0, 5).join("\n") : "") }));
await page.goto("http://localhost:8080/?nocache=" + Date.now(), { waitUntil: "load" });
await page.waitForTimeout(8000);
const counts = {};
for (const e of errors) {
  const key = e.text.split("\n")[0].slice(0, 200);
  counts[key] = (counts[key] || 0) + 1;
}
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
console.log("Top error/warning lines (counts):");
for (const [text, c] of sorted.slice(0, 30)) console.log(`  ${String(c).padStart(4)}x  ${text}`);
console.log(`\nTotal events: ${errors.length}`);
const max = errors.find((e) => e.text.includes("Maximum update depth"));
if (max) console.log("\nFirst Max-update-depth full text:\n", max.text);
await browser.close();
