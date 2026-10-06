/**
 * Stages 3 and 5-6 against a live page, one driver per plan family.
 *
 * A driver *binds* the plan's variables to things the page actually has, then
 * *drives* each planned state and reports what the page showed before and
 * after. It never judges: the verdict comes from `evaluateInvariant` in
 * `runtime.ts`, the same for every family.
 *
 * Binding is by the vocabulary the evidence itself used. A rule about
 * `cart.total` binds to a control whose id/name/label says "total"; a state
 * machine binds to the one element on the page that shows one of the machine's
 * own state names, and to the controls named like its events. If a name
 * matches nothing, or matches ambiguously, the candidate stops at "binding"
 * and is never guessed onto a nearby control.
 */

import type { Page } from "playwright";
import type { ExecutedAction, ObservedState } from "../invariant.js";
import type {
  ExperimentPlan,
  InvariantCandidate,
  NumericBoundaryPlan,
  PlannedState,
  StateTransitionPlan,
} from "./types.js";

export interface Run {
  before: ObservedState;
  after: ObservedState;
  actions: ExecutedAction[];
}

export interface Failed {
  failed: string;
}

export interface Session {
  /** Drive one planned state and report what the page showed. */
  drive(st: PlannedState): Promise<Run | Failed>;
  /** One sentence naming what was observed in a violating run. */
  explain(st: PlannedState, run: Run): string;
  /** Leave the page as the experiment found it, where that is possible. */
  restore(): Promise<void>;
}

export interface Unbound {
  reason: string;
}

export type Binder = (page: Page, c: InvariantCandidate, plan: ExperimentPlan) => Promise<Session | Unbound>;

// ---- numeric-boundary ------------------------------------------------------

interface Located {
  found: boolean;
  reason?: string;
  value?: number | null;
}

/** Runs in the page. Locates a control or readout for an identifier and, for
 * inputs, tags it so Playwright can address it. */
async function locateField(page: Page, field: string, kind: "input" | "output"): Promise<Located> {
  return page
    .evaluate(
      ({ field, kind }) => {
        const norm = (s: string) =>
          s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const want = norm(field);
        const rank = (idents: string[]): number => {
          let best = 0;
          for (const raw of idents) {
            const v = norm(raw);
            if (!v) continue;
            if (v === want) best = Math.max(best, 2);
            else if ((" " + v + " ").includes(" " + want + " ")) best = Math.max(best, 1);
          }
          return best;
        };
        const idents = (el: Element): string[] => {
          const out = [
            el.id,
            el.getAttribute("name") ?? "",
            el.getAttribute("data-testid") ?? "",
            el.getAttribute("data-field") ?? "",
            el.getAttribute("aria-label") ?? "",
            el.getAttribute("placeholder") ?? "",
          ];
          if (el.id) {
            for (const l of document.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]')) {
              out.push((l as HTMLElement).innerText ?? "");
            }
          }
          const wrap = el.closest("label");
          if (wrap) out.push((wrap as HTMLElement).innerText ?? "");
          return out;
        };
        const num = (t: string): number | null => {
          const m = t.replace(/ /g, " ").match(/-?\d[\d,]*(?:\.\d+)?/);
          return m ? Number(m[0].replace(/,/g, "")) : null;
        };

        if (kind === "input") {
          const sel =
            "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea";
          const els = Array.from(document.querySelectorAll(sel));
          const scored = els.map((el) => ({ el, r: rank(idents(el)) })).filter((x) => x.r > 0);
          if (scored.length === 0) return { found: false, reason: 'no input is named like "' + field + '"' };
          const top = Math.max(...scored.map((x) => x.r));
          const best = scored.filter((x) => x.r === top);
          if (best.length !== 1) return { found: false, reason: best.length + ' inputs match "' + field + '" equally' };
          document.querySelectorAll("[data-aztrx-field]").forEach((e) => e.removeAttribute("data-aztrx-field"));
          best[0].el.setAttribute("data-aztrx-field", field);
          return { found: true, value: num((best[0].el as HTMLInputElement).value) };
        }

        const skip = "input, textarea, script, style, button, select, option";
        const els = Array.from(document.querySelectorAll("[id], [data-testid], [data-field], [name], output")).filter(
          (e) => !e.matches(skip)
        );
        const scored = els
          .map((el) => ({ el, r: rank(idents(el)), text: ((el as HTMLElement).innerText ?? el.textContent ?? "").trim() }))
          .filter((x) => x.r > 0 && num(x.text) !== null);
        if (scored.length > 0) {
          const top = Math.max(...scored.map((x) => x.r));
          const best = scored.filter((x) => x.r === top);
          // Nested matches (a wrapper and the value inside it) read the same figure.
          const figures = new Set(best.map((x) => num(x.text)));
          if (figures.size === 1) return { found: true, value: num(best[0].text) };
          return { found: false, reason: best.length + ' readouts match "' + field + '" with different figures' };
        }
        // Fallback: a "Shipping: $5.99" style line in the visible text.
        const body = document.body?.innerText ?? "";
        const words = want.split(" ").join("[\\s_-]*");
        const m = new RegExp(words + "[^\\d\\n-]{0,24}(-?\\$?\\s?\\d[\\d,]*(?:\\.\\d+)?)", "i").exec(body);
        if (m) return { found: true, value: num(m[1]) };
        return { found: false, reason: 'no readout is named like "' + field + '"' };
      },
      { field, kind }
    )
    .catch(() => ({ found: false, reason: "page evaluation failed" }) as Located);
}

