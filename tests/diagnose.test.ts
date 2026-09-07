import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseFinding } from "../src/core/diagnose.js";
import type { Finding } from "../src/core/types.js";

function f(partial: Partial<Finding> = {}): Finding {
  return {
    id: "x",
    fingerprint: "x",
    occurrences: 1,
    severity: "crash",
    type: "uncaught_exception",
    rawMessage: "Error: boom",
    rawStack: "",
    actionHistory: [],
    ...partial,
  };
}

test("null/undefined deref names the property and suggests optional chaining", () => {
  const dx = diagnoseFinding(
    f({ rawMessage: "TypeError: Cannot read properties of undefined (reading 'cart')" })
  );
  assert.ok(dx.includes("cart"), "names the accessed property");
  assert.ok(dx.includes("undefined"), "names the nullish value");
  assert.ok(dx.includes("?."), "suggests optional chaining");
});

test("null deref is distinguished from undefined", () => {
  const dx = diagnoseFinding(
    f({ rawMessage: "Cannot read properties of null (reading 'length')" })
  );
  assert.ok(dx.includes("null"));
  assert.ok(dx.includes("length"));
});

test("legacy V8 deref shape is recognized", () => {
  const dx = diagnoseFinding(
    f({ rawMessage: "TypeError: Cannot read property 'total' of undefined" })
  );
  assert.ok(dx.includes("total"));
  assert.ok(dx.includes("undefined"));
});

test("toFixed on a string points at Number()", () => {
  const dx = diagnoseFinding(f({ rawMessage: 'TypeError: "9".toFixed is not a function' }));
  assert.ok(dx.includes("Number()"));
});

test("JSON.parse failure suggests try/catch", () => {
  const dx = diagnoseFinding(f({ rawMessage: 'SyntaxError: "oops" is not valid JSON' }));
  assert.ok(dx.includes("JSON.parse"));
  assert.ok(/try\/catch/i.test(dx));
});

test("unbounded recursion names the fix", () => {
  const dx = diagnoseFinding(
    f({ rawMessage: "RangeError: Maximum call stack size exceeded" })
  );
  assert.ok(/recursion/i.test(dx));
});

test("network_5xx and network_timeout get type-based diagnoses", () => {
  const n5xx = diagnoseFinding(
    f({ type: "network_5xx", severity: "error", rawMessage: "HTTP 500 http://localhost/api/cart" })
  );
  assert.ok(/5xx|server/i.test(n5xx));

  const timeout = diagnoseFinding(
    f({ type: "network_timeout", severity: "error", rawMessage: "Request failed: /api/cart (net::ERR_ABORTED)" })
  );
  assert.ok(/timeout|await/i.test(timeout));
});

test("unhandled_rejection suggests .catch()", () => {
  const dx = diagnoseFinding(
    f({ type: "unhandled_rejection", severity: "error", rawMessage: "Error: Order submit failed: quota exceeded" })
  );
  assert.ok(dx.includes(".catch()"));
});

test("warning and noise get no headline", () => {
  assert.equal(diagnoseFinding(f({ severity: "warning", type: "console_error" })), "");
  assert.equal(diagnoseFinding(f({ severity: "noise" })), "");
});

test("unknown error shapes still get a type-based fallback", () => {
  const dx = diagnoseFinding(f({ rawMessage: "Some unclassified throw" }));
  assert.ok(dx.length > 0);
});

test("ru localization is selectable", () => {
  const dx = diagnoseFinding(
    f({ rawMessage: "Cannot read properties of undefined (reading 'cart')" }),
    "ru"
  );
  assert.ok(dx.includes("значение"), "returns Russian");
});
