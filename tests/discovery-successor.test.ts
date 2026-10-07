import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { inferCandidates } from "../src/core/discovery/infer.js";
import { planExperiment, planFamily } from "../src/core/discovery/plan.js";
import { routeIntents } from "../src/core/discovery/drivers.js";
import { scriptPriority } from "../src/core/discovery/evidence.js";
import { attachInterceptor } from "../src/core/interceptor.js";
import { EventBus } from "../src/core/eventBus.js";
import type { EvidenceChunk } from "../src/core/discovery/evidence.js";
import type { StateTransitionPlan } from "../src/core/discovery/types.js";

const src = (content: string, extra: Partial<EvidenceChunk> = {}): EvidenceChunk => ({
  source: "repo_source",
  location: "m.ts",
  content,
  ...extra,
});

const LIST = [
  "export const T: Record<S, readonly S[]> = {",
  '  PENDING: ["SHIPPED", "CANCELLED"],',
  '  SHIPPED: ["DELIVERED", "CANCELLED"],',
  "  DELIVERED: [],",
  "  CANCELLED: [],",
  "};",
].join("\n");

// Same machine, every identifier replaced with something meaningless.
const RENAMED = LIST.replace(/PENDING/g, "q1").replace(/SHIPPED/g, "q2").replace(/DELIVERED/g, "q3").replace(/CANCELLED/g, "q4").replace(/\bT\b/, "zz");

// ---- inference -------------------------------------------------------------

test("successor list: an unlisted move is a rule, a listed one is not, a self-move is neither", () => {
  const ids = inferCandidates(src(LIST)).map((c) => c.id);
  assert.deepEqual(ids, [
    "T:PENDING->DELIVERED=>stays(PENDING)",
    "T:SHIPPED->PENDING=>stays(SHIPPED)",
    "T:DELIVERED->PENDING=>stays(DELIVERED)",
    "T:DELIVERED->SHIPPED=>stays(DELIVERED)",
    "T:DELIVERED->CANCELLED=>stays(DELIVERED)",
    "T:CANCELLED->PENDING=>stays(CANCELLED)",
    "T:CANCELLED->SHIPPED=>stays(CANCELLED)",
    "T:CANCELLED->DELIVERED=>stays(CANCELLED)",
  ]);
});

test("successor list: a rule carries its own evidence, a target (not an action), and the table it came from", () => {
  const c = inferCandidates(src(LIST)).find((x) => x.id === "T:DELIVERED->PENDING=>stays(DELIVERED)")!;
  assert.deepEqual(c.preconditions, [{ field: "state", path: "T", op: "==", value: "DELIVERED" }]);
  assert.deepEqual(c.expectation, c.preconditions);
  assert.deepEqual(c.target, { state: "PENDING" });
  assert.equal(c.action, undefined);
  assert.equal(c.evidence.location, "m.ts:4");
  assert.deepEqual(c.evidence.signals, ["DELIVERED: []"]);
  assert.equal(c.context?.transitionTable.form, "successor-list");
  assert.deepEqual(c.context?.transitionTable.successors.PENDING, ["SHIPPED", "CANCELLED"]);
  assert.ok(c.confidence >= 0.7, "an explicitly empty row is the strongest statement");
});

test("successor list: inference is structural — renamed states and tables give the same rules", () => {
  const shape = (cs: ReturnType<typeof inferCandidates>) =>
    cs.map((c) => [c.preconditions[0].value, c.target?.state].map((s) => String(s).replace(/^q/, "")).join(">"));
  const a = inferCandidates(src(LIST));
  const b = inferCandidates(src(RENAMED));
  assert.equal(b.length, a.length);
  // q1..q4 are PENDING..CANCELLED in order, so the n-th rule is the same move.
  const order = ["PENDING", "SHIPPED", "DELIVERED", "CANCELLED"];
  const ren = (s: string) => `q${order.indexOf(s) + 1}`;
  assert.deepEqual(
    a.map((c) => [ren(c.preconditions[0].value as string), ren(c.target!.state)]),
    b.map((c) => [c.preconditions[0].value, c.target!.state])
  );
  assert.ok(b.every((c) => c.id.startsWith("zz:")));
  assert.deepEqual(shape(b).length, 8);
});

test("successor list: only the rows a diff touched produce rules", () => {
  const found = inferCandidates({ source: "git_diff", location: "m.ts", content: LIST, changedLines: [4] });
  assert.deepEqual(
    found.map((c) => c.id),
    ["T:DELIVERED->PENDING=>stays(DELIVERED)", "T:DELIVERED->SHIPPED=>stays(DELIVERED)", "T:DELIVERED->CANCELLED=>stays(DELIVERED)"]
  );
  assert.ok(found.every((c) => c.evidence.changed === true));
});

