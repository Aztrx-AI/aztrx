import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { mkdirSync } from "fs";

const root = dirname(fileURLToPath(import.meta.url));
const framesDir = resolve(root, "..", "media", "frames");
mkdirSync(framesDir, { recursive: true });

const W = 724;
const H = 430;
const FPS = 12;
const T = 4.7;
const steps = Math.round(T * FPS);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await page.goto("file://" + resolve(root, "demo.html"));
await page.waitForTimeout(250);

for (let i = 0; i <= steps; i++) {
  const t = (i / steps) * T;
  await page.evaluate((tt) => window.__seek(tt), t);
  const n = String(i).padStart(3, "0");
  await page.screenshot({ path: resolve(framesDir, `frame_${n}.png`) });
}

await browser.close();
console.log(`captured ${steps + 1} frames → ${framesDir}`);
