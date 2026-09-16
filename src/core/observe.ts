/**
 * Observer — a mission with no clicks. Discovers internal routes, navigates
 * to each by plain `goto`, and sits still while console errors, failed
 * requests and unhandled rejections flow through the interceptor into the
 * classifier. Long main-thread tasks (>200ms) are reported as noise so they
 * surface in the live panel without being dressed up as crashes.
 */

import type { Page } from "playwright";
import { EventBus } from "./eventBus.js";
import { originOf } from "./domWalker.js";

export interface ObserveOptions {
  /** Max routes to sit on (the budget). */
  maxRoutes?: number;
  /** How long to sit still on each route, ms — the window the app gets to misbehave. */
  settleMs?: number;
  dryRun?: boolean;
}

/** Internal links on the current page, deduped against `visited`. */
async function collectInternalLinks(
  page: Page,
  startOrigin: string,
  visited: Set<string>,
  queue: string[]
): Promise<void> {
  const hrefs = await page
    .evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? ""))
    .catch(() => [] as string[]);
  for (const href of hrefs) {
    if (!href || /^(javascript:|mailto:|tel:|#)/.test(href)) continue;
    try {
      const target = new URL(href, page.url()).href.split("#")[0];
      if (target.startsWith(startOrigin) && !visited.has(target) && queue.length < 20) {
        queue.push(target);
      }
    } catch {
      // unparseable href — ignore
    }
  }
}

/** Count of long tasks recorded on this page so far, or null if unsupported. */
async function longTaskCount(page: Page): Promise<number | null> {
  return page
    .evaluate(() => {
      const e = performance.getEntriesByType("longtask");
      return e.length > 0 ? e.length : null;
    })
    .catch(() => null);
}

export async function observe(
  page: Page,
  bus: EventBus,
  opts: ObserveOptions = {}
): Promise<{ actions: number; longTasks: number }> {
  const maxRoutes = opts.maxRoutes ?? 100;
  const settleMs = opts.settleMs ?? 2500;
  const startOrigin = originOf(page.url());
  const queue: string[] = [page.url()];
  const visited = new Set<string>();
  let routes = 0;
  let longTasksTotal = 0;

  while (queue.length > 0 && routes < maxRoutes) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    if (page.url() !== url) {
      await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(300);
    }
    bus.emit("route", { url, ts: Date.now() });

    // Sit still — the interceptor reports whatever rejects while we wait.
    await page.waitForTimeout(settleMs);

    const longTasks = await longTaskCount(page);
    if (longTasks !== null && longTasks > 0) {
      longTasksTotal += longTasks;
      bus.emit("noise", { ts: Date.now() });
    }

    await collectInternalLinks(page, startOrigin, visited, queue);
    routes++;
  }

  return { actions: routes, longTasks: longTasksTotal };
}
