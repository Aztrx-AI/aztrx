import { test } from "node:test";
import assert from "node:assert/strict";
import { auditPatch } from "../src/core/heal/gates.js";

const ts = (original: string, patched: string) => auditPatch(original, patched, "app.ts");

test("auditPatch accepts a benign patch", () => {
  const r = ts("const total = price * 2;", "const total = price * qty;");
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test("auditPatch rejects a new import", () => {
  const r = ts("const x = 1;", 'import { z } from "lodash";\nconst x = 1;');
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.rule === "no-new-imports"));
});

test("auditPatch rejects eval and new Function", () => {
  for (const patched of ['eval("alert(1)")', "new Function('return 1')"]) {
    const r = ts("const x = 1;", patched);
    assert.equal(r.ok, false, patched);
    assert.ok(r.violations.some((v) => v.rule === "no-eval"), patched);
  }
});

test("auditPatch rejects child_process and process.exit", () => {
  const r = ts("const x = 1;", 'require("child_process").exec("ls")');
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.rule === "no-child-process"));

  const r2 = ts("const x = 1;", "process.exit(1)");
  assert.equal(r2.ok, false);
  assert.ok(r2.violations.some((v) => v.rule === "no-child-process"));
});

test("auditPatch rejects an empty catch", () => {
  const r = ts("const x = 1;", "try { doThing(); } catch (e) {}");
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.rule === "no-empty-catch"));
});

test("auditPatch rejects setTimeout with a string (eval-by-proxy)", () => {
  const r = ts("const x = 1;", 'setTimeout("alert(1)", 100)');
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.rule === "no-eval"));
});

test("auditPatch audits inline <script> blocks in HTML", () => {
  const r = auditPatch(
    "<script>const x = 1;</script>",
    '<script>eval("pwned")</script>',
    "page.html"
  );
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.rule === "no-eval"));
});
