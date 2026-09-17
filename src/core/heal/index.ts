/**
 * F10 — closed-loop healing. Orchestrates the full loop, in order:
 *
 *   1. redact   — strip secrets from anything that will leave the machine
 *   2. generate — ask an LLM for a Search & Replace diff (against the redacted
 *                 file, unredacted before it touches the raw bytes)
 *   3. gate     — re-parse the patched file; reject new imports / eval /
 *                 child_process / empty catch
 *   4. sandbox  — apply the patch in a detached git worktree, never the tree
 *   5. test     — run the repo's own test suite; reject the patch if it goes red
 *   6. verify   — replay the repro against the patched app; the bug must be gone
 *   7. hand off — write a unified-diff `.patch` for a human to review and commit
 *
 * Aztrx never commits. A patch that fails any gate, does not apply exactly, or
 * still reproduces the bug is rejected and reported, not silently kept.
 */

import { createServer } from "http";
import * as fs from "fs";
import * as path from "path";
import { redact, unredact } from "./redact.js";
import { auditPatch } from "./gates.js";
import { generatePatch, generateRulePatch, modelTiers, RULE_TIER, BudgetExhaustedError } from "./llm.js";
import { hasLlmKey } from "../llm.js";
import type { ModelTier } from "./llm.js";
import { applyHunks, applyHunksLoose, createWorktree, diffWorktree, runTests, typecheckWorktree, writeWorktreeFile } from "./sandbox.js";
import { bootServer, detectStartCommand } from "./boot.js";
import { verifyFix, verifySecretFix } from "./verify.js";
import type { Finding } from "../types.js";
import type { HealContext, HealOptions, HealResult, Patch, TestGateResult, VerifyResult } from "./types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

/** Can this file be verification-served as-is? Only a self-contained HTML
 * document. Static serving hands back raw bytes with no build step, so a `.tsx`
 * arrives as text the browser will not execute — the code under test never runs
 * and the crash cannot reproduce. Fixtures qualify; app sources never do. */
function isStaticEntry(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".html" || ext === ".htm";
}

/** Default verification server: serve the worktree's repo root statically and
 * address the mapped file directly. Works for static fixtures; real apps boot
 * the patched worktree instead (see the serve selection in `heal`). */
