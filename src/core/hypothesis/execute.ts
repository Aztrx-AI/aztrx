/**
 * Stages 3–5: prioritize, execute, classify.
 *
 * A script runs in a fresh browser context; readings are taken at snapshots;
 * relations are judged by the shared invariant evaluator. A violation is only
 * reported after a second, independent session reproduces it — a surprising
 * observation is a lead, not a finding.
 */

import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { evaluateInvariant, type ExecutedAction, type ObservedState } from "../invariant.js";
import type { Hypothesis, HypothesisResult, Outcome, Reading, Relation, RunTrace, Step, Target } from "./types.js";

// ---- prioritize -----------------------------------------------------------

const SOURCE_WEIGHT = { doc: 1, test: 1, ui: 0.7, universal: 0.5 } as const;

/**
 * Expected information per unit of cost. A claim anchored in the project's own
 * words is worth more than a generic property, a failure that would hurt users
 * is worth more than a cosmetic one, and a short script is cheaper than a long
 * one. Heuristic and uncalibrated — it orders, it does not estimate probability.
 */
export function priority(h: Hypothesis): number {
  const cost = 1 + h.steps.length / 6;
  return Number(((h.impact * SOURCE_WEIGHT[h.expectation.kind]) / cost).toFixed(3));
}

/** Highest priority first; near-duplicates (same property, same first target)
 * are dropped so the budget is not spent re-testing one idea. */
