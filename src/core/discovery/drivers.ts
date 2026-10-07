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
import { ensureEntityHelpers, surveyEntities, type ScopeSpec } from "./entities.js";
import type {
  BindingRecord,
  ExperimentPlan,
  InvariantCandidate,
  NumericBoundaryPlan,
  PlannedState,
  StateTransitionPlan,
  TransitionIntent,
  TransitionTable,
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
  /** What the rule was tied to in the running app, and why that element. */
  binding: BindingRecord[];
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
  /** Which element was matched and how strongly. */
  via?: string;
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

        const describe = (el: Element) =>
          el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.getAttribute("name") ? "[name=" + el.getAttribute("name") + "]" : "");

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
          return {
            found: true,
            value: num((best[0].el as HTMLInputElement).value),
            via: describe(best[0].el) + (top === 2 ? " (exact name)" : " (word match)"),
          };
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
          if (figures.size === 1) {
            return { found: true, value: num(best[0].text), via: describe(best[0].el) + ' showing "' + best[0].text.slice(0, 24) + '"' };
          }
          return { found: false, reason: best.length + ' readouts match "' + field + '" with different figures' };
        }
        // Fallback: a "Shipping: $5.99" style line in the visible text.
        const body = document.body?.innerText ?? "";
        const words = want.split(" ").join("[\\s_-]*");
        const m = new RegExp(words + "[^\\d\\n-]{0,24}(-?\\$?\\s?\\d[\\d,]*(?:\\.\\d+)?)", "i").exec(body);
        if (m) return { found: true, value: num(m[1]), via: 'visible text "' + m[0].trim().slice(0, 32) + '"' };
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
    binding: [
      { role: "input", name: variable, matched: inBind.via ?? "input" },
      { role: "output", name: target.field, matched: outBind.via ?? "readout" },
    ],
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

interface StateReading {
  found: boolean;
  /** Canonical state name as the evidence spelled it. */
  state?: string;
  reason?: string;
  /** The element the state was read from. */
  via?: string;
}

/** Everything below can run against the whole page (`spec` null) or inside one
 * entity of a repeated structure (`spec` says which, by identity). Inside an
 * entity, only that entity's subtree is searched: a state or a control from
 * another repetition is not visible, so it cannot be paired by mistake. */

/** Runs in the page. The state readout is whichever visible, non-interactive
 * element's text *is* one of the machine's own state names (optionally after a
 * `Label:` prefix), or the selected option of a `<select>` whose option maps to
 * one. Readouts showing different states at once make the binding ambiguous —
 * a legend or a list of orders is not one entity's state. */
async function readState(page: Page, states: string[], spec: ScopeSpec | null): Promise<StateReading> {
  if (spec) await ensureEntityHelpers(page);
  return page
    .evaluate(({ states, spec }) => {
      const norm = (s: string) =>
        s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      let root: Element = document.body;
      if (spec) {
        const h = (window as unknown as { __aztrx?: { resolve(s: unknown, st: string[]): { el: Element | null; reason: string } } }).__aztrx;
        const r = h?.resolve(spec, states);
        if (!r || !r.el) return { found: false, reason: r?.reason ?? "entity helpers unavailable" };
        root = r.el;
      }
      const byNorm = new Map(states.map((s) => [norm(s), s]));
      const interactive = "button, a, input, select, option, textarea, label, script, style, [role=button]";
      const seen = new Set<string>();
      let via = "";
      const describe = (el: Element) =>
        el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.getAttribute("data-testid") ? "[data-testid=" + el.getAttribute("data-testid") + "]" : "");
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (el.matches(interactive) || el.closest("button, a, [role=button]")) continue;
        if (el.getClientRects().length === 0) continue;
        const text = ((el as HTMLElement).innerText ?? "").trim();
        if (!text || text.length > 80) continue;
        const tail = text.includes(":") ? text.slice(text.lastIndexOf(":") + 1) : text;
        const hit = byNorm.get(norm(tail));
        if (hit !== undefined) {
          seen.add(hit);
          // Innermost match is the most specific: keep descending.
          via = describe(el) + ' "' + text.slice(0, 32) + '"';
        }
      }
      for (const sel of Array.from(root.querySelectorAll("select"))) {
        if (sel.getClientRects().length === 0) continue;
        const o = (sel as HTMLSelectElement).selectedOptions[0];
        if (!o) continue;
        const a = byNorm.get(norm(o.value));
        const b = byNorm.get(norm(o.textContent ?? ""));
        if ((a && b && a !== b) || !(a ?? b)) continue;
        seen.add((a ?? b) as string);
        via = describe(sel) + ' selected "' + (o.textContent ?? "").trim().slice(0, 24) + '"';
      }
      if (seen.size === 1) return { found: true, state: [...seen][0], via };
      if (seen.size === 0) return { found: false, reason: "nothing on the page shows one of the machine's states" };
      return { found: false, reason: "the page shows several of the machine's states at once: " + [...seen].join(", ") };
    }, { states, spec })
    .catch(() => ({ found: false, reason: "page evaluation failed" }) as StateReading);
}

