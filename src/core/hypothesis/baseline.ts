/**
 * The comparison arm: a plain tool-using agent loop. Same model client, same
 * inventory text, same browser primitives and the same spend/time/step budget
 * as the hypothesis pipeline — and none of its structure: no stated hypotheses,
 * no prioritization, no replay-before-report, no outcome taxonomy. It decides
 * what to do next turn by turn and reports what it believes is a bug.
 *
 * Whether either arm's claims are real is decided afterwards by the same
 * independent evaluation, never by the arm itself.
 */

import { chromium } from "playwright";
import type { Completer } from "./generate.js";
import { Ledger, BudgetExceeded, redact } from "./ledger.js";
import { locate } from "./execute.js";
import { buildInventory } from "./inventory.js";
import type { Target } from "./types.js";

const SYSTEM = `You are testing a running web application for behavioral defects, acting like a real user. You are NOT told of any bug and must not assume one exists.

Each turn reply with ONLY one JSON object, one of:
 {"act":"goto","path":"/x"}
 {"act":"click","target":T}
 {"act":"fill","target":T,"value":string}
 {"act":"press","key":string}
 {"act":"reload"}
 {"act":"look"}                      (see the current page: title, url, visible text, controls)
 {"act":"report","claim":string,"why_it_is_wrong":string}   (you found a defect; say what you did and saw)
 {"act":"done"}
T is an object with any of: text, label, placeholder, role, selector.
Stay inside the product: same-origin only, synthetic data, no attacks, no deleting data you did not create.
Report only what you actually observed in this session, with the exact steps.`;

export interface BaselineReport {
  turns: Array<{ act: unknown; observation: string }>;
  claims: Array<{ claim: string; why_it_is_wrong: string; atTurn: number }>;
  stoppedBecause: string;
  ledger: ReturnType<Ledger["summary"]>;
}

export async function runBaseline(opts: {
  baseUrl: string;
  repoDir?: string;
  complete: Completer;
  ledger: Ledger;
  /** Same budgets the pipeline ran under. */
  maxTurns: number;
  maxMs: number;
  maxTokensPerTurn?: number;
}): Promise<BaselineReport> {
  const browser = await chromium.launch({ headless: true });
  const turns: BaselineReport["turns"] = [];
  const claims: BaselineReport["claims"] = [];
  let stoppedBecause = "agent said done";
  const t0 = Date.now();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const inv = await buildInventory({ repoDir: opts.repoDir, page, baseUrl: opts.baseUrl });
    await page.goto(opts.baseUrl, { waitUntil: "load" });
    const transcript: string[] = [];
    const look = async () =>
      (await page.evaluate(() => `url: ${location.pathname}${location.search}\ntitle: ${document.title}\ntext: ${document.body.innerText.replace(/\s+/g, " ").slice(0, 1500)}`).catch(() => "(no page)"));

    for (let i = 0; i < opts.maxTurns; i++) {
      if (Date.now() - t0 > opts.maxMs) { stoppedBecause = "wall-clock cap reached"; break; }
      const prompt = `=== INVENTORY ===\n${inv.text}\n=== END INVENTORY ===\n\nHistory (latest last):\n${transcript.slice(-24).join("\n") || "(none yet)"}\n\nTurn ${i + 1} of ${opts.maxTurns}. Reply with one JSON action.`;
      const maxTokens = opts.maxTokensPerTurn ?? 700;
      let reply: string;
      try {
        opts.ledger.guard(SYSTEM.length + prompt.length, maxTokens);
        reply = await opts.complete({ system: SYSTEM, prompt, maxTokens });
      } catch (e) {
        stoppedBecause = e instanceof BudgetExceeded ? `budget: ${e.message}` : `model call failed: ${redact(String((e as Error).message))}`;
        break;
      }
      let act: Record<string, unknown>;
      try {
        act = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
      } catch {
        turns.push({ act: reply.slice(0, 200), observation: "unparseable reply" });
        transcript.push(`#${i + 1} (unparseable reply)`);
        continue;
      }
      let obs = "ok";
      try {
        const T = act.target as Target;
        switch (act.act) {
          case "goto": await page.goto(new URL(String(act.path), opts.baseUrl).toString(), { waitUntil: "load", timeout: 20_000 }); obs = await look(); break;
          case "click": await locate(page, T).click({ timeout: 8_000 }); await page.waitForTimeout(300); obs = await look(); break;
          case "fill": await locate(page, T).fill(String(act.value), { timeout: 8_000 }); obs = "filled"; break;
          case "press": await page.keyboard.press(String(act.key)); await page.waitForTimeout(300); obs = await look(); break;
          case "reload": await page.reload({ waitUntil: "load" }); obs = await look(); break;
          case "look": obs = await look(); break;
          case "report":
            claims.push({ claim: String(act.claim), why_it_is_wrong: String(act.why_it_is_wrong), atTurn: i + 1 });
            obs = "recorded";
            break;
          case "done": stoppedBecause = "agent said done"; i = opts.maxTurns; break;
          default: obs = "unknown action";
        }
      } catch (e) {
        obs = `failed: ${String((e as Error).message).split("\n")[0]}`;
      }
      turns.push({ act, observation: obs.slice(0, 600) });
      transcript.push(`#${i + 1} ${JSON.stringify(act)} -> ${obs.slice(0, 500)}`);
      if (i === opts.maxTurns - 1) stoppedBecause = "turn cap reached";
    }
    await ctx.close();
  } finally {
    await browser.close().catch(() => undefined);
  }
  return { turns, claims, stoppedBecause, ledger: opts.ledger.summary() };
}
