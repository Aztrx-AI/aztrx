import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyFix } from "../src/core/heal/verify.js";
import type { Verifier } from "../src/core/heal/verify.js";
import type { RecordedAction } from "../src/core/types.js";

const navigate = (value: string): RecordedAction => ({
  type: "navigate",
  selectors: [],
  value,
  timestamp: 1,
});

const request = (url: string): RecordedAction => ({
  type: "request",
  selectors: [],
  request: { url, method: "GET" },
  timestamp: 2,
});

/** A stub engine that records every call and replays a scripted result per call. */
function stub(results: { reproduced: boolean; loaded: boolean }[]) {
  const calls: { url: string; actions: RecordedAction[]; fingerprint: string }[] = [];
  let i = 0;
  const engine: Verifier = {
    async run(url, actions, fingerprint) {
      calls.push({ url, actions, fingerprint });
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      return r ?? { reproduced: false, loaded: false };
    },
    async close() {},
  };
  return { engine, calls };
}

const serveAt = (url: string) => async () => ({ url, close: async () => {} });

test("verifyFix: a fix is only 'fixed' when the app actually loaded", async () => {
  // Every run reached the app and the bug never reappeared — the one honest pass.
  const { engine } = stub([
    { reproduced: false, loaded: true },
    { reproduced: false, loaded: true },
    { reproduced: false, loaded: true },
  ]);
  const r = await verifyFix({
    url: "http://localhost:3000",
    actions: [],
    fingerprint: "fp",
    serve: serveAt("http://127.0.0.1:5555"),
    engine,
  });
  assert.deepEqual(r, { runs: 3, reproductions: 0, loaded: 3, fixed: true });
});

test("verifyFix: a page that never loaded proves nothing — never 'fixed'", async () => {
  // The regression this guards: a dead serve URL emits no telemetry, which used
  // to be indistinguishable from "the crash is gone" and was reported as healed.
  const { engine } = stub([
    { reproduced: false, loaded: false },
    { reproduced: false, loaded: false },
    { reproduced: false, loaded: false },
  ]);
  const r = await verifyFix({
    url: "http://localhost:3000",
    actions: [],
    fingerprint: "fp",
    serve: serveAt("http://127.0.0.1:5555"),
    engine,
  });
  assert.equal(r.fixed, false);
  assert.equal(r.loaded, 0);
  assert.equal(r.reproductions, 0);
  assert.equal(r.runs, 3);
});

test("verifyFix: run count is never zero", async () => {
  // `fixed` is derived from the reproduction count, so a caller asking for zero
  // runs would otherwise be told the patch was verified without a single attempt.
  const { engine, calls } = stub([{ reproduced: false, loaded: true }]);
  const r = await verifyFix({
    url: "http://localhost:3000",
    actions: [],
    fingerprint: "fp",
    runs: 0,
    serve: serveAt("http://127.0.0.1:5555"),
    engine,
  });
  assert.equal(calls.length, 1);
  assert.equal(r.runs, 1);
  assert.equal(r.fixed, true);
});

test("verifyFix: a negative run count is clamped too", async () => {
  const { engine, calls } = stub([{ reproduced: false, loaded: true }]);
  const r = await verifyFix({
    url: "http://localhost:3000",
    actions: [],
    fingerprint: "fp",
    runs: -5,
    serve: serveAt("http://127.0.0.1:5555"),
    engine,
  });
  assert.equal(calls.length, 1);
  assert.equal(r.runs, 1);
});

test("verifyFix: a bug that still reproduces is not 'fixed'", async () => {
  const { engine } = stub([
    { reproduced: true, loaded: true },
    { reproduced: false, loaded: true },
    { reproduced: true, loaded: true },
  ]);
  const r = await verifyFix({
    url: "http://localhost:3000",
    actions: [],
    fingerprint: "fp",
    serve: serveAt("http://127.0.0.1:5555"),
    engine,
  });
  assert.equal(r.reproductions, 2);
  assert.equal(r.fixed, false);
});

test("verifyFix: one reproduction among loads is enough to reject", async () => {
  const { engine } = stub([
    { reproduced: false, loaded: true },
    { reproduced: true, loaded: true },
    { reproduced: false, loaded: true },
  ]);
  const r = await verifyFix({
    url: "http://localhost:3000",
    actions: [],
    fingerprint: "fp",
    serve: serveAt("http://127.0.0.1:5555"),
    engine,
  });
  assert.equal(r.fixed, false);
});

