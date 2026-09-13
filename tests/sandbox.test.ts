import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyHunks, createWorktree, typecheckWorktree } from "../src/core/heal/sandbox.js";

test("applyHunks applies a single exact-match hunk", () => {
  const r = applyHunks("const total = price * 2;", [
    { search: "price * 2", replace: "price * qty" },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.applied, 1);
  assert.equal(r.patched, "const total = price * qty;");
});

test("applyHunks inserts $ sequences in replace literally (no substitution)", () => {
  // A fix that introduces a literal `$5.00` price and a `$1` regex capture must
  // land verbatim — `String.replace` would otherwise swallow `$5`/`$1` as tokens.
  const r = applyHunks('const label = "total";', [
    { search: '"total"', replace: '"total: $5.00"' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.patched, 'const label = "total: $5.00";');
});

test("applyHunks applies multiple hunks in order", () => {
  const r = applyHunks("const a = 1;\nconst b = 2;\n", [
    { search: "a = 1", replace: "a = 10" },
    { search: "b = 2", replace: "b = 20" },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.applied, 2);
  assert.equal(r.patched, "const a = 10;\nconst b = 20;\n");
});

test("applyHunks refuses a missing search (no partial writes)", () => {
  const r = applyHunks("const a = 1;", [
    { search: "a = 1", replace: "a = 10" },
    { search: "does not exist", replace: "x" },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.applied, 0);
  assert.equal(r.patched, "const a = 1;"); // untouched
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /search not found/);
});

test("applyHunks refuses an ambiguous (multi-match) search", () => {
  const r = applyHunks("x = f(); y = f();", [{ search: "f()", replace: "g()" }]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /ambiguous/);
});

/**
 * A hermetic fake repo: `tsconfig.json` so the gate does not skip on sight, and a
 * `node_modules/typescript/bin/tsc` that is really a script we control. The
 * sandbox runs the real compiler for real, so the only honest way to test the
 * ceiling is to make "tsc" too slow to finish.
 */
function fakeRepo(tscBody: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-sandbox-"));
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
  const bin = path.join(root, "node_modules", "typescript", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "tsc"), tscBody);
  return root;
}

test("typecheckWorktree passes a clean compile through", async () => {
  const root = fakeRepo("process.exit(0);");
  try {
    const r = await typecheckWorktree(root, root);
    assert.equal(r.ok, true);
    assert.equal(r.ran, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("typecheckWorktree rejects a patch the compiler actually refused", async () => {
  const root = fakeRepo('console.error("error TS1005: fake"); process.exit(2);');
  try {
    const r = await typecheckWorktree(root, root);
    assert.equal(r.ok, false);
    assert.equal(r.ran, true);
    assert.match(r.output, /TS1005/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("typecheckWorktree skips — does not fail — when tsc exceeds the ceiling", async () => {
  // The whole point: a compile that never finished is not a compile that failed.
  // Reporting it as a failure would reject a good patch and blame the compiler.
  const root = fakeRepo("setTimeout(() => {}, 60000);");
  try {
    const r = await typecheckWorktree(root, root, { timeoutMs: 1000 });
    assert.equal(r.ran, false, "a timed-out check did not run to a verdict");
    assert.equal(r.ok, true, "and must not be reported as a failure");
    assert.match(r.output, /did not finish within 1000ms/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("typecheckWorktree skips when the project has no tsconfig", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-sandbox-"));
  try {
    const r = await typecheckWorktree(root, root);
    assert.equal(r.ok, true);
    assert.equal(r.ran, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(args: string[], cwd: string): void {
  spawnSync("git", args, { cwd, encoding: "utf-8" });
}

/** A real repo with one commit, because `createWorktree` detaches from HEAD. */
function committedRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-wt-link-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n", "utf-8");
  git(["add", "--", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

/**
 * The worktree sandbox links the repo's `node_modules` into the worktree (see
 * `typecheckWorktree`, `runTests`, and `bootServer`) because a fresh worktree has
 * none. On Windows that link is a junction, and `git worktree remove --force`
 * recurses *through* it: the ordinary cleanup deletes the user's real
 * node_modules. That is not a hypothesis — it happened to this repo's own
 * node_modules during a heal run, and it is why `cleanup` unlinks directory links
 * before handing the worktree back to git.
 *
 * The destructive descent is Windows-specific (on POSIX git unlinks a symlink
 * instead of descending into it), so a green Linux CI run does NOT by itself
 * prove this is fixed — this test is the guard, and it only bites on Windows.
 */
test("worktree cleanup does not follow a node_modules link out of the sandbox", async () => {
  const repo = committedRepo();
  // Stand in for the user's real dependencies, with a sentinel to check after.
  const realModules = path.join(repo, "node_modules");
  const sentinel = path.join(realModules, "sentinel.txt");
  fs.mkdirSync(realModules, { recursive: true });
  fs.writeFileSync(sentinel, "must survive\n", "utf-8");

  try {
    const wt = await createWorktree(repo, "link-test");
    fs.symlinkSync(
      realModules,
      path.join(wt.dir, "node_modules"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await wt.cleanup();

    assert.equal(
      fs.existsSync(sentinel),
      true,
      "cleanup followed the node_modules link and deleted the real node_modules"
    );
    assert.equal(fs.existsSync(wt.dir), false, "the worktree itself should still be gone");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
