import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inferCandidates } from "../src/core/discovery/infer.js";
import { boundaryValues, planExperiment } from "../src/core/discovery/plan.js";
import type { EvidenceChunk } from "../src/core/discovery/evidence.js";
import { compileCandidate, evalPredicate } from "../src/core/discovery/compile.js";
import { evaluateInvariant } from "../src/core/invariant.js";
import { submitEpisode } from "../src/core/telemetry/index.js";
import type { DiscoveryTrace, NumericBoundaryPlan } from "../src/core/discovery/types.js";

const ev = (content: string): EvidenceChunk => ({ source: "served_js", location: "checkout.ts", content });

test("infer: a literal if-rule becomes a structured candidate with its own evidence", () => {
  const [c] = inferCandidates(ev("if (cart.total >= 50) {\n  shipping = 0;\n}"));
  assert.equal(c.preconditions[0].field, "total");
  assert.equal(c.preconditions[0].op, ">=");
  assert.equal(c.preconditions[0].value, 50);
  assert.equal(c.expectation[0].field, "shipping");
  assert.equal(c.expectation[0].value, 0);
  assert.equal(c.evidence.source, "served_js");
  assert.match(c.evidence.location ?? "", /^checkout\.ts:1$/);
  assert.match(c.evidence.signals[0], /cart\.total >= 50/);
  assert.match(c.description, /checkout\.ts says cart\.total >= 50 sets shipping to 0/);
});

test("infer: a named constant is resolved from the same text, and the hop is recorded", () => {
  const [c] = inferCandidates(ev("const FREE_AT = 75;\nif (order.subtotal > FREE_AT) { fee = 0; }"));
  assert.equal(c.preconditions[0].value, 75);
  assert.equal(c.preconditions[0].op, ">");
  assert.ok(c.evidence.signals.includes("FREE_AT = 75"));
  const [literal] = inferCandidates(ev("if (a.b >= 5) { c = 1; }"));
  assert.ok(c.confidence < literal.confidence, "an indirect threshold is less direct evidence");
});

test("infer: a ternary assignment is read the same way", () => {
  const [c] = inferCandidates(ev("shipping = total >= 40 ? 0 : 4.5;"));
  assert.equal(c.preconditions[0].value, 40);
  assert.equal(c.expectation[0].field, "shipping");
});

test("infer: no evidence, no candidate — unresolved identifiers and prose are not rules", () => {
  assert.deepEqual(inferCandidates(ev("if (cart.total >= LIMIT) { shipping = 0; }")), []);
  assert.deepEqual(inferCandidates(ev("// e-commerce sites usually give free shipping above some threshold")), []);
  assert.deepEqual(inferCandidates(ev("if (cart.total >= 50) { notify(); }")), []);
});

test("boundary: states are built from the threshold alone, scaled to its precision", () => {
  assert.deepEqual(
    boundaryValues(50, ">=").map((s) => [s.label, s.value]),
    [["below", 49], ["boundary", 50], ["just-above", 51], ["clearly-above", 100]]
  );
  assert.deepEqual(boundaryValues(9.99, ">").map((s) => s.value), [9.98, 9.99, 10, 19.98]);
  const lt = boundaryValues(18, "<");
  assert.equal(lt[3].label, "clearly-below");
  assert.equal(lt[3].value, 0);
});

test("plan: only states where the precondition holds are judged; the rest are controls", () => {
  const [c] = inferCandidates(ev("if (cart.total > 50) { shipping = 0; }"));
  const plan = planExperiment(c) as NumericBoundaryPlan;
  assert.equal(plan.family, "numeric-boundary");
  assert.equal(plan.threshold, 50);
  const byLabel = Object.fromEntries(plan.states.map((s) => [s.label, s.applicable]));
  assert.deepEqual(byLabel, { below: false, boundary: false, "just-above": true, "clearly-above": true });
});

test("plan: a candidate with no ordered threshold cannot be planned", () => {
  const [c] = inferCandidates(ev("if (a.b >= 5) { c = 1; }"));
  assert.equal(planExperiment({ ...c, preconditions: [{ field: "b", path: "a.b", op: "==", value: 5 }] }), null);
});

test("compile: an unobserved field is no evidence, not a violation", () => {
  const [c] = inferCandidates(ev("if (cart.total >= 50) { shipping = 0; }"));
  assert.equal(evalPredicate(c.expectation[0], { flags: {} }), undefined);
  const spec = compileCandidate(c);
  const ep = evaluateInvariant(spec, { flags: { total: 50 } }, [], { flags: { total: 50, shipping: 5.99 } });
  assert.equal(ep.verdict, "violated");
  assert.equal(evaluateInvariant(spec, { flags: { total: 50 } }, [], { flags: { total: 50, shipping: 0 } }).verdict, "preserved");
  assert.equal(evaluateInvariant(spec, { flags: { total: 49 } }, [], { flags: { total: 49, shipping: 5.99 } }).verdict, "unknown");
});

test("evaluateInvariant stays generic: no check-type branching in the evaluator", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "core", "invariant.ts"), "utf-8");
  const body = src.slice(src.indexOf("export function evaluateInvariant"));
  assert.ok(!/\bswitch\b/.test(body), "no switch in evaluateInvariant");
  assert.ok(!/spec\.id\s*(===|==|!==)/.test(body), "no branching on spec.id");
});

test("episode telemetry: discovery traces are persisted, and their strings cross the sanitizer", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-disc-"));
  try {
    const trace: DiscoveryTrace = {
      candidate: {
        id: "x",
        description: "checkout.ts says cart.total >= 50 sets shipping to 0",
        evidence: { source: "served_js", location: "checkout.ts:1", signals: ["const key = 'sk_live_abcdefghijklmnop1234'; if (cart.total >= 50) { shipping = 0; }"] },
        preconditions: [{ field: "total", path: "cart.total", op: ">=", value: 50 }],
        expectation: [{ field: "shipping", path: "shipping", op: "==", value: 0 }],
        confidence: 0.8,
      },
      reachedStage: "evaluation",
      observations: [],
      verdict: "violated",
      durationMs: 1,
    };
    submitEpisode(
      {
        missionId: "r:0",
        roleId: "invariant-discoverer",
        hypothesis: "h",
        signals: [],
        actionsAttempted: 4,
        verdict: "verified_bug",
        findingIds: ["abc"],
        discovery: [trace],
        durationMs: 1,
      },
      { repoRoot, telemetry: true, shareData: false }
    );
    const line = fs.readFileSync(path.join(repoRoot, ".aztrx", "telemetry", "episodes.jsonl"), "utf-8").trim();
    const rec = JSON.parse(line);
    assert.equal(rec.discovery[0].candidate.confidence, 0.8);
    assert.equal(rec.discovery[0].candidate.preconditions[0].value, 50);
    assert.ok(!line.includes("sk_live_abcdefghijklmnop1234"), "a secret in the evidence must not be persisted");
    assert.deepEqual(rec.finding_ids, ["abc"]);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
