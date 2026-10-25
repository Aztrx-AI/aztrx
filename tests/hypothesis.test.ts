import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { discover } from "../src/core/hypothesis/index.js";
import { parseHypotheses } from "../src/core/hypothesis/generate.js";
import { judge, prioritize, priority } from "../src/core/hypothesis/execute.js";
import { BudgetExceeded, Ledger, findLeaks, pricingFromEnv, redact } from "../src/core/hypothesis/ledger.js";
import type { Hypothesis, Inventory, Reading } from "../src/core/hypothesis/types.js";

// A fixture of our own, unrelated to any evaluation task: a server-rendered
// list. The buggy variant cannot remove the last remaining item.
function listApp(buggy: boolean): Promise<{ url: string; close: () => void; reset: () => Promise<void> }> {
  const items: string[] = [];
  const page = () =>
    `<!doctype html><title>List</title><h1>Shopping list</h1>
<form method="post" action="/add"><label>New item <input name="item"></label><button>Add</button></form>
<ul>${items.map((t, i) => `<li>${t} <form method="post" action="/remove?i=${i}" style="display:inline"><button>Remove</button></form></li>`).join("")}</ul>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && u.pathname === "/__reset") {
        items.length = 0;
        res.writeHead(204).end();
        return;
      }
      if (req.method === "POST" && u.pathname === "/add") {
        const v = new URLSearchParams(body).get("item")?.trim();
        if (v) items.push(v);
      } else if (req.method === "POST" && u.pathname === "/remove") {
        if (!(buggy && items.length === 1)) items.splice(Number(u.searchParams.get("i")), 1);
      }
      if (req.method === "POST") {
        res.writeHead(303, { location: "/" }).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(page());
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => server.close(),
        reset: async () => void (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/__reset`, { method: "POST" })),
      })
    )
  );
}

const inv: Inventory = { text: "### docs:README.md\nAdd items to your list and remove them again.", sections: [] };

const roundTrip = {
  behavior: "An item that is added and then removed is gone from the list",
  property: "round-trip",
  expectation: { kind: "ui", quote: "New item" },
  impact: 4,
  steps: [
    { op: "goto", path: "/" },
    { op: "snapshot", label: "before" },
    { op: "fill", target: { label: "New item" }, value: "zz-probe" },
    { op: "click", target: { role: "button", text: "Add" } },
    { op: "snapshot", label: "added" },
    { op: "click", target: { role: "button", text: "Remove" } },
    { op: "snapshot", label: "after" },
  ],
  reads: [{ name: "rows", what: "count", target: { selector: "li" } }],
  expect: [
    { kind: "increased_by", left: "added.rows", base: "before.rows", by: 1 },
    { kind: "equals", left: "after.rows", right: "before.rows" },
  ],
};

const unrunnable = {
  behavior: "A share button exists",
  property: "other",
  expectation: { kind: "universal" },
  impact: 2,
  steps: [{ op: "goto", path: "/" }, { op: "click", target: { text: "Share with friends" } }, { op: "snapshot", label: "s" }],
  reads: [{ name: "rows", what: "count", target: { selector: "li" } }],
  expect: [{ kind: "equals", left: "s.rows", right: 0 }],
};

const scripted = (hs: unknown[]) => async () => JSON.stringify(hs);

async function attempt(buggy: boolean, hs: unknown[]) {
  const app = await listApp(buggy);
  try {
    return await discover({ baseUrl: app.url, complete: scripted(hs), ledger: new Ledger(), maxMs: 60_000, reset: app.reset });
  } finally {
    app.close();
  }
}

test("pipeline: a round-trip that fails is reported only after a fresh session reproduces it", async () => {
  const r = await attempt(true, [roundTrip]);
  assert.equal(r.counts.supported_violation, 1);
  assert.equal(r.results[0].runs.length, 2, "the violation was replayed once in a fresh session");
  assert.equal(r.isolation, "reset-per-run");
  assert.equal(r.results[0].hypothesis.expectation.kind, "ui", "the quote is in the observed UI, so the source is kept");
});

test("pipeline: the same hypothesis on a correct app is disproven, not reported", async () => {
  const r = await attempt(false, [roundTrip]);
  assert.equal(r.counts.supported_violation, 0);
  assert.equal(r.counts.disproven, 1);
});

test("pipeline: a script that cannot run is unknown, never a finding", async () => {
  const r = await attempt(true, [unrunnable]);
  assert.equal(r.counts.unknown, 1);
  assert.equal(r.counts.supported_violation, 0);
  assert.match(r.results[0].reason, /could not run/);
});