/** Wait for the state to stop moving, then say what it is. `reason` is set when
 * it could not be read — for a scoped read, usually because the entity could
 * no longer be found. */
async function settledState(page: Page, states: string[], spec: ScopeSpec | null): Promise<{ state: string | null; reason?: string }> {
  await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
  const started = Date.now();
  let last: string | null | undefined;
  let lastReason: string | undefined;
  let stable = 0;
  while (Date.now() - started < 3000) {
    await page.waitForTimeout(100);
    const r = await readState(page, states, spec);
    const v = r.found ? (r.state ?? null) : null;
    lastReason = r.found ? undefined : r.reason;
    stable = v === last ? stable + 1 : 0;
    last = v;
    if (stable >= 4 && Date.now() - started >= 600) break;
  }
  return { state: last ?? null, reason: lastReason };
}

/** Tags the one visible control named like `event` so it can be clicked. */
async function locateAction(
  page: Page,
  event: string,
  tag: boolean,
  states: string[],
  spec: ScopeSpec | null
): Promise<{ found: boolean; reason?: string; via?: string }> {
  if (spec) await ensureEntityHelpers(page);
  return page
    .evaluate(({ event, tag, states, spec }) => {
      const norm = (s: string) =>
        s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      let root: Element = document.body;
      if (spec) {
        const h = (window as unknown as { __aztrx?: { resolve(s: unknown, st: string[]): { el: Element | null; reason: string } } }).__aztrx;
        const r = h?.resolve(spec, states);
        if (!r || !r.el) return { found: false, reason: r?.reason ?? "entity helpers unavailable" };
        root = r.el;
      }
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
        root.querySelectorAll("button, [role=button], a[href], input[type=submit], input[type=button]")
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
      if (tag) {
        document.querySelectorAll("[data-aztrx-action]").forEach((e) => e.removeAttribute("data-aztrx-action"));
        best[0].el.setAttribute("data-aztrx-action", event);
      }
      const el = best[0].el as HTMLElement;
      const via =
        el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + ' "' + (el.innerText ?? "").trim().slice(0, 24) + '"' +
        (top === 2 ? " (exact name)" : " (word match)");
      return { found: true, via };
    }, { event, tag, states, spec })
    .catch(() => ({ found: false, reason: "page evaluation failed" }));
}

/** How a page lets a user move to a given state: through the option of a
 * `<select>` whose options are the machine's states, or through a control
 * named like the state. Option-to-state mapping is by the option's value or
 * text matching a state name exactly (after case/punctuation folding); an
 * option that maps to two different states, or a page with several such
 * selects, is not guessed at. */
interface TargetControl {
  found: boolean;
  kind?: "select" | "control";
  /** The states a matching select offers right now. */
  offered?: string[];
  /** The option to choose (select only). */
  value?: string;
  reason?: string;
  via?: string;
}

