import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { repoPathProblem } from "../src/cli/repo.js";

/** The built CLI, not the source: this file is about what the command line
 * actually does with argv, and argv is parsed by the real entry point. `pretest`
 * builds dist before the suite runs (same assumption as mcp.test.ts). */
const DIST_CLI = path.join(process.cwd(), "dist", "cli.js");

const TEMP: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-repo-"));
  TEMP.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort — a leaked temp dir is the OS's problem, not a test failure */
    }
  }
});

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [DIST_CLI, ...args], { cwd, encoding: "utf-8" });
}

// ---------------------------------------------------------------- the check

test("a directory is a usable project root", () => {
  assert.equal(repoPathProblem(tempDir()), null);
});

test("a path that does not exist is refused by name", () => {
  const missing = path.join(tempDir(), "nope");
  const problem = repoPathProblem(missing);
  assert.ok(problem, "a missing directory must not be accepted");
  assert.match(problem, /no such directory/);
  assert.ok(problem.includes(missing));
});

test("a flag eaten by --repo is named as the likely mistake", () => {
  const problem = repoPathProblem(path.join(tempDir(), "--fix"));
  assert.ok(problem);
  assert.match(problem, /looks like a flag/);
});

test("a file is not a project root", () => {
  const file = path.join(tempDir(), "package.json");
  fs.writeFileSync(file, "{}", "utf-8");
  assert.match(repoPathProblem(file) ?? "", /not a directory/);
});

// ------------------------------------------------- the failure it prevents

test("`--repo --fix` does not scaffold a directory named --fix", () => {
  // The whole point: before this check, this exact command *succeeded*. It
  // resolved the flag to `<cwd>/--fix`, ran the scan against the dead URL
  // below, and wrote `.aztrx/events.jsonl` + `.aztrx/report.html` into a
  // directory it had just invented — the same shape as the stray
  // `C:\Users\dchap\--fix\` this was found in. Reproduced here against the
  // published 0.5.1 to be sure of that, including the exit code 0.
  const cwd = tempDir();
  const res = runCli(["run", "http://127.0.0.1:1", "--repo", "--fix"], cwd);

  assert.equal(res.status, 1, "a project root that does not exist is a usage error");
  assert.match(res.stderr, /no such directory/);
  assert.match(res.stderr, /--fix/);
  assert.equal(fs.existsSync(path.join(cwd, "--fix")), false, "aztrx invented this directory");
  assert.deepEqual(fs.readdirSync(cwd), [], "the run should have written nothing at all");
});

test("an init into a missing root fails instead of half-scaffolding it", () => {
  const cwd = tempDir();
  const missing = path.join(cwd, "nope");
  const res = runCli(["init", "--repo", missing], cwd);

  assert.equal(res.status, 1);
  assert.match(res.stderr, /no such directory/);
  assert.equal(fs.existsSync(missing), false);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test("a real root still reaches the real error, rather than the new one", () => {
  // Guards the other direction: the check must not reject a directory that
  // exists. This one fails later and for its own reason — no app to scan.
  const cwd = tempDir();
  const res = runCli(["run", "--repo", cwd], cwd);

  assert.doesNotMatch(res.stderr, /no such directory/);
  assert.match(res.stderr, /No dev server is running/);
});
