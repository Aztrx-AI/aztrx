import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { parseHypotheses } from "../src/core/hypothesis/generate.js";
import { MAX_CONSECUTIVE_INVALID, TOOLS, checkArguments, runBaseline, toolDefs, type ToolCaller } from "../src/core/hypothesis/baseline.js";
import { Ledger } from "../src/core/hypothesis/ledger.js";
import type { Inventory } from "../src/core/hypothesis/types.js";

const inv: Inventory = { text: "### docs:README.md\nAdd notes and delete them again.", sections: [] };

const valid = {
  behavior: "A note that is added shows up in the list",
  property: "round-trip",
  expectation: { kind: "universal" },
  impact: 3,
  steps: [
    { op: "goto", path: "/" },
    { op: "snapshot", label: "a" },
    { op: "fill", target: { label: "Note text" }, value: "x" },
    { op: "click", target: { text: "Save note" } },
    { op: "snapshot", label: "b" },
  ],
  reads: [{ name: "n", what: "count", target: { selector: "li" } }],
  expect: [{ kind: "increased_by", left: "b.n", base: "a.n", by: 1 }],
};

test("generation status: ok / no_hypotheses / format_error / all_rejected are distinct", () => {
  assert.equal(parseHypotheses(JSON.stringify({ hypotheses: [valid] }), inv).status, "ok");
  assert.equal(parseHypotheses(JSON.stringify([valid]), inv).status, "ok");
  assert.equal(parseHypotheses(JSON.stringify({ hypotheses: [] }), inv).status, "no_hypotheses");
  assert.equal(parseHypotheses("[]", inv).status, "no_hypotheses");
  assert.equal(parseHypotheses(JSON.stringify({ hypotheses: [{ behavior: "x" }] }), inv).status, "all_rejected");
  for (const bad of ["", "I think there are no bugs.", '{"hypotheses": [{"behavior": "cut o', JSON.stringify({ other: 1 })]) {
    const r = parseHypotheses(bad, inv);
    assert.equal(r.status, "format_error", bad);
    assert.ok(r.formatError);
    assert.equal(r.accepted.length, 0, "nothing is invented from a bad reply");
  }
});

test("a reply cut off by the output limit is reported as truncation, not as an empty result", () => {
  const r = parseHypotheses('{"hypotheses":[{"behavior":"abc', inv, "length");
  assert.equal(r.status, "format_error");
  assert.match(r.formatError ?? "", /cut off/);
});

test("meaningless or inert hypotheses are rejected, not repaired", () => {
  const noAction = { ...valid, steps: [{ op: "snapshot", label: "a" }, { op: "snapshot", label: "b" }] };
  const noSnap = { ...valid, steps: [{ op: "goto", path: "/" }], expect: [{ kind: "equals", left: "a.n", right: 1 }] };
  const tautology = { ...valid, expect: [{ kind: "equals", left: "b.n", right: "b.n" }] };
  const vague = { ...valid, behavior: "works" };
  const r = parseHypotheses(JSON.stringify({ hypotheses: [noAction, noSnap, tautology, vague] }), inv);
  assert.equal(r.accepted.length, 0);
  assert.deepEqual(r.rejected.map((x) => x.why), [
    "script performs no action",
    "script takes no snapshot",
    "relation compares a reading with itself",
    "no meaningful behavior statement",
  ]);
});

test("a quote the model never saw demotes the expectation source to universal", () => {
  const r = parseHypotheses(JSON.stringify({ hypotheses: [{ ...valid, expectation: { kind: "doc", quote: "invented sentence about billing" } }] }), inv);
  assert.equal(r.accepted[0].expectation.kind, "universal");
});

// ---- baseline tool contract ----------------------------------------------

test("every model-facing tool is executable and every executable tool is model-facing", () => {
  const defs = toolDefs();
  assert.deepEqual(defs.map((d) => d.name), TOOLS.map((t) => t.name));
  for (const t of TOOLS) {
    assert.equal(typeof t.run, "function", t.name);
    assert.ok(t.description.length > 10, `${t.name} is described`);
    assert.equal((t.parameters as { type: string }).type, "object", `${t.name} has an object schema`);
  }
  assert.deepEqual(defs.map((d) => d.name), ["look", "goto", "click", "fill", "press", "reload", "report", "done"]);
});

test("argument checks catch missing, unknown and mistyped arguments", () => {
  const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
  assert.equal(checkArguments(tool("goto"), { path: "/x" }), undefined);
  assert.match(checkArguments(tool("goto"), {})!, /missing required/);
  assert.match(checkArguments(tool("goto"), { path: "//evil.example" })!, /same-origin/);
  assert.match(checkArguments(tool("goto"), { path: "/x", extra: 1 })!, /unknown argument/);
  assert.match(checkArguments(tool("click"), { target: {} })!, /at least one/);
  assert.match(checkArguments(tool("fill"), { target: { text: "a" } })!, /missing required/);
  assert.match(checkArguments(tool("press"), { key: 5 })!, /must be a string/);
});

