import type { Page } from "playwright";
import type { EventBus } from "./eventBus.js";
import type { RecordedAction } from "./types.js";
import { selectorCascade } from "./recorder.js";
import { mulberry32 } from "./rng.js";

// F6 guard-rail (part 1): never click anything that looks destructive. The
// full deny-list (config regexps, data-aztrx-skip) is a later pass.
export const DESTRUCTIVE = /(delete|remove|logout|sign\s?out|log\s?out|pay|checkout|submit\s?order|purchase|buy|удалить|оплатить|выйти|выход)/i;

export const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "tel", "url", "number", ""]);

export const SELECTOR = 'a, button, input, select, textarea, [role="button"], [onclick]';

export interface WalkOptions {
  maxActions?: number;
  dryRun?: boolean;
  /** Opt-in: include controls the deny-list skips (delete/pay/logout/checkout…).
   * Off by default — these can mutate real state, so they're refused unless the
   * caller explicitly accepts the risk. */
  allowDestructive?: boolean;
  /** Session-killer jitter: after each action, with this probability the page
   * reloads mid-flow and re-settles before the walk continues. The reload is
   * recorded as a `navigate` action so a repro replays it. */
  chaos?: { seed: number; chance: number };
}

/**
 * F5-lite — discover interactive elements and act on them, tripping runtime
 * errors for the interceptor to catch. This is the deterministic "walk every
 * button" seed of the Chaos Fuzzer; rage-clicks, form fuzzing, and network
 * jitter come next.
 */
