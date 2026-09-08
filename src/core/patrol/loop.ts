/**
 * `aztrx patrol` — the autonomous bug-patrol loop. It wraps the existing
 * `run()` detect → repro → heal pipeline in a supervisor loop with memory, so
 * instead of "run it and read the output" the tool re-scans on an interval,
 * fixes anything new, and opens a PR per bug — no human in the middle.
 *
 * Guardrails that keep an autonomous run from going off the rails:
 *   - memory (PatrolState) — a handled fingerprint is never re-fixed/re-PR'd;
 *   - per-session fix cap (`maxFixes`) — bounds LLM spend + PR spam;
 *   - scoped staging — PRs carry only the files the patch touched;
 *   - a liveness check — a dead target skips the cycle instead of burning a crawl.
 */

import pc from "picocolors";
import { run } from "../orchestrator.js";
import { applyVerifiedPatches } from "../heal/apply.js";
import type { Finding } from "../types.js";
import type { SpendBudget } from "../heal/types.js";
import { PatrolState } from "./state.js";
import { openPatrolPr } from "./pr.js";

export interface PatrolOptions {
  url: string;
  repoRoot: string;
  intervalMs: number;
  maxFixes?: number;
  maxActions?: number;
  /** Hard cap on paid LLM generations across the whole session (0/undefined = unlimited). */
  maxSpend?: number;
  once?: boolean;
  // Pass-through to run():
  fuzz?: boolean;
  workers?: number;
  allowHosts?: string[];
  storageState?: string;
  login?: boolean;
  loginEmail?: string;
  loginPassword?: string;
  loginUrl?: string;
  healModel?: string;
  healFastModel?: string;
  testCommand?: string;
  testTimeoutMs?: number;
  skipTest?: boolean;
  startCommand?: string;
  lang?: string;
  seed?: number;
  allowDestructive?: boolean;
  httpFuzz?: boolean;
  httpFuzzMutations?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Any HTTP response means the server is up; only a network failure is "down". */
async function isAlive(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

function head(f: Finding): string {
  return f.rawMessage.split("\n")[0].slice(0, 50);
}

export async function patrol(opts: PatrolOptions): Promise<void> {
  const state = new PatrolState(opts.repoRoot, opts.url);
  const maxFixes = opts.maxFixes ?? 5;
  let sessionFixes = 0;
  // One budget object is shared across every cycle so the cap spans the session,
  // not just a single run.
  const budget: SpendBudget | undefined =
    opts.maxSpend && opts.maxSpend > 0 ? { remaining: opts.maxSpend } : undefined;

  console.log(pc.cyan("Aztrx AI — patrol"));
  console.log(
    pc.dim(
      `Target: ${opts.url}   interval: ${Math.round(opts.intervalMs / 1000)}s   max fixes/session: ${maxFixes}` +
        (budget ? `   spend cap: ${budget.remaining} generations` : "")
    )
  );
  console.log("");

  for (let cycle = 1; ; cycle++) {
    if (!(await isAlive(opts.url))) {
      console.log(pc.dim(`[cycle ${cycle}] target not responding — skipping this pass.`));
      if (opts.once) break;
      await sleep(opts.intervalMs);
      continue;
    }

    console.log(pc.dim(`[cycle ${cycle}] scanning…`));

    let findings: Finding[];
    try {
      // `ui: true` silences the per-run console so patrol prints its own concise
      // summary instead of the full pipeline log on every cycle.
      findings = await run({
        url: opts.url,
        repoRoot: opts.repoRoot,
        maxActions: opts.maxActions,
        fuzz: opts.fuzz,
        workers: opts.workers,
        allowHosts: opts.allowHosts,
        storageState: opts.storageState,
        login: opts.login,
        loginEmail: opts.loginEmail,
        loginPassword: opts.loginPassword,
        loginUrl: opts.loginUrl,
        lang: opts.lang,
        seed: opts.seed,
        allowDestructive: opts.allowDestructive,
        httpFuzz: opts.httpFuzz,
        httpFuzzMutations: opts.httpFuzzMutations,
        repro: true,
        heal: true,
        healModel: opts.healModel,
        healFastModel: opts.healFastModel,
        testCommand: opts.testCommand,
        testTimeoutMs: opts.testTimeoutMs,
        skipTest: opts.skipTest,
        startCommand: opts.startCommand,
        // Already-handled fingerprints from a prior cycle get skipped before heal,
        // so a re-scan re-detects (to confirm they're still gone) without re-paying
        // the LLM to re-fix them.
        skipHealFingerprints: state.handled(),
        budget,
        ui: true,
      });
    } catch (e) {
      console.log(pc.red(`[cycle ${cycle}] run failed: ${(e as Error).message}`));
      if (opts.once) break;
      await sleep(opts.intervalMs);
      continue;
    }

    // Reproducible but not healed → mark unfixable so we don't re-burn the LLM
    // on it every cycle. (Phase 2 will back off and retry on a cooldown.)
    // `budget-exhausted` / `no-llm` are NOT unfixable — they mean we never got a
    // real attempt, so they must not be written into memory as "won't fix".
    for (const f of findings) {
      if (
        (f.severity === "crash" || f.severity === "error") &&
        f.repro &&
        f.heal &&
        f.heal.status !== "healed" &&
        f.heal.status !== "budget-exhausted" &&
        f.heal.status !== "no-llm" &&
        !state.isHandled(f.fingerprint)
      ) {
        state.markUnfixed(f.fingerprint);
      }
    }

    const newHealed = findings.filter(
      (f) => f.heal?.status === "healed" && !state.isHandled(f.fingerprint)
    );

    if (newHealed.length === 0) {
      console.log(pc.dim(`[cycle ${cycle}] ${findings.length} finding(s) — nothing new to fix.`));
    }

    for (const f of newHealed) {
      if (sessionFixes >= maxFixes) {
        console.log(
          pc.yellow(`[cycle ${cycle}] reached max fixes (${maxFixes}) — no more PRs this session.`)
        );
        break;
      }

      const applied = applyVerifiedPatches(opts.repoRoot, [f]);
      if (applied.applied.length === 0) {
        state.markUnfixed(f.fingerprint);
        console.log(pc.yellow(`  ◐ ${head(f)} — apply conflict, marked unfixable.`));
        continue;
      }

      const files = applied.applied.map((a) => a.filePath);
      const pr = await openPatrolPr(opts.repoRoot, f, opts.url, files);

      if (pr.ok && pr.url) {
        sessionFixes++;
        state.markPr(f.fingerprint, pr.url, pr.branch ?? "");
        console.log(pc.green(`  ✓ PR opened ${pr.url} — ${head(f)}`));
      } else if (pr.skipped) {
        state.markPr(f.fingerprint, "existing", pr.branch ?? "");
        console.log(pc.dim(`  — already has a PR (${pr.branch})`));
      } else {
        state.markUnfixed(f.fingerprint);
        console.log(pc.red(`  ✗ PR failed: ${pr.error}`));
      }
    }

    // Once the session's paid budget is spent there's nothing left to fix — stop
    // rather than silently re-detecting without healing.
    if (budget && budget.remaining <= 0) {
      console.log(pc.yellow(`\nSpend budget exhausted — ${sessionFixes} PR(s) opened this session.`));
      break;
    }

    state.save();

    if (opts.once) break;
    await sleep(opts.intervalMs);
  }

  console.log(pc.dim(`patrol session done — ${sessionFixes} PR(s) opened.`));
}