/** Read the readout until it stops moving: a debounced or server-backed
 * update must land before it counts as "what the page shows". */
async function settledReading(page: Page, field: string): Promise<number | null> {
  const started = Date.now();
  let last: number | null | undefined;
  let stable = 0;
  while (Date.now() - started < 2500) {
    await page.waitForTimeout(100);
    const r = await locateField(page, field, "output");
    const v = r.found ? (r.value ?? null) : null;
    stable = v === last ? stable + 1 : 0;
    last = v;
    if (stable >= 3 && Date.now() - started >= 400) break;
  }
  return last ?? null;
}

async function currentOutput(page: Page, field: string): Promise<number | null> {
  const r = await locateField(page, field, "output");
  return r.found ? (r.value ?? null) : null;
}

async function driveNumeric(page: Page, variable: string, target: string, value: number, label: string): Promise<Run | Failed> {
  const input = page.locator('[data-aztrx-field="' + variable + '"]');
  const initialOutput = await currentOutput(page, target);
  try {
    await input.fill(String(value), { timeout: 3000 });
    await input.evaluate((el) => {
      el.dispatchEvent(new Event("change", { bubbles: true }));
      (el as HTMLElement).blur();
    });
  } catch {
    return { failed: "could not set the input" };
  }
  const readBack = Number(await input.inputValue().catch(() => "NaN"));
  const outcome = await settledReading(page, target);

  const before: ObservedState = {
    url: page.url(),
    flags: { [variable]: readBack, ...(initialOutput !== null ? { [target]: initialOutput } : {}) },
  };
  const after: ObservedState = {
    url: page.url(),
    flags: { [variable]: readBack, ...(outcome !== null ? { [target]: outcome } : {}) },
  };
  return { before, after, actions: [{ kind: "setInput", target: variable, detail: label + ": " + variable + "=" + value }] };
}

export const bindNumericBoundary: Binder = async (page, c, rawPlan) => {
  const plan = rawPlan as NumericBoundaryPlan;
  const variable = plan.variable.field;
  const target = c.expectation[0];

  const inBind = await locateField(page, variable, "input");
  if (!inBind.found) return { reason: inBind.reason ?? "input not found" };
  const outBind = await locateField(page, target.field, "output");
  if (!outBind.found) return { reason: outBind.reason ?? "readout not found" };
  const initialInput = inBind.value;

  return {
    drive: (st) => driveNumeric(page, variable, target.field, st.assign[variable] as number, st.label),
    explain: (st, run) =>
      "At " + variable + "=" + run.after.flags?.[variable] + " (" + st.label + ") the page shows " + target.field + "=" +
      run.after.flags?.[target.field] + ", expected " + target.field + " " + target.op + " " + target.value,
    restore: async () => {
      if (initialInput === null || initialInput === undefined) return;
      await page
        .locator('[data-aztrx-field="' + variable + '"]')
        .fill(String(initialInput))
        .catch(() => {});
    },
  };
};

