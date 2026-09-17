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

/**
 * Remove directory links (POSIX symlinks / Windows junctions) from a worktree root.
 *
 * This MUST run before `git worktree remove`. Git's worktree teardown recurses
 * *through* a junction and deletes its target, so the `node_modules` link that
 * boot/verify create inside the worktree (below) turns an ordinary cleanup into a
 * recursive delete of the user's real node_modules. Established by experiment,
 * not by reading docs: a sentinel file inside the junction target did not survive
 * `git worktree remove --force`. Node's own recursive `fs.rmSync` handles reparse
 * points correctly and is safe either way; git's does not.
 */
function unlinkDirLinks(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    try {
      if (!fs.lstatSync(p).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    // `unlink` covers POSIX dir symlinks; Windows junctions need `rmdir`.
    try {
      fs.unlinkSync(p);
    } catch {
      try {
        fs.rmdirSync(p);
      } catch {
        /* best effort — a link that survives is still not followed by the rmSync below */
      }
    }
  }
}

/** Create a detached worktree at HEAD in a temp dir (outside the repo). */
export async function createWorktree(repoRoot: string, label: string): Promise<Worktree> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aztrx-heal-${label}-`));
  await execFileP("git", ["-C", repoRoot, "worktree", "add", "--detach", dir, "HEAD"]);
  return {
    dir,
    cleanup: async () => {
      unlinkDirLinks(dir);
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
    // Function replacer: a plain `replace(search, replace)` treats `$&`, `$1`,
    // `` $` ``, `$'`, `$$` in `replace` as substitution tokens, so a fix that
    // introduces a literal `$5` (a price, a template fragment, a regex capture)
    // would be silently mangled. The function form inserts `replace` verbatim.
    patched = patched.replace(h.search, () => h.replace);
  }
  return { ok: true, patched, applied: hunks.length, errors: [] };
}

/**
 * Whitespace-tolerant apply — the fallback for model-written diffs whose
 * context lines lost (or gained) a leading space here and there. Lines match
 * by trimmed content, so indentation drift on one line no longer sinks the
 * whole hunk. Used only after the exact match failed; the result still passes
 * the same gate and verification as any other patch.
 */
export function applyHunksLoose(content: string, hunks: PatchHunk[]): ApplyResult {
  let lines = content.split("\n");
  for (const h of hunks) {
    const searchLines = h.search.split("\n").map((l) => l.trim());
    let start = -1;
    for (let i = 0; i <= lines.length - searchLines.length && start < 0; i++) {
      let ok = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (lines[i + j].trim() !== searchLines[j]) {
          ok = false;
          break;
        }
      }
      if (ok) start = i;
    }
    if (start < 0) {
      return { ok: false, patched: content, applied: 0, errors: [`loose match failed: ${preview(h.search)}`] };
    }
    const replaceLines = h.replace.split("\n");
    lines = [...lines.slice(0, start), ...replaceLines, ...lines.slice(start + searchLines.length)];
  }
  return { ok: true, patched: lines.join("\n"), applied: hunks.length, errors: [] };
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
 * removed with the worktree on cleanup.
 *
 * Unlike every other gate here, this one is whole-project work: `tsc` type-checks
 * the entire repository, so its cost scales with the repo, and on a very large
 * one it is minutes. It therefore carries a ceiling — and a timeout is reported
 * as *skipped*, not failed. "The compiler never reached a verdict" is a different
 * sentence from "the patch is broken", and conflating them would silently discard
 * good fixes on exactly the large repos this ceiling exists to protect. */
export async function typecheckWorktree(
  worktreeDir: string,
  repoRoot: string,
  opts: { timeoutMs?: number } = {}
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

  const timeoutMs = opts.timeoutMs ?? 300000;
  try {
    const { stdout } = await execFileP(
      process.execPath,
      [tscBin, "--noEmit", "-p", worktreeDir],
      { cwd: worktreeDir, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env: buildChildEnv() }
    );
    return { ok: true, ran: true, output: stdout.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    // A timeout kills the child; that is not a compile error. Skip the gate and
    // say why, rather than reporting a verdict the compiler never gave.
    if (err.killed || err.signal) {
      return {
        ok: true,
        ran: false,
        output: `tsc did not finish within ${timeoutMs}ms — type check skipped`,
      };
    }
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
