/**
 * F10 — closed-loop healing. Orchestrates the full loop, in order:
 *
 *   1. redact   — strip secrets from anything that will leave the machine
 *   2. generate — ask an LLM for a Search & Replace diff (against the redacted
 *                 file, unredacted before it touches the raw bytes)
 *   3. gate     — re-parse the patched file; reject new imports / eval /
 *                 child_process / empty catch
 *   4. sandbox  — apply the patch in a detached git worktree, never the tree
 *   5. verify   — replay the repro against the patched app; the bug must be gone
 *   6. hand off — write a unified-diff `.patch` for a human to review and commit
 *
 * Aztrx never commits. A patch that fails any gate, does not apply exactly, or
 * still reproduces the bug is rejected and reported, not silently kept.
 */

import { createServer } from "http";
import * as fs from "fs";
import * as path from "path";
import { redact, unredact } from "./redact.js";
import { auditPatch } from "./gates.js";
import { generatePatch } from "./llm.js";
import { applyHunks, createWorktree, diffWorktree, writeWorktreeFile } from "./sandbox.js";
import { verifyFix } from "./verify.js";
import type { Finding } from "../types.js";
import type { HealContext, HealOptions, HealResult, Patch } from "./types.js";

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

/** Default verification server: serve the worktree's repo root statically and
 * address the mapped file directly. Works for static fixtures; real apps inject
 * their own dev-server `serve` fn. */
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

  const filePath = loc.filePath;
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

  // 2. Generate.
  let patch: Patch;
  try {
    patch = await generatePatch(ctx, { model: opts.model, patchFn: opts.patchFn });
  } catch (e) {
    return { ...base, status: "no-llm", error: (e as Error).message };
  }

  if (patch.hunks.length === 0) {
    return { ...base, status: "rejected", explanation: patch.explanation, error: "model produced no edits" };
  }

  // Unredact the diff back onto the raw bytes before anything is applied.
  const hunks = patch.hunks.map((h) => ({
    search: unredact(h.search, red.map),
    replace: unredact(h.replace, red.map),
  }));

  // Apply in memory (exact-match), then gate the resulting file.
  const applied = applyHunks(original, hunks);
  if (!applied.ok) {
    return { ...base, status: "apply-failed", hunks, explanation: patch.explanation, error: applied.errors.join("; ") };
  }

  const gate = auditPatch(original, applied.patched, filePath);
  if (!gate.ok) {
    return { ...base, status: "rejected", hunks, explanation: patch.explanation, violations: gate.violations };
  }

  // 3. Sandbox — apply in a detached worktree.
  const wt = await createWorktree(opts.repoRoot, finding.id);
  try {
    const writeErr = writeWorktreeFile(wt.dir, filePath, applied.patched);
    if (writeErr) {
      return { ...base, status: "apply-failed", hunks, explanation: patch.explanation, error: writeErr };
    }

    // 4. Verify — the bug must stop reproducing.
    const serve = opts.serve ?? ((dir, fp) => staticServe(dir, fp));
    const v = await verifyFix({
      url: opts.url,
      actions: opts.actions,
      fingerprint: opts.fingerprint,
      runs: opts.verifyRuns ?? 3,
      serve: () => serve(wt.dir, filePath),
    });

    // 5. Hand off a reviewable patch.
    const patchPath = await saveArtifact(opts.repoRoot, finding, patch, gate.ok, v, wt.dir, filePath);

    return {
      ...base,
      status: v.fixed ? "healed" : "unfixed",
      explanation: patch.explanation,
      hunks,
      violations: gate.violations,
      verification: v,
      patchPath,
    };
  } finally {
    await wt.cleanup();
  }
}
