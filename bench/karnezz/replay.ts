/**
 * Evaluator-side replay: run one arm-produced hypothesis against two running
 * instances (buggy and fixed) and print both outcomes. Holds no sealed material.
 *
 *   npx tsx bench/karnezz/replay.ts <discovery-report.json> <hypothesis-id> <buggyUrl> <fixedUrl>
 */
import * as fs from "node:fs";
import { chromium } from "playwright";
import { runHypothesis } from "../../src/core/hypothesis/execute.js";
import type { Hypothesis } from "../../src/core/hypothesis/types.js";

const [reportPath, id, buggyUrl, fixedUrl] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { hypotheses: Hypothesis[] };
const h = report.hypotheses.find((x) => x.id === id);
if (!h) throw new Error(`no hypothesis ${id}`);
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, url] of [["buggy", buggyUrl], ["fixed", fixedUrl]] as const) {
    const r = await runHypothesis(browser, url, h, 1);
    console.log(JSON.stringify({ revision: name, outcome: r.outcome, reason: r.reason, readings: r.runs.map((x) => x.readings.map((q) => `${q.label}.${q.name}=${JSON.stringify(q.value)}`)) }));
  }
} finally {
  await browser.close();
}
