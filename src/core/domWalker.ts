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
  let actions = 0;
  const seen = new Set<string>();

  // Re-scan the DOM after every action (the page may have mutated or navigated)
  // rather than walking a stale snapshot. Mirrors the fuzzer's recover-and-iterate
  // loop, but deterministically (document order) and without re-clicking elements
  // it has already acted on.
  while (actions < max) {
    if (page.url() !== startUrl) {
      // A previous action navigated away — return to the starting page.
      await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(300);
    }

    let handles: Awaited<ReturnType<Page["$$"]>>;
    try {
      handles = await page.$$(SELECTOR);
    } catch {
      // A navigation raced the re-scan — reset to the start page and retry.
      await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(300);
      continue;
    }
    let acted = false;

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
        const href = (await handle.getAttribute("href")) ?? "";
        if (/^https?:\/\//.test(href) && !href.startsWith(originOf(startUrl))) continue;
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
      acted = true;
      await page.waitForTimeout(120);
      break; // re-scan next iteration — the DOM may have changed
    }

    if (!acted) break; // nothing left to act on
  }

  return actions;
}

export function originOf(url: string): string {
  return url.match(/^https?:\/\/[^/]+/)?.[0] ?? "";
}
