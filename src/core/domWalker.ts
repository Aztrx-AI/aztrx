import type { Page } from "playwright";
import type { EventBus } from "./eventBus.js";
import type { RecordedAction } from "./types.js";
import { selectorCascade } from "./recorder.js";

// F6 guard-rail (part 1): never click anything that looks destructive. The
// full deny-list (config regexps, data-aztrx-skip) is a later pass.
export const DESTRUCTIVE = /(delete|remove|logout|sign\s?out|log\s?out|pay|checkout|submit\s?order|purchase|buy|удалить|оплатить|выйти|выход)/i;

export const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "tel", "url", "number", ""]);

export const SELECTOR = 'a, button, input, select, textarea, [role="button"], [onclick]';

export interface WalkOptions {
  maxActions?: number;
  dryRun?: boolean;
}

/**
 * F5-lite — discover interactive elements and act on them, tripping runtime
 * errors for the interceptor to catch. This is the deterministic "walk every
 * button" seed of the Chaos Fuzzer; rage-clicks, form fuzzing, and network
 * jitter come next.
 */
export async function walkDom(page: Page, bus: EventBus, opts: WalkOptions = {}): Promise<number> {
  const max = opts.maxActions ?? 100;
  const startUrl = page.url();
  const startOrigin = originOf(startUrl);
  let actions = 0;
  const visited = new Set<string>();
  const queue: string[] = [startUrl];

  // Breadth-first crawl: visit each internal page, walk its in-place controls
  // (buttons/inputs/selects), and queue any internal links it reveals. This finds
  // bugs on every route, not just the one you pointed at.
  while (queue.length > 0 && actions < max) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    if (page.url() !== url) {
      await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(300);
    }

    // Per-page "seen" set — the same button label on two pages is two targets.
    const seen = new Set<string>();
    let handles: Awaited<ReturnType<Page["$$"]>>;
    try {
      handles = await page.$$(SELECTOR);
    } catch {
      continue; // mid-navigation — the next queued URL is visited anyway
    }

    for (const handle of handles) {
      if (actions >= max) break;

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

      if (DESTRUCTIVE.test(label)) continue;

      if (tag === "a") {
        // Don't click links directly — queue internal ones for the crawl.
        const href = (await handle.getAttribute("href")) ?? "";
        if (href && !/^(javascript:|mailto:|tel:|#)/.test(href)) {
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

      if (tag === "input") {
        const type = (await handle.getAttribute("type")) ?? "";
        if (!TEXT_INPUT_TYPES.has(type)) continue; // skip password/hidden/submit/checkbox/etc.
      }

      const selectors = await selectorCascade(page, handle);
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

      // A click may navigate (e.g. a submit) — queue the new URL and stop this
      // page's walk; the queue visits it next.
      if (page.url() !== url) {
        const target = page.url().split("#")[0];
        if (target.startsWith(startOrigin) && !visited.has(target) && queue.length < 20) {
          queue.push(target);
        }
        break;
      }
    }
  }

  return actions;
}

export function originOf(url: string): string {
  return url.match(/^https?:\/\/[^/]+/)?.[0] ?? "";
}
