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
import { openPatrolPr, openPatrolBatchPr } from "./pr.js";
import { recordFindingGif } from "./record.js";

export interface PatrolOptions {
  url: string;
  repoRoot: string;
  intervalMs: number;
  maxFixes?: number;
  maxActions?: number;
  /** Hard cap on paid LLM generations across the whole session (0/undefined = unlimited). */
  maxSpend?: number;
  /** Cooldown before an `unfixed` fingerprint is retried, ms. Default 30 min. */
  retryAfterMs?: number;
  /** Group all of a cycle's fixes into one PR instead of one PR per bug. */
  batch?: boolean;
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

/** Best-effort GIF recording — a failed capture must never block a PR. */
async function recordGif(repoRoot: string, url: string, f: Finding): Promise<string | null> {
  try {
    return await recordFindingGif(repoRoot, url, f);
  } catch (e) {
    console.log(pc.dim(`  · recorded repro skipped: ${(e as Error).message}`));
    return null;
  }
}

export async function patrol(opts: PatrolOptions): Promise<void> {
  const retryAfterMs = opts.retryAfterMs ?? 30 * 60 * 1000;
  const state = new PatrolState(opts.repoRoot, opts.url, retryAfterMs);
  const maxFixes = opts.maxFixes ?? 5;
  let sessionFixes = 0;
  let sessionPrs = 0;
  const seenFp = new Set<string>();
  // One budget object is shared across every cycle so the cap spans the session,
  // not just a single run.
  const budget: SpendBudget | undefined =
    opts.maxSpend && opts.maxSpend > 0 ? { remaining: opts.maxSpend } : undefined;

  console.log(pc.cyan("Aztrx AI — patrol"));
  console.log(
    pc.dim(
      `Target: ${opts.url}   interval: ${Math.round(opts.intervalMs / 1000)}s   max fixes/session: ${maxFixes}` +
        `   retry unfixed after: ${Math.round(retryAfterMs / 1000)}s` +
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

    // "found" = distinct crash/error fingerprints ever seen this session.
    for (const f of findings) {
      if (f.severity === "crash" || f.severity === "error") seenFp.add(f.fingerprint);
    }

    // Reproducible but not healed → mark unfixable so we don't re-burn the LLM on
    // it every cycle; `PatrolState` backs off and retries it once the cooldown
    // lapses. `budget-exhausted` / `no-llm` are NOT unfixable — they mean we never
    // got a real attempt, so they must not be written into memory as "won't fix".
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

    const toFix = newHealed.slice(0, Math.max(0, maxFixes - sessionFixes));
    if (toFix.length === 0 && sessionFixes >= maxFixes && newHealed.length > 0) {
      console.log(pc.yellow(`[cycle ${cycle}] reached max fixes (${maxFixes}) — no more this session.`));
    }

    if (opts.batch) {
      // Batch: apply each patch, then open one PR carrying every fix that landed.
      const landed: Finding[] = [];
      const files: string[] = [];
      for (const f of toFix) {
        const applied = applyVerifiedPatches(opts.repoRoot, [f]);
        if (applied.applied.length === 0) {
          state.markUnfixed(f.fingerprint);
          console.log(pc.yellow(`  ◐ ${head(f)} — apply conflict, marked unfixable.`));
          continue;
        }
        landed.push(f);
        for (const a of applied.applied) files.push(a.filePath);
      }

      if (landed.length > 0) {
        const mediaPaths: (string | null)[] = [];
        for (const f of landed) mediaPaths.push(await recordGif(opts.repoRoot, opts.url, f));
        const pr = await openPatrolBatchPr(opts.repoRoot, landed, opts.url, [...new Set(files)], mediaPaths);
        if (pr.ok && pr.url) {
          sessionPrs++;
          sessionFixes += landed.length;
          for (const f of landed) state.markPr(f.fingerprint, pr.url, pr.branch ?? "");
          console.log(pc.green(`  ✓ batch PR opened ${pr.url} — ${landed.length} fix(es)`));
        } else if (pr.skipped) {
          for (const f of landed) state.markPr(f.fingerprint, "existing", pr.branch ?? "");
          console.log(pc.dim(`  — batch PR already exists (${pr.branch})`));
        } else {
          for (const f of landed) state.markUnfixed(f.fingerprint);
          console.log(pc.red(`  ✗ batch PR failed: ${pr.error}`));
        }
      }
    } else {
      for (const f of toFix) {
        const applied = applyVerifiedPatches(opts.repoRoot, [f]);
        if (applied.applied.length === 0) {
          state.markUnfixed(f.fingerprint);
          console.log(pc.yellow(`  ◐ ${head(f)} — apply conflict, marked unfixable.`));
          continue;
        }

        const files = applied.applied.map((a) => a.filePath);
        const mediaPath = await recordGif(opts.repoRoot, opts.url, f);
        const pr = await openPatrolPr(opts.repoRoot, f, opts.url, files, mediaPath);

        if (pr.ok && pr.url) {
          sessionPrs++;
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
    }

    // Rolling status — the "found / fixed / PRs" tally that makes the loop read
    // as alive rather than a stream of isolated lines.
    console.log(
      pc.dim(
        `[cycle ${cycle}] found ${seenFp.size} · fixed ${sessionFixes} · PRs ${sessionPrs}` +
          (newHealed.length === 0 ? " · nothing new to fix" : "")
      )
    );

    // Once the session's paid budget is spent there's nothing left to fix — stop
    // rather than silently re-detecting without healing.
    if (budget && budget.remaining <= 0) {
      console.log(pc.yellow(`\nSpend budget exhausted — ${sessionPrs} PR(s) opened this session.`));
      break;
    }

    state.save();

    if (opts.once) break;
    await sleep(opts.intervalMs);
  }

  console.log(pc.cyan(`patrol session done — found ${seenFp.size} bug(s) · fixed ${sessionFixes} · PRs ${sessionPrs}`));
}