function page(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>T</title><h1>Hello</h1><button>Go</button><input placeholder="name">`);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }))
  );
}

const scripted = (calls: Array<{ name: string; arguments: Record<string, unknown> } | null>): ToolCaller => {
  let i = 0;
  return async () => {
    const c = calls[Math.min(i++, calls.length - 1)];
    return { calls: c ? [c] : [], text: c ? "" : "I will click the button" };
  };
};

test("baseline: valid calls execute and return real page observations; unknown actions are recorded, not run", async () => {
  const app = await page();
  try {
    const r = await runBaseline({
      baseUrl: app.url,
      callTools: scripted([
        { name: "look", arguments: {} },
        { name: "teleport", arguments: { to: "/" } },
        { name: "click", arguments: { target: { text: "Go" } } },
        { name: "fill", arguments: { target: { placeholder: "name" }, value: "zed" } },
        { name: "click", arguments: { target: { text: "No such control" } } },
        { name: "done", arguments: {} },
      ]),
      ledger: new Ledger(),
      maxTurns: 10,
      maxMs: 60_000,
    });
    assert.deepEqual(r.turns.map((t) => t.status), ["ok", "invalid_tool_call", "ok", "ok", "tool_error", "ok"]);
    assert.match(r.turns[0].observation, /title: T[\s\S]*text: Hello[\s\S]*controls: .*button "Go"/, "look returns real page content incl. controls");
    assert.match(r.turns[1].observation, /unknown action "teleport"\. Available actions: look, goto, click, fill, press, reload, report, done/);
    assert.equal(r.metrics.validToolCalls, 5);
    assert.equal(r.metrics.invalidToolCalls, 1);
    assert.equal(r.metrics.toolErrors, 1);
    assert.equal(r.metrics.observations, 2);
    assert.equal(r.metrics.actionsExecuted, 2);
    assert.equal(r.stoppedBecause, "agent said done");
  } finally {
    app.close();
  }
});

test("baseline: repeated invalid calls end the session instead of retrying forever", async () => {
  const app = await page();
  try {
    const r = await runBaseline({
      baseUrl: app.url,
      callTools: scripted([{ name: "navigate", arguments: {} }, null, { name: "goto", arguments: {} }, { name: "look", arguments: {} }]),
      ledger: new Ledger(),
      maxTurns: 40,
      maxMs: 60_000,
    });
    assert.equal(r.turns.length, MAX_CONSECUTIVE_INVALID);
    assert.deepEqual(r.turns.map((t) => t.status), ["invalid_tool_call", "no_tool_call", "invalid_tool_call"]);
    assert.match(r.stoppedBecause, /3 consecutive invalid tool calls/);
    assert.equal(r.metrics.validToolCalls, 0);
    assert.equal(r.metrics.validCallRate, 0);
  } finally {
    app.close();
  }
});

test("baseline: a report call is recorded as a claim", async () => {
  const app = await page();
  try {
    const r = await runBaseline({
      baseUrl: app.url,
      callTools: scripted([{ name: "report", arguments: { claim: "did X saw Y", why_it_is_wrong: "Z" } }, { name: "done", arguments: {} }]),
      ledger: new Ledger(),
      maxTurns: 5,
      maxMs: 60_000,
    });
    assert.equal(r.claims.length, 1);
    assert.equal(r.claims[0].atTurn, 1);
  } finally {
    app.close();
  }
});

test("relations accept structured {snapshot, read} references and still reject malformed ones", () => {
  const structured = {
    ...valid,
    expect: [{ kind: "increased_by", left: { snapshot: "b", read: "n" }, base: { snapshot: "a", read: "n" }, by: 1 }],
  };
  const withRef = { ...valid, expect: [{ kind: "equals", left: { snapshot: "b", read: "n" }, right_ref: { snapshot: "a", read: "n" } }] };
  const bareName = { ...valid, expect: [{ kind: "equals", left: "n", right: 1 }] };
  const noRead = { ...valid, expect: [{ kind: "equals", left: { snapshot: "b" }, right: 1 }] };
  const badRight = { ...valid, expect: [{ kind: "equals", left: { snapshot: "b", read: "n" }, right_ref: { snapshot: "a" } }] };
  const r = parseHypotheses(JSON.stringify({ hypotheses: [structured, withRef, bareName, noRead, badRight] }), inv);
  assert.equal(r.accepted.length, 2);
  assert.deepEqual(r.accepted[0].expect, [{ kind: "increased_by", left: "b.n", base: "a.n", by: 1 }]);
  assert.deepEqual(r.accepted[1].expect, [{ kind: "equals", left: "b.n", right: "a.n" }]);
  assert.equal(r.rejected.length, 3, "a bare reading name, a half reference and a bad right_ref are not guessed at");
});

test("baseline: an invalid call is answered with a worked example of the right shape", async () => {
  const app = await page();
  try {
    const r = await runBaseline({
      baseUrl: app.url,
      callTools: scripted([{ name: "click", arguments: { target: "text: Go" } }, { name: "done", arguments: {} }]),
      ledger: new Ledger(),
      maxTurns: 3,
      maxMs: 60_000,
    });
    assert.match(r.turns[0].observation, /must be an object\. A valid call looks like click\(\{"target":\{"text":"Save"\}\}\)/);
  } finally {
    app.close();
  }
});
