/**
 * Protocol smoke tests for the Karnezz agent interface, against the local model.
 * Each stage is independent and reports its own verdict; none of this is an
 * evaluation — the fixture is a tiny app of ours (bench/karnezz/dev), not a task.
 *
 *   AZTRX_API_BASE=http://localhost:11434/v1 AZTRX_MODEL=qwen3.5:9b \
 *     npx tsx bench/karnezz/smoke.ts [--bug] [--stage 1|2|3|all]
 *
 *   1  the model emits schema-valid, validated hypotheses (format_error vs no_hypotheses)
 *   2  the first hypothesis becomes ONE executable experiment with real readings
 *   3  the baseline agent makes valid tool calls and gets real page observations
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { completeDetailed, completeWithTools, setUsageSink } from "../../src/core/llm.js";
import { generateHypotheses } from "../../src/core/hypothesis/generate.js";
import { buildInventory } from "../../src/core/hypothesis/inventory.js";
import { prioritize, runHypothesis } from "../../src/core/hypothesis/execute.js";
import { runBaseline } from "../../src/core/hypothesis/baseline.js";
import { Ledger } from "../../src/core/hypothesis/ledger.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dev = path.join(here, "dev");
const bug = process.argv.includes("--bug");
const stageArg = process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : "all";
const want = (n: string) => stageArg === "all" || stageArg === n;

if (!process.env.AZTRX_API_BASE || !process.env.AZTRX_MODEL) {
  console.error("set AZTRX_API_BASE and AZTRX_MODEL");
  process.exit(2);
}

const ledger = new Ledger();
setUsageSink(ledger.record);

function startApp(): Promise<{ url: string; stop: () => void; reset: () => Promise<void> }> {
  const child = spawn(process.execPath, [path.join(dev, "notes-app.mjs"), "0", ...(bug ? ["--bug"] : [])], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      const m = String(d).match(/listening (\d+)/);
      if (m) {
        const url = `http://127.0.0.1:${m[1]}`;
        resolve({ url, stop: () => child.kill(), reset: async () => void (await fetch(`${url}/__reset`, { method: "POST" })) });
      }
    });
    child.on("error", reject);
  });
}

const results: Array<{ stage: string; pass: boolean; detail: Record<string, unknown> }> = [];
const record = (stage: string, pass: boolean, detail: Record<string, unknown>) => {
  results.push({ stage, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${stage}`, JSON.stringify(detail));
};

const app = await startApp();
const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  const inv = await buildInventory({ repoDir: dev, page, baseUrl: app.url });
  const completer = (req: { system: string; prompt: string; maxTokens: number; schema?: object }) => completeDetailed(req);

  // Stage 1 — structured hypotheses.
  const t1 = Date.now();
  const before1 = ledger.summary();
  const gen = await generateHypotheses(inv, completer, 4);
  const first = gen.accepted[0];
  if (want("1")) {
    record("1-hypothesis", gen.status === "ok", {
      status: gen.status,
      formatError: gen.formatError ?? null,
      finishReason: gen.finishReason ?? null,
      accepted: gen.accepted.length,
      rejected: gen.rejected,
      sources: gen.accepted.map((h) => h.expectation.kind),
      outputTokens: ledger.summary().outputTokens - before1.outputTokens,
      ms: Date.now() - t1,
    });
  }

  // Stage 2 — one hypothesis → one executable experiment.
  if (want("2")) {
    if (!first) record("2-experiment", false, { reason: "no accepted hypothesis from stage 1", status: gen.status });
    else {
      const [{ h, priority }] = prioritize([first]);
      const t2 = Date.now();
      const r = await runHypothesis(browser, app.url, h, priority, app.reset);
      const run = r.runs[0];
      const stepsOk = run?.steps.filter((s) => s.ok).length ?? 0;
      const readings = run?.readings.filter((x) => x.value !== null).length ?? 0;
      // Pass = the experiment really ran and produced readings. Whether it was decisive
      // (outcome) is reported, not required: `unknown` is the honest record of a model
      // that read the wrong element.
      record("2-experiment", stepsOk === (run?.steps.length ?? -1) && readings > 0, {
        decisive: r.outcome !== "unknown",
        behavior: h.behavior,
        outcome: r.outcome,
        reason: r.reason,
        stepsExecuted: `${stepsOk}/${run?.steps.length ?? 0}`,
        readingsObserved: readings,
        ms: Date.now() - t2,
      });
    }
  }

  // Stage 3 — baseline tool contract.
  if (want("3")) {
    await app.reset();
    const t3 = Date.now();
    const before3 = ledger.summary();
    const b = await runBaseline({ baseUrl: app.url, repoDir: dev, callTools: completeWithTools, ledger, maxTurns: 8, maxMs: 5 * 60_000 });
    const after3 = ledger.summary();
    record("3-baseline", b.metrics.validToolCalls > 0 && b.metrics.observations > 0, {
      ...b.metrics,
      stoppedBecause: b.stoppedBecause,
      claims: b.claims.length,
      tokens: { in: after3.inputTokens - before3.inputTokens, out: after3.outputTokens - before3.outputTokens },
      ms: Date.now() - t3,
      trace: b.turns.map((t) => `${t.status}:${JSON.stringify(t.act).slice(0, 90)}`),
    });
  }
} finally {
  await browser.close().catch(() => undefined);
  app.stop();
}

const s = ledger.summary();
console.log(JSON.stringify({ fixture: bug ? "notes-app --bug" : "notes-app", model: process.env.AZTRX_MODEL, calls: s.calls, inputTokens: s.inputTokens, outputTokens: s.outputTokens, elapsedMs: s.elapsedMs, passed: results.filter((r) => r.pass).length, of: results.length }));
process.exit(results.every((r) => r.pass) ? 0 : 1);