async function locateTarget(
  page: Page,
  states: string[],
  target: string,
  tag: boolean,
  spec: ScopeSpec | null
): Promise<TargetControl> {
  if (spec) await ensureEntityHelpers(page);
  return page
    .evaluate(({ states, target, tag, spec }) => {
      const norm = (s: string) =>
        s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      let root: Element = document.body;
      if (spec) {
        const h = (window as unknown as { __aztrx?: { resolve(s: unknown, st: string[]): { el: Element | null; reason: string } } }).__aztrx;
        const r = h?.resolve(spec, states);
        if (!r || !r.el) return { found: false, reason: r?.reason ?? "entity helpers unavailable" };
        root = r.el;
      }
      const byNorm = new Map(states.map((s) => [norm(s), s]));
      const stateOf = (o: HTMLOptionElement): string | null | "?" => {
        const a = byNorm.get(norm(o.value));
        const b = byNorm.get(norm(o.textContent ?? ""));
        if (a && b && a !== b) return "?";
        return a ?? b ?? null;
      };
      const describe = (el: Element) =>
        el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.getAttribute("name") ? "[name=" + el.getAttribute("name") + "]" : "");

      // A select belongs to the machine when its options are the machine's
      // states. A final state can leave it with a single option, so one is
      // enough — as long as no option is ambiguous.
      const selects = Array.from(root.querySelectorAll("select"))
        .filter((sel) => sel.getClientRects().length > 0)
        .map((sel) => ({ sel, opts: Array.from((sel as HTMLSelectElement).options).map((o) => ({ o, st: stateOf(o) })) }))
        .filter((x) => x.opts.some((y) => y.st && y.st !== "?") && !x.opts.some((y) => y.st === "?"));
      if (selects.length > 1) {
        return { found: false, reason: selects.length + " selects offer the machine's states; can't tell which one is this entity's" };
      }
      if (selects.length === 1) {
        const { sel, opts } = selects[0];
        const offered = [...new Set(opts.map((y) => y.st).filter((v): v is string => !!v && v !== "?"))];
        const hits = opts.filter((y) => y.st === target);
        if ((sel as HTMLSelectElement).disabled) {
          return {
            found: false,
            kind: "select" as const,
            offered,
            reason: "the select is disabled (it offers: " + offered.join(", ") + ")",
          };
        }
        if (hits.length === 0) {
          return {
            found: false,
            kind: "select" as const,
            offered,
            reason: 'the select offers no option for "' + target + '" (it offers: ' + offered.join(", ") + ")",
          };
        }
        if (hits.length > 1) {
          return { found: false, kind: "select" as const, offered, reason: hits.length + ' options map to "' + target + '"' };
        }
        if (tag) {
          document.querySelectorAll("[data-aztrx-select]").forEach((e) => e.removeAttribute("data-aztrx-select"));
          sel.setAttribute("data-aztrx-select", "1");
        }
        return {
          found: true,
          kind: "select" as const,
          offered,
          value: hits[0].o.value,
          via: describe(sel) + ' option "' + (hits[0].o.textContent ?? "").trim().slice(0, 24) + '" (offers: ' + offered.join(", ") + ")",
        };
      }

      // No select of states: a control named like the state ("Cancelled").
      const want = norm(target);
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
        root.querySelectorAll("button, [role=button], a[href], input[type=submit], input[type=button]")
      ).filter((el) => el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled);
      const scored = controls
        .map((el) => ({
          el,
          r: rank([
            el.id,
            el.getAttribute("name") ?? "",
            el.getAttribute("data-testid") ?? "",
            el.getAttribute("aria-label") ?? "",
            el.getAttribute("title") ?? "",
            (el as HTMLInputElement).value ?? "",
            (el as HTMLElement).innerText ?? "",
          ]),
        }))
        .filter((x) => x.r > 0);
      if (scored.length === 0) return { found: false, reason: 'no select option or control is named like "' + target + '"' };
      const top = Math.max(...scored.map((x) => x.r));
      const best = scored.filter((x) => x.r === top);
      if (best.length !== 1) return { found: false, reason: best.length + ' controls match "' + target + '" equally' };
      if (tag) {
        document.querySelectorAll("[data-aztrx-action]").forEach((e) => e.removeAttribute("data-aztrx-action"));
        best[0].el.setAttribute("data-aztrx-action", "@" + target);
      }
      const el = best[0].el as HTMLElement;
      return {
        found: true,
        kind: "control" as const,
        via: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + ' "' + (el.innerText ?? "").trim().slice(0, 24) + '"' + (top === 2 ? " (exact name)" : " (word match)"),
      };
    }, { states, target, tag, spec })
    .catch(() => ({ found: false, reason: "page evaluation failed" }) as TargetControl);
}

/** Which of the machine's states the page lets a user move to, and through
 * what — the evidence that a page is the thing a successor-list describes. */
async function surveyTargets(page: Page, states: string[], spec: ScopeSpec | null): Promise<Array<{ state: string; via: string }>> {
  const out: Array<{ state: string; via: string }> = [];
  for (const s of states) {
    const t = await locateTarget(page, states, s, false, spec);
    if (t.found) out.push({ state: s, via: t.via ?? "control" });
  }
  return out;
}

type Edge = { intent: TransitionIntent; next: string };

