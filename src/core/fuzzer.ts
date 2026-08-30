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

export interface FuzzResult {
  actions: number;
  /** JS code ranges executed for the first time during this run — a coverage
   * signal that this pass explored new code, not just re-clicked known paths. */
  newCoverage: number;
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

interface Actionable {
  handle: Awaited<ReturnType<Page["$$"]>>[number];
  tag: string;
  label: string;
}

/**
 * F5 — chaos fuzzer with coverage guidance. A seeded random walk (click/hover/
 * keypress/select/garbage input) that also reads V8 JS coverage and biases its
 * picks toward elements whose action previously uncovered new code — the same
 * "prefer the input that reaches new code" idea behind libFuzzer/AFL, applied to
 * the DOM. Returns how many brand-new JS ranges this pass executed.
 */
export async function fuzz(page: Page, bus: EventBus, opts: FuzzOptions = {}): Promise<FuzzResult> {
  const max = opts.maxActions ?? 100;
  const rnd = mulberry32(opts.seed ?? 42);
  const startUrl = page.url();
  let acted = 0;
  let newCoverage = 0;
  const seenRanges = new Set<string>();
  const interesting = new Set<string>(); // labels whose action uncovered new code

  try {
    await page.coverage.startJSCoverage();
  } catch {
    // coverage unsupported in this context — the fuzz still runs, just blind.
  }

  // Snapshot current JS coverage; returns the count of newly-seen ranges.
  const snapshot = async (): Promise<number> => {
    let fresh = 0;
    try {
      const entries = await page.coverage.stopJSCoverage();
      for (const e of entries) {
        const id = e.scriptId || e.url;
        for (const fn of e.functions) {
          for (const r of fn.ranges) {
            const key = `${id}:${r.startOffset}:${r.endOffset}`;
            if (!seenRanges.has(key)) {
              seenRanges.add(key);
              fresh++;
            }
          }
        }
      }
    } catch {
      // ignore
    }
    try {
      await page.coverage.startJSCoverage();
    } catch {
      // ignore
    }
    return fresh;
  };

  const recordCoverage = async (label: string): Promise<void> => {
    const fresh = await snapshot();
    if (fresh > 0) {
      newCoverage += fresh;
      if (label) interesting.add(label);
    }
  };

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
      await recordCoverage("");
      continue;
    }

    // Build the actionable list up front (skip destructive/external/non-text),
    // so coverage guidance can bias the pick before we act.
    const handles = await page.$$(SELECTOR);
    const actionable: Actionable[] = [];
    for (const h of handles) {
      const v = await h.isVisible().catch(() => false);
      const e = await h.isEnabled().catch(() => false);
      if (!v || !e) continue;

      let tag: string;
      try {
        tag = await h.evaluate((el) => el.tagName.toLowerCase());
      } catch {
        continue; // element detached/unreadable mid-query — skip
      }
      let label = "";
      try {
        label = await h.evaluate((el) => {
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
        const href = (await h.getAttribute("href")) ?? "";
        if (/^https?:\/\//.test(href) && !href.startsWith(originOf(startUrl))) continue;
      }

      if (tag === "input") {
        const type = (await h.getAttribute("type")) ?? "";
        if (!TEXT_INPUT_TYPES.has(type)) continue; // skip password/hidden/submit/checkbox/etc.
      }

      actionable.push({ handle: h, tag, label });
    }
    if (actionable.length === 0) break;

    // Coverage guidance: prefer elements that previously uncovered new code.
    const known = actionable.filter((a) => a.label && interesting.has(a.label));
    const chosen = known.length > 0 && rnd() < 0.5 ? pick(rnd, known) : pick(rnd, actionable);
    const { handle, tag, label } = chosen;
    const selectors = await selectorCascade(page, handle);
    const roll = rnd();
    let didAct = true;

    if (tag === "input" || tag === "textarea") {
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
    } else if (tag === "select") {
      let options: string[] = [];
      try {
        options = await handle.evaluate((el) =>
          Array.from((el as HTMLSelectElement).options).map((o) => o.value || o.textContent?.trim() || "")
        );
      } catch {
        didAct = false; // options unreadable — skip this select
      }
      if (didAct && options.length > 0) {
        const value = pick(rnd, options);
        const action: RecordedAction = { type: "select", selectors, value, timestamp: Date.now() };
        bus.emit("action", action);
        if (!opts.dryRun) await handle.selectOption(value).catch(() => {});
      } else {
        didAct = false;
      }
    } else if (roll < 0.55) {
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

    if (didAct) {
      acted++;
      await page.waitForTimeout(60);
      await recordCoverage(label);
    }
  }

  return { actions: acted, newCoverage };
}
