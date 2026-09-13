#!/usr/bin/env node
/**
 * Enumerate tests/*.test.ts and hand the explicit list to the Node test runner.
 *
 * Why this exists: passing a quoted "tests/<star><star>/<star>.test.ts" pattern to
 * `tsx --test` only works where *Node itself* expands it, and `--test` gained glob
 * support in Node 21. On Node 18 or 20 the pattern reaches the runner verbatim and
 * the run dies with:
 *
 *     Could not find '.../tests/**\/*.test.ts'
 *
 * Both are versions this project claims: `engines.node` says `>=18`, and
 * `action.yml` pins `node-version: 20`. So `npm test` was broken on exactly the
 * versions it advertised. Dropping the quotes would only move the problem — `sh`
 * expands the glob on Unix, `cmd.exe` does not on Windows.
 *
 * readdir behaves identically everywhere, so the file set is the same on every
 * platform and every supported Node.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(repoRoot, "tests");

const files = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join("tests", name));

if (files.length === 0) {
  console.error("run-tests: no *.test.ts files found in tests/");
  process.exit(1);
}

// `tsx` resolves through node_modules/.bin, which npm puts on PATH for scripts.
// `shell` is only needed so Windows finds the tsx.cmd shim.
const result = spawnSync("tsx", ["--test", ...files], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