test("verifyFix: replays are addressed to the served origin, not the original app", async () => {
  // The regression this guards: a recorded `navigate` left pointing at the
  // original app sends the replay back to the *unpatched* code, so the patch is
  // never exercised — and when the fingerprint is absent there, it reads as fixed.
  const { engine, calls } = stub([{ reproduced: false, loaded: true }]);
  await verifyFix({
    url: "http://localhost:3000",
    actions: [
      navigate("http://localhost:3000/checkout?step=2"),
      request("http://localhost:3000/api/cart"),
    ],
    fingerprint: "fp",
    runs: 1,
    serve: serveAt("http://127.0.0.1:5555"),
    engine,
  });
  assert.equal(calls[0].url, "http://127.0.0.1:5555");
  const [nav, req] = calls[0].actions;
  assert.equal(nav.value, "http://127.0.0.1:5555/checkout?step=2");
  assert.equal(req.request?.url, "http://127.0.0.1:5555/api/cart");
});

test("verifyFix: rewriting preserves path and query, and leaves relative URLs alone", async () => {
  const { engine, calls } = stub([{ reproduced: false, loaded: true }]);
  await verifyFix({
    url: "http://localhost:3000",
    actions: [navigate("/settings"), navigate("not a url")],
    fingerprint: "fp",
    runs: 1,
    serve: serveAt("http://127.0.0.1:5555/base"),
    engine,
  });
  // A relative path has no origin to rewrite; it must survive untouched rather
  // than be mangled into something the page cannot resolve.
  assert.equal(calls[0].actions[0].value, "/settings");
  assert.equal(calls[0].actions[1].value, "not a url");
});

test("verifyFix: the target type is threaded through to the engine", async () => {
  const seen: (string | undefined)[] = [];
  const engine: Verifier = {
    async run(_url, _actions, _fp, opts) {
      seen.push(opts?.targetType);
      return { reproduced: false, loaded: true };
    },
    async close() {},
  };
  await verifyFix({
    url: "http://localhost:3000",
    actions: [],
    fingerprint: "fp",
    runs: 1,
    targetType: "network_5xx",
    serve: serveAt("http://127.0.0.1:5555"),
    engine,
  });
  assert.deepEqual(seen, ["network_5xx"]);
});

test("verifyFix: the served app is always closed, even when a run throws", async () => {
  let closed = false;
  const engine: Verifier = {
    async run() {
      throw new Error("browser died");
    },
    async close() {},
  };
  await assert.rejects(
    verifyFix({
      url: "http://localhost:3000",
      actions: [],
      fingerprint: "fp",
      serve: async () => ({ url: "http://127.0.0.1:5555", close: async () => { closed = true; } }),
      engine,
    }),
    /browser died/
  );
  // A leaked dev server holds its port and hangs the next heal — cleanup is not
  // allowed to depend on the happy path.
  assert.equal(closed, true);
});

test("verifyFix: a patch that swaps the crash for a different one is rejected", async () => {
  // The regression: optional-chaining the read fixed the target fingerprint,
  // but left the undefined value to blow up the render — "the bug is gone"
  // while the app still crashes. Verification must reject that.
  const { engine } = stub([{ reproduced: false, loaded: true, otherErrors: ["throw:users.map|..."] }]);
  const r = await verifyFix({
    url: "http://localhost:3000",
    actions: [],
    fingerprint: "fp",
    serve: serveAt("http://127.0.0.1:5555"),
    engine,
  });
  assert.equal(r.fixed, false);
  assert.ok(r.otherErrors && r.otherErrors.length > 0);
});

test("verifyFix: other errors do not block a network-type verification", async () => {
  // Server findings verify by signal type; unrelated client noise on the same
  // page must not fail a patch for a 500 the server no longer returns.
  const { engine } = stub([{ reproduced: false, loaded: true, otherErrors: ["noise"] }]);
  const r = await verifyFix({
    url: "http://localhost:3000",
    actions: [],
    fingerprint: "fp",
    serve: serveAt("http://127.0.0.1:5555"),
    engine,
    targetType: "network_5xx",
  });
  assert.equal(r.fixed, true);
});