test("successor list: lists that are not state machines are not read", () => {
  // Members that aren't rows of the table: a permissions/groups blob, not transitions.
  assert.deepEqual(inferCandidates(src('const groups = { admins: ["alice", "bob"], users: ["carol"] };')), []);
  // Computed / non-literal members.
  assert.deepEqual(inferCandidates(src('const t = { a: [next], b: [] };')), []);
  assert.deepEqual(inferCandidates(src('const t = { a: [B.X], b: [] };')), [], "enum members are not literals");
  // A table that mixes the two forms.
  assert.deepEqual(inferCandidates(src('const t = { a: ["b"], b: { go: "a" } };')), []);
  // Nothing declared at all.
  assert.deepEqual(inferCandidates(src("const t = { a: [], b: [] };")), []);
});

test("successor list: trailing commas, comments, quoted keys and `as const` are tolerated", () => {
  const text = [
    "const flow = {",
    "  // start",
    '  "open": ["closed",],',
    "  /* done */ closed: [],",
    "} as const;",
  ].join("\n");
  assert.deepEqual(
    inferCandidates(src(text)).map((c) => c.id),
    ["flow:closed->open=>stays(closed)"]
  );
});

test("action maps still read exactly as before", () => {
  const text = ["const m = {", '  a: { go: "b" },', "  b: {},", "};"].join("\n");
  const found = inferCandidates(src(text));
  assert.deepEqual(found.map((c) => c.id), ["m:b+go=>stays(b)"]);
  assert.equal(found[0].context?.transitionTable.form, "action-map");
  assert.deepEqual(found[0].action, { name: "go" });
  assert.equal(found[0].target, undefined);
});

// ---- planning --------------------------------------------------------------

test("plan: a successor-list rule becomes the intent to move to a state, with a control that vouches for it", () => {
  const c = inferCandidates(src(LIST)).find((x) => x.id === "T:DELIVERED->PENDING=>stays(DELIVERED)")!;
  assert.equal(planFamily(c), "state-transition");
  const plan = planExperiment(c) as StateTransitionPlan;
  assert.deepEqual(plan.intent, { kind: "target", state: "PENDING" });
  const [forbidden, control] = plan.states;
  assert.deepEqual([forbidden.label, forbidden.assign.state, forbidden.intent, forbidden.applicable], ["forbidden", "DELIVERED", { kind: "target", state: "PENDING" }, true]);
  // Nothing moves *into* PENDING, so the control falls back to a permitted move that exercises the same controls.
  assert.equal(control.label, "allowed-control");
  assert.equal(control.applicable, false);
  assert.deepEqual(control.intent, { kind: "target", state: "SHIPPED" });
  assert.deepEqual(control.mustReach, { field: "state", value: "SHIPPED" });
  assert.equal(control.assign.state, "PENDING");
});

test("plan: when the same target is permitted elsewhere, that is the control", () => {
  const c = inferCandidates(src(LIST)).find((x) => x.id === "T:PENDING->DELIVERED=>stays(PENDING)")!;
  const plan = planExperiment(c) as StateTransitionPlan;
  const control = plan.states[1];
  assert.deepEqual(control.intent, { kind: "target", state: "DELIVERED" });
  assert.equal(control.assign.state, "SHIPPED");
  assert.deepEqual(control.mustReach, { field: "state", value: "DELIVERED" });
});

test("plan: renamed states give the same experiment shape", () => {
  const shape = (text: string, id: string) => {
    const c = inferCandidates(src(text)).find((x) => x.id === id)!;
    const p = planExperiment(c) as StateTransitionPlan;
    return p.states.map((s) => [s.label, s.applicable, s.intent?.kind, Boolean(s.mustReach)]);
  };
  assert.deepEqual(shape(LIST, "T:DELIVERED->PENDING=>stays(DELIVERED)"), shape(RENAMED, "zz:q3->q1=>stays(q3)"));
});

test("plan: a machine with no permitted move at all has nothing to vouch for the experiment, so no plan", () => {
  const text = 'const t = { a: ["b"], b: [], c: [] };';
  const c = inferCandidates(src(text)).find((x) => x.id === "t:c->a=>stays(c)");
  assert.ok(c);
  // a -> b is permitted, so a control exists:
  assert.ok(planExperiment(c!));
  const none = { ...c!, context: { transitionTable: { ...c!.context!.transitionTable, successors: { a: [], b: [], c: [] } } } };
  assert.equal(planExperiment(none), null);
});

