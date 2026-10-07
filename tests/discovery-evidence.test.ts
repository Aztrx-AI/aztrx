import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { inferCandidates, inferFromEvidence } from "../src/core/discovery/infer.js";
import { planExperiment, planFamily } from "../src/core/discovery/plan.js";
import { compileCandidate } from "../src/core/discovery/compile.js";
import { collectGitDiff, collectLocalEvidence, collectRepoSource, parseUnifiedDiff } from "../src/core/discovery/evidence.js";
import type { EvidenceChunk } from "../src/core/discovery/evidence.js";
import { routeThrough } from "../src/core/discovery/drivers.js";
import { evaluateInvariant } from "../src/core/invariant.js";
import type { StateTransitionPlan } from "../src/core/discovery/types.js";

const served = (content: string, location = "app.js"): EvidenceChunk => ({ source: "served_js", location, content });

const MACHINE = [
  "const orderMachine = {",
  '  pending:   { pay: "paid", cancel: "cancelled" },',
  '  paid:      { fulfill: "fulfilled", cancel: "cancelled" },',
  "  cancelled: {},",
  "  fulfilled: {},",
  "};",
].join("\n");

// ---- diff parsing ----------------------------------------------------------

test("parseUnifiedDiff: records the new-side line numbers each file gained, nothing for removals", () => {
  const diff = [
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -3,2 +3,3 @@ fn",
    " keep",
    "-old",
    "+new one",
    "+new two",
    "@@ -20 +22 @@",
    "-x",
    "+y",
    "diff --git a/gone.js b/gone.js",
    "--- a/gone.js",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
  ].join("\n");
  assert.deepEqual(parseUnifiedDiff(diff), [{ file: "src/a.js", added: [4, 5, 22] }]);
});

// ---- inference over one chunk shape ----------------------------------------

test("infer: a git_diff chunk yields only rules that sit on changed lines, located at the real line", () => {
  const content = [
    "function a(c) {",
    "  let s = 5;",
    "  if (c.total >= 100) { s = 0; }", // line 3, unchanged
    "  return s;",
    "}",
    "function b(o) {",
    "  let h = 2;",
    "  if (o.qty >= 10) { h = 0; }", // line 8, changed
    "  return h;",
    "}",
  ].join("\n");
  const found = inferCandidates({ source: "git_diff", location: "src/rules.js", content, changedLines: [8] });
  assert.equal(found.length, 1);
  assert.equal(found[0].preconditions[0].path, "o.qty");
  assert.equal(found[0].evidence.location, "src/rules.js:8");
  assert.equal(found[0].evidence.changed, true);
  assert.equal(found[0].evidence.source, "git_diff");
  // The same text as repo source states both rules, and claims nothing about change.
  const both = inferCandidates({ source: "repo_source", location: "src/rules.js", content });
  assert.equal(both.length, 2);
  assert.equal(both[0].evidence.changed, undefined);
});

test("infer: changing only a constant changes the rule that reads it", () => {
  const content = ["const FREE_AT = 50;", "function f(c) {", "  let s = 5;", "  if (c.total >= FREE_AT) { s = 0; }", "}"].join("\n");
  const found = inferCandidates({ source: "git_diff", location: "cfg.js", content, changedLines: [1] });
  assert.equal(found.length, 1);
  assert.equal(found[0].preconditions[0].value, 50);
  assert.equal(found[0].evidence.location, "cfg.js:4");
  assert.ok(found[0].evidence.signals.includes("FREE_AT = 50"));
});

test("infer: an empty change is no evidence — a diff chunk with no touched line yields nothing", () => {
  assert.deepEqual(inferCandidates({ source: "git_diff", location: "x.js", content: MACHINE, changedLines: [] }), []);
});

// ---- transition tables -----------------------------------------------------

