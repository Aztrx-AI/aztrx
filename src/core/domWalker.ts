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

  const handles = await page.$$(SELECTOR);
  for (const handle of handles) {
    if (actions >= max) break;
    if (page.url() !== startUrl) break; // navigated — bail this pass

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
  }

  return actions;
}

export function originOf(url: string): string {
  return url.match(/^https?:\/\/[^/]+/)?.[0] ?? "";
}
