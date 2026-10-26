/**
 * No-hint discovery, end to end:
 *
 *   inventory → hypotheses → priority → experiments → outcomes → ledger
 *
 * The app is already running at `baseUrl` (started by whoever owns the
 * environment); this module never starts, builds or patches it, and takes no
 * argument that could carry a bug description or a revision to diff against.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright";
import { generateHypotheses, type Completer, type GenerationStatus } from "./generate.js";
import { buildInventory } from "./inventory.js";
import { BudgetExceeded, Ledger, redact, sha256 } from "./ledger.js";
import { prioritize, runHypothesis } from "./execute.js";
import type { Hypothesis, HypothesisResult, Outcome } from "./types.js";

export interface DiscoverOptions {
  baseUrl: string;
  /** Working tree of the app's source (docs and test names are read from it). */
  repoDir?: string;
  complete: Completer;
  ledger: Ledger;
  maxHypotheses?: number;
  /** Cap on experiments executed. */
  maxExperiments?: number;
  /** Wall-clock cap for the whole attempt. */
  maxMs?: number;
  /** Where the report JSON goes. */
  outDir?: string;
  headless?: boolean;
  /** Return the app to its starting state; called before every run. */
  reset?: () => Promise<void>;
}

export interface DiscoveryReport {
  baseUrl: string;
  startedAt: string;
  inventory: { sha256: string; sections: Array<{ source: string; chars: number }>; text: string };
  prompt: string;
  reply: string;
  /** How hypothesis generation ended — `format_error` and `no_hypotheses` are different failures. */
  generation: { status: GenerationStatus | "call_failed"; formatError?: string; finishReason?: string };
  hypotheses: Hypothesis[];
  rejected: Array<{ index: number; why: string }>;
  results: HypothesisResult[];
  notRun: Array<{ id: string; why: string }>;
  counts: Record<Outcome, number> & { generated: number; executed: number };
  /** Readings that returned a real value (not null) across all executed runs. */
  observations: number;
  stoppedBecause: string;
  /** `reset-per-run` when the environment was restored before each run. */
  isolation: "reset-per-run" | "shared-state";
  ledger: ReturnType<Ledger["summary"]>;
}

export async function discover(opts: DiscoverOptions): Promise<DiscoveryReport> {
  const { baseUrl, ledger } = opts;
  const startedAt = new Date().toISOString();
  const maxMs = opts.maxMs ?? 10 * 60_000;
  const t0 = Date.now();
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const report: Partial<DiscoveryReport> = { baseUrl, startedAt };
  let stoppedBecause = "all prioritized hypotheses executed";
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const inv = await buildInventory({ repoDir: opts.repoDir, page, baseUrl });
    await ctx.close();
    report.inventory = { sha256: sha256(inv.text), sections: inv.sections, text: redact(inv.text) };

    const guarded: Completer = async (req) => {
      ledger.guard(req.system.length + req.prompt.length, req.maxTokens);
      return opts.complete(req);
    };
    let accepted: Hypothesis[] = [];
    let rejected: Array<{ index: number; why: string }> = [];
    let prompt = "";
    let reply = "";
    let generation: DiscoveryReport["generation"] = { status: "call_failed" };
    try {
      const g = await generateHypotheses(inv, guarded, opts.maxHypotheses ?? 12);
      ({ accepted, rejected, prompt, reply } = g);
      generation = { status: g.status, ...(g.formatError ? { formatError: g.formatError } : {}), ...(g.finishReason ? { finishReason: g.finishReason } : {}) };
      if (g.status !== "ok") stoppedBecause = `no experiments: generation ${g.status}${g.formatError ? ` (${g.formatError})` : ""}`;
    } catch (e) {
      stoppedBecause = e instanceof BudgetExceeded ? `budget: ${e.message}` : `generation failed: ${redact(String((e as Error).message))}`;
    }
    Object.assign(report, { prompt: redact(prompt), reply: redact(reply), generation, hypotheses: accepted, rejected });

    const ordered = prioritize(accepted);
    const results: HypothesisResult[] = [];
    const notRun: Array<{ id: string; why: string }> = accepted
      .filter((h) => !ordered.some((o) => o.h.id === h.id))
      .map((h) => ({ id: h.id, why: "near-duplicate of a higher-priority hypothesis" }));
    for (const { h, priority } of ordered) {
      if (results.length >= (opts.maxExperiments ?? 12)) {
        stoppedBecause = "experiment cap reached";
        notRun.push({ id: h.id, why: stoppedBecause });
        continue;
      }
      if (Date.now() - t0 > maxMs) {
        stoppedBecause = "wall-clock cap reached";
        notRun.push({ id: h.id, why: stoppedBecause });
        continue;
      }
      results.push(await runHypothesis(browser, baseUrl, h, priority, opts.reset));
    }
    report.results = results;
    report.notRun = notRun;
  } finally {
    await browser.close().catch(() => undefined);
  }

  const results = report.results ?? [];
  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  const full: DiscoveryReport = {
    baseUrl,
    startedAt,
    inventory: report.inventory ?? { sha256: "", sections: [], text: "" },
    prompt: report.prompt ?? "",
    reply: report.reply ?? "",
    generation: report.generation ?? { status: "call_failed" },
    hypotheses: report.hypotheses ?? [],
    rejected: report.rejected ?? [],
    results,
    notRun: report.notRun ?? [],
    counts: {
      generated: (report.hypotheses ?? []).length,
      executed: results.length,
      supported_violation: count("supported_violation"),
      disproven: count("disproven"),
      unknown: count("unknown"),
      environment: count("environment"),
    },
    observations: results.reduce((n, r) => n + r.runs.reduce((m, run) => m + run.readings.filter((x) => x.value !== null).length, 0), 0),
    stoppedBecause,
    isolation: opts.reset ? "reset-per-run" : "shared-state",
    ledger: ledger.summary(),
  };
  if (opts.outDir) {
    fs.mkdirSync(opts.outDir, { recursive: true });
    fs.writeFileSync(path.join(opts.outDir, "discovery-report.json"), redact(JSON.stringify(full, null, 2)));
  }
  return full;
}

export * from "./types.js";
export { Ledger, pricingFromEnv, BudgetExceeded, findLeaks, redact } from "./ledger.js";
export { parseHypotheses, generateHypotheses, HYPOTHESES_SCHEMA, type GenerationStatus } from "./generate.js";
export { prioritize, judge } from "./execute.js";