test("pipeline: an unreachable app is an environment failure, not a verdict on the product", async () => {
  const app = await listApp(true);
  app.close();
  const r = await discover({ baseUrl: app.url, complete: scripted([roundTrip]), ledger: new Ledger(), maxMs: 60_000 });
  assert.equal(r.counts.supported_violation, 0);
  assert.equal(r.counts.environment, 1, "a dead app is an environment failure, not a disproof or a finding");
});

test("parse: a quote that is not in the inventory demotes the source to universal", () => {
  const invented = { ...roundTrip, expectation: { kind: "doc", quote: "Items vanish permanently within one second." } };
  const { accepted } = parseHypotheses(JSON.stringify([invented]), inv);
  assert.equal(accepted[0].expectation.kind, "universal");
  assert.equal(accepted[0].expectation.quote, undefined);
});

test("parse: malformed hypotheses are dropped with a reason, not repaired", () => {
  const noReads = { ...roundTrip, reads: [] };
  const badRef = { ...roundTrip, expect: [{ kind: "equals", left: "nowhere.rows", right: 1 }] };
  const tooLong = { ...roundTrip, steps: Array.from({ length: 13 }, () => ({ op: "reload" })) };
  const { accepted, rejected } = parseHypotheses(JSON.stringify([noReads, badRef, tooLong, roundTrip]), inv);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 3);
  assert.match(rejected[1].why, /unknown snapshot/);
});

test("parse: a reply wrapped in prose and a fence is still read", () => {
  const { accepted } = parseHypotheses("Here you go:\n```json\n" + JSON.stringify([roundTrip]) + "\n```", inv);
  assert.equal(accepted.length, 1);
});

test("judge: numbers compare as numbers, missing readings are null not false", () => {
  const rs: Reading[] = [
    { label: "a", name: "total", value: "$12.50" },
    { label: "b", name: "total", value: "12.5" },
    { label: "a", name: "gone", value: null },
  ];
  assert.equal(judge({ kind: "equals", left: "a.total", right: "b.total" }, rs), true);
  assert.equal(judge({ kind: "equals", left: "a.gone", right: "b.total" }, rs), null);
  assert.equal(judge({ kind: "not_contains", left: "a.total", right: "error" }, rs), true);
});

test("prioritize: project-anchored, high-impact, short experiments come first; near-duplicates collapse", () => {
  const base = parseHypotheses(JSON.stringify([roundTrip]), inv).accepted[0];
  const generic: Hypothesis = {
    ...base,
    id: "g",
    property: "persistence",
    expectation: { kind: "universal" },
    impact: 2,
  };
  const dup: Hypothesis = { ...base, id: "z-dup" };
  const order = prioritize([generic, dup, base]);
  assert.deepEqual(order.map((o) => o.h.id), ["h1", "g"]);
  assert.ok(priority(base) > priority(generic));
});

test("ledger: a cap without prices refuses to start, and a call that could cross the cap is refused", () => {
  assert.throws(() => new Ledger({ capUsd: 5 }), /needs prices/);
  const l = new Ledger({ capUsd: 0.01, pricing: { inputPerM: 1, outputPerM: 10 } });
  assert.throws(() => l.guard(4_000_000, 100), BudgetExceeded);
  l.guard(400, 100);
  l.record({ model: "m", inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(l.costUsd, 1);
  assert.throws(() => l.guard(40, 10), BudgetExceeded);
});

test("ledger: prices come only from the operator's environment", () => {
  assert.equal(pricingFromEnv({}), undefined);
  assert.deepEqual(pricingFromEnv({ AZTRX_PRICE_IN: "0.5", AZTRX_PRICE_OUT: "2" }), { inputPerM: 0.5, outputPerM: 2 });
});

test("redact: credentials never reach a report", () => {
  const out = redact("Authorization: Bearer abcdefghijklmnopqrstuvwx and sk-abcdefghijklmnopqrstuv and api_key=hunter2hunter2");
  assert.doesNotMatch(out, /abcdefghijklmnopqrstuvwx|sk-abcdef|hunter2/);
});

test("leaks: sealed fragments found anywhere in what the agent saw are reported", () => {
  assert.deepEqual(findLeaks(["the cart total ignores quantity"], ["ignores quantity", "unrelated phrase"]), ["ignores quantity"]);
  assert.deepEqual(findLeaks(["nothing here"], ["ignores quantity"]), []);
});
