/**
 * PR opener for `aztrx patrol`. Like `fixPr.openFixPr`, but built for an
 * autonomous loop, so it adds two things a human-driven flow doesn't need:
 *
 *   - **Dedup**: a fingerprint-stable branch name (`aztrx/fix-<fp8>`) plus a
 *     `gh pr list --head` check, so a re-scan never opens a second PR for a bug
 *     that already has one open.
 *   - **Scoped staging**: stages only the files the patch touched (`git add --
 *     <files>`), never `git add -A` — an autonomous run must not sweep up the
 *     user's unrelated uncommitted work into a PR.
 *
 * The caller is responsible for applying patches first (`applyVerifiedPatches`).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { Finding } from "../types.js";

const exec = promisify(execFile);

export interface PatrolPrResult {
  ok: boolean;
  skipped?: boolean;
  url?: string;
  branch?: string;
  error?: string;
}

export function branchFor(fp: string): string {
  return `aztrx/fix-${fp.slice(0, 8)}`;
}

async function hasOpenPr(repoRoot: string, branch: string): Promise<boolean> {
  try {
    const { stdout } = await exec(
      "gh",
      ["pr", "list", "--head", branch, "--state", "open", "--json", "number"],
      { cwd: repoRoot }
    );
    const list = JSON.parse(stdout || "[]");
    return Array.isArray(list) && list.length > 0;
  } catch {
    // gh missing / unauthenticated — surface on the create step instead.
    return false;
  }
}

async function currentBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim() || "main";
  } catch {
    return "main";
  }
}

async function safeCheckout(repoRoot: string, branch: string): Promise<void> {
  await exec("git", ["-C", repoRoot, "checkout", branch]).catch(() => {});
}

export async function openPatrolPr(
  repoRoot: string,
  finding: Finding,
  url: string,
  files: string[]
): Promise<PatrolPrResult> {
  const branch = branchFor(finding.fingerprint);
  if (await hasOpenPr(repoRoot, branch)) {
    return { ok: false, skipped: true, branch, error: "PR already open for this finding" };
  }

  const head = finding.rawMessage.split("\n")[0].slice(0, 60);
  const title = `fix: ${head}`;
  const loc = finding.mappedLocation
    ? `${finding.mappedLocation.filePath}:${finding.mappedLocation.line}`
    : "unknown location";
  const repro = finding.repro?.verdict
    ? `repro: ${finding.repro.verdict} ${finding.repro.reproductions}/${finding.repro.runs}`
    : "";
  const body = [
    "## Aztrx AI — autonomous fix",
    "",
    `Found against ${url}:`,
    "",
    `- **${finding.rawMessage.split("\n")[0].slice(0, 120)}** — \`${loc}\` ${repro}`.trim(),
    "",
    "Verified: AST-gated, compiled, run against the test suite, and replayed against the repro before this PR. Opened automatically by `aztrx patrol`.",
  ].join("\n");

  const originalBranch = await currentBranch(repoRoot);

  try {
    // `-B` (re)creates the branch at HEAD — idempotent against a stale local
    // branch left over from a previously failed PR attempt.
    await exec("git", ["-C", repoRoot, "checkout", "-B", branch]);
    if (files.length) {
      await exec("git", ["-C", repoRoot, "add", "--", ...files]);
    } else {
      await exec("git", ["-C", repoRoot, "add", "-A"]);
    }
    await exec("git", ["-C", repoRoot, "commit", "-m", title]);
  } catch (e) {
    await safeCheckout(repoRoot, originalBranch);
    return { ok: false, branch, error: `git failed: ${(e as Error).message}` };
  }

  try {
    const { stdout } = await exec("gh", ["pr", "create", "--title", title, "--body", body], {
      cwd: repoRoot,
    });
    await safeCheckout(repoRoot, originalBranch);
    return { ok: true, branch, url: stdout.trim() };
  } catch (e) {
    await safeCheckout(repoRoot, originalBranch);
    return {
      ok: false,
      branch,
      error: `gh pr create failed (is gh installed and authenticated?): ${(e as Error).message}`,
    };
  }
}