function staticServe(worktreeDir: string, filePath: string): Promise<{ url: string; close: () => Promise<void> }> {
  const entry = filePath.split(path.sep).join("/");
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      let p = path.normalize(path.join(worktreeDir, pathname));
      const root = path.resolve(worktreeDir);
      if (p !== root && !p.startsWith(root + path.sep)) {
        res.statusCode = 403;
        res.end("forbidden");
        return;
      }
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
      try {
        const body = fs.readFileSync(p);
        res.setHeader("Content-Type", MIME[path.extname(p).toLowerCase()] ?? "text/plain");
        res.end(body);
      } catch {
        res.statusCode = 404;
        res.end("not found");
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/${entry}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function saveArtifact(
  repoRoot: string,
  finding: Finding,
  patch: Patch,
  gateOk: boolean,
  verification: HealResult["verification"],
  worktreeDir: string,
  filePath: string
): Promise<string> {
  const dir = path.join(repoRoot, ".aztrx", "heal");
  fs.mkdirSync(dir, { recursive: true });
  const diff = await diffWorktree(worktreeDir, filePath);
  const diffPath = path.join(dir, `${finding.id}.patch`);
  fs.writeFileSync(diffPath, diff || `# (no unified diff produced)\n`, "utf-8");
  fs.writeFileSync(
    path.join(dir, `${finding.id}.json`),
    JSON.stringify({ explanation: patch.explanation, hunks: patch.hunks, gateOk, verification }, null, 2),
    "utf-8"
  );
  return diffPath;
}

export async function heal(finding: Finding, opts: HealOptions): Promise<HealResult> {
  const base: HealResult = {
    status: "skipped",
    findingId: finding.id,
    filePath: finding.mappedLocation?.filePath ?? "",
    hunks: [],
    violations: [],
  };

  const loc = finding.mappedLocation;
  if (!loc || !loc.isOwnCode) {
    return { ...base, error: "no own-code source location to heal" };
  }
  if (!finding.repro || finding.repro.verdict === "unreliable") {
    return { ...base, error: "no deterministic repro to verify against" };
  }

  // Verification has to run the *patched* code, and there are only two ways to
  // do that. Booting the worktree runs the real app, but needs a start command.
  // Static serving runs anything, but with no build step and no bundler — so a
  // `.tsx` comes back as text the browser will not execute, the patched code
  // never runs, and the crash "not reproducing" means nothing. Only a
  // self-contained HTML document is honest to static-serve (the fixture path).
  //
  // So: an injected serve hook wins, then booting, then static — and when none
  // applies we refuse. Both checks run before paying the LLM, so an unverifiable
  // finding skips cleanly instead of after an expensive generation.
  const isNetwork = finding.type === "network_5xx";
  const startCommand = opts.startCommand ?? detectStartCommand(opts.repoRoot);
  const filePath = loc.filePath;
  if (!opts.serve && !startCommand) {
    if (isNetwork || !isStaticEntry(filePath)) {
      return {
        ...base,
        error: isNetwork
          ? "no start command for server heal (set --start-command, or add scripts.dev / scripts.start)"
          : `cannot verify a patch to ${filePath} without running it — a statically served source file never executes, so "fixed" would be unprovable. Set --start-command, or add scripts.dev / scripts.start to package.json`,
      };
    }
  }

  const absPath = path.resolve(opts.repoRoot, filePath);
  let original: string;
  try {
    original = fs.readFileSync(absPath, "utf-8");
  } catch (e) {
    return { ...base, error: `cannot read ${filePath}: ${(e as Error).message}` };
  }

  // 1. Redact — only the redacted copy is shown to the model.
  const red = redact(original);
  const ctx: HealContext = { finding, filePath, fileContent: original, redactedContent: red.text };

  // A free, no-key rule-based fix (null/undefined deref) — tried before any LLM.
  const rulePatch = !opts.patchFn ? generateRulePatch(ctx) : null;

  // No transport configured, and no rule fix applies → nothing to try.
  if (!opts.patchFn && !hasLlmKey() && !rulePatch) {
    return {
      ...base,
      status: "no-llm",
      error: "this crash needs a model — the free fixer only handles null/undefined derefs. Add a key: Anthropic → ANTHROPIC_API_KEY, or any provider → AZTRX_API_BASE + AZTRX_API_KEY + AZTRX_MODEL (no Aztrx account needed)",
    };
  }

  // The Smart Cloud Router tier plan: the free rule fix first, then fast/cheap,
  // then Sonnet. An injected patchFn collapses to a single tier. Paid tiers are
  // enqueued only when a key is actually configured — otherwise the last tier
  // throws "…_API_KEY is not set" and overwrites the specific failure the free
  // rule tier already reported (test-failed, compile-failed, …), telling the
  // user to add a key when the real problem was something else entirely.
  const tiers: ModelTier[] = [
    ...(rulePatch ? [{ model: RULE_TIER, label: "fast" as const }] : []),
    ...(opts.patchFn
      ? [{ model: opts.model ?? "default", label: "sonnet" as const }]
      : hasLlmKey()
        ? modelTiers(opts.model, opts.fastModel)
        : []),
  ];

  const wt = await createWorktree(opts.repoRoot, finding.id);
  // The winning (or last) patch + verification, held back for the final save.
  let savedPatch: Patch | null = null;
  let savedVerification: VerifyResult | null = null;
  let savedTest: TestGateResult | null = null;
  let savedGateOk = false;
  let last: HealResult = base;
  // Multi-model consensus: with AZTRX_CONSENSUS, try every tier and keep the
  // smallest-diff fix that actually heals, instead of the first one that works.
  const consensus = Boolean(process.env.AZTRX_CONSENSUS);
  let best: { result: HealResult; patch: Patch; verification: VerifyResult; gateOk: boolean; diffSize: number } | null = null;

  try {
    for (const tier of tiers) {
      // 2. Generate (this tier).
      let patch: Patch;
      try {
        patch = await generatePatch(ctx, { model: tier.model, patchFn: opts.patchFn, budget: opts.budget });
      } catch (e) {
        // A spent session budget stops everything paid; a transport/config failure
        // won't be fixed by a pricier tier either, so both break out here. Keep an
        // earlier tier's gate failure (test-failed, unfixed, …) — it names a real
        // problem the user can act on, where "no key" would mask it.
        if (e instanceof BudgetExhaustedError || last.status === base.status) {
          last = e instanceof BudgetExhaustedError
            ? { ...base, status: "budget-exhausted", error: e.message, model: tier.model }
            : { ...base, status: "no-llm", error: (e as Error).message, model: tier.model };
        }
        break;
      }

      if (patch.hunks.length === 0) {
        last = {
          ...base,
          status: "rejected",
          explanation: patch.explanation,
          error: "model produced no edits",
          model: tier.model,
        };
        continue; // a higher tier may still produce a real edit
      }

      // Unredact the diff back onto the raw bytes before anything is applied.
      let hunks = patch.hunks.map((h) => ({
        search: unredact(h.search, red.map),
        replace: unredact(h.replace, red.map),
      }));

      // Apply in memory (exact-match), then gate the resulting file.
      let applied = applyHunks(original, hunks);
      if (!applied.ok) {
        // The classic LLM diff artifact: a space added after the marker
        // ("-  <script>" instead of "- <script>") pads every line by one.
        // One relaxed retry — drop a single leading space from every line of
        // both sides — before declaring the patch unapplicable.
        const drop = (s: string) =>
          s
            .split("\n")
            .map((l) => (l.startsWith(" ") ? l.slice(1) : l))
            .join("\n");
        const relaxed = hunks.map((h) => ({ search: drop(h.search), replace: drop(h.replace) }));
        if (relaxed.some((h, i) => h.search !== hunks[i].search)) {
          const retry = applyHunks(original, relaxed);
          if (retry.ok) {
            hunks = relaxed;
            applied = retry;
          }
        }
      }
      if (!applied.ok) {
        // Model diffs also drift by a space on SOME lines only (context lines
        // copied with one less indent than the file). Trimmed-content matching
        // tolerates that — same gate and verification still apply afterwards.
        applied = applyHunksLoose(original, hunks);
      }
      if (!applied.ok) {
        last = {
          ...base,
          status: "apply-failed",
          hunks,
          explanation: patch.explanation,
          error: applied.errors.join("; "),
          model: tier.model,
        };
        continue;
      }

      const gate = auditPatch(original, applied.patched, filePath);
      if (!gate.ok) {
        last = {
          ...base,
          status: "rejected",
          hunks,
          explanation: patch.explanation,
          violations: gate.violations,
          model: tier.model,
        };
        continue;
      }

      // 3. Sandbox — apply in a detached worktree.
      const writeErr = writeWorktreeFile(wt.dir, filePath, applied.patched);
      if (writeErr) {
        last = {
          ...base,
          status: "apply-failed",
          hunks,
          explanation: patch.explanation,
          error: writeErr,
          model: tier.model,
        };
        continue;
      }

      // 3b. Compile fast-fail — reject a patch that doesn't typecheck before
      // paying for the Playwright verification loop.
      const compile = await typecheckWorktree(wt.dir, opts.repoRoot);
      if (!compile.ok) {
        last = {
          ...base,
          status: "compile-failed",
          hunks,
          explanation: patch.explanation,
          error: compile.output.slice(0, 400) || "tsc --noEmit failed",
          model: tier.model,
        };
        continue;
      }

      // 3c. Test gate — run the repo's own test suite against the patched
      // worktree. A patch that breaks tests is rejected before we pay for the
      // Playwright verification, so "autonomous fixing" never regresses checks.
      const test: TestGateResult = opts.skipTest
        ? { ran: false, ok: true, command: "", output: "" }
        : await runTests(wt.dir, opts.repoRoot, {
            command: opts.testCommand,
            timeoutMs: opts.testTimeoutMs,
          });
      if (test.ran) savedTest = test;
      if (test.ran && !test.ok) {
        last = {
          ...base,
          status: "test-failed",
          hunks,
          explanation: patch.explanation,
          error: test.output.slice(0, 400) || `${test.command} failed`,
          model: tier.model,
        };
        continue;
      }

      // 4. Verify — the bug must stop reproducing, against the *patched* code.
      // Mirror the selection made before generation: an injected hook wins, then
      // booting the worktree, then static serving for a real HTML entry.
      // Secret leaks verify by re-scanning the patched page (the replay engine
      // cannot re-drive a static scan).
      const serve =
        opts.serve ??
        (startCommand
          ? (dir: string) => bootServer({ worktreeDir: dir, repoRoot: opts.repoRoot, startCommand })
          : (dir: string, fp: string) => staticServe(dir, fp));
      const v =
        finding.type === "secret_leak"
          ? await verifySecretFix({ serve: () => serve(wt.dir, filePath), finding })
          : await verifyFix({
              url: opts.url,
              actions: opts.actions,
              fingerprint: opts.fingerprint,
              runs: opts.verifyRuns ?? 3,
              serve: () => serve(wt.dir, filePath),
              targetType: isNetwork ? finding.type : undefined,
              seedState: opts.seedState,
            });

      savedPatch = patch;
      savedVerification = v;
      savedGateOk = gate.ok;

      last = {
        ...base,
        status: v.fixed ? "healed" : "unfixed",
        explanation: patch.explanation,
        hunks,
        violations: gate.violations,
        verification: v,
        model: tier.model,
      };
      if (v.fixed) {
        const diffSize = hunks.reduce((s, h) => s + h.replace.length, 0);
        if (!best || diffSize < best.diffSize) {
          best = { result: last, patch, verification: v, gateOk: gate.ok, diffSize };
        }
        if (!consensus) break;
      }
    }

    if (best) {
      last = best.result;
      savedPatch = best.patch;
      savedVerification = best.verification;
      savedGateOk = best.gateOk;
    }

    // 5. Hand off a reviewable patch (the winning — or last — attempt only).
    if (savedPatch && savedVerification) {
      last.patchPath = await saveArtifact(
        opts.repoRoot,
        finding,
        savedPatch,
        savedGateOk,
        savedVerification,
        wt.dir,
        filePath
      );
    }

    return { ...last, test: savedTest ?? undefined, tiers: tiers.map((t) => t.model) };
  } finally {
    await wt.cleanup();
  }
}