test("plan: the planner is control-agnostic — it never mentions a kind of control", () => {
  const code = fs
    .readFileSync(path.join(import.meta.dirname, "..", "src", "core", "discovery", "plan.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/button|select|option|href|\bclick|menu|<a\b|element|selector/i.test(code), "plan.ts must not speak of controls");
});

// ---- routing ---------------------------------------------------------------

test("routeIntents: through a successor list the route is a list of target states", () => {
  const c = inferCandidates(src(LIST))[0];
  const table = c.context!.transitionTable;
  assert.deepEqual(routeIntents(table, "PENDING", "DELIVERED"), [
    { kind: "target", state: "SHIPPED" },
    { kind: "target", state: "DELIVERED" },
  ]);
  assert.deepEqual(routeIntents(table, "PENDING", "PENDING"), []);
  assert.equal(routeIntents(table, "DELIVERED", "PENDING"), null, "a terminal state has no way out");
});

test("routeIntents: through an action table the route is a list of actions", () => {
  const text = 'const m = { a: { go: "b" }, b: { back: "a", end: "c" }, c: {} };';
  const table = inferCandidates(src(text))[0].context!.transitionTable;
  assert.deepEqual(routeIntents(table, "a", "c"), [
    { kind: "action", name: "go" },
    { kind: "action", name: "end" },
  ]);
});

// ---- evidence ranking ------------------------------------------------------

test("scripts: library-looking chunks sort after application-looking ones", () => {
  const vendor = [
    "/_next/static/chunks/node_modules_next_dist_compiled_react-dom_096_9a-._.js",
    "/static/js/vendors~main.chunk.js",
    "/assets/vendor-3f2a.js",
    "/js/framework-abc.js",
    "/js/polyfills.js",
    "/js/jquery.min.js",
    "/webpack-runtime.js",
  ];
  for (const v of vendor) assert.equal(scriptPriority(v), 1, v);
  for (const a of ["/assets/checkout-9d1c.js", "/_next/static/chunks/app_orders_page_1a2b._.js", "/js/main.js", "/static/js/orders.chunk.js"]) {
    assert.equal(scriptPriority(a), 0, a);
  }
});

// ---- environment vs behavior ----------------------------------------------

function fakePage() {
  const handlers = new Map<string, (arg: unknown) => void>();
  return {
    page: { on: (e: string, h: (arg: unknown) => void) => handlers.set(e, h), addInitScript: () => {} } as never,
    fail: (url: string, errorText: string) =>
      handlers.get("requestfailed")?.({ url: () => url, failure: () => ({ errorText }) }),
  };
}

test("environment: an unreachable cross-origin dependency is recorded as environment, not as a finding", () => {
  const bus = new EventBus();
  const telemetry: string[] = [];
  const env: Array<{ url: string; error: string }> = [];
  bus.on("telemetry", (p) => telemetry.push(p.rawMessage));
  bus.on("environment", (e) => env.push(e));
  const { page, fail } = fakePage();
  attachInterceptor(page, bus, "http://localhost:3100");

  fail("http://localhost:5000/api/products", "net::ERR_CONNECTION_REFUSED");
  fail("https://api.example.invalid/x", "net::ERR_NAME_NOT_RESOLVED");
  assert.deepEqual(telemetry, []);
  assert.deepEqual(env.map((e) => e.error), ["net::ERR_CONNECTION_REFUSED", "net::ERR_NAME_NOT_RESOLVED"]);
});

test("environment: the app's own origin refusing connections is still a failure of the app", () => {
  const bus = new EventBus();
  const telemetry: string[] = [];
  const env: unknown[] = [];
  bus.on("telemetry", (p) => telemetry.push(p.rawMessage));
  bus.on("environment", (e) => env.push(e));
  const { page, fail } = fakePage();
  attachInterceptor(page, bus, "http://localhost:3100");

  fail("http://localhost:3100/api/crash", "net::ERR_CONNECTION_REFUSED");
  assert.equal(env.length, 0);
  assert.match(telemetry[0], /Request failed: http:\/\/localhost:3100\/api\/crash/);
});

test("environment: a dependency that answered badly or hung is still behavior, and callers without an origin see old behavior", () => {
  const bus = new EventBus();
  const telemetry: string[] = [];
  const env: unknown[] = [];
  bus.on("telemetry", (p) => telemetry.push(p.rawMessage));
  bus.on("environment", (e) => env.push(e));
  const a = fakePage();
  attachInterceptor(a.page, bus, "http://localhost:3100");
  a.fail("http://localhost:5000/slow", "net::ERR_CONNECTION_TIMED_OUT");
  a.fail("http://localhost:5000/reset", "net::ERR_CONNECTION_RESET");
  assert.equal(telemetry.length, 2);
  assert.equal(env.length, 0);

  const b = fakePage();
  attachInterceptor(b.page, bus); // no origin: nothing can be classified
  b.fail("http://localhost:5000/api", "net::ERR_CONNECTION_REFUSED");
  assert.equal(telemetry.length, 3);
});
