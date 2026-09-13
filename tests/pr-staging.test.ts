import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openPatrolPr, branchFor } from "../src/core/patrol/pr.js";
import { openFixPr } from "../src/core/fixPr.js";
import type { Finding } from "../src/core/types.js";

/** Both PR openers used to stage with `git add -A`, which commits whatever else
 * the user happened to have open. These run against a real git repo with real
 * uncommitted work in it, because that is the only way to observe whether the
 * user's work survives. */

function run(args: string[], cwd: string): { status: number | null; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-staging-"));
  run(["init"], dir);
  run(["config", "user.email", "test@example.com"], dir);
  run(["config", "user.name", "test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n", "utf-8");
  run(["add", "--", "README.md"], dir);
  run(["commit", "-m", "init"], dir);
  return dir;
}

const branchOf = (dir: string) => run(["rev-parse", "--abbrev-ref", "HEAD"], dir).out;
const statusOf = (dir: string) => run(["status", "--porcelain"], dir).out;
const localBranches = (dir: string) => run(["branch", "--list", "aztrx/*"], dir).out;

function finding(fp: string, healFilePath?: string): Finding {
  return {
    id: "f1",
    fingerprint: fp,
    occurrences: 1,
    severity: "high",
    type: "runtime_error",
    rawMessage: "Cannot read properties of undefined (reading 'x')",
    rawStack: "at App (App.tsx:3:1)",
    mappedLocation: { filePath: "App.tsx", line: 3, column: 1, codeContext: "", isOwnCode: true },
    actionHistory: [],
    repro: { actions: [], specPath: "s.ts", verdict: "deterministic", rate: 1, runs: 3, reproductions: 3 },
    ...(healFilePath !== undefined
      ? {
          heal: {
            status: "healed" as const,
            findingId: "f1",
            filePath: healFilePath,
            hunks: [{ search: "a", replace: "b" }],
            violations: [],
          },
        }
      : {}),
  };
}

test("patrol refuses an empty fix set instead of committing the working tree", async () => {
  const dir = gitRepo();
  const before = branchOf(dir);
  // The user's work in progress: exactly what must not end up in an auto-PR.
  fs.writeFileSync(path.join(dir, "wip.txt"), "half-finished refactor\n", "utf-8");

  const r = await openPatrolPr(dir, finding("abcdef1234"), "http://localhost:3000", [], null);

  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no files to stage/);
  // Not committed, not stashed, not touched — and no branch was even created.
  assert.match(statusOf(dir), /wip\.txt/);
  assert.equal(branchOf(dir), before);
  assert.equal(localBranches(dir), "");
});

test("patrol stages only the patched files, never the user's other work", async () => {
  const dir = gitRepo();
  const before = branchOf(dir);
  fs.writeFileSync(path.join(dir, "App.tsx"), "export const App = () => null;\n", "utf-8");
  fs.writeFileSync(path.join(dir, "wip.txt"), "half-finished refactor\n", "utf-8");

  const fp = "abcdef1234";
  // `gh` is absent or unauthenticated in a throwaway repo, so the PR step fails —
  // but the commit happens first, and the commit is what this asserts about.
  await openPatrolPr(dir, finding(fp), "http://localhost:3000", ["App.tsx"], null);

  const committed = run(["show", "--name-only", "--pretty=format:", branchFor(fp)], dir).out
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(committed, ["App.tsx"]);
  // The unrelated file is still sitting uncommitted, exactly as the user left it.
  assert.match(statusOf(dir), /wip\.txt/);
  assert.equal(branchOf(dir), before, "must return to the branch it started on");
});

test("patrol stages nothing when the only uncommitted work is the user's", async () => {
  const dir = gitRepo();
  const before = branchOf(dir);
  fs.writeFileSync(path.join(dir, "wip.txt"), "half-finished refactor\n", "utf-8");
  fs.writeFileSync(path.join(dir, "README.md"), "locally edited\n", "utf-8");

  const r = await openPatrolPr(dir, finding("feedface99"), "http://localhost:3000", [], null);

  assert.equal(r.ok, false);
  // A tracked file modified by the user is the dangerous case: `git add -A`
  // would have swept it in silently, since it is neither new nor ignored.
  assert.match(statusOf(dir), /README\.md/);
  assert.match(statusOf(dir), /wip\.txt/);
  assert.equal(branchOf(dir), before);
});

test("fix-pr refuses when no source file was recorded for the fixes", async () => {
  const dir = gitRepo();
  const before = branchOf(dir);
  fs.writeFileSync(path.join(dir, "wip.txt"), "half-finished refactor\n", "utf-8");

  // A healed finding whose source path was never recorded: it passes the
  // "is it healed?" filter, so it is the file list that has to stop the commit.
  const r = await openFixPr(dir, [finding("aaaa1111", "")], "http://localhost:3000");

  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no staged files recorded/);
  assert.match(statusOf(dir), /wip\.txt/);
  assert.equal(branchOf(dir), before);
});

test("fix-pr stages only the healed file, never the user's other work", async () => {
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, "App.tsx"), "export const App = () => null;\n", "utf-8");
  fs.writeFileSync(path.join(dir, "wip.txt"), "half-finished refactor\n", "utf-8");
  run(["add", "--", "App.tsx"], dir);

  await openFixPr(dir, [finding("aaaaaaaa", "App.tsx")], "http://localhost:3000");

  const branches = run(["branch", "--list", "aztrx/fix-*"], dir).out;
  const name = branches.replace(/^[*+]\s*/, "").trim().split("\n")[0];
  assert.match(name, /^aztrx\/fix-/);
  const committed = run(["show", "--name-only", "--pretty=format:", name], dir).out
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(committed, ["App.tsx"]);
  assert.match(statusOf(dir), /wip\.txt/);
});

test("fix-pr stages each healed file exactly once across findings", async () => {
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, "App.tsx"), "export const App = () => null;\n", "utf-8");
  fs.writeFileSync(path.join(dir, "store.ts"), "export const s = 1;\n", "utf-8");
  run(["add", "--", "App.tsx", "store.ts"], dir);

  const a = finding("aaaaaaaa", "App.tsx");
  const b = finding("bbbbbbbb", "App.tsx"); // same file healed for a second crash
  const c = finding("cccccccc", "store.ts");
  await openFixPr(dir, [a, b, c], "http://localhost:3000");

  const branches = run(["branch", "--list", "aztrx/fix-*"], dir).out;
  const name = branches.replace(/^[*+]\s*/, "").trim().split("\n")[0];
  const committed = run(["show", "--name-only", "--pretty=format:", name], dir).out
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(committed, ["App.tsx", "store.ts"]);
});
