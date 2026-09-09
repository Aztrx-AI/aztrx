import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHunks } from "../src/core/heal/sandbox.js";

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
