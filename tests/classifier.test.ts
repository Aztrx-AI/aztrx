import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SignalClassifier,
  fingerprintOf,
  rootKeyOf,
  collapseSignals,
} from "../src/core/classifier.js";
import type { Finding, TelemetryErrorPayload } from "../src/core/types.js";

// A Server Action throw stack as the browser sees it: the throw site is an
// `about://React/Server/…` frame (an encoded Turbopack chunk), followed by
// framework frames in node_modules.
const SA_STACK = [
  "Error: Order submit failed: quota exceeded",
  "    at placeOrder (about://React/Server/C:%5Capp%5Cactions.ts?2:33:11)",
  "    at resolveErrorDev (http://localhost:3000/_next/static/chunks/node_modules_next_dist_compiled_react-server-dom-turbopack_123._.js:1937:105)",
].join("\n");

function payload(partial: Partial<TelemetryErrorPayload> = {}): TelemetryErrorPayload {
  return {
    type: "uncaught_exception",
    rawMessage: "Order submit failed: quota exceeded",
    rawStack: SA_STACK,
    ...partial,
  };
}

test("fingerprint ignores the leading Error: prefix", () => {
  const bare = fingerprintOf(payload());
  const prefixed = fingerprintOf(payload({ rawMessage: "Error: Order submit failed: quota exceeded" }));
  assert.equal(bare, prefixed);
});

test("a Server Action about:// frame is own code, so the finding is a crash", () => {
  const c = new SignalClassifier();
  const f = c.classify(payload());
  assert.ok(f, "expected a finding");
  assert.equal(f.severity, "crash");
});

test("unhandled_rejection stays error even with an own-code frame", () => {
  const c = new SignalClassifier();
  const f = c.classify(
    payload({ type: "unhandled_rejection", rawMessage: "Error: Order submit failed: quota exceeded" })
  );
  assert.ok(f);
  assert.equal(f.severity, "error");
});

test("throw root keys collapse uncaught_exception and unhandled_rejection", () => {
  const uncaught = rootKeyOf(payload());
  const rejection = rootKeyOf(
    payload({ type: "unhandled_rejection", rawMessage: "Error: Order submit failed: quota exceeded" })
  );
  assert.equal(uncaught, rejection);
});

test("network root keys group by resource URL across capture paths", () => {
  const n5xx = rootKeyOf({
    type: "network_5xx",
    rawMessage: "HTTP 500 http://localhost:3000/api/cart",
    rawStack: "",
  });
  const consoleErr = rootKeyOf({
    type: "console_error",
    rawMessage: "Failed to load resource: the server responded with a status of 500 (Internal Server Error)",
    rawStack: "",
    url: "http://localhost:3000/api/cart#frag",
  });
  assert.equal(n5xx, consoleErr);
});

test("collapseSignals merges one fault across paths and keeps the crash", () => {
  const crash: Finding = {
    id: "a",
    fingerprint: "a",
    rootKey: "throw:x",
    occurrences: 1,
    severity: "crash",
    type: "uncaught_exception",
    rawMessage: "Order submit failed: quota exceeded",
    rawStack: SA_STACK,
    actionHistory: [],
  };
  const err: Finding = {
    ...crash,
    id: "b",
    fingerprint: "b",
    severity: "error",
    type: "unhandled_rejection",
    rawMessage: "Error: Order submit failed: quota exceeded",
  };
  const out = collapseSignals([err, crash]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "crash");
  assert.equal(out[0].occurrences, 2);
});
