/**
 * Run ONE arm of the no-hint pilot against an app that is already running.
 *
 *   npx tsx bench/karnezz/run.ts --arm pipeline|baseline --url http://localhost:PORT \
 *     --repo <source tree, .git removed> --out <dir> [--cap 2] [--reset "<shell command>"]
 *
 * Credentials are taken ONLY from AZTRX_API_BASE / AZTRX_API_KEY / AZTRX_MODEL
 * and prices from AZTRX_PRICE_IN / AZTRX_PRICE_OUT. The ambient OPENAI_* variables
 * are deliberately cleared first: whatever else a shell happens to export, this
 * run never reaches for a credential nobody configured for it.
 *
 * Both arms get the same model, inventory, browser primitives and budgets.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { completeDetailed, completeWithTools, isOllama, resolveSettings, setUsageSink } from "../../src/core/llm.js";
import { discover } from "../../src/core/hypothesis/index.js";
import { runBaseline } from "../../src/core/hypothesis/baseline.js";
import { Ledger, pricingFromEnv, redact } from "../../src/core/hypothesis/ledger.js";

delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function die(msg: string): never {
  console.error(`karnezz: ${msg}`);
  process.exit(2);
}

const arm = arg("arm");
const url = arg("url");
const out = arg("out");
if ((arm !== "pipeline" && arm !== "baseline") || !url || !out) die("usage: --arm pipeline|baseline --url <app> --out <dir> [--repo <dir>] [--cap <usd>] [--reset <cmd>]");

const base = process.env.AZTRX_API_BASE?.trim();
if (!base || !process.env.AZTRX_MODEL) die("set AZTRX_API_BASE and AZTRX_MODEL for this project (nothing else is read)");
// A local Ollama endpoint needs no key and costs nothing; anything else is paid and must be priced and keyed.
const local = isOllama(resolveSettings());
if (!local && !process.env.AZTRX_API_KEY) die("set AZTRX_API_KEY. OpenAI: AZTRX_API_BASE=https://api.openai.com/v1");
const pricing = local ? { inputPerM: 0, outputPerM: 0 } : pricingFromEnv();
if (!pricing) die("set AZTRX_PRICE_IN and AZTRX_PRICE_OUT (USD per 1M tokens) so the spend cap can be enforced");

// Per-arm cap: two arms at the default stay under the $5 pilot limit with margin.
const capUsd = Number(arg("cap", "2"));
if (!(capUsd > 0) || capUsd > 2.5) die("--cap must be in (0, 2.5] so both arms fit the $5 pilot limit");

const ledger = new Ledger({ capUsd, pricing });
setUsageSink(ledger.record);

const repoDir = arg("repo");
const resetCmd = arg("reset");
const reset = resetCmd ? async () => void execSync(resetCmd, { stdio: "ignore", timeout: 120_000 }) : undefined;
const completer = (req: { system: string; prompt: string; maxTokens: number; schema?: object }) => completeDetailed(req);

const BUDGET = { maxMs: 10 * 60_000, experiments: 12, turns: 40 };

fs.mkdirSync(out, { recursive: true });
const meta = {
  arm,
  model: process.env.AZTRX_MODEL,
  provider: new URL(base).host,
  capUsd,
  budgets: BUDGET,
  repoDir: repoDir ?? null,
  startedAt: new Date().toISOString(),
};

try {
  if (arm === "pipeline") {
    const r = await discover({ baseUrl: url, repoDir, complete: completer, ledger, maxMs: BUDGET.maxMs, maxExperiments: BUDGET.experiments, outDir: out, reset });
    console.log(JSON.stringify({ ...meta, generation: r.generation, counts: r.counts, observations: r.observations, stoppedBecause: r.stoppedBecause, ledger: r.ledger }, null, 2));
  } else {
    const r = await runBaseline({ baseUrl: url, repoDir, callTools: completeWithTools, ledger, maxTurns: BUDGET.turns, maxMs: BUDGET.maxMs });
    fs.writeFileSync(path.join(out, "baseline-report.json"), redact(JSON.stringify({ ...meta, ...r }, null, 2)));
    console.log(JSON.stringify({ ...meta, claims: r.claims.length, metrics: r.metrics, stoppedBecause: r.stoppedBecause, ledger: r.ledger }, null, 2));
  }
} catch (e) {
  die(redact(String((e as Error).message ?? e)));
}
