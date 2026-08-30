import { execFile } from "child_process";
import { promisify } from "util";
import type { Finding } from "./types.js";

const exec = promisify(execFile);

export interface FixPrResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/**
 * Turn applied, verified fixes into a merge-ready PR: create a branch, commit,
 * and open a PR via the `gh` CLI with the repro evidence in the body. Mirrors
 * the "merge-ready PR" flow but for runtime crashes, not security vulns.
 */
export async function openFixPr(
  repoRoot: string,
  findings: Finding[],
  url: string
): Promise<FixPrResult> {
  const healed = findings.filter((f) => f.heal?.status === "healed");
  if (healed.length === 0) return { ok: false, error: "no verified fixes to open a PR for" };

  const branch = `aztrx/fix-${Date.now().toString(36)}`;
  const title = `fix: ${healed.length} runtime bug${healed.length === 1 ? "" : "s"} found by Aztrx`;

  const bullets = healed.map((f) => {
    const loc = f.mappedLocation
      ? `${f.mappedLocation.filePath}:${f.mappedLocation.line}`
      : "unknown location";
    const repro = f.repro?.verdict
      ? `repro: ${f.repro.verdict} ${f.repro.reproductions}/${f.repro.runs}`
      : "";
    return `- **${f.rawMessage.split("\n")[0].slice(0, 120)}** — \`${loc}\` ${repro}`.trim();
  });

  const body = [
    "## Aztrx AI — verified fixes",
    "",
    `Found ${healed.length} runtime bug${healed.length === 1 ? "" : "s"} against ${url}:`,
    "",
    ...bullets,
    "",
    "Each fix was gated (AST safety), compiled, run against the test suite, and replayed against the repro in an isolated worktree before this PR.",
  ].join("\n");

  try {
    await exec("git", ["-C", repoRoot, "checkout", "-b", branch]);
    await exec("git", ["-C", repoRoot, "add", "-A"]);
    await exec("git", ["-C", repoRoot, "commit", "-m", title]);
  } catch (e) {
    return { ok: false, error: `git failed: ${(e as Error).message}` };
  }

  try {
    const { stdout } = await exec("gh", ["pr", "create", "--title", title, "--body", body], {
      cwd: repoRoot,
    });
    return { ok: true, url: stdout.trim() };
  } catch (e) {
    return { ok: false, error: `gh pr create failed (is gh installed and authenticated?): ${(e as Error).message}` };
  }
}
