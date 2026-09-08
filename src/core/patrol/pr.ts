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
import { createHash } from "crypto";
import type { Finding } from "../types.js";
import { diagnoseFinding } from "../diagnose.js";
import { sanitizeSecrets } from "../heal/redact.js";

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

/** Stable branch name for a *set* of fingerprints — the same set always maps to
 * the same branch, so a re-scan of an unchanged batch doesn't open a duplicate PR. */
export function branchForSet(fps: string[]): string {
  const h = createHash("sha1").update([...fps].sort().join("\n")).digest("hex").slice(0, 8);
  return `aztrx/fix-batch-${h}`;
}

function headTitle(f: Finding): string {
  return f.rawMessage.split("\n")[0].slice(0, 60);
}

/** A `localhost`/loopback target is a dev box; anything else is a deployed app,
 * so a crash there is "live in production" and worth flagging loudly. */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host === "::1" || host === "::" || host === "0.0.0.0") return true;
    return /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return true; // unparseable target → assume local, don't scare-monger
  }
}

/** Per-finding "before/after" narrative: the crash ("before"), a one-line *why*
 * from the deterministic diagnosis, and the healed fix explanation ("after").
 * Plain words rather than a stack trace, so a reviewer who never ran the scan
 * still understands the PR at a glance. Untrusted text is secret-scrubbed. */
function findingBlock(f: Finding, i: number): string {
  const head = sanitizeSecrets(f.rawMessage.split("\n")[0].trim());
  const loc = f.mappedLocation
    ? `\`${f.mappedLocation.filePath}:${f.mappedLocation.line}\``
    : "unknown location";
  const why = diagnoseFinding(f);
  const fix =
    f.heal?.status === "healed" && f.heal.explanation
      ? sanitizeSecrets(f.heal.explanation.trim())
      : "";
  const repro = f.repro?.verdict
    ? `_repro: ${f.repro.verdict} ${f.repro.reproductions}/${f.repro.runs}_`
    : "";

  const lines: string[] = [`### ${i}. ${head.length > 96 ? head.slice(0, 93) + "…" : head}`];
  lines.push(`- **Where:** ${loc}`);
  if (why) lines.push(`- **Why:** ${why}`);
  if (fix) lines.push(`- **The fix:** ${fix.length > 400 ? fix.slice(0, 397) + "…" : fix}`);
  if (repro) lines.push(`- ${repro}`);
  return lines.join("\n");
}

const PROD_BANNER =
  "> ⚠️ **This crash is live in production right now** — the target isn't a local dev server.";

const VERIFIED_NOTE =
  "Verified: AST-gated, compiled, run against the test suite, and replayed against the repro before this PR. Opened automatically by `aztrx patrol`.";

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

/** Shared git plumbing: (re)create the branch at HEAD, stage only the touched
 * files, commit, open the PR, and return to the original branch. The caller has
 * already done its own dedup + title/body. */
async function createPr(
  repoRoot: string,
  branch: string,
  title: string,
  body: string,
  files: string[]
): Promise<PatrolPrResult> {
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

  const body = [
    "## Aztrx AI — autonomous fix",
    "",
    ...(isLocalUrl(url) ? [] : [PROD_BANNER, ""]),
    `Found against ${url}:`,
    "",
    findingBlock(finding, 1),
    "",
    VERIFIED_NOTE,
  ].join("\n");
  return createPr(repoRoot, branch, `fix: ${headTitle(finding)}`, body, files);
}

/** One PR carrying a whole batch of fixes. Branch is stable across the *set*, so
 * an unchanged batch re-scan dedups to the same PR. */
export async function openPatrolBatchPr(
  repoRoot: string,
  findings: Finding[],
  url: string,
  files: string[]
): Promise<PatrolPrResult> {
  const branch = branchForSet(findings.map((f) => f.fingerprint));
  if (await hasOpenPr(repoRoot, branch)) {
    return { ok: false, skipped: true, branch, error: "batch PR already open" };
  }

  const n = findings.length;
  const body = [
    "## Aztrx AI — autonomous fix (batch)",
    "",
    ...(isLocalUrl(url) ? [] : [PROD_BANNER, ""]),
    `Found ${n} bug${n === 1 ? "" : "s"} against ${url}:`,
    "",
    findings.map((f, i) => findingBlock(f, i + 1)).join("\n\n"),
    "",
    VERIFIED_NOTE,
  ].join("\n");
  const title = `fix: ${n} bug${n === 1 ? "" : "s"} (${headTitle(findings[0])})`;
  return createPr(repoRoot, branch, title, body, files);
}
