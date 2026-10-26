/**
 * The adaptive investigation loop:
 *
 *   observe → propose ONE grounded experiment → execute → interpret → revise
 *
 * It adds no execution engine. Observation (`ground.ts`) gives every control and
 * every readable thing on the live page an id; the model may only name those ids
 * (the reply schema enumerates them), the reply is translated into an ordinary
 * `Hypothesis`, validated by the same `parseHypotheses`, and run by the same
 * `runHypothesis`. What the loop adds is what happens *between* experiments: an
 * experiment that changed the app becomes a new observed state the next one can
 * continue from, a control that failed is never offered again, a repeat is
 * skipped, and every choice records why it was made.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { applyStep, runHypothesis, type Setup } from "./execute.js";
import { asStep, parseHypotheses, replyText, type Completer } from "./generate.js";
import { allControls, allReadables, detectPrerequisites, groundingOf, observeState, statusOf, type ObservedControl, type ObservedReadable, type Prerequisite, type StateMap } from "./ground.js";
import { buildInventory } from "./inventory.js";
import { BudgetExceeded, Ledger, redact, sha256 } from "./ledger.js";
import type { Grounding, Hypothesis, HypothesisResult, Inventory, ResultStatus, Step } from "./types.js";

// ---- operator-supplied session ----------------------------------------------

/** Steps that sign in, with credentials the operator chose for this test environment. */
export interface AuthSpec {
  loginPath?: string;
  steps: Step[];
}

export function parseAuthSpec(json: string): AuthSpec {
  const o = JSON.parse(json) as { loginPath?: unknown; steps?: unknown };
  const steps = Array.isArray(o.steps) ? o.steps.map(asStep) : [];
  if (!steps.length || steps.some((s) => !s)) throw new Error("auth file needs a non-empty, valid \"steps\" array");
  return { loginPath: typeof o.loginPath === "string" ? o.loginPath : undefined, steps: steps as Step[] };
}

export function setupFrom(auth: AuthSpec, baseUrl: string): Setup {
  return async (page: Page) => {
    await page.goto(new URL(auth.loginPath ?? "/", baseUrl).toString(), { waitUntil: "load", timeout: 20_000 });
    for (const s of auth.steps) {
      if (s.op === "snapshot") continue;
      await applyStep(page, baseUrl, s);
      await page.waitForTimeout(250);
    }
  };
}

// ---- states -------------------------------------------------------------------

interface StateEntry {
  id: string;
  /** Steps that bring a fresh app to this state (never snapshots). */
  prefix: Exclude<Step, { op: "snapshot" }>[];
  /** The control each prefix step used (undefined for goto/press/reload). */
  prefixControls: Array<string | undefined>;
  /** Which control each prefix step used, for the narrative. */
  via: string;
  map: StateMap;
}

const stepText = (s: Step) =>
  s.op === "goto" ? `goto ${s.path}` : s.op === "click" ? `click ${JSON.stringify(s.target)}` : s.op === "fill" ? `fill ${JSON.stringify(s.target)}="${s.value}"` : s.op === "press" ? `press ${s.key}` : s.op === "reload" ? "reload" : `snapshot ${s.label}`;

function describeMap(m: StateMap): string {
  return m.routes
    .map((r) => {
      const lines = [`route ${r.path} — "${r.title}"`];
      for (const c of r.controls) lines.push(`  ${c.id} [${c.kind}${c.type ? ":" + c.type : ""}] "${c.name}"${c.href ? ` -> ${c.href}` : ""}`);
      for (const q of r.readables) lines.push(`  ${q.id} [${q.kind === "count" ? "count of items" : "text"}] currently ${q.kind === "count" ? q.sample : `"${q.sample}"`}`);
      return lines.join("\n");
    })
    .join("\n");
}

// ---- reply schema --------------------------------------------------------------

const nonEmpty = (xs: string[]) => (xs.length ? xs : ["(none)"]);