// ---- state-transition ------------------------------------------------------

const normName = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

interface StateReading {
  found: boolean;
  /** Canonical state name as the evidence spelled it. */
  state?: string;
  reason?: string;
}

/** Runs in the page. The state readout is whichever visible, non-interactive
 * element's text *is* one of the machine's own state names (optionally after a
 * `Label:` prefix). Elements showing different states at once make the
 * binding ambiguous — a legend or a list of orders is not one entity's state. */
async function readState(page: Page, states: string[]): Promise<StateReading> {
  return page
    .evaluate((states) => {
      const norm = (s: string) =>
        s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const byNorm = new Map(states.map((s) => [norm(s), s]));
      const interactive = "button, a, input, select, option, textarea, label, script, style, [role=button]";
      const seen = new Set<string>();
      for (const el of Array.from(document.body?.querySelectorAll("*") ?? [])) {
        if (el.matches(interactive) || el.closest("button, a, [role=button]")) continue;
        if (el.getClientRects().length === 0) continue;
        const text = ((el as HTMLElement).innerText ?? "").trim();
        if (!text || text.length > 80) continue;
        const tail = text.includes(":") ? text.slice(text.lastIndexOf(":") + 1) : text;
        const hit = byNorm.get(norm(tail));
        if (hit !== undefined) seen.add(hit);
      }
      if (seen.size === 1) return { found: true, state: [...seen][0] };
      if (seen.size === 0) return { found: false, reason: "nothing on the page shows one of the machine's states" };
      return { found: false, reason: "the page shows several of the machine's states at once: " + [...seen].join(", ") };
    }, states)
    .catch(() => ({ found: false, reason: "page evaluation failed" }) as StateReading);
}

async function settledState(page: Page, states: string[]): Promise<string | null> {
  await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
  const started = Date.now();
  let last: string | null | undefined;
  let stable = 0;
  while (Date.now() - started < 3000) {
    await page.waitForTimeout(100);
    const r = await readState(page, states);
    const v = r.found ? (r.state ?? null) : null;
    stable = v === last ? stable + 1 : 0;
    last = v;
    if (stable >= 4 && Date.now() - started >= 600) break;
  }
  return last ?? null;
}

/** Tags the one visible control named like `event` so it can be clicked. */
async function locateAction(page: Page, event: string): Promise<{ found: boolean; reason?: string }> {
  return page
    .evaluate((event) => {
      const norm = (s: string) =>
        s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const want = norm(event);
      const rank = (idents: string[]): number => {
        let best = 0;
        for (const raw of idents) {
          const v = norm(raw);
          if (!v) continue;
          if (v === want) best = Math.max(best, 2);
          else if ((" " + v + " ").includes(" " + want + " ")) best = Math.max(best, 1);
        }
        return best;
      };
      const controls = Array.from(
        document.querySelectorAll("button, [role=button], a[href], input[type=submit], input[type=button]")
      ).filter((el) => el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled);
      const scored = controls
        .map((el) => ({
          el,
          r: rank([
            el.id,
            el.getAttribute("name") ?? "",
            el.getAttribute("data-testid") ?? "",
            el.getAttribute("data-action") ?? "",
            el.getAttribute("aria-label") ?? "",
            el.getAttribute("title") ?? "",
            (el as HTMLInputElement).value ?? "",
            (el as HTMLElement).innerText ?? "",
          ]),
        }))
        .filter((x) => x.r > 0);
      if (scored.length === 0) return { found: false, reason: 'no control is named like "' + event + '"' };
      const top = Math.max(...scored.map((x) => x.r));
      const best = scored.filter((x) => x.r === top);
      if (best.length !== 1) return { found: false, reason: best.length + ' controls match "' + event + '" equally' };
      document.querySelectorAll("[data-aztrx-action]").forEach((e) => e.removeAttribute("data-aztrx-action"));
      best[0].el.setAttribute("data-aztrx-action", event);
      return { found: true };
    }, event)
    .catch(() => ({ found: false, reason: "page evaluation failed" }));
}