test("infer: a transition table states which actions have no edge out of which states", () => {
  const found = inferCandidates(served(MACHINE));
  const ids = found.map((c) => c.id);
  assert.ok(ids.includes("orderMachine:cancelled+fulfill=>stays(cancelled)"));
  assert.ok(ids.includes("orderMachine:pending+fulfill=>stays(pending)"));
  assert.ok(!ids.some((id) => id.includes("paid+fulfill")), "an edge that exists is not a rule");
  const c = found.find((x) => x.id === "orderMachine:cancelled+fulfill=>stays(cancelled)")!;
  assert.deepEqual(c.preconditions, [{ field: "state", path: "orderMachine", op: "==", value: "cancelled" }]);
  assert.deepEqual(c.expectation, c.preconditions);
  assert.equal(c.action?.name, "fulfill");
  assert.equal(c.evidence.location, "app.js:4");
  assert.equal(c.evidence.signals[0], "cancelled: {}");
  assert.match(c.evidence.signals[1], /paid:\s+\{ fulfill: "fulfilled"/);
  assert.ok(c.confidence > 0);
});

test("infer: a diff that touches one row yields only that row's rules", () => {
  const found = inferCandidates({ source: "git_diff", location: "m.js", content: MACHINE, changedLines: [4] });
  assert.deepEqual(
    found.map((c) => c.id).sort(),
    ["orderMachine:cancelled+cancel=>stays(cancelled)", "orderMachine:cancelled+fulfill=>stays(cancelled)", "orderMachine:cancelled+pay=>stays(cancelled)"]
  );
  assert.ok(found.every((c) => c.evidence.changed === true && c.evidence.location === "m.js:4"));
});

test("infer: an object that merely nests objects is not a state machine", () => {
  assert.deepEqual(inferCandidates(served('const cfg = { a: { x: "1" }, b: { y: "2" } };')), []);
  assert.deepEqual(inferCandidates(served('const t = { a: { go: "nowhere" }, b: {} };')), [], "targets must be rows of the table");
  assert.deepEqual(inferCandidates(served("const t = { a: { go: next }, b: {} };")), [], "a computed target is not a literal edge");
  assert.deepEqual(inferCandidates(served("const t = { a, b };")), [], "shorthand properties are not read");
});

test("infer: comments, quoted keys and trailing commas inside a table are tolerated", () => {
  const src = [
    "const flow = {",
    "  // initial",
    '  "open": { "close": "closed", },',
    "  /* terminal */ closed: {},",
    "};",
  ].join("\n");
  const ids = inferCandidates(served(src)).map((c) => c.id);
  assert.deepEqual(ids, ["flow:closed+close=>stays(closed)"]);
});

// ---- merging sources -------------------------------------------------------

test("inferFromEvidence: one rule stated in three places keeps the copy closest to the change", () => {
  const text = "function f(c) {\n  let s = 5;\n  if (c.total >= 50) { s = 0; }\n}";
  const merged = inferFromEvidence([
    { source: "served_js", location: "/app.js", content: text },
    { source: "repo_source", location: "src/f.js", content: text },
    { source: "git_diff", location: "src/f.js", content: text, changedLines: [3] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].evidence.source, "git_diff");
  assert.equal(merged[0].evidence.changed, true);
  assert.deepEqual([...(merged[0].evidence.alsoSeenIn ?? [])].sort(), ["repo_source@src/f.js:3", "served_js@/app.js:3"]);
});

test("inferFromEvidence: rules read from changed code come first, so a cap can't drop them", () => {
  const merged = inferFromEvidence([
    { source: "repo_source", location: "a.js", content: "if (a.x >= 1) { y = 0; }" },
    { source: "git_diff", location: "b.js", content: "if (b.x >= 2) { y = 0; }", changedLines: [1] },
  ]);
  assert.equal(merged[0].evidence.location, "b.js:1");
});

// ---- planning --------------------------------------------------------------

test("plan: the family follows the form of the rule, not the names in it", () => {
  const [num] = inferCandidates(served("if (a.b >= 5) { c = 0; }"));
  const [tr] = inferCandidates(served(MACHINE));
  assert.equal(planFamily(num), "numeric-boundary");
  assert.equal(planFamily(tr), "state-transition");

  // Same machine, every name changed: the plan has the same shape.
  const renamed = MACHINE.replace(/orderMachine/g, "zz").replace(/cancelled/g, "q1").replace(/fulfill/g, "w2");
  const [tr2] = inferCandidates(served(renamed));
  assert.equal(planFamily(tr2), "state-transition");
  const p1 = planExperiment(tr) as StateTransitionPlan;
  const p2 = planExperiment(tr2) as StateTransitionPlan;
  assert.deepEqual(p1.states.map((s) => [s.label, s.applicable]), p2.states.map((s) => [s.label, s.applicable]));
});

test("plan: a transition is judged where it must be refused, and checked where it must work", () => {
  const c = inferCandidates(served(MACHINE)).find((x) => x.id === "orderMachine:cancelled+fulfill=>stays(cancelled)")!;
  const plan = planExperiment(c) as StateTransitionPlan;
  assert.equal(plan.family, "state-transition");
  assert.equal(plan.from, "cancelled");
  assert.deepEqual(plan.intent, { kind: "action", name: "fulfill" });
  const [forbidden, control] = plan.states;
  assert.deepEqual([forbidden.label, forbidden.assign.state, forbidden.intent, forbidden.applicable], ["forbidden", "cancelled", { kind: "action", name: "fulfill" }, true]);
  assert.deepEqual([control.label, control.assign.state, control.intent, control.applicable], ["allowed-control", "paid", { kind: "action", name: "fulfill" }, false]);
  assert.deepEqual(control.mustReach, { field: "state", value: "fulfilled" });
});

test("plan: a candidate that fits neither family has no plan", () => {
  const [c] = inferCandidates(served("if (a.b >= 5) { c = 0; }"));
  assert.equal(planExperiment({ ...c, preconditions: [{ field: "b", path: "a.b", op: "==", value: "x" }] }), null);
});

test("routeThrough: shortest declared route, or none", () => {
  const g = { pending: { pay: "paid", cancel: "cancelled" }, paid: { fulfill: "fulfilled", cancel: "cancelled" }, cancelled: {}, fulfilled: {} };
  assert.deepEqual(routeThrough(g, "pending", "pending"), []);
  assert.deepEqual(routeThrough(g, "pending", "cancelled"), ["cancel"]);
  assert.deepEqual(routeThrough(g, "pending", "fulfilled"), ["pay", "fulfill"]);
  assert.equal(routeThrough(g, "cancelled", "paid"), null, "a terminal state has no way out");
});

// ---- the shared evaluator judges a transition like anything else -----------

test("compile: the same evaluator that judges a threshold judges a refused transition", () => {
  const c = inferCandidates(served(MACHINE)).find((x) => x.id === "orderMachine:cancelled+fulfill=>stays(cancelled)")!;
  const spec = compileCandidate(c);
  const before = { flags: { state: "cancelled" } };
  assert.equal(evaluateInvariant(spec, before, [], { flags: { state: "cancelled" } }).verdict, "preserved");
  assert.equal(evaluateInvariant(spec, before, [], { flags: { state: "fulfilled" } }).verdict, "violated");
  assert.equal(evaluateInvariant(spec, { flags: { state: "paid" } }, [], { flags: { state: "fulfilled" } }).verdict, "unknown");
});

// ---- local evidence: git + repo --------------------------------------------

function sh(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-ev-"));
  sh(dir, "init", "-q");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "t");
  sh(dir, "config", "commit.gpgsign", "false");
  return dir;
}

test("git diff: a clean tree is an empty answer, not an invented one", () => {
  const dir = tempRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.js"), "if (c.total >= 50) { s = 0; }\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "init");
    const d = collectGitDiff(dir);
    assert.equal(d.status, "empty");
    assert.deepEqual(d.chunks, []);
    assert.deepEqual(inferFromEvidence(d.chunks), []);
    assert.deepEqual(collectLocalEvidence(dir, { diff: true }).chunks, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git diff: an edit becomes a rule whose trace points at the changed line", () => {
  const dir = tempRepo();
  try {
    const file = path.join(dir, "rules.js");
    fs.writeFileSync(file, "// shipping\nlet s = 5;\nif (c.total >= 100) { s = 0; }\nlet h = 2;\nif (o.qty >= 10) { h = 0; }\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "init");
    fs.writeFileSync(file, "// shipping\nlet s = 5;\nif (c.total >= 50) { s = 0; }\nlet h = 2;\nif (o.qty >= 10) { h = 0; }\n");

    const d = collectGitDiff(dir);
    assert.equal(d.status, "ok");
    assert.equal(d.chunks.length, 1);
    assert.deepEqual(d.chunks[0].changedLines, [3]);
    const found = inferFromEvidence(d.chunks);
    assert.equal(found.length, 1, "the unchanged qty rule is not part of the change");
    assert.equal(found[0].preconditions[0].value, 50);
    assert.equal(found[0].evidence.location, "rules.js:3");
    assert.equal(found[0].evidence.source, "git_diff");

    // Against an older base the same file reads as the same change.
    fs.writeFileSync(file, "// shipping\nlet s = 5;\nif (c.total >= 50) { s = 0; }\nlet h = 2;\nif (o.qty >= 10) { h = 0; }\n");
    sh(dir, "commit", "-qam", "tune");
    assert.equal(collectGitDiff(dir).status, "empty");
    assert.equal(collectGitDiff(dir, "HEAD~1").status, "ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git diff: a brand-new untracked code file counts as changed, and a non-repo is unavailable", () => {
  const dir = tempRepo();
  try {
    fs.writeFileSync(path.join(dir, "seed.js"), "x\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "init");
    fs.writeFileSync(path.join(dir, "new.js"), "if (c.total >= 50) { s = 0; }\n");
    fs.writeFileSync(path.join(dir, "notes.md"), "hello\n");
    const d = collectGitDiff(dir);
    assert.equal(d.status, "ok");
    assert.deepEqual(d.chunks.map((c) => c.location), ["new.js"]);
    assert.equal(inferFromEvidence(d.chunks)[0].evidence.location, "new.js:1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-nogit-"));
  try {
    const d = collectGitDiff(bare);
    assert.equal(d.status, "unavailable");
    assert.deepEqual(d.chunks, []);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test("repo source: reads code files, skips dependencies and build output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-repo-"));
  try {
    for (const f of ["src/a.ts", "node_modules/x/i.js", "dist/b.js", ".aztrx/c.js", "src/readme.md", "src/lib.min.js"]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), "if (a.b >= 1) { c = 0; }\n");
    }
    const chunks = collectRepoSource(dir);
    assert.deepEqual(chunks.map((c) => c.location), ["src/a.ts"]);
    assert.equal(chunks[0].source, "repo_source");
    assert.equal(chunks[0].changedLines, undefined);
    assert.equal(inferFromEvidence(chunks)[0].evidence.source, "repo_source");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- no one-off checkers ---------------------------------------------------

test("discovery code names no product feature: planning and inference are by shape", () => {
  const dir = path.join(import.meta.dirname, "..", "src", "core", "discovery");
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const code = fs
      .readFileSync(path.join(dir, f), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(!/shipping|cancel|fulfil|checkout|invoice|coupon|refund/i.test(code), `${f} must not name a product feature`);
  }
});
