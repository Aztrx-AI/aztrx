import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyHunks, typecheckWorktree } from "../src/core/heal/sandbox.js";

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