export function investigationSchema(stateIds: string[], controls: ObservedControl[], readables: ObservedReadable[], routes: string[]): object {
  const elements = nonEmpty([...controls.map((c) => c.id), ...readables.map((r) => r.id)]);
  const ref = { type: "object", properties: { snapshot: { type: "string" }, read: { type: "string" } }, required: ["snapshot", "read"] };
  return {
    type: "object",
    properties: {
      why_next: { type: "string" },
      from_state: { type: "string", enum: stateIds },
      page: { type: "string", enum: nonEmpty(routes) },
      behavior: { type: "string" },
      property: { type: "string", enum: ["round-trip", "persistence", "consistency", "idempotence", "ordering", "documented", "other"] },
      expectation: { type: "object", properties: { kind: { type: "string", enum: ["doc", "test", "ui", "universal"] }, quote: { type: "string" } }, required: ["kind"] },
      impact: { type: "integer", minimum: 1, maximum: 5 },
      // One variant per op, each requiring the fields that op needs. There is no goto: the experiment's page is a field of its own.
      steps: {
        type: "array",
        items: {
          anyOf: [
            { type: "object", properties: { op: { type: "string", enum: ["click"] }, control: { type: "string", enum: nonEmpty(controls.map((c) => c.id)) } }, required: ["op", "control"] },
            { type: "object", properties: { op: { type: "string", enum: ["fill"] }, control: { type: "string", enum: nonEmpty(controls.map((c) => c.id)) }, value: { type: "string" } }, required: ["op", "control", "value"] },
            { type: "object", properties: { op: { type: "string", enum: ["press"] }, key: { type: "string" } }, required: ["op", "key"] },
            { type: "object", properties: { op: { type: "string", enum: ["reload"] } }, required: ["op"] },
            { type: "object", properties: { op: { type: "string", enum: ["snapshot"] }, label: { type: "string" } }, required: ["op", "label"] },
          ],
        },
      },
      reads: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, element: { type: "string", enum: elements }, what: { type: "string", enum: ["count", "visible"] } },
          required: ["name", "element"],
        },
      },
      expect: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["equals", "not_equals", "increased_by", "contains", "not_contains"] },
            left: ref,
            right: { type: ["string", "number"] },
            right_ref: ref,
            base: ref,
            by: { type: "number" },
          },
          required: ["kind", "left"],
        },
      },
    },
    required: ["why_next", "from_state", "page", "behavior", "property", "expectation", "impact", "steps", "reads", "expect"],
  };
}

const EXAMPLE = `Example of a good reply (the ids here are illustrative — use the real ones):
{"why_next":"The page shows a row count and a form; submitting should add exactly one row, and nothing has tested that yet.",
 "from_state":"s0","page":"/","behavior":"Submitting the form adds exactly one row to the table.","property":"consistency",
 "expectation":{"kind":"doc","quote":"<a sentence copied word for word from the inventory that states this>"},"impact":3,
 "steps":[{"op":"fill","control":"c1","value":"sample entry"},{"op":"click","control":"c2"}],
 "reads":[{"name":"rows","element":"r1"}],
 "expect":[{"kind":"increased_by","left":{"snapshot":"after","read":"rows"},"base":{"snapshot":"before","read":"rows"},"by":1}]}`;

const SYSTEM = `You investigate a running web application one experiment at a time, like a careful tester. You are NOT told of any bug and must not assume one exists.

Each turn you see the application's REAL controls and readable elements, each with an id (c1, r2, …), and what earlier experiments found. Propose exactly ONE experiment, as JSON.

Rules:
1. Use ONLY ids that are listed. Never invent a control, a label, a selector or a URL. A step acts on a control by its id ("control"); a read measures an element by its id ("element").
   Each experiment happens on ONE page: name it in "page" (one of the listed routes). The system opens that page for you; every control and element you use must be listed under that route.
2. Say in "why_next" why this experiment is the most informative next step given what is listed and what earlier experiments showed. Do not repeat an experiment already done.
3. State where the expected behavior comes from: "doc"/"test"/"ui" with a quote copied verbatim from the inventory, or "universal" for a property any software of this kind should have. If the documentation, a test name or the UI states a requirement, test that and cite it (doc/test/ui) in preference to a generic property; use "universal" only when nothing in the inventory states it.
4. Express the expectation as a relation between readings ({"snapshot": label, "read": name}). Compare a reading with another reading. A count that should change by N is "increased_by" with base = the earlier reading and by = N (negative for a decrease) — not a literal. Use a literal only if the script typed it or the inventory states it; never guess a number or text.
5. Readings are taken automatically on the page you are on: "before" (just before your first action) and "after" (after your last step); refer to them as {"snapshot":"before","read":NAME}. Only add snapshot steps yourself if you need a reading in between. A "read" names one element id; for a control, "what" may be "visible" or "count" (how many match).
6. Stay inside the product: synthetic data you create yourself, no attacks, never log in or guess credentials — if something needs a sign-in that is not supplied, test what is reachable.
7. "behavior" is one full sentence describing the behavior under test.
8. "from_state": s0 is the fresh application; a later state is what an earlier experiment left behind, reached automatically; use that state's own page.

${EXAMPLE}`;

