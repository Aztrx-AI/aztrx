/**
 * The Mapper — a state-aware crawler. Where domWalker flattens the app into
 * "every button on every route", the Mapper models it as a finite state
 * machine: it loads a page, snapshots its state (URL + localStorage + cookies
 * + risk markers in the DOM), and treats every state change — including a
 * token appearing with the URL unchanged (SPA navigation) — as a new StateNode.
 *
 * Exploration is driven by the StateGraph's PriorityQueue: actions whose
 * labels smell of business risk (Login, Checkout, Admin…) go first.
 */

import type { ElementHandle, Page } from "playwright";
import { selectorCascade } from "./recorder.js";
import { DESTRUCTIVE } from "./domWalker.js";
import { PriorityQueue, StateGraph, riskWeight, stateWeight } from "./graph.js";
import type { EdgeAction, StateSnapshot } from "./graph.js";

export interface MapperOptions {
  /** Max states to explore (default 20). */
  maxStates?: number;
  /** Max interactive elements acted on per state (default 8). */
  maxActionsPerState?: number;
  /** Report the actions without performing them. */
  dryRun?: boolean;
  log?: (msg: string) => void;
}

const INTERACTIVE =
  'button, [role="button"], input[type="submit"], a[href], [onclick]';

/** The full state snapshot of the current page. */
export async function captureState(page: Page): Promise<StateSnapshot> {
  const url = page.url();

  const ls: Record<string, string> = await page
    .evaluate(() => {
      const out: Record<string, string> = {};
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k) out[k] = window.localStorage.getItem(k) ?? "";
        }
      } catch {
        // storage disabled (about:blank, sandboxed frame) — not a failure
      }
      return out;
    })
    .catch(() => ({}));

  const cookies = await page.context().cookies().catch(() => []);

  // Risk markers: the business-risk words actually present in the DOM.
  const domMarkers: string[] = await page
    .evaluate(() => {
      const words = ["login", "checkout", "admin", "pay", "token", "auth", "delete"];
      const text = document.body?.innerText ?? "";
      const lower = text.toLowerCase();
      return words.filter((w) => lower.includes(w)).slice(0, 12);
    })
    .catch(() => []);

  return { url, localStorage: ls, cookies, domMarkers };
}

interface Candidate {
  from: import("./graph.js").StateNode;
  action: EdgeAction;
}

/** The interactive elements of the current page, as unexplored candidates. */
async function discoverCandidates(
  page: Page,
  from: import("./graph.js").StateNode,
  limit: number,
  startOrigin: string
): Promise<Candidate[]> {
  let handles: Awaited<ReturnType<Page["$$"]>>;
  try {
    handles = await page.$$(INTERACTIVE);
  } catch {
    return [];
  }

  const candidates: Candidate[] = [];
  for (const handle of handles) {
    if (candidates.length >= limit) break;

    const visible = await handle.isVisible().catch(() => false);
    if (!visible) continue;

    const info = await handle
      .evaluate((el) => {
        const e = el as HTMLElement;
        return {
          tag: e.tagName.toLowerCase(),
          label: (
            e.innerText ||
            e.getAttribute("aria-label") ||
            e.getAttribute("value") ||
            ""
          ).trim(),
          href: e.getAttribute("href") ?? "",
        };
      })
      .catch(() => null);
    if (!info || !info.label) continue;

    if (DESTRUCTIVE.test(info.label)) continue; // same deny-list as the walker

    const selectors = await selectorCascade(handle as ElementHandle<SVGElement | HTMLElement>);

    if (info.tag === "a" && info.href) {
      if (/^(javascript:|mailto:|tel:|#)/.test(info.href)) continue;
      try {
        const target = new URL(info.href, page.url()).href.split("#")[0];
        if (!target.startsWith(startOrigin)) continue; // same-origin only
        candidates.push({
          from,
          action: { type: "navigate", label: `open "${info.label}"`, selectors: [target] },
        });
      } catch {
        continue;
      }
    } else if (info.tag === "input") {
      candidates.push({
        from,
        action: { type: "submit", label: `submit "${info.label}"`, selectors },
      });
    } else {
      candidates.push({
        from,
        action: { type: "click", label: `click "${info.label}"`, selectors },
      });
    }
  }
  return candidates;
}

/** Perform one action against the live page. */
async function perform(page: Page, action: EdgeAction, dryRun: boolean, log?: (m: string) => void): Promise<void> {
  if (dryRun) return;
  log?.(`   ↳ ${action.label}`);
  if (action.type === "navigate") {
    await page.goto(action.selectors[0], { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    return;
  }
  const loc = page.locator(action.selectors[0]).first();
  if (action.type === "submit") {
    await loc.click({ timeout: 3000 }).catch(() => {});
  } else {
    await loc.click({ timeout: 3000 }).catch(() => {});
  }
  // Let SPA state settle — the next snapshot must see the new state, not the
  // half-updated one.
  await page.waitForTimeout(700);
}

/**
 * Explore the app from `startUrl` and return the state graph. The queue is
 * the PriorityQueue: risky states and risky actions surface first, so the
 * login → admin path is walked before the "About" page.
 */
export async function buildStateGraph(
  page: Page,
  startUrl: string,
  opts: MapperOptions = {}
): Promise<StateGraph> {
  const maxStates = opts.maxStates ?? 20;
  const maxActions = opts.maxActionsPerState ?? 8;
  const graph = new StateGraph();
  const queue = new PriorityQueue<Candidate>();
  const startOrigin = new URL(startUrl).origin;
  const scheduled = new Set<string>();
  const acted = new Set<string>();

  const scheduleNode = async (node: import("./graph.js").StateNode): Promise<void> => {
    const candidates = await discoverCandidates(page, node, maxActions, startOrigin);
    for (const c of candidates) {
      // The edge weight: the state's risk minus the action label's own risk —
      // `click "Login"` beats `click "About"` even from the same state.
      const w = Math.max(1, stateWeight(node.snapshot) - riskWeight(c.action.label) * 2);
      const key = `${node.id}|${c.action.label}`;
      if (scheduled.has(key)) continue;
      scheduled.add(key);
      queue.push(c, w);
    }
  };

  const root = graph.addState(await captureState(page));
  opts.log?.(`root: ${root.snapshot.url} (w=${root.weight})`);
  await scheduleNode(root);

  while (queue.size > 0 && graph.size < maxStates) {
    const entry = queue.pop()!;
    const { from, action } = entry.item;
    const key = `${from.id}|${action.label}`;
    if (acted.has(key)) continue;
    acted.add(key);

    // The action must run FROM its state — restore it if the page drifted
    // (a previous navigate moved us elsewhere).
    if (page.url() !== from.snapshot.url) {
      await page.goto(from.snapshot.url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(400);
    }

    await perform(page, action, Boolean(opts.dryRun), opts.log);

    const snapshot = await captureState(page);
    const to = graph.addState(snapshot);
    if (to !== from) {
      graph.addEdge(from, to, action);
      opts.log?.(`state: ${to.snapshot.url} ${Object.keys(to.snapshot.localStorage).length ? "🔑" : ""} (w=${to.weight}) — via ${action.label}`);
      await scheduleNode(to);
    } else {
      opts.log?.(`no state change from: ${action.label}`);
    }
  }

  return graph;
}