/** Shortest list of events that takes `from` to `to` using only transitions
 * the evidence declares, or null when there is none. */
export function routeThrough(graph: Record<string, Record<string, string>>, from: string, to: string): string[] | null {
  if (from === to) return [];
  const prev = new Map<string, { state: string; event: string }>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const s = queue.shift() as string;
    for (const [event, next] of Object.entries(graph[s] ?? {})) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, { state: s, event });
      if (next === to) {
        const path: string[] = [];
        for (let cur = to; cur !== from; ) {
          const p = prev.get(cur) as { state: string; event: string };
          path.unshift(p.event);
          cur = p.state;
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

async function clickAction(page: Page, event: string): Promise<string | null> {
  const loc = await locateAction(page, event);
  if (!loc.found) return loc.reason ?? "control not found";
  try {
    await page.locator('[data-aztrx-action="' + event + '"]').click({ timeout: 3000 });
  } catch {
    return 'could not click "' + event + '"';
  }
  return null;
}

/** A fresh session: another visitor's view of the app. Used only when the
 * current state can't be left (a terminal state) and the experiment needs a
 * different one. */
async function freshSession(page: Page): Promise<void> {
  await page.context().clearCookies().catch(() => {});
  await page.evaluate(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* storage may be unavailable */
    }
  }).catch(() => {});
  await page.reload({ waitUntil: "load" }).catch(() => {});
}

export const bindStateTransition: Binder = async (page, _c, rawPlan) => {
  const plan = rawPlan as StateTransitionPlan;
  const table = plan.graph.transitions;
  const states = Object.keys(table);
  const field = plan.variable.field;

  const reading = await readState(page, states);
  if (!reading.found) return { reason: reading.reason ?? "no state readout" };
  const probe = await locateAction(page, plan.action);
  if (!probe.found) return { reason: probe.reason ?? "action control not found" };

  return {
    async drive(st) {
      const target = st.assign[field] as string;
      const actions: ExecutedAction[] = [];

      let cur = await settledState(page, states);
      if (cur === null) return { failed: "could not read the state" };
      let path = routeThrough(table, cur, target);
      if (path === null) {
        // Can't get there from here (a terminal state). Start over as a new visitor.
        await freshSession(page);
        cur = await settledState(page, states);
        if (cur === null) return { failed: "could not read the state after a fresh session" };
        actions.push({ kind: "navigate", target: page.url(), detail: "fresh session" });
        path = routeThrough(table, cur, target);
      }
      if (path === null) return { failed: 'no declared route from "' + cur + '" to "' + target + '"' };

      for (const event of path) {
        const expected: string = table[cur as string][event];
        const err = await clickAction(page, event);
        if (err) return { failed: "setup step: " + err };
        actions.push({ kind: "click", target: event, detail: "setup: " + event });
        const next = await settledState(page, states);
        if (next !== expected) {
          return { failed: 'setup step "' + event + '" from "' + cur + '" should reach "' + expected + '" but the page shows "' + next + '"' };
        }
        cur = next;
      }

      const before: ObservedState = { url: page.url(), flags: { [field]: cur as string } };
      const err = await clickAction(page, st.action as string);
      if (err) return { failed: err };
      actions.push({ kind: "click", target: st.action as string, detail: st.label + ": " + st.action + " in " + cur });
      const outcome = await settledState(page, states);
      const after: ObservedState = { url: page.url(), flags: outcome !== null ? { [field]: outcome } : {} };
      return { before, after, actions };
    },
    explain: (st, run) =>
      'After "' + st.action + '" in state "' + run.before.flags?.[field] + '" the page shows ' + field + "=" +
      run.after.flags?.[field] + ', expected the state to stay "' + run.before.flags?.[field] + '"',
    restore: async () => {},
  };
};

export function binderFor(plan: ExperimentPlan): Binder {
  switch (plan.family) {
    case "numeric-boundary":
      return bindNumericBoundary;
    case "state-transition":
      return bindStateTransition;
  }
}