// ---- planning ------------------------------------------------------------------

export interface Plan {
  hypothesis: Hypothesis;
  /** Control id used by each step (undefined for goto/press/reload/snapshot). */
  stepControls: Array<string | undefined>;
  fromState: string;
  why: string;
  /** Observed element each named reading measures. */
  readElements: Record<string, string>;
}

interface RawStep { op?: string; control?: string; path?: string; value?: string; key?: string; label?: string }
interface RawRead { name?: string; what?: string; element?: string }

/**
 * Translate the model's reply into a Hypothesis bound to observed controls, or
 * say why it cannot be. Nothing is repaired: an unknown id, a control on the
 * wrong page or a goto out of a derived state is a rejection.
 */
export function planFromReply(reply: string, states: StateEntry[], failed: Map<string, string>, inv: Inventory): { plan?: Plan; rejected?: string } {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(reply);
  } catch {
    return { rejected: "reply is not valid JSON" };
  }
  const st = states.find((s) => s.id === o.from_state);
  if (!st) return { rejected: `unknown from_state ${JSON.stringify(o.from_state)}` };
  const controls = new Map(allControls(st.map).map((c) => [c.id, c]));
  const readables = new Map(allReadables(st.map).map((r) => [r.id, r]));
  const routes = new Set(st.map.routes.map((r) => r.path));

  // One experiment, one page: the model names it, every control and reading must belong to it, and the
  // system opens it. The model never has to track navigation, so it cannot get it wrong.
  const page = typeof o.page === "string" ? o.page : st.map.startRoute;
  if (!routes.has(page)) return { rejected: `"page" must be one of the listed routes (${[...routes].join(", ")}), got ${JSON.stringify(o.page)}` };
  if (st.prefix.length && page !== st.map.startRoute) return { rejected: `state ${st.id} is on ${st.map.startRoute}, so an experiment from it must have "page": "${st.map.startRoute}"` };

  let rawSteps = (Array.isArray(o.steps) ? o.steps : []) as RawStep[];
  if (rawSteps.some((x) => x.op === "goto")) return { rejected: 'goto is not a step: choose the page in "page" and the system opens it; every control and element must be on that page' };
  // Protocol: unless the script places snapshots itself, readings are taken before the first action ("before") and after the last step ("after").
  if (!rawSteps.some((x) => x.op === "snapshot")) rawSteps = [{ op: "snapshot", label: "before" }, ...rawSteps, { op: "snapshot", label: "after" }];
  const stepControls: Array<string | undefined> = [];
  const steps: unknown[] = [];
  if (!st.prefix.length && page !== st.map.startRoute) {
    steps.push({ op: "goto", path: page });
    stepControls.push(undefined);
  }
  for (const s of rawSteps) {
    if (s.op === "click" || s.op === "fill") {
      const c = s.control ? controls.get(s.control) : undefined;
      if (!c) return { rejected: `step ${s.op} names ${JSON.stringify(s.control)}, which is not an observed control in ${st.id}` };
      if (failed.has(c.id)) return { rejected: `control ${c.id} is unusable: ${failed.get(c.id)}` };
      if (c.route !== page) return { rejected: `control ${c.id} is on ${c.route}, but this experiment's page is ${page}; use only controls listed under route ${page}` };
      if (s.op === "click" && c.kind === "link" && c.href && c.href !== page) return { rejected: `clicking link ${c.id} leaves ${page}; to test ${c.href} choose it as "page" instead` };
      steps.push(s.op === "click" ? { op: "click", target: c.target } : { op: "fill", target: c.target, value: s.value });
      stepControls.push(c.id);
    } else {
      steps.push(s);
      stepControls.push(undefined);
    }
  }
  const rawReads = (Array.isArray(o.reads) ? o.reads : []) as RawRead[];
  const reads: unknown[] = [];
  const observedSamples = new Map<string, string>();
  const readElements: Record<string, string> = {};
  for (const r of rawReads) {
    const el = r.element ? controls.get(r.element) ?? readables.get(r.element) : undefined;
    if (!el) return { rejected: `read names ${JSON.stringify(r.element)}, which is not an observed element in ${st.id}` };
    if (failed.has(el.id)) return { rejected: `element ${el.id} is unusable: ${failed.get(el.id)}` };
    if (el.route !== page) return { rejected: `read ${r.name}: ${el.id} is on ${el.route}, but this experiment's page is ${page}; use only elements listed under route ${page}` };
    const isReadable = "sample" in el;
    // What to measure follows from what the element is, not from the model's say-so.
    const what = isReadable
      ? (el as ObservedReadable).kind === "count" ? "count" : "text"
      : (el as ObservedControl).kind === "input" || (el as ObservedControl).kind === "textarea" || (el as ObservedControl).kind === "select" ? "value"
      : r.what === "visible" ? "visible" : "count";
    reads.push({ name: r.name, what, target: el.target });
    if (r.name) readElements[r.name] = el.id;
    if (isReadable && r.name) observedSamples.set(r.name, (el as ObservedReadable).sample);
  }

  const parsed = parseHypotheses(JSON.stringify({ hypotheses: [{ ...o, steps, reads }] }), inv);
  const h = parsed.accepted[0];
  if (!h) return { rejected: parsed.rejected[0]?.why ?? parsed.formatError ?? "rejected" };

  h.steps = [...st.prefix, ...h.steps];
  const grounding: Grounding = groundingOf(h, { bound: true, observed: observedSamples });
  h.grounding = grounding;
  h.why = String(o.why_next ?? "").slice(0, 400);
  return { plan: { hypothesis: h, stepControls: [...st.prefixControls, ...stepControls], fromState: st.id, why: h.why, readElements } };
}