export function prioritize(hs: Hypothesis[]): Array<{ h: Hypothesis; priority: number }> {
  const seen = new Set<string>();
  return hs
    .map((h) => ({ h, priority: priority(h) }))
    .sort((a, b) => b.priority - a.priority || a.h.id.localeCompare(b.h.id))
    .filter(({ h }) => {
      const first = h.steps.find((s) => s.op === "click" || s.op === "fill") as Extract<Step, { target: Target }> | undefined;
      const key = `${h.property}|${JSON.stringify(first?.target ?? h.reads[0].target)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// ---- execute --------------------------------------------------------------

const STEP_TIMEOUT = 8_000;

export function locate(page: Page, t: Target): Locator {
  if (t.selector) return page.locator(t.selector).first();
  if (t.label) return page.getByLabel(t.label, { exact: false }).first();
  if (t.placeholder) return page.getByPlaceholder(t.placeholder, { exact: false }).first();
  if (t.role) {
    return page.getByRole(t.role as Parameters<Page["getByRole"]>[0], t.text ? { name: t.text } : undefined).first();
  }
  return page.getByText(t.text as string, { exact: false }).first();
}

const locateAll = (page: Page, t: Target): Locator => {
  if (t.selector) return page.locator(t.selector);
  if (t.label) return page.getByLabel(t.label, { exact: false });
  if (t.placeholder) return page.getByPlaceholder(t.placeholder, { exact: false });
  if (t.role) return page.getByRole(t.role as Parameters<Page["getByRole"]>[0], t.text ? { name: t.text } : undefined);
  return page.getByText(t.text as string, { exact: false });
};

export async function read(page: Page, r: Hypothesis["reads"][number]): Promise<Reading["value"]> {
  try {
    if (r.what === "count") return await locateAll(page, r.target).count();
    const loc = locate(page, r.target);
    if (r.what === "visible") return await loc.isVisible({ timeout: 1500 });
    if ((await loc.count()) === 0) return null;
    if (r.what === "value") return await loc.inputValue({ timeout: 1500 });
    return ((await loc.innerText({ timeout: 1500 })) ?? "").replace(/\s+/g, " ").trim();
  } catch {
    return null;
  }
}

const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const m = v.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m && /^[^\d-]*-?\d[\d,]*(?:\.\d+)?[^\d]*$/.test(v) ? Number(m[0]) : undefined;
};

function lookup(readings: Reading[], ref: string): Reading["value"] | undefined {
  const [label, name] = ref.split(".");
  return readings.find((r) => r.label === label && r.name === name)?.value;
}

/** True/false when it can be judged, null when a reading it needs is missing. */
export function judge(rel: Relation, readings: Reading[]): boolean | null {
  const left = lookup(readings, rel.left);
  if (left === undefined || left === null) return null;
  const rightOf = (r: string | number): Reading["value"] | undefined => {
    if (typeof r === "string" && /^[\w-]+\.[\w-]+$/.test(r) && readings.some((x) => `${x.label}.${x.name}` === r)) return lookup(readings, r);
    return r;
  };
  switch (rel.kind) {
    case "equals":
    case "not_equals": {
      const right = rightOf(rel.right);
      if (right === undefined || right === null) return null;
      const ln = num(left);
      const rn = num(right);
      const eq = ln !== undefined && rn !== undefined ? ln === rn : String(left).trim() === String(right).trim();
      return rel.kind === "equals" ? eq : !eq;
    }
    case "increased_by": {
      const base = num(lookup(readings, rel.base));
      const l = num(left);
      return base === undefined || l === undefined ? null : l - base === rel.by;
    }
    case "contains":
      return String(left).toLowerCase().includes(rel.right.toLowerCase());
    case "not_contains":
      return !String(left).toLowerCase().includes(rel.right.toLowerCase());
  }
}

const ENV_ERR = /ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ECONNREFUSED|net::ERR_(?:ABORTED|FAILED)|ERR_EMPTY_RESPONSE/i;

async function runOnce(ctx: BrowserContext, baseUrl: string, h: Hypothesis): Promise<RunTrace> {
  const page = await ctx.newPage();
  const origin = new URL(baseUrl).origin;
  const environment: string[] = [];
  page.on("response", (r) => {
    if (r.url().startsWith(origin) && r.status() >= 500) environment.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  page.on("requestfailed", (r) => {
    if (r.url().startsWith(origin) && ENV_ERR.test(r.failure()?.errorText ?? "")) environment.push(`request failed ${new URL(r.url()).pathname}`);
  });

  const trace: RunTrace = { steps: [], readings: [], relations: [], environment };
  const first = h.steps[0];
  if (!first || first.op !== "goto") await page.goto(baseUrl, { waitUntil: "load", timeout: 20_000 }).catch((e) => environment.push(String(e.message).split("\n")[0]));

  for (const step of h.steps) {
    try {
      switch (step.op) {
        case "goto":
          await page.goto(new URL(step.path, baseUrl).toString(), { waitUntil: "load", timeout: 20_000 });
          break;
        case "click":
          await locate(page, step.target).click({ timeout: STEP_TIMEOUT });
          break;
        case "fill":
          await locate(page, step.target).fill(step.value, { timeout: STEP_TIMEOUT });
          break;
        case "press":
          await page.keyboard.press(step.key);
          break;
        case "reload":
          await page.reload({ waitUntil: "load", timeout: 20_000 });
          break;
        case "snapshot":
          await page.waitForTimeout(300);
          for (const r of h.reads) trace.readings.push({ label: step.label, name: r.name, value: await read(page, r) });
          break;
      }
      trace.steps.push({ step, ok: true });
      if (step.op !== "snapshot") await page.waitForTimeout(250);
    } catch (e) {
      const error = String((e as Error).message ?? e).split("\n")[0];
      trace.steps.push({ step, ok: false, error });
      if (ENV_ERR.test(error)) environment.push(error);
      break;
    }
  }
  trace.relations = h.expect.map((relation) => ({ relation, held: judge(relation, trace.readings) }));
  await page.close().catch(() => undefined);
  return trace;
}

function verdictOf(h: Hypothesis, trace: RunTrace) {
  const flags: Record<string, boolean | string | number> = {};
  trace.readings.forEach((r) => {
    if (r.value !== null) flags[`${r.label}.${r.name}`] = r.value;
  });
  trace.relations.forEach((r, i) => {
    if (r.held !== null) flags[`rel${i}`] = r.held;
  });
  const state: ObservedState = { flags };
  const actions: ExecutedAction[] = trace.steps.filter((s) => s.ok).map((s) => ({ kind: s.step.op === "goto" || s.step.op === "reload" ? "navigate" : s.step.op === "fill" ? "setInput" : s.step.op === "snapshot" ? "request" : "click", target: JSON.stringify(s.step) }));
  return evaluateInvariant(
    {
      id: h.id,
      subject: h.behavior,
      precondition: () => trace.steps.every((s) => s.ok) && trace.relations.every((r) => r.held !== null),
      expectation: () => trace.relations.every((r) => r.held === true),
    },
    state,
    actions,
    state
  ).verdict;
}

/**
 * `reset` returns the app to its starting state. It runs before every run: a
 * replay that starts from the state the first run left behind is not an
 * independent reproduction, and neither is a hypothesis that starts from what
 * the previous one created. Without it the caller accepts shared state, and the
 * report says so.
 */
export async function runHypothesis(
  browser: Browser,
  baseUrl: string,
  h: Hypothesis,
  prio: number,
  reset?: () => Promise<void>
): Promise<HypothesisResult> {
  const t0 = Date.now();
  const fresh = () => browser.newContext({ viewport: { width: 1280, height: 800 } });
  const runs: RunTrace[] = [];
  const done = (outcome: Outcome, reason: string): HypothesisResult => ({ hypothesis: h, priority: prio, outcome, reason, runs, durationMs: Date.now() - t0 });

  let ctx = await fresh();
  try {
    await reset?.();
    const a = await runOnce(ctx, baseUrl, h);
    runs.push(a);
    const v = verdictOf(h, a);
    if (a.environment.length && v !== "preserved") return done("environment", `app dependency failed during the run: ${a.environment[0]}`);
    if (v === "unknown") {
      const bad = a.steps.find((s) => !s.ok);
      return done("unknown", bad ? `step could not run (${JSON.stringify(bad.step)}): ${bad.error}` : "a reading the expectation needs was not available");
    }
    if (v === "preserved") return done("disproven", "the script ran in full and every relation held");

    await ctx.close();
    ctx = await fresh();
    await reset?.();
    const b = await runOnce(ctx, baseUrl, h);
    runs.push(b);
    if (b.environment.length) return done("environment", `app dependency failed on replay: ${b.environment[0]}`);
    return verdictOf(h, b) === "violated"
      ? done("supported_violation", "violated in two independent sessions")
      : done("unknown", reset ? "violated once but did not reproduce after a reset" : "violated once but did not reproduce in a fresh session (app state was shared between runs, so this may be state left by the first run)");
  } finally {
    await ctx.close().catch(() => undefined);
  }
}
