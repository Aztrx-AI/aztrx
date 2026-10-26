import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { investigate } from "../src/core/hypothesis/investigate.js";
import { groundingOf, observeState, statusOf, ungroundedLiterals } from "../src/core/hypothesis/ground.js";
import { Ledger } from "../src/core/hypothesis/ledger.js";
import type { Completer } from "../src/core/hypothesis/generate.js";
import type { Hypothesis, HypothesisResult } from "../src/core/hypothesis/types.js";

// A fixture of our own, unrelated to any evaluation task: items you can add,
// a visible count, and a Delete button that exists only once an item exists.
function app(opts: { loginWall?: boolean } = {}): Promise<{ url: string; close: () => void; reset: () => Promise<void> }> {
  const items: string[] = [];
  const page = () =>
    opts.loginWall
      ? `<!doctype html><title>Locked</title><h1>Locked</h1><label>Password <input type="password"></label><button>Log in</button>`
      : `<!doctype html><title>Todo</title><h1>Tasks</h1><p id="n">${items.length} tasks</p>
<form method="post" action="/add"><label>Task name <input name="t"></label><button>Add task</button></form>
<ul>${items.map((t, i) => `<li>${t} <form method="post" action="/del?i=${i}" style="display:inline"><button>Remove</button></form></li>`).join("")}</ul>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && u.pathname === "/__reset") { items.length = 0; return void res.writeHead(204).end(); }
      if (req.method === "POST" && u.pathname === "/add") { const v = new URLSearchParams(body).get("t")?.trim(); if (v) items.push(v); }
      else if (req.method === "POST" && u.pathname === "/del") items.splice(Number(u.searchParams.get("i")), 1);
      if (req.method === "POST") return void res.writeHead(303, { location: "/" }).end();
      res.writeHead(200, { "content-type": "text/html" }).end(page());
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({ url, close: () => server.close(), reset: async () => void (await fetch(`${url}/__reset`, { method: "POST" })) });
    })
  );
}

/** The id the prompt lists for a control/element whose line matches `re` (like a model reading the listing). */
const idOf = (prompt: string, re: RegExp): string => {
  const line = prompt.split("\n").find((l) => re.test(l));
  const m = line?.match(/^\s*([cr]\d+)\b/);
  if (!m) throw new Error(`no listed element matches ${re}\n${prompt.slice(-1500)}`);
  return m[1];
};

const reply = (o: unknown) => JSON.stringify(o);
const addThenCount = (prompt: string, from = "s0") => ({
  why_next: "The count and the list are the app's two views of the same data; adding a task should move both.",
  from_state: from,
  page: "/",
  behavior: "Adding a task increases the displayed task count by one",
  property: "consistency",
  expectation: { kind: "universal" },
  impact: 3,
  steps: [
    { op: "snapshot", label: "before" },
    { op: "fill", control: idOf(prompt, /\[input(?::\w+)?\] "Task name"/), value: "write tests" },
    { op: "click", control: idOf(prompt, /\[button\] "Add task"/) },
    { op: "snapshot", label: "after" },
  ],
  reads: [{ name: "count", what: "text", element: idOf(prompt, /\[text\] currently "\d+ tasks"/) }],
  expect: [{ kind: "increased_by", left: { snapshot: "after", read: "count" }, base: { snapshot: "before", read: "count" }, by: 1 }],
});

test("observeState lists the real controls and readables, each with an id and a target that resolves", async () => {
  const a = await app();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(a.url);
    const m = await observeState(page, a.url, { crawl: false });
    const names = m.routes[0].controls.map((c) => `${c.kind}:${c.name}`);
    assert.deepEqual(names, ["input:Task name", "button:Add task"]);
    assert.ok(m.routes[0].controls.every((c) => /^c\d+$/.test(c.id)));
    const count = m.routes[0].readables.find((r) => r.sample === "0 tasks");
    assert.ok(count, "the visible counter is a readable");
    assert.ok(m.routes[0].readables.some((r) => r.kind === "count" && r.sample === "0"), "the empty list is a count of 0");
  } finally {
    await browser.close();
    a.close();
  }
});

test("grounding: a stated requirement is specified; a universal property with established operands is general; an invented constant is exploratory", () => {
  const base: Hypothesis = {
    id: "h", behavior: "x".repeat(20), property: "consistency", impact: 3,
    expectation: { kind: "universal" },
    steps: [{ op: "goto", path: "/" }, { op: "snapshot", label: "a" }],
    reads: [{ name: "n", what: "count", target: { selector: "li" } }],
    expect: [{ kind: "equals", left: "a.n", right: 10 }],
  };
  assert.deepEqual(ungroundedLiterals(base), ["10"]);
  assert.equal(groundingOf(base, { bound: true }), "exploratory", "10 is nobody's number");
  assert.equal(groundingOf({ ...base, expect: [{ kind: "equals", left: "a.n", right: 0 }] }, { bound: true, observed: new Map([["n", "0"]]) }), "general", "0 is what the page showed");
  assert.equal(groundingOf({ ...base, expect: [{ kind: "increased_by", left: "a.n", base: "a.n", by: 1 }] }, { bound: true }), "general");
  assert.equal(groundingOf({ ...base, expect: [{ kind: "increased_by", left: "a.n", base: "a.n", by: 1 }] }, { bound: false }), "exploratory", "preconditions not established");
  assert.equal(groundingOf({ ...base, expectation: { kind: "doc", quote: "lists show their items" }, expect: [{ kind: "increased_by", left: "a.n", base: "a.n", by: 1 }] }), "specified");
});

test("a replayed violation is a finding only when a stated requirement is behind it; otherwise a lead", () => {
  const h = (kind: "doc" | "universal"): Hypothesis => ({
    id: "h", behavior: "x".repeat(20), property: "consistency", impact: 3,
    expectation: kind === "doc" ? { kind, quote: "q" } : { kind },
    steps: [{ op: "goto", path: "/" }], reads: [], expect: [{ kind: "increased_by", left: "a.n", base: "a.n", by: 1 }],
  });
  const result = (hyp: Hypothesis): HypothesisResult => ({
    hypothesis: hyp, priority: 1, outcome: "supported_violation", reason: "", durationMs: 1,
    runs: [{ steps: [{ step: { op: "goto", path: "/" }, ok: true }], readings: [], relations: [], environment: [] }],
  });
  assert.equal(statusOf(result(h("doc"))), "finding");
  assert.equal(statusOf(result(h("universal"))), "lead");
});

test("investigate: continues from the state an experiment left, never offers a failed control again, and records why", async () => {
  const a = await app();
  const seenSchemas: string[] = [];
  let call = 0;
  const complete: Completer = async (req) => {
    call++;
    seenSchemas.push(JSON.stringify(req.schema));
    if (call === 1) return reply(addThenCount(req.prompt));
    if (call === 2) {
      // The Remove button exists only in the state the first experiment left behind.
      return reply({
        why_next: "Removal is the inverse of adding; the first experiment left a task to remove.",
        from_state: "s1",
        page: "/",
        behavior: "Removing the only task returns the displayed count to what it was before",
        property: "round-trip",
        expectation: { kind: "universal" },
        impact: 4,
        steps: [{ op: "snapshot", label: "with" }, { op: "click", control: idOf(req.prompt, /\[button\] "Remove"/) }, { op: "snapshot", label: "without" }],
        reads: [{ name: "count", what: "text", element: idOf(req.prompt.split("=== STATE s1")[1], /\[text\] currently "\d+ tasks"/) }],
        expect: [{ kind: "increased_by", left: { snapshot: "with", read: "count" }, base: { snapshot: "without", read: "count" }, by: 1 }],
      });
    }
    // Asks for a control that was never observed.
    return reply({ ...addThenCount(req.prompt), steps: [{ op: "snapshot", label: "before" }, { op: "click", control: "c99" }, { op: "snapshot", label: "after" }] });
  };
  try {
    const r = await investigate({ baseUrl: a.url, complete, ledger: new Ledger(), maxIterations: 3, maxMs: 120_000, reset: a.reset });
    assert.deepEqual(r.iterations[0].rejectedProposals, [], "first proposal accepted");
    assert.equal(r.iterations[0].result?.outcome, "disproven", `healthy app: the count rose by one (${r.stoppedBecause})`);
    assert.equal(r.iterations[0].grounding, "general");
    assert.deepEqual(r.states.map((s) => s.id), ["s0", "s1", "s2"].slice(0, r.states.length));
    assert.ok(r.states.length >= 2, "the first experiment became a state");
    assert.equal(r.iterations[1].fromState, "s1");
    assert.equal(r.iterations[1].result?.outcome, "disproven", "the Remove control, seen only in s1, ran");
    assert.match(r.iterations[1].why, /inverse of adding/);
    assert.match(r.iterations[2].rejectedProposals[0], /c99.*not an observed control/);
    assert.equal(r.counts.findings + r.counts.leads, 0, "a healthy app yields no claims");
    assert.equal(r.metrics.groundedStepRate, 1);
    assert.ok(seenSchemas[0].includes('"enum":["c1","c2"]'), "the reply schema offers only observed control ids");
  } finally {
    a.close();
  }
});

test("investigate: an unsupported expectation never becomes a finding, and its invented constant is exploratory", async () => {
  const a = await app();
  const complete: Completer = async (req) =>
    reply({
      ...addThenCount(req.prompt),
      behavior: "The task counter shows exactly 7 tasks after one is added",
      steps: [{ op: "fill", control: idOf(req.prompt, /\[input(?::\w+)?\] "Task name"/), value: "a" }, { op: "click", control: idOf(req.prompt, /\[button\] "Add task"/) }, { op: "snapshot", label: "after" }],
      expect: [{ kind: "equals", left: { snapshot: "after", read: "count" }, right: "7 tasks" }],
    });
  try {
    const r = await investigate({ baseUrl: a.url, complete, ledger: new Ledger(), maxIterations: 1, maxMs: 120_000, reset: a.reset });
    assert.equal(r.iterations[0].grounding, "exploratory");
    assert.equal(r.iterations[0].result?.outcome, "supported_violation", "it did violate the guess, twice");
    assert.equal(r.iterations[0].result?.status, "lead", "but a guess is not a requirement");
    assert.equal(r.counts.findings, 0);
    assert.equal(r.counts.leads, 1);
  } finally {
    a.close();
  }
});

test("investigate: a login wall is reported as a prerequisite blocker, not as a defect", async () => {
  const a = await app({ loginWall: true });
  const complete: Completer = async (req) =>
    reply({
      why_next: "Try the only control.",
      from_state: "s0",
      page: "/",
      behavior: "Clicking the log in button with no password shows an error",
      property: "other",
      expectation: { kind: "universal" },
      impact: 2,
      steps: [{ op: "click", control: idOf(req.prompt, /\[button\] "Log in"/) }, { op: "snapshot", label: "after" }],
      reads: [{ name: "h", what: "text", element: idOf(req.prompt, /\[text\] currently "Locked"/) }],
      expect: [{ kind: "contains", left: { snapshot: "after", read: "h" }, right: "error" }],
    });
  try {
    const r = await investigate({ baseUrl: a.url, complete, ledger: new Ledger(), maxIterations: 1, maxMs: 60_000, reset: a.reset });
    assert.equal(r.prerequisites[0]?.kind, "authentication");
    assert.equal(r.prerequisites[0].satisfied, false);
    assert.match(r.blockers[0], /authentication prerequisite/);
    assert.equal(r.counts.findings, 0);
  } finally {
    a.close();
  }
});
