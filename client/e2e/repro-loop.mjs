import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push(`PAGE ERROR: ${err.message}\n${err.stack?.split("\n").slice(0,8).join("\n")}`));

// Try to log in via the UI to reach the ChatLayout path.
await page.goto("http://localhost:8080/?nocache=" + Date.now(), { waitUntil: "load" });
await page.waitForSelector("input[placeholder='Username']", { timeout: 10000 }).catch(() => {});
await page.fill("input[placeholder='Username']", "corr");
await page.fill("input[placeholder='Password']", "wrong-password-trigger-error");
await page.click("button:has-text('Login')").catch(() => {});
await page.waitForTimeout(8000);

console.log(`\nTotal errors: ${errors.length}`);
const counts = {};
for (const e of errors) {
  const key = e.split("\n")[0].slice(0, 200);
  counts[key] = (counts[key] || 0) + 1;
}
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
for (const [text, c] of sorted.slice(0, 10)) console.log(`  ${String(c).padStart(4)}x  ${text}`);
const max = errors.find((e) => e.includes("Maximum update"));
if (max) console.log("\n=== Stack of first Max-update error ===\n", max);
await browser.close();
