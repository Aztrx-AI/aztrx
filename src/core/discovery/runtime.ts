/**
 * Stages 1, 3, 5-7 against a live page: collect code evidence, bind the
 * rule's variables to controls the page actually has, drive the planned
 * states, read what the page shows, and hand every verdict to
 * `evaluateInvariant`.
 *
 * Binding is by the identifier names the evidence itself used: a rule about
 * `cart.total` binds to a control whose id/name/label says "total". If a name
 * matches nothing, or matches ambiguously, the candidate stops at "binding"
 * and is never guessed onto a nearby control.
 */

import type { Page } from "playwright";
import { EventBus } from "../eventBus.js";
import { evaluateInvariant } from "../invariant.js";
import type { ExecutedAction, ObservedState, Verdict } from "../invariant.js";
import { compileCandidate } from "./compile.js";
import { inferCandidates, type TextEvidence } from "./infer.js";
import { planExperiment } from "./plan.js";
import type { DiscoveryTrace, ExperimentObservation, InvariantCandidate } from "./types.js";

const MAX_SCRIPTS = 8;
const MAX_SCRIPT_BYTES = 200_000;
const MAX_CANDIDATES = 6;

/** Served program text for the page: inline scripts plus same-origin
 * external ones. This is code the browser was handed, real evidence of
 * what the app is written to do, not an assumption about it. */
export async function collectCodeEvidence(page: Page): Promise<TextEvidence[]> {
  const origin = new URL(page.url()).origin;
  const scripts = await page
    .evaluate(() => Array.from(document.scripts).map((s) => ({ src: s.src, text: s.src ? "" : s.textContent ?? "" })))
    .catch(() => [] as Array<{ src: string; text: string }>);

  const out: TextEvidence[] = [];
  let n = 0;
  for (const s of scripts) {
    if (n >= MAX_SCRIPTS) break;
    if (!s.src) {
      if (s.text.trim()) {
        out.push({ source: "code", location: `${new URL(page.url()).pathname} <inline script>`, text: s.text.slice(0, MAX_SCRIPT_BYTES) });
      }
      n++;
      continue;
    }
    let u: URL;
    try {
      u = new URL(s.src);
    } catch {
      continue;
    }
    if (u.origin !== origin) continue;
    n++;
    const text = await page
      .evaluate(async (src) => {
        try {
          const r = await fetch(src);
          return r.ok ? await r.text() : "";
        } catch {
          return "";
        }
      }, s.src)
      .catch(() => "");
    if (text) out.push({ source: "code", location: u.pathname, text: text.slice(0, MAX_SCRIPT_BYTES) });
  }
  return out;
}

// ---- binding ---------------------------------------------------------------

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
          const m = t.replace(/ /g, " ").match(/-?\d[\d,]*(?:\.\d+)?/);
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

// ---- execution -------------------------------------------------------------

