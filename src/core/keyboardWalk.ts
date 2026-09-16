/**
 * Keyboard-only walk (power / a11y roles). Drives the page with Tab, Enter
 * and Escape — never a pointer. Tabs through the focusable elements of each
 * route, activates them with Enter, presses Escape afterwards in case a modal
 * opened, and types into text fields straight from the keyboard.
 *
 * Every key is recorded as a `keypress` action (focus selector + key), so the
 * replay drives the exact same keys back; text entry is recorded as an
 * `input` action because the replay fills it deterministically. Tab presses
 * are movement and do not spend the budget — activations do.
 */

import type { ElementHandle, Page } from "playwright";
import { EventBus } from "./eventBus.js";
import { selectorCascade } from "./recorder.js";
import { originOf } from "./domWalker.js";
import type { RecordedAction } from "./types.js";

const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"], [onclick]';

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "tel", "url", "number", ""]);

export interface KeyboardWalkOptions {
  maxActions?: number;
  dryRun?: boolean;
}

interface FocusInfo {
  tag: string;
  label: string;
  href: string;
  type: string;
}

async function readFocus(page: Page): Promise<{ handle: ElementHandle<SVGElement | HTMLElement> | null; info: FocusInfo | null }> {
  const js = await page.evaluateHandle(() => document.activeElement).catch(() => null);
  if (!js) return { handle: null, info: null };
  // `asElement` is synchronous in Playwright 1.62 and returns null when the
  // handle wraps null (e.g. document.activeElement on an empty page).
  const handle = js.asElement() as ElementHandle<SVGElement | HTMLElement> | null;
  if (!handle) return { handle: null, info: null };
  const info: FocusInfo | null = await handle
    .evaluate((el) => {
      const e = el as HTMLElement;
      return {
        tag: e.tagName.toLowerCase(),
        label: (
          e.innerText ||
          e.getAttribute("aria-label") ||
          e.getAttribute("value") ||
          e.getAttribute("placeholder") ||
          ""
        ).trim(),
        href: e.getAttribute("href") ?? "",
        type: e.getAttribute("type") ?? "",
      };
    })
    .catch(() => null);
  if (!info || info.tag === "body") return { handle: null, info: null };
  return { handle, info };
}

export async function keyboardWalk(
  page: Page,
  bus: EventBus,
  opts: KeyboardWalkOptions = {}
): Promise<{ actions: number; sawLoginForm: boolean }> {
  const max = opts.maxActions ?? 100;
  const startOrigin = originOf(page.url());
  const queue: string[] = [page.url()];
  const visited = new Set<string>();
  let actions = 0;
  let sawLoginForm = false;

  while (queue.length > 0 && actions < max) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    if (page.url() !== url) {
      await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(300);
    }

    // Reset focus to the document top so Tab starts from the first element.
    await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      if (a?.blur) a.blur();
    }).catch(() => {});

    // Per-route guards: max Tab presses, and a repeat-detector so a focus trap
    // (Tab cycles the same elements forever) doesn't burn the whole budget.
    const TAB_CAP = 60;
    let tabs = 0;
    let repeatStreak = 0;
    let lastFocusKey = "";

    while (tabs < TAB_CAP && actions < max) {
      const before = await readFocus(page);
      // Tab moves focus FROM this element — record its selectors so the replay
      // re-focuses it first and presses the same key.
      const tabSelectors = before.handle ? await selectorCascade(before.handle).catch(() => []) : [];
      const tab: RecordedAction = {
        type: "keypress",
        selectors: tabSelectors,
        value: "Tab",
        timestamp: Date.now(),
      };
      bus.emit("action", tab);
      if (!opts.dryRun) await page.keyboard.press("Tab").catch(() => {});
      await page.waitForTimeout(40);
      tabs++;

      const { handle, info } = await readFocus(page);
      if (!handle || !info) {
        // No focusable element left on this route — move on.
        break;
      }

      const focusKey = `${info.tag}|${info.label}`;
      repeatStreak = focusKey === lastFocusKey ? repeatStreak + 1 : 1;
      lastFocusKey = focusKey;
      if (repeatStreak > 3) break; // Tab is cycling the same element — a trap

      const selectors = await selectorCascade(handle);

      if (info.tag === "a") {
        // Don't activate links — queue internal ones for the crawl (same
        // policy as the pointer walker) and Tab on.
        if (info.href && !/^(javascript:|mailto:|tel:|#)/.test(info.href)) {
          try {
            const target = new URL(info.href, url).href.split("#")[0];
            if (target.startsWith(startOrigin) && !visited.has(target) && queue.length < 20) {
              queue.push(target);
            }
          } catch {
            // unparseable href — ignore
          }
        }
        continue;
      }

      if (info.tag === "input" && info.type === "password") {
        sawLoginForm = true;
        continue;
      }

      if ((info.tag === "input" && TEXT_INPUT_TYPES.has(info.type)) || info.tag === "textarea") {
        const fill: RecordedAction = { type: "input", selectors, value: "test", timestamp: Date.now() };
        bus.emit("action", fill);
        if (!opts.dryRun) await page.keyboard.type("test").catch(() => {});
        actions++;
        await page.waitForTimeout(120);
        // A submit-navigating input may have moved us — queue the new URL.
        if (page.url() !== url) {
          const target = page.url().split("#")[0];
          if (target.startsWith(startOrigin) && !visited.has(target) && queue.length < 20) queue.push(target);
          break;
        }
        continue;
      }

      // Buttons, [role=button], [onclick] — activate with Enter.
      const enter: RecordedAction = { type: "keypress", selectors, value: "Enter", timestamp: Date.now() };
      bus.emit("action", enter);
      if (!opts.dryRun) await page.keyboard.press("Enter").catch(() => {});
      actions++;
      await page.waitForTimeout(120);

      // Escape after every activation in case a modal opened; a no-op otherwise.
      const esc: RecordedAction = { type: "keypress", selectors, value: "Escape", timestamp: Date.now() };
      bus.emit("action", esc);
      if (!opts.dryRun) await page.keyboard.press("Escape").catch(() => {});

      if (page.url() !== url) {
        const target = page.url().split("#")[0];
        if (target.startsWith(startOrigin) && !visited.has(target) && queue.length < 20) queue.push(target);
        break;
      }
    }

    // Give in-flight async work a moment to reject before the next route.
    await page.waitForTimeout(500);
  }

  return { actions, sawLoginForm };
}