function edgesOf(graph: TransitionTable, state: string): Edge[] {
  if (graph.form === "action-map") {
    return Object.entries(graph.transitions[state] ?? {}).map(([name, next]) => ({ intent: { kind: "action" as const, name }, next }));
  }
  return (graph.successors[state] ?? []).map((next) => ({ intent: { kind: "target" as const, state: next }, next }));
}

/** Shortest list of intents that takes `from` to `to` using only transitions
 * the evidence declares, or null when there is none. */
export function routeIntents(graph: TransitionTable, from: string, to: string): TransitionIntent[] | null {
  if (from === to) return [];
  const prev = new Map<string, { state: string; intent: TransitionIntent }>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const s = queue.shift() as string;
    for (const e of edgesOf(graph, s)) {
      if (seen.has(e.next)) continue;
      seen.add(e.next);
      prev.set(e.next, { state: s, intent: e.intent });
      if (e.next === to) {
        const path: TransitionIntent[] = [];
        for (let cur = to; cur !== from; ) {
          const p = prev.get(cur) as { state: string; intent: TransitionIntent };
          path.unshift(p.intent);
          cur = p.state;
        }
        return path;
      }
      queue.push(e.next);
    }
  }
  return null;
}

/** Shortest list of events that takes `from` to `to` in an action table. */
export function routeThrough(graph: Record<string, Record<string, string>>, from: string, to: string): string[] | null {
  const successors: Record<string, string[]> = {};
  for (const [s, row] of Object.entries(graph)) successors[s] = Object.values(row);
  const route = routeIntents({ name: "", form: "action-map", transitions: graph, successors }, from, to);
  return route ? route.map((i) => (i.kind === "action" ? i.name : i.state)) : null;
}

const describeIntent = (i: TransitionIntent): string => (i.kind === "action" ? i.name : "→ " + i.state);

/** Attempt one intent on the page — or inside one entity of it. Returns why it
 * could not be attempted, or null when the attempt was made. "Not offered" is a
 * fact about the page (it does not let a user try that move from here), never a
 * verdict on the rule. */
