import type { Browser, BrowserContext, Page } from "playwright";
import { EventBus } from "./eventBus.js";
import { launchChromium } from "./browser.js";
import { attachInterceptor } from "./interceptor.js";
import { fingerprintOf } from "./classifier.js";
import type { FindingType, RecordedAction } from "./types.js";
import type { StateSnapshot } from "./graph.js";

export interface ReplayEngineOptions {
  attachGuard?: (page: Page) => Promise<void>;
  /** Playwright storage-state JSON (path or object) for authenticated replays. */
  storageState?: string;
  /** State-Graph handoff: boot the replay INTO this state (cookies +
   * localStorage restored before the steps run), so bugs found in the
   * authed zone replay as the user who found them. */
  seedState?: StateSnapshot;
}

export interface ReplayResult {
  reproduced: boolean;
  /** Did the target page actually load? A navigation that was refused, timed out,
   * or answered non-2xx produces no telemetry — which is indistinguishable from
   * "the bug is gone" unless the caller can tell the two apart. Verification
   * depends on this: an unreachable page must never count as a passing run. */
  loaded: boolean;
}

/**
 * How long to let a freshly-navigated page settle before acting on it.
 *
 * The walker waits this long after its own `page.goto` before it touches
 * anything, so every recorded selector was resolved against a page that had
 * been given 300ms to render — a replay that clicks the instant the navigation
 * commits is asking for something the recording never was.
 *
 * Measured on a real Next.js app rather than guessed: with no settle, every
 * action after a `navigate` was skipped — `count()` does not wait, so an
 * element that is not in the DOM *yet* is indistinguishable from one that is
 * gone, and the skip is silent — and a bug that fires on every single click
 * came back `unreliable` 0/3. With 300ms it reproduced 3/3.
 */
const NAV_SETTLE_MS = 300;

/**
 * How long to keep watching after the last replayed action, for a bug whose
 * trigger is asynchronous. See the poll in `run` — it exits the moment the
 * fingerprint appears, so this is a ceiling, not a delay.
 */
const POST_REPLAY_WINDOW_MS = 1500;

/** Replays a recorded action sequence against a page. Best-effort: a selector
 * that no longer resolves is skipped, not fatal. */
export async function replayActions(page: Page, actions: RecordedAction[]): Promise<void> {
  for (const a of actions) {
    if (a.type === "navigate") {
      if (a.value) {
        // Already there: a trace can carry the same URL twice, and re-loading
        // the page it is already on costs a full load and resets its state.
        if (page.url() !== a.value) {
          await page.goto(a.value, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(NAV_SETTLE_MS);
        }
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

        // State-Graph handoff: restore the captured session BEFORE the steps
        // run — goto the origin first (so the cookie domain matches), then
        // cookies, then localStorage. A failure leaves the replay guest-mode;
        // it never aborts it.
        if (this.opts.seedState) {
          try {
            const origin = new URL(url).origin;
            await page
              .goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 15000 })
              .catch(() => {});
            if (this.opts.seedState.cookies.length > 0) {
              await context.addCookies(
                this.opts.seedState.cookies.map((c) => ({ ...c, url: origin }))
              );
            }
            await page.evaluate((ls) => {
              for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
            }, this.opts.seedState.localStorage);
          } catch {
            // best-effort — see above
          }
        }

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

        // A rejected navigation (refused connection, DNS failure, timeout) and a
        // non-2xx answer both leave a page that will never emit the telemetry we
        // are looking for. Capture that here rather than letting the empty
        // fingerprint set read as a passing verification.
        const nav = await page
          .goto(url, { waitUntil: "load", timeout: 30000 })
          .catch(() => null);
        const loaded = nav !== null && nav.ok();
        // Settle for hydration before replaying — the detection pass waits on the
        // `load` event plus a settle window, and a replay that clicks before React
        // attaches its handlers won't reproduce the crash (false "unreliable").
        await page.waitForTimeout(2000);
        if (opts?.targetType) collecting = true;
        await replayActions(page, actions);

        // An action can start work that throws later — a `fetch` behind a 300ms
        // mock, a promise chain, a state update that re-renders into the bug —
        // and the last action is not the last word. Waiting a fixed 300ms for
        // that measured *exactly* on the boundary of a real app's own 300ms
        // delay, so the same trace flipped between reproducing and not from one
        // run to the next.
        //
        // Poll instead of sleeping: a bug that fires during the replay returns
        // on the first check, so the window costs nothing where the verdict is
        // already decided, and only a trace that is going to be called
        // `unreliable` pays for the full wait — which is the case that must not
        // be wrong.
        const seen = (): boolean =>
          opts?.targetType ? types.has(opts.targetType) : fingerprints.has(targetFingerprint);
        const deadline = Date.now() + POST_REPLAY_WINDOW_MS;
        while (!seen() && Date.now() < deadline) await page.waitForTimeout(50);

        return { reproduced: seen(), loaded };
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
