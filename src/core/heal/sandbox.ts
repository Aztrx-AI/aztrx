/**
 * F10 gate #3 — isolated Git worktree sandbox. A patch is never applied to the
 * user's working tree: it lands in a detached `git worktree`, is verified there,
 * and the only artifact that escapes is a `.patch` file for a human to review
 * and apply. Aztrx never commits — humans do.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PatchHunk, TestGateResult } from "./types.js";
import { buildChildEnv } from "./childEnv.js";

const execFileP = promisify(execFile);

export interface Worktree {
  dir: string;
  cleanup: () => Promise<void>;
}

export interface ApplyResult {
  ok: boolean;
  patched: string;
  applied: number;
  errors: string[];
}

const preview = (s: string): string => JSON.stringify(s.length > 60 ? s.slice(0, 57) + "…" : s);

/** Create a detached worktree at HEAD in a temp dir (outside the repo). */
export async function createWorktree(repoRoot: string, label: string): Promise<Worktree> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aztrx-heal-${label}-`));
  await execFileP("git", ["-C", repoRoot, "worktree", "add", "--detach", dir, "HEAD"]);
  return {
    dir,
    cleanup: async () => {
      await execFileP("git", ["-C", repoRoot, "worktree", "remove", "--force", dir]).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Apply Search & Replace hunks to an in-memory file. Each `search` must match
 * exactly once; ambiguous or missing matches fail the whole apply (no partial
 * writes). Pure — the caller decides where the result lands. */
export function applyHunks(content: string, hunks: PatchHunk[]): ApplyResult {
  const errors: string[] = [];
  for (const h of hunks) {
    const first = content.indexOf(h.search);
    if (first === -1) {
      errors.push(`search not found: ${preview(h.search)}`);
      continue;
    }
    if (content.indexOf(h.search, first + h.search.length) !== -1) {
      errors.push(`search ambiguous (matches multiple times): ${preview(h.search)}`);
    }
  }
  if (errors.length) return { ok: false, patched: content, applied: 0, errors };

  let patched = content;
  for (const h of hunks) {
    patched = patched.replace(h.search, h.replace);
  }
  return { ok: true, patched, applied: hunks.length, errors: [] };
}

/** Write the patched file into the worktree, refusing to escape it. */
export function writeWorktreeFile(worktreeDir: string, repoRelativePath: string, content: string): string | null {
  const root = path.resolve(worktreeDir);
  const target = path.resolve(root, repoRelativePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return `refusing to write outside worktree: ${repoRelativePath}`;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
  return null;
}

/** Produce a unified diff of the patched file against HEAD in the worktree. */
export async function diffWorktree(worktreeDir: string, repoRelativePath: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", worktreeDir, "diff", "--", repoRelativePath]);
    return stdout;
  } catch {
    return "";
  }
}

/** Run `tsc --noEmit` against the patched worktree — the full type check that
 * follows the AST syntax gate. Best-effort: passes (skips) when the repo has no
 * TypeScript or the worktree has no tsconfig, so non-TS projects aren't blocked.
 * The worktree has no node_modules; a symlink to the root's is created first and
 * removed with the worktree on cleanup. */
export async function typecheckWorktree(
  worktreeDir: string,
  repoRoot: string
): Promise<{ ok: boolean; ran: boolean; output: string }> {
  const tscBin = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const hasTsconfig = fs.existsSync(path.join(worktreeDir, "tsconfig.json"));
  if (!fs.existsSync(tscBin) || !hasTsconfig) {
    return { ok: true, ran: false, output: "" };
  }

  const rootNodeModules = path.join(repoRoot, "node_modules");
  const wtNodeModules = path.join(worktreeDir, "node_modules");
  if (!fs.existsSync(wtNodeModules)) {
    try {
      fs.symlinkSync(rootNodeModules, wtNodeModules, process.platform === "win32" ? "junction" : "dir");
    } catch {
      /* symlink failed — tsc reports its own resolution errors below */
    }
  }

  try {
    const { stdout } = await execFileP(
      process.execPath,
      [tscBin, "--noEmit", "-p", worktreeDir],
      { cwd: worktreeDir, maxBuffer: 10 * 1024 * 1024, env: buildChildEnv() }
    );
    return { ok: true, ran: true, output: stdout.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, ran: true, output: ((err.stdout ?? "") + (err.stderr ?? "")).trim() };
  }
}

/** Run the repo's own test suite inside the patched worktree. Best-effort: skips
 * (passes by omission) when there is no `test` script to run, so untested or
 * non-JS projects are never blocked. `CI=true` is set so watch-mode runners exit
 * instead of hanging until the timeout. */
export async function runTests(
  worktreeDir: string,
  repoRoot: string,
  opts: { command?: string; timeoutMs?: number } = {}
): Promise<TestGateResult> {
  const command = opts.command ?? "npm test";

  // Auto-detect: without an explicit command, only run when package.json declares
  // a `test` script — `npm test` otherwise errors "Missing script".
  if (!opts.command) {
    let hasTest = false;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(worktreeDir, "package.json"), "utf-8"));
      hasTest = typeof pkg.scripts?.test === "string";
    } catch {
      hasTest = false;
    }
    if (!hasTest) return { ran: false, ok: true, command: "", output: "" };
  }

  // A fresh worktree has no node_modules — symlink the root's so the runner
  // resolves (the same trick typecheckWorktree uses).
  const rootNodeModules = path.join(repoRoot, "node_modules");
  const wtNodeModules = path.join(worktreeDir, "node_modules");
  if (!fs.existsSync(wtNodeModules) && fs.existsSync(rootNodeModules)) {
    try {
      fs.symlinkSync(rootNodeModules, wtNodeModules, process.platform === "win32" ? "junction" : "dir");
    } catch {
      /* resolution errors surface in the run below */
    }
  }

  const timeoutMs = opts.timeoutMs ?? 300000;
  try {
    const { stdout } = await execFileP(command, [], {
      cwd: worktreeDir,
      shell: true,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      // Minimal allow-list — never hand the full `process.env` (and its
      // ANTHROPIC_API_KEY / GH_TOKEN / AWS_* secrets) to untrusted PR test code.
      env: buildChildEnv({ CI: "true" }),
    });
    return { ran: true, ok: true, command, output: stdout.trim().slice(0, 2000) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim().slice(0, 2000);
    return { ran: true, ok: false, command, output };
  }
}
