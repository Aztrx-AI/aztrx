import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { EventBus } from "./eventBus.js";
import { attachInterceptor } from "./interceptor.js";
import { fingerprintOf } from "./classifier.js";
import type { RecordedAction } from "./types.js";

export interface ReplayEngineOptions {
  attachGuard?: (page: Page) => Promise<void>;
}

export interface ReplayResult {
  reproduced: boolean;
}

/** Replays a recorded action sequence against a page. Best-effort: a selector
 * that no longer resolves is skipped, not fatal. */
export async function replayActions(page: Page, actions: RecordedAction[]): Promise<void> {
  for (const a of actions) {
    if (a.type === "navigate") {
      if (a.value) {
        await page.goto(a.value, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      }
      continue;
    }
    if (a.type === "scroll") {
      await page.mouse.wheel(0, a.value === "up" ? -600 : 600).catch(() => {});
      await page.waitForTimeout(30);
      continue;
    }
    if (a.type === "keypress") {
      const key = a.value ?? "Enter";
      if (a.selectors[0]) {
        await page.locator(a.selectors[0]).first().focus().catch(() => {});
      }
      await page.keyboard.press(key).catch(() => {});
      await page.waitForTimeout(30);
      continue;
    }
    for (const sel of a.selectors) {
      const loc = page.locator(sel).first();
      const n = await loc.count().catch(() => 0);
      if (n === 0) continue;
      switch (a.type) {
        case "input":
          await loc.fill(a.value ?? "").catch(() => {});
          break;
        case "hover":
          await loc.hover().catch(() => {});
          break;
        case "select":
          await loc.selectOption(a.value ?? "").catch(() => {});
          break;
        default:
          await loc.click({ timeout: 1000 }).catch(() => {});
          break;
      }
      break;
    }
    await page.waitForTimeout(50);
  }
}

/**
 * Reuses one browser across replays (ddmin + validator each run many). Each
 * `run` gets a fresh page; the interceptor collects telemetry fingerprints and
 * reports whether `targetFingerprint` was seen.
 */
export class ReplayEngine {
  private browser: Browser | null = null;

  constructor(private opts: ReplayEngineOptions = {}) {}

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) this.browser = await chromium.launch({ headless: true });
    return this.browser;
  }

  async run(url: string, actions: RecordedAction[], targetFingerprint: string): Promise<ReplayResult> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      const bus = new EventBus();
      const fingerprints = new Set<string>();
      bus.on("telemetry", (p) => fingerprints.add(fingerprintOf(p)));
      attachInterceptor(page, bus);
      if (this.opts.attachGuard) await this.opts.attachGuard(page);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await replayActions(page, actions);
      await page.waitForTimeout(300);

      return { reproduced: fingerprints.has(targetFingerprint) };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }
}
