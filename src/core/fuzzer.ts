import type { Page } from "playwright";
import type { EventBus } from "./eventBus.js";
import type { RecordedAction } from "./types.js";
import { selectorCascade } from "./recorder.js";
import { SELECTOR, DESTRUCTIVE, TEXT_INPUT_TYPES, originOf } from "./domWalker.js";
import { mulberry32 } from "./rng.js";

export interface FuzzOptions {
  seed?: number;
  maxActions?: number;
  dryRun?: boolean;
}

const GARBAGE = [
  "<script>alert(1)</script>",
  "'; DROP TABLE users;--",
  "a".repeat(4096),
  "字".repeat(64),
  String.fromCharCode(0) + "null-byte",
  "NaN",
  "-1",
  "0",
  "99999999999999999999",
  "\n\t\r  whitespace",
  "\"'`${}[]()",
  "undefined",
];

// Keys most likely to trip state-dependent bugs: Enter submits, Escape closes
// modals, Backspace/Tab mutate focused fields, arrows scroll/select.
const KEYS = ["Enter", "Escape", "Backspace", "Tab", "ArrowDown", "ArrowUp", " ", "Delete"];

function pick<T>(rnd: () => number, arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}

/**
 * F5 — chaos fuzzer. Seeded random walk with a richer vocabulary than the
 * deterministic walk: clicks (occasionally doubled), hover, keypresses, select
 * option changes, scrolls, and garbage-filled text inputs — tripping runtime
 * errors for the interceptor. Skips anything the destructive deny-list flags,
 * and never follows off-origin links.
 */
export async function fuzz(page: Page, bus: EventBus, opts: FuzzOptions = {}): Promise<number> {
  const max = opts.maxActions ?? 100;
  const rnd = mulberry32(opts.seed ?? 42);
  const startUrl = page.url();
  let acted = 0;

  for (let i = 0; i < max; i++) {
    if (page.url() !== startUrl) {
      await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    }

    // Occasional page-level scroll — reaches lazy-loaded / intersection-gated UI.
    if (rnd() < 0.08) {
      const dir = rnd() < 0.5 ? "up" : "down";
      const action: RecordedAction = { type: "scroll", selectors: [], value: dir, timestamp: Date.now() };
      bus.emit("action", action);
      if (!opts.dryRun) await page.mouse.wheel(0, dir === "up" ? -600 : 600).catch(() => {});
      acted++;
      await page.waitForTimeout(40);
      continue;
    }

    const handles = await page.$$(SELECTOR);
    const visible: typeof handles[number][] = [];
    for (const h of handles) {
      const v = await h.isVisible().catch(() => false);
      const e = await h.isEnabled().catch(() => false);
      if (v && e) visible.push(h);
    }
    if (visible.length === 0) break;

    const handle = pick(rnd, visible);

    let tag: string;
    try {
      tag = await handle.evaluate((el) => el.tagName.toLowerCase());
    } catch {
      continue; // element detached/unreadable mid-query — skip
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

    // Text inputs — mostly pour garbage in, sometimes hit keys or hover.
    if (tag === "input" || tag === "textarea") {
      const type = (await handle.getAttribute("type")) ?? "";
      if (!TEXT_INPUT_TYPES.has(type)) continue;
      const selectors = await selectorCascade(page, handle);
      const roll = rnd();

      if (roll < 0.6) {
        const value = pick(rnd, GARBAGE);
        const action: RecordedAction = { type: "input", selectors, value, timestamp: Date.now() };
        bus.emit("action", action);
        if (!opts.dryRun) await handle.fill(value).catch(() => {});
      } else if (roll < 0.85) {
        const key = pick(rnd, KEYS);
        const action: RecordedAction = { type: "keypress", selectors, value: key, timestamp: Date.now() };
        bus.emit("action", action);
        if (!opts.dryRun) {
          await handle.focus().catch(() => {});
          await page.keyboard.press(key).catch(() => {});
        }
      } else {
        const action: RecordedAction = { type: "hover", selectors, timestamp: Date.now() };
        bus.emit("action", action);
        if (!opts.dryRun) await handle.hover().catch(() => {});
      }

      acted++;
      await page.waitForTimeout(60);
      continue;
    }

    // Select — actually change the option, a common source of state bugs.
    if (tag === "select") {
      let options: string[] = [];
      try {
        options = await handle.evaluate((el) =>
          Array.from((el as HTMLSelectElement).options).map((o) => o.value || o.textContent?.trim() || "")
        );
      } catch {
        continue; // options unreadable — skip this select
      }
      if (options.length > 0) {
        const value = pick(rnd, options);
        const selectors = await selectorCascade(page, handle);
        const action: RecordedAction = { type: "select", selectors, value, timestamp: Date.now() };
        bus.emit("action", action);
        if (!opts.dryRun) await handle.selectOption(value).catch(() => {});
        acted++;
        await page.waitForTimeout(60);
      }
      continue;
    }

    // Clickable — mostly click, otherwise hover or keyboard-navigate.
    const selectors = await selectorCascade(page, handle);
    const roll = rnd();

    if (roll < 0.55) {
      const action: RecordedAction = { type: "click", selectors, timestamp: Date.now() };
      bus.emit("action", action);
      if (!opts.dryRun) {
        await handle.click({ timeout: 1000 }).catch(() => {});
        if (rnd() < 0.15) await handle.click({ timeout: 1000 }).catch(() => {}); // double-click
      }
    } else if (roll < 0.85) {
      const action: RecordedAction = { type: "hover", selectors, timestamp: Date.now() };
      bus.emit("action", action);
      if (!opts.dryRun) await handle.hover().catch(() => {});
    } else {
      const key = pick(rnd, KEYS);
      const action: RecordedAction = { type: "keypress", selectors, value: key, timestamp: Date.now() };
      bus.emit("action", action);
      if (!opts.dryRun) {
        await handle.focus().catch(() => {});
        await page.keyboard.press(key).catch(() => {});
      }
    }

    acted++;
    await page.waitForTimeout(60);
  }

  return acted;
}
