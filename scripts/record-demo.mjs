/**
 * record-demo.mjs — capture the running product as video, for the submission.
 *
 * The demo rules say "show the live product, not a slide deck, not a code
 * walkthrough", so this drives the real app in a real browser and records what
 * a judge would see: the scroll-driven landing acts, the live trial data, the
 * hall rows that quote their own settlement receipts, the forge console.
 *
 * Playback is deliberately slow. The landing page is a scrub: every frame is a
 * function of scroll position, so small steps read as a steady push through
 * the arena rather than a jump cut.
 *
 *   node scripts/record-demo.mjs [--url http://localhost:3100] [--out docs/media]
 *
 * Needs a browser: `npx playwright install chromium` once, or set
 * PLAYWRIGHT_BROWSERS_PATH. Falls back to the playwright-core that ships with
 * the repo's own toolchain when the import resolves.
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Resolved lazily so the script can live in the repo while the browser toolchain
// lives wherever it was installed: `PLAYWRIGHT_PATH=file:///…/playwright/index.mjs`.
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ?? "playwright");

const url = argValue("--url") ?? "http://localhost:3100";
const outDir = resolve(argValue("--out") ?? "docs/media/raw");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** A slow, mechanical scroll: small steps, small waits, no easing surprises. */
async function glide(page, from, to, steps = 26, waitMs = 90) {
  const delta = (to - from) / steps;
  for (let i = 1; i <= steps; i += 1) {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), from + delta * i);
    await page.waitForTimeout(waitMs);
  }
}

const sleep = (ms) => page0.waitForTimeout(ms);

let page0;
async function hold(ms) {
  await page0.waitForTimeout(ms);
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    // The browser toolchain on this machine is versioned by the MCP that installed
    // it, not by the playwright npm package this script imports. `executablePath`
    // points at the installed chromium directly, so a version skew between the two
    // does not produce "executable doesn't exist" on a machine that has a browser.
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM ??
      "C:/Users/HP/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
    args: ["--force-color-profile=srgb", "--disable-lcd-text"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    recordVideo: { dir: outDir, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  page0 = page;

  // ---- 1. the landing walk -------------------------------------------------
  await page.goto(url, { waitUntil: "networkidle" }).catch(() => {});
  await hold(2500);

  const height = async () => page.evaluate(() => document.body.scrollHeight);
  const h = await height();

  // Six acts, one screen each: a steady push with a beat on each act.
  const acts = 6;
  const per = h / (acts + 2);
  for (let i = 1; i <= acts; i += 1) {
    await glide(page, per * (i - 1), per * i, 30, 80);
    await hold(2600);
  }

  // ---- 2. the work surfaces ------------------------------------------------
  const go = async (path, holdMs) => {
    await page.goto(new URL(path, url).href, { waitUntil: "domcontentloaded" }).catch(() => {});
    await hold(1200);
    await glide(page, 0, 400, 14, 70);
    await hold(holdMs);
  };

  await go("/trials", 3500);
  await go("/trials/1", 4500);
  await go("/hall", 4500);
  await go("/bounties", 3000);
  await go("/forge", 3500);
  await go("/docs", 3000);

  // ---- 3. home for the last beat -------------------------------------------
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await hold(3000);

  await context.close(); // flushes the video
  await browser.close();
  console.log(`recording written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