async function driveState(
  page: Page,
  variable: string,
  target: string,
  value: number,
  label: string
): Promise<{ before: ObservedState; after: ObservedState; actions: ExecutedAction[] } | null> {
  const input = page.locator('[data-aztrx-field="' + variable + '"]');
  const initialOutput = await currentOutput(page, target);
  try {
    await input.fill(String(value), { timeout: 3000 });
    await input.evaluate((el) => {
      el.dispatchEvent(new Event("change", { bubbles: true }));
      (el as HTMLElement).blur();
    });
  } catch {
    return null;
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

// ---- the behavior ----------------------------------------------------------

export interface InvariantDiscoveryOptions {
  dryRun?: boolean;
  maxCandidates?: number;
  /** Extra evidence the caller already has (a git diff's added lines, a
   * test file), merged with what the page serves. */
  extraEvidence?: TextEvidence[];
}

export async function invariantDiscovery(
  page: Page,
  bus: EventBus,
  opts: InvariantDiscoveryOptions = {}
): Promise<{ candidates: number; statesRun: number; findings: number; traces: DiscoveryTrace[] }> {
  const traces: DiscoveryTrace[] = [];
  let statesRun = 0;
  let findings = 0;

  const evidence = [...(await collectCodeEvidence(page)), ...(opts.extraEvidence ?? [])];
  const candidates: InvariantCandidate[] = [];
  for (const ev of evidence) candidates.push(...inferCandidates(ev));

  for (const candidate of candidates.slice(0, opts.maxCandidates ?? MAX_CANDIDATES)) {
    const t0 = Date.now();
    const trace: DiscoveryTrace = { candidate, reachedStage: "inference", observations: [], verdict: "unknown", durationMs: 0 };
    traces.push(trace);
    const stop = (why: string) => {
      trace.stoppedBecause = why;
      trace.durationMs = Date.now() - t0;
    };

    const plan = planExperiment(candidate);
    if (!plan) {
      stop("planning: no ordered numeric precondition to build a boundary around");
      continue;
    }
    trace.plan = plan;
    trace.reachedStage = "planning";

    const target = candidate.expectation[0];
    const inBind = await locateField(page, plan.variable.field, "input");
    if (!inBind.found) {
      stop("binding: " + inBind.reason);
      continue;
    }
    const outBind = await locateField(page, target.field, "output");
    if (!outBind.found) {
      stop("binding: " + outBind.reason);
      continue;
    }
    trace.reachedStage = "binding";
    if (opts.dryRun) {
      stop("dry run");
      continue;
    }

    const spec = compileCandidate(candidate);
    const initialInput = inBind.value;
    for (const st of plan.states) {
      const value = st.assign[plan.variable.field];
      const run = await driveState(page, plan.variable.field, target.field, value, st.label);
      statesRun++;
      if (!run) {
        trace.observations.push({
          label: st.label,
          applicable: st.applicable,
          actions: [],
          before: {},
          after: {},
          verdict: "unknown",
          note: "could not set the input",
        });
        continue;
      }
      trace.reachedStage = "execution";
      let verdict: Verdict = "unknown";
      let note: string | undefined;
      if (run.after.flags?.[target.field] === undefined) {
        note = "output was not readable as a number; not judged";
      } else {
        verdict = evaluateInvariant(spec, run.before, run.actions, run.after, [{ label: "state", value: st.label }]).verdict;
        if (verdict === "unknown") note = "precondition not met in this state; control only";
      }
      trace.reachedStage = "evaluation";
      const obs: ExperimentObservation = {
        label: st.label,
        applicable: st.applicable,
        actions: run.actions,
        before: run.before,
        after: run.after,
        verdict,
        note,
      };

      if (verdict === "violated") {
        // Replay once: proof means it happens again, not once.
        const again = await driveState(page, plan.variable.field, target.field, value, st.label);
        obs.reproduced =
          !!again &&
          again.after.flags?.[target.field] !== undefined &&
          evaluateInvariant(spec, again.before, again.actions, again.after).verdict === "violated";
        statesRun++;
      }
      trace.observations.push(obs);
    }
    if (initialInput !== null && initialInput !== undefined) {
      await page
        .locator('[data-aztrx-field="' + plan.variable.field + '"]')
        .fill(String(initialInput))
        .catch(() => {});
    }

    const proven = trace.observations.find((o) => o.verdict === "violated" && o.reproduced);
    if (proven) {
      trace.verdict = "violated";
      const seen = proven.after.flags?.[target.field];
      const at = proven.after.flags?.[plan.variable.field];
      trace.findingMessage =
        "Discovered invariant violated: " + candidate.description + ". " +
        "At " + plan.variable.field + "=" + at + " (" + proven.label + ") the page shows " + target.field + "=" + seen +
        ", expected " + target.field + " " + target.op + " " + target.value + ". " +
        "Evidence: " + candidate.evidence.signals[0];
      findings++;
      bus.emit("telemetry", { type: "business_logic_violation", rawMessage: trace.findingMessage, rawStack: "" });
    } else if (
      trace.observations.some((o) => o.verdict === "preserved") &&
      !trace.observations.some((o) => o.verdict === "violated")
    ) {
      trace.verdict = "preserved";
    }
    trace.durationMs = Date.now() - t0;
  }

  return { candidates: candidates.length, statesRun, findings, traces };
}