// ---- independent check of a cited requirement ------------------------------------

const SUPPORT_SCHEMA = { type: "object", properties: { supports: { type: "boolean" }, reason: { type: "string" } }, required: ["supports", "reason"] };

/**
 * A verbatim quote proves only that the text exists. Before a violation is called a
 * finding, ask — separately, with nothing but the quote and the claim — whether the
 * quote actually states the expectation that failed.
 */
export async function quoteSupports(complete: Completer, quote: string, behavior: string, checks: string): Promise<boolean> {
  const out = replyText(
    await complete({
      system: "You check whether a piece of documentation states a specific expected behavior. Answer strictly from the quoted text; do not use outside knowledge.",
      prompt: `Quoted text:\n"${quote}"\n\nExpected behavior being tested: ${behavior}\nThe test asserts: ${checks}\n\nDoes the quoted text state this expected behavior, or directly imply it? Answer supports=false if the quote is about something else or the assertion goes beyond it.`,
      maxTokens: 300,
      schema: SUPPORT_SCHEMA,
    })
  ).text;
  try {
    return (JSON.parse(out) as { supports?: unknown }).supports === true;
  } catch {
    return false;
  }
}

const relationText = (h: Hypothesis) =>
  h.expect
    .map((r) => (r.kind === "increased_by" ? `${r.left} = ${r.base} + ${r.by}` : `${r.left} ${r.kind.replace("_", " ")} ${JSON.stringify(r.right)}`))
    .join("; ");

// ---- the loop -------------------------------------------------------------------

export interface InvestigateOptions {
  baseUrl: string;
  repoDir?: string;
  complete: Completer;
  ledger: Ledger;
  maxIterations?: number;
  maxMs?: number;
  maxStates?: number;
  outDir?: string;
  headless?: boolean;
  reset?: () => Promise<void>;
  /** Signs a fresh page in. Absent = no session was supplied. */
  setup?: Setup;
}

export interface IterationRecord {
  n: number;
  fromState: string;
  why: string;
  modelCalls: number;
  rejectedProposals: string[];
  skipped?: string;
  hypothesis?: Hypothesis;
  grounding?: Grounding;
  result?: { outcome: HypothesisResult["outcome"]; status: ResultStatus; reason: string };
  readings?: string[];
  durationMs: number;
}

