import type { Browser, BrowserContext, Page } from "playwright";
import { EventBus } from "./eventBus.js";
import { launchChromium } from "./browser.js";
import { attachInterceptor } from "./interceptor.js";
import { fingerprintOf } from "./classifier.js";
import type { FindingType, RecordedAction } from "./types.js";

export interface ReplayEngineOptions {
  attachGuard?: (page: Page) => Promise<void>;
  /** Playwright storage-state JSON (path or object) for authenticated replays. */
  storageState?: string;
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
    if (a.type === "request" && a.request) {
      // Issue the request in-page so the attached interceptor sees the response
      // and emits `network_5xx` — that is how a server finding reproduces here.
      await page
        .evaluate(async (r) => {
          try {
            await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
          } catch {
            // ignore — the 5xx (or its absence) is observed by the interceptor
          }
        }, a.request)
        .catch(() => {});
      await page.waitForTimeout(50);
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
    if (!this.browser) this.browser = await launchChromium();
    return this.browser;
  }

  async run(
    url: string,
    actions: RecordedAction[],
    targetFingerprint: string,
    opts?: { targetType?: FindingType }
  ): Promise<ReplayResult> {
    // The browser is reused across replays for speed, but after enough page
    // loads a renderer can crash. Relaunch once and retry so a single crash
    // doesn't take down the whole repro pipeline.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let context: BrowserContext | null = null;
      let page: Page | null = null;
      try {
        const browser = await this.getBrowser();
        context = await browser.newContext(
          this.opts.storageState ? { storageState: this.opts.storageState } : {}
        );
        page = await context.newPage();
        const bus = new EventBus();
        const fingerprints = new Set<string>();
        const types = new Set<FindingType>();
        // For type-based verification (server findings), ignore telemetry from the
        // initial load + settle window — only the replayed requests count. Client
        // verification stays fingerprint-exact and keeps collecting from page
        // attach, so a mount-time client bug still verifies.
        let collecting = !opts?.targetType;
        bus.on("telemetry", (p) => {
          if (!collecting) return;
          fingerprints.add(fingerprintOf(p));
          types.add(p.type);
        });
        attachInterceptor(page, bus);
        if (this.opts.attachGuard) await this.opts.attachGuard(page);

        await page.goto(url, { waitUntil: "load", timeout: 30000 }).catch(() => {});
        // Settle for hydration before replaying — the detection pass waits on the
        // `load` event plus a settle window, and a replay that clicks before React
        // attaches its handlers won't reproduce the crash (false "unreliable").
        await page.waitForTimeout(2000);
        if (opts?.targetType) collecting = true;
        await replayActions(page, actions);
        await page.waitForTimeout(300);

        const reproduced = opts?.targetType
          ? types.has(opts.targetType)
          : fingerprints.has(targetFingerprint);
        return { reproduced };
      } catch (e) {
        lastError = e;
        await this.close(); // drop the (possibly crashed) browser and retry fresh
      } finally {
        await page?.close().catch(() => {});
        await context?.close().catch(() => {});
      }
    }
    throw lastError;
  }

  async close(): Promise<void> {
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }
}