async function attempt(page: Page, states: string[], intent: TransitionIntent, spec: ScopeSpec | null): Promise<string | null> {
  if (intent.kind === "action") {
    const loc = await locateAction(page, intent.name, true, states, spec);
    if (!loc.found) return loc.reason ?? "control not found";
    try {
      await page.locator('[data-aztrx-action="' + intent.name + '"]').click({ timeout: 3000 });
    } catch {
      return 'could not click "' + intent.name + '"';
    }
    return null;
  }

  const t = await locateTarget(page, states, intent.state, true, spec);
  if (!t.found) return t.kind === "select" ? "not offered: " + t.reason : (t.reason ?? "control not found");
  try {
    if (t.kind === "select") await page.locator("[data-aztrx-select]").selectOption(t.value as string, { timeout: 3000 });
    else await page.locator('[data-aztrx-action="@' + intent.state + '"]').click({ timeout: 3000 });
  } catch {
    return 'could not move to "' + intent.state + '"';
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

/** How many of a machine's moves must be bindable to something on the page
 * before the page is accepted as the thing the machine describes. */
const MIN_LINKED_MOVES = 2;
/** Entities examined when checking that a repeated structure offers the moves. */
const MAX_ENTITIES_CHECKED = 6;

export const bindStateTransition: Binder = async (page, _c, rawPlan) => {
  const plan = rawPlan as StateTransitionPlan;
  const table = plan.graph;
  const states = Object.keys(table.successors);
  const field = plan.variable.field;
  const bound: BindingRecord[] = [];

  // Is the page one thing, or many? A repeated structure is bound entity by
  // entity or not at all; a state from one repetition is never paired with a
  // control from another.
  const survey = await surveyEntities(page, states);
  if (survey.mode === "ambiguous") return { reason: "entity scoping: " + survey.reason };
  const scoped = survey.mode === "entities";

  if (scoped) {
    const ents = survey.entities ?? [];
    bound.push({
      role: "entity_scope",
      name: table.name,
      matched:
        survey.shape + "; identity at " + survey.slot + " (" + ents.slice(0, 4).map((e) => '"' + e.value + '"').join(", ") +
        (ents.length > 4 ? ", …" : "") + "); states: " + ents.map((e) => e.state ?? "?").join(", "),
      confidence: survey.slot?.startsWith("attr:") || survey.slot?.startsWith("href:") ? 0.9 : 0.7,
    });

    // The moves must be offered *inside* an entity. Check a few, and keep the
    // one that offers the most — the page is only accepted if some entity does.
    type Best = { value: string; records: BindingRecord[]; linked: number; needed: number };
    let found: Best | null = null;
    for (const e of ents.slice(0, MAX_ENTITIES_CHECKED)) {
      const spec: ScopeSpec = { slot: survey.slot as string, value: e.value, witnesses: e.witnesses };
      const records: BindingRecord[] = [];
      let linked = 0;
      let needed: number;
      if (table.form === "action-map") {
        const events = [...new Set(Object.values(table.transitions).flatMap((row) => Object.keys(row)))];
        for (const event of events) {
          const f = await locateAction(page, event, false, states, spec);
          if (f.found) {
            records.push({ role: "control", name: event, matched: f.via ?? "control" });
            linked++;
          }
        }
        needed = Math.min(events.length, MIN_LINKED_MOVES);
      } else {
        const targets = await surveyTargets(page, states, spec);
        for (const t of targets) records.push({ role: "control", name: t.state, matched: t.via });
        linked = targets.length;
        needed = Math.min(states.length, MIN_LINKED_MOVES);
      }
      if (!found || linked > found.linked) found = { value: e.value, records, linked, needed };
    }
    const best = found as Best | null;
    if (!best || best.linked < best.needed) {
      return {
        reason:
          "the page shows several of the machine's states at once in " + survey.shape +
          " and its controls are not inside any one of them: no entity offers " + (best?.needed ?? MIN_LINKED_MOVES) +
          " of the machine's moves (best offered " + (best?.linked ?? 0) + ")",
      };
    }
    bound.push({ role: "state_readout", name: table.name, matched: 'inside each entity (e.g. "' + best.value + '")' });
    bound.push(...best.records.map((r) => ({ ...r, matched: r.matched + ' [entity "' + best.value + '"]' })));
  } else {
    const reading = await readState(page, states, null);
    if (!reading.found) return { reason: reading.reason ?? "no state readout" };
    bound.push({ role: "state_readout", name: table.name, matched: reading.via ?? "state readout" });

    // The link from source to page is the machine's own vocabulary showing up in
    // the UI. One stray "Cancel" button is not enough to call a page the thing
    // the table describes: require the page to expose several of its moves.
    if (table.form === "action-map") {
      const events = [...new Set(Object.values(table.transitions).flatMap((row) => Object.keys(row)))];
      const missing: string[] = [];
      let linked = 0;
      for (const event of events) {
        const f = await locateAction(page, event, false, states, null);
        if (f.found) {
          bound.push({ role: "control", name: event, matched: f.via ?? "control" });
          linked++;
        } else missing.push(event);
      }
      const probe = plan.intent.kind === "action" ? await locateAction(page, plan.intent.name, true, states, null) : { found: true };
      if (!probe.found) return { reason: (probe as { reason?: string }).reason ?? "action control not found" };
      const needed = Math.min(events.length, MIN_LINKED_MOVES);
      if (linked < needed) {
        return {
          reason:
            "weak source-to-page link: only " + linked + " of " + events.length + " actions of " + table.name +
            " have a control on the page (need " + needed + "); no control for: " + missing.join(", "),
        };
      }
    } else {
      const needed = Math.min(states.length, MIN_LINKED_MOVES);
      let targets = await surveyTargets(page, states, null);
      if (targets.length < needed) {
        // What a page offers depends on where the entity is: a select at a final
        // state offers only itself. That says nothing about the page, so look
        // once more as a new visitor before calling the link weak.
        await freshSession(page);
        targets = await surveyTargets(page, states, null);
        const again = await readState(page, states, null);
        if (again.found) bound[0] = { role: "state_readout", name: table.name, matched: again.via ?? "state readout" };
      }
      if (targets.length < needed) {
        return {
          reason:
            "weak source-to-page link: the page offers a way to reach only " + targets.length + " of " + states.length +
            " states of " + table.name + " (need " + needed + "): " + (targets.map((t) => t.state).join(", ") || "none"),
        };
      }
      for (const t of targets) bound.push({ role: "control", name: t.state, matched: t.via });
    }
  }

  // An attempted move can raise a confirm dialog ("Cancel this order?"). That is
  // part of the product flow being attempted, so it is accepted; dismissing it
  // would make a refused move and a declined confirmation look identical.
  const dialogs: string[] = [];
  const onDialog = (d: import("playwright").Dialog) => {
    dialogs.push(d.message());
    void d.accept().catch(() => {});
  };
  page.on("dialog", onDialog);

  return {
    binding: bound,
    async drive(st) {
      const target = st.assign[field] as string;
      const intent = st.intent as TransitionIntent;
      const actions: ExecutedAction[] = [];
      let spec: ScopeSpec | null = null;
      let entity: string | undefined;

      if (scoped) {
        // Pick the entity that needs the least setup to be in the state this
        // experiment starts from. Which one is a matter of convenience, never
        // of ambiguity: the choice is by identity, and every read and every
        // control after it stays inside that entity.
        const now = await surveyEntities(page, states);
        if (now.mode !== "entities" || !now.slot) return { failed: "entity scoping: " + (now.reason ?? "the page no longer shows a repeated structure") };
        let pick: { value: string; steps: number; witnesses?: Record<string, string> } | null = null;
        for (const e of now.entities ?? []) {
          if (!e.state) continue;
          const r = routeIntents(table, e.state, target);
          if (r && (!pick || r.length < pick.steps)) pick = { value: e.value, steps: r.length, witnesses: e.witnesses };
        }
        if (!pick) return { failed: 'no entity on the page can reach "' + target + '" along the declared transitions' };
        spec = { slot: now.slot, value: pick.value, witnesses: pick.witnesses };
        entity = pick.value;
      }
      const where = entity !== undefined ? ' [entity "' + entity + '"]' : "";
      const flagsOf = (state: string): Record<string, string> => ({ [field]: state, ...(entity !== undefined ? { entity } : {}) });

      let first = await settledState(page, states, spec);
      let cur = first.state;
      if (cur === null) return { failed: spec ? "could not read the entity's state: " + first.reason : "could not read the state" };
      let path = routeIntents(table, cur, target);
      if (path === null && !scoped) {
        // Can't get there from here (a terminal state). Start over as a new visitor.
        await freshSession(page);
        first = await settledState(page, states, null);
        cur = first.state;
        if (cur === null) return { failed: "could not read the state after a fresh session" };
        actions.push({ kind: "navigate", target: page.url(), detail: "fresh session" });
        path = routeIntents(table, cur, target);
      }
      if (path === null) return { failed: 'no declared route from "' + cur + '" to "' + target + '"' };

      for (const step of path) {
        const expected: string | undefined = edgesOf(table, cur as string).find((e) => JSON.stringify(e.intent) === JSON.stringify(step))?.next;
        const err = await attempt(page, states, step, spec);
        if (err) return { failed: "setup step: " + err + where };
        actions.push({ kind: "click", target: describeIntent(step), detail: "setup: " + describeIntent(step) + where });
        const next = await settledState(page, states, spec);
        if (next.state === null) return { failed: "setup step: could not re-read the entity after the action (" + next.reason + ")" + where };
        if (next.state !== expected) {
          return { failed: 'setup step "' + describeIntent(step) + '" from "' + cur + '" should reach "' + expected + '" but the page shows "' + next.state + '"' + where };
        }
        cur = next.state;
      }

      const before: ObservedState = { url: page.url(), flags: flagsOf(cur as string) };
      dialogs.length = 0;
      const err = await attempt(page, states, intent, spec);
      if (err) return { failed: err + where };
      actions.push({
        kind: "click",
        target: describeIntent(intent),
        detail:
          st.label + ": " + describeIntent(intent) + " in " + cur + where +
          (dialogs.length ? ' (accepted dialog: "' + dialogs[0].slice(0, 60) + '")' : ""),
      });
      const outcome = await settledState(page, states, spec);
      // Observe the same entity or nothing: if it can't be found again, this is
      // not evidence about the entity we acted on, and no other row stands in.
      if (spec && outcome.state === null) {
        return { failed: "the entity could not be re-identified after the action (" + outcome.reason + ")" + where };
      }
      const after: ObservedState = { url: page.url(), flags: outcome.state !== null ? flagsOf(outcome.state) : {} };
      return { before, after, actions };
    },
    explain: (st, run) => {
      const i = st.intent as TransitionIntent;
      const what = i.kind === "action" ? '"' + i.name + '"' : 'moving to "' + i.state + '"';
      const ent = run.after.flags?.entity !== undefined ? ' (entity "' + run.after.flags.entity + '")' : "";
      return (
        "After " + what + ' in state "' + run.before.flags?.[field] + '"' + ent + " the page shows " + field + "=" +
        run.after.flags?.[field] + ', expected the state to stay "' + run.before.flags?.[field] + '"'
      );
    },
    restore: async () => {
      page.off("dialog", onDialog);
    },
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