export interface InvestigationReport {
  baseUrl: string;
  startedAt: string;
  inventory: { sha256: string; sections: Array<{ source: string; chars: number }> };
  prerequisites: Prerequisite[];
  blockers: string[];
  states: Array<{ id: string; via: string; routes: number; controls: number }>;
  iterations: IterationRecord[];
  counts: { proposed: number; rejectedProposals: number; duplicates: number; executed: number; findings: number; leads: number; held: number; unknown: number; environment: number };
  metrics: { validObservations: number; groundedStepRate: number; specifiedRate: number; generalRate: number; exploratoryRate: number; executableRate: number };
  stoppedBecause: string;
  ledger: ReturnType<Ledger["summary"]>;
}

const fingerprint = (h: Hypothesis) => JSON.stringify([h.steps, h.reads, h.expect]);

function buildPrompt(inv: Inventory, prereqs: Prerequisite[], states: StateEntry[], current: StateEntry, history: IterationRecord[], failed: Map<string, string>, recentRejections: string[] = []): string {
  const s0 = states[0];
  const parts = [`=== INVENTORY ===\n${inv.text.slice(0, 9000)}\n=== END INVENTORY ===`];
  if (prereqs.length) {
    parts.push(
      `=== PREREQUISITES ===\n${prereqs.map((p) => `${p.kind}: ${p.satisfied ? "an authenticated session is supplied and is used for every run" : "NOT supplied — anything behind it cannot be tested; do not try to sign in"}\n  seen: ${p.evidence.join("; ")}`).join("\n")}`
    );
  }
  parts.push(`=== STATE s0 (fresh application) ===\n${describeMap(s0.map)}`);
  if (current.id !== "s0") parts.push(`=== STATE ${current.id} (reached by: ${current.via}) ===\n${describeMap(current.map)}`);
  if (failed.size) parts.push(`=== ELEMENTS THAT FAILED OR READ EMPTY (unusable — do not use) ===\n${[...failed].map(([id, why]) => `${id}: ${why}`).join("\n")}`);
  const done = history.filter((h) => h.hypothesis);
  parts.push(
    `=== EXPERIMENTS SO FAR ===\n${
      done.length
        ? done
            .map((h) => `#${h.n} from ${h.fromState}: ${h.hypothesis!.behavior}\n   -> ${h.result?.status ?? "not run"}: ${h.result?.reason ?? h.skipped ?? ""}${h.readings?.length ? ` [${h.readings.join(", ")}]` : ""}`)
            .join("\n")
        : "(none yet)"
    }`
  );
  if (recentRejections.length) parts.push(`=== YOUR RECENT PROPOSALS THAT WERE REJECTED (fix these mistakes) ===\n${recentRejections.slice(-3).join("\n")}`);
  parts.push(`Propose the next experiment. from_state is one of: ${states.length > 1 ? `s0, ${current.id}` : "s0"}.`);
  return parts.join("\n\n");
}

export async function investigate(opts: InvestigateOptions): Promise<InvestigationReport> {
  const { baseUrl, ledger } = opts;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const maxMs = opts.maxMs ?? 10 * 60_000;
  const maxIterations = opts.maxIterations ?? 8;
  const browser: Browser = await chromium.launch({ headless: opts.headless ?? true });
  const iterations: IterationRecord[] = [];
  const failed = new Map<string, string>();
  const seen = new Set<string>();
  let stoppedBecause = "iteration cap reached";
  let inv: Inventory = { text: "", sections: [] };
  let prerequisites: Prerequisite[] = [];
  const states: StateEntry[] = [];
  const results: Array<{ r: HypothesisResult; stepControls: Array<string | undefined> }> = [];
  let modelCalls = 0;
  let noPlanInARow = 0;
  const recentRejections: string[] = [];
  const overrides = new Map<string, ResultStatus>();
  let blockers: string[] = [];

  /** A fresh, reset, signed-in page at `prefix`. */
  const pageAt = async (prefix: StateEntry["prefix"]) => {
    await opts.reset?.();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    if (opts.setup) await opts.setup(page);
    await page.goto(baseUrl, { waitUntil: "load", timeout: 20_000 });
    for (const s of prefix) {
      await applyStep(page, baseUrl, s);
      await page.waitForTimeout(250);
    }
    return { ctx, page };
  };

  try {
    const first = await pageAt([]);
    inv = await buildInventory({ repoDir: opts.repoDir, page: first.page, baseUrl });
    const map0 = await observeState(first.page, baseUrl, { crawl: true });
    await first.ctx.close();
    states.push({ id: "s0", prefix: [], prefixControls: [], via: "fresh application", map: map0 });
    prerequisites = detectPrerequisites(inv, map0, Boolean(opts.setup));
    blockers = prerequisites.filter((p) => !p.satisfied).map((p) => `${p.kind} prerequisite: ${p.evidence[0]} — no authenticated session was supplied`);

    for (let n = 1; n <= maxIterations; n++) {
      if (Date.now() - t0 > maxMs) { stoppedBecause = "wall-clock cap reached"; break; }
      const iterStart = Date.now();
      const current = states[states.length - 1];
      const rec: IterationRecord = { n, fromState: current.id, why: "", modelCalls: 0, rejectedProposals: [], durationMs: 0 };
      iterations.push(rec);

      // The reply may only name what is observed in the states it can pick from.
      const pickable = current.id === "s0" ? [states[0]] : [states[0], current];
      const controls = pickable.flatMap((s) => allControls(s.map)).filter((c) => !failed.has(c.id));
      const readables = pickable.flatMap((s) => allReadables(s.map)).filter((r) => !failed.has(r.id));
      const routes = [...new Set(states[0].map.routes.map((r) => r.path))];
      const schema = investigationSchema(pickable.map((s) => s.id), controls, readables, routes);

      let plan: Plan | undefined;
      let feedback = "";
      let modelFailed = false;
      for (let attempt = 0; attempt < 2 && !plan; attempt++) {
        const prompt = buildPrompt(inv, prerequisites, states, current, iterations.slice(0, -1), failed, recentRejections) + feedback;
        let reply: string;
        try {
          ledger.guard(SYSTEM.length + prompt.length, 2000);
          reply = replyText(await opts.complete({ system: SYSTEM, prompt, maxTokens: 2000, schema })).text;
        } catch (e) {
          stoppedBecause = e instanceof BudgetExceeded ? `budget: ${e.message}` : `model call failed: ${redact(String((e as Error).message))}`;
          modelFailed = true;
          break;
        }
        modelCalls++;
        rec.modelCalls++;
        const p = planFromReply(reply, states, failed, inv);
        if (p.plan) plan = p.plan;
        else {
          rec.rejectedProposals.push(p.rejected ?? "rejected");
          recentRejections.push(p.rejected ?? "rejected");
          feedback = `\n\nYour previous proposal was rejected: ${p.rejected}. Propose a different experiment using only listed ids.`;
        }
      }
      if (!plan) {
        rec.durationMs = Date.now() - iterStart;
        if (modelFailed) break;
        // One bad iteration is not the end of the investigation; three in a row is.
        if (++noPlanInARow >= 3) {
          stoppedBecause = "no valid proposal in 3 consecutive iterations";
          break;
        }
        continue;
      }

      noPlanInARow = 0;
      const h = plan.hypothesis;
      h.id = `e${n}`;
      rec.fromState = plan.fromState;
      rec.why = plan.why;
      rec.hypothesis = h;
      rec.grounding = h.grounding;
      const fp = fingerprint(h);
      if (seen.has(fp)) {
        rec.skipped = "identical to an experiment already run";
        rec.durationMs = Date.now() - iterStart;
        continue;
      }
      seen.add(fp);

      const result = await runHypothesis(browser, baseUrl, h, n, opts.reset, opts.setup);
      results.push({ r: result, stepControls: plan.stepControls });
      let status = statusOf(result);
      let reason = result.reason;
      if (status === "finding" && h.expectation.quote) {
        let ok = false;
        try {
          ledger.guard(h.expectation.quote.length + 400, 300);
          ok = await quoteSupports(opts.complete, h.expectation.quote, h.behavior, relationText(h));
          modelCalls++;
        } catch {
          /* an unverifiable citation does not support a finding */
        }
        if (!ok) {
          status = "lead";
          reason += " (the cited text does not state this expectation, so it is a lead, not a finding)";
        }
      }
      overrides.set(h.id, status);
      const bad = result.runs[0]?.steps.findIndex((s) => !s.ok) ?? -1;
      if (result.outcome === "unknown" && bad >= 0) {
        const cid = plan.stepControls[bad];
        if (cid) failed.set(cid, `${result.runs[0].steps[bad].error ?? "failed"}`.slice(0, 80));
        if (blockers.length) reason += ` (${blockers[0].split(":")[0]} unmet — not a product defect)`;
      }
      const last = result.runs[result.runs.length - 1];
      if (result.outcome === "unknown" && bad < 0) {
        const empty = [...new Set(last.readings.filter((q) => q.value === null).map((q) => q.name))];
        for (const name of empty) {
          const id = plan.readElements[name];
          if (id) failed.set(id, "its reading came back empty in the experiment, so nothing could be compared");
        }
        if (empty.length) reason = `reading${empty.length > 1 ? "s" : ""} ${empty.map((n) => `"${n}" (${plan.readElements[n] ?? "?"})`).join(", ")} came back empty, so the expectation could not be judged`;
      }
      rec.result = { outcome: result.outcome, status, reason };
      rec.readings = last?.readings.map((q) => `${q.label}.${q.name}=${JSON.stringify(q.value)}`);
      rec.durationMs = Date.now() - iterStart;

      // Revise: an experiment that ran and changed the app leaves a state the next one can continue from.
      const changed = h.steps.some((s) => s.op === "fill" || s.op === "click");
      if (result.outcome !== "environment" && result.runs[0]?.steps.every((s) => s.ok) && changed && states.length < (opts.maxStates ?? 4)) {
        try {
          const prefix = h.steps.filter((s): s is Exclude<Step, { op: "snapshot" }> => s.op !== "snapshot");
          const at = await pageAt(prefix);
          const map = await observeState(at.page, baseUrl, { crawl: false });
          await at.ctx.close();
          const prefixControls = plan.stepControls.filter((_, i) => h.steps[i].op !== "snapshot");
          states.push({ id: `s${states.length}`, prefix, prefixControls, via: prefix.map(stepText).join(" ; ").slice(0, 160), map });
        } catch {
          /* the state could not be re-reached; the next experiment starts from the fresh app */
        }
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const ran = results.map((x) => x.r);
  const effective = (r: HypothesisResult) => overrides.get(r.hypothesis.id) ?? statusOf(r);
  const count = (s: ResultStatus) => ran.filter((r) => effective(r) === s).length;
  const withHyp = iterations.filter((i) => i.hypothesis);
  const executed = ran.length;
  const stepsTotal = ran.reduce((n, r) => n + r.hypothesis.steps.filter((s) => s.op === "click" || s.op === "fill").length, 0);
  const rate = (g: Grounding) => (withHyp.length ? Number((withHyp.filter((i) => i.grounding === g).length / withHyp.length).toFixed(3)) : 0);
  const report: InvestigationReport = {
    baseUrl,
    startedAt,
    inventory: { sha256: sha256(inv.text), sections: inv.sections },
    prerequisites,
    blockers,
    states: states.map((s) => ({ id: s.id, via: s.via, routes: s.map.routes.length, controls: allControls(s.map).length })),
    iterations,
    counts: {
      proposed: withHyp.length,
      rejectedProposals: iterations.reduce((n, i) => n + i.rejectedProposals.length, 0),
      duplicates: iterations.filter((i) => i.skipped).length,
      executed,
      findings: count("finding"),
      leads: count("lead"),
      held: count("held"),
      unknown: count("unknown"),
      environment: count("environment"),
    },
    metrics: {
      validObservations: ran.reduce((n, r) => n + r.runs.reduce((m, run) => m + run.readings.filter((x) => x.value !== null).length, 0), 0),
      // Every click/fill target comes from an observed control by construction; reported so a regression shows.
      groundedStepRate: stepsTotal ? Number((results.reduce((n, x) => n + x.stepControls.filter(Boolean).length, 0) / stepsTotal).toFixed(3)) : 1,
      specifiedRate: rate("specified"),
      generalRate: rate("general"),
      exploratoryRate: rate("exploratory"),
      executableRate: withHyp.length ? Number((ran.filter((r) => r.runs[0]?.steps.every((s) => s.ok)).length / withHyp.length).toFixed(3)) : 0,
    },
    stoppedBecause,
    ledger: ledger.summary(),
  };
  if (opts.outDir) {
    fs.mkdirSync(opts.outDir, { recursive: true });
    fs.writeFileSync(path.join(opts.outDir, "investigation-report.json"), redact(JSON.stringify(report, null, 2)));
  }
  return report;
}