export async function walkDom(
  page: Page,
  bus: EventBus,
  opts: WalkOptions = {},
): Promise<{ actions: number; sawLoginForm: boolean }> {
  const max = opts.maxActions ?? 100;
  const startUrl = page.url();
  const startOrigin = originOf(startUrl);
  const rnd = mulberry32(opts.chaos?.seed ?? 42);
  let actions = 0;
  let sawLoginForm = false;
  const visited = new Set<string>();
  const queue: string[] = [startUrl];

  // Breadth-first crawl: visit each internal page, walk its in-place controls
  // (buttons/inputs/selects), and queue any internal links it reveals. This finds
  // bugs on every route, not just the one you pointed at.
  while (queue.length > 0 && actions < max) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    if (!samePage(page.url(), url)) {
      await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(300);
    }

    // Per-page "seen" set — the same button label on two pages is two targets.
    const seen = new Set<string>();

    // Two passes: buttons/inputs first, links second. Links navigate (and
    // SPA hash links re-render in place), so clicking them first starved the
    // walker: the first nav link broke the page loop and the in-place
    // controls — the ones that actually trip bugs — were never touched.
    //
    // After every successful action the page is RESCANNED from the top:
    // React re-renders the DOM on setState, so handles captured before the
    // click point at dead elements and the walk would stall after the first
    // button. `seen` (keyed by selector cascade) prevents repeats.
    for (let pass = 0; pass < 2; pass++) {
      let handles: Awaited<ReturnType<Page["$$"]>> = [];
      try {
        handles = await page.$$(SELECTOR);
      } catch {
        continue; // mid-navigation — the next queued URL is visited anyway
      }
      let hi = 0;
      let navigated = false;
      while (hi < handles.length && actions < max && !navigated) {
        const handle = handles[hi];
        hi++;

        const visible = await handle.isVisible().catch(() => false);
        const enabled = await handle.isEnabled().catch(() => false);
        if (!visible || !enabled) continue;

        let tag: string;
        try {
          tag = await handle.evaluate((el) => el.tagName.toLowerCase());
        } catch {
          continue; // element unreadable mid-query — skip
        }
        let label = "";
        try {
          label = await handle.evaluate((el) => {
            const t =
              (el as HTMLElement).innerText ||
              el.getAttribute("aria-label") ||
              el.getAttribute("value") ||
              el.getAttribute("placeholder") ||
              "";
            return t.trim();
          });
        } catch {
          label = ""; // degraded — no label to filter on
        }

        if (!opts.allowDestructive && DESTRUCTIVE.test(label)) continue;

        if (tag === "a") {
          if (pass === 0) continue; // links wait for the second pass
          const href = (await handle.getAttribute("href")) ?? "";
          // SPA hash links (#/admin) change the page without a document
          // navigation — click them in place, then queue the new URL (WITH its
          // hash) as its own crawl page. Treating `#…` as "not a link" made
          // every hash-routed SPA invisible to the walker.
          if (href.startsWith("#")) {
            const selectors = await selectorCascade(handle);
            const signature = selectors.join("|") || `a:${label}`;
            if (seen.has(signature)) continue;
            seen.add(signature);
            const action: RecordedAction = { type: "click", selectors, timestamp: Date.now() };
            bus.emit("action", action);
            if (!opts.dryRun) await handle.click({ timeout: 1500 }).catch(() => {});
            actions++;
            await page.waitForTimeout(120);
            if (page.url() !== url && !visited.has(page.url()) && queue.length < 20) {
              queue.push(page.url());
              navigated = true;
            }
            // The SPA re-rendered either way — rescan (seen guards repeats),
            // or the rest of this pass walks dead handles.
            try {
              handles = await page.$$(SELECTOR);
              hi = 0;
            } catch {
              navigated = true;
            }
            continue;
          }
          // Don't click regular links directly — queue internal ones for the crawl.
          if (href && !/^(javascript:|mailto:|tel:)/.test(href)) {
            try {
              const target = new URL(href, url).href.split("#")[0];
              if (target.startsWith(startOrigin) && !visited.has(target) && queue.length < 20) {
                queue.push(target);
              }
            } catch {
              // unparseable href — ignore
            }
          }
          continue;
        }

        if (pass === 1) continue; // second pass handles links only

        if (tag === "input") {
          const type = (await handle.getAttribute("type")) ?? "";
          if (type === "password") sawLoginForm = true;
          if (!TEXT_INPUT_TYPES.has(type)) continue; // skip password/hidden/submit/checkbox/etc.
        }

        const selectors = await selectorCascade(handle);
        const signature = selectors.join("|") || `${tag}:${label}`;
        if (seen.has(signature)) continue; // already acted on this element
        seen.add(signature);

        if (tag === "input" || tag === "textarea") {
          const action: RecordedAction = { type: "input", selectors, value: "test", timestamp: Date.now() };
          bus.emit("action", action);
          if (!opts.dryRun) await handle.fill("test").catch(() => {});
        } else {
          const action: RecordedAction = { type: "click", selectors, timestamp: Date.now() };
          bus.emit("action", action);
          if (!opts.dryRun) await handle.click({ timeout: 1500 }).catch(() => {});
        }

        actions++;
        await page.waitForTimeout(120);

        // Session-killer jitter: reload mid-flow with the configured probability,
        // recorded as a navigate action so the repro replays the reload too.
        if (opts.chaos && rnd() < opts.chaos.chance) {
          const reload: RecordedAction = { type: "navigate", selectors: [], value: page.url(), timestamp: Date.now() };
          bus.emit("action", reload);
          if (!opts.dryRun) {
            await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(500);
          }
        }

        // A click may navigate (e.g. a submit, or an SPA hash-route change) —
        // queue the new URL (hash included — it is its own crawl page) and stop
        // this page's walk; the queue visits it next.
        if (page.url() !== url) {
          const next = page.url();
          const base = next.split("#")[0];
          if (!visited.has(next) && queue.length < 20) {
            queue.push(next);
          } else if (base.startsWith(startOrigin) && !visited.has(base) && queue.length < 20) {
            queue.push(base);
          }
          navigated = true;
          continue;
        }

        // No navigation, but the action may have re-rendered the DOM (React
        // setState) — rescan from the top for the next element. `seen` keeps
        // the already-acted controls out of the way.
        try {
          handles = await page.$$(SELECTOR);
          hi = 0;
        } catch {
          navigated = true; // mid-navigation after all — bail out safely
        }
      }
      if (navigated) break; // leave the pass loop; the queued page is next
    }

    // Give in-flight async work (fetches, timers) a moment to reject before we
    // navigate to the next crawled page — otherwise a 300ms-later throw is lost.
    await page.waitForTimeout(500);
  }

  return { actions, sawLoginForm };
}

export function originOf(url: string): string {
  return url.match(/^https?:\/\/[^/]+/)?.[0] ?? "";
}

/**
 * Are these two strings the same page? Compared as parsed URLs, not as text,
 * because the browser normalises what the crawler was handed: a run against
 * `http://localhost:3000` has `page.url() === "http://localhost:3000/"`, so a
 * raw string compare says "different" and the walk re-loads the start page it
 * is already sitting on — once per run, re-firing every mount effect for
 * nothing. `new URL(x).href` puts both sides in the browser's own spelling.
 */
function samePage(current: string, target: string): boolean {
  try {
    return new URL(current).href === new URL(target).href;
  } catch {
    return current === target; // about:blank, or an unparseable href
  }
}
