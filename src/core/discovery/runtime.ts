/**
 * Stages 1, 3, 5-7 against a live page: gather evidence, bind the rule's
 * variables to what the page actually has, drive the planned states, and hand
 * every observation to `evaluateInvariant`.
 *
 * Everything family-specific lives behind a `Binder` (see `drivers.ts`); the
 * loop here is the same for every rule shape: bind -> drive each planned state
 * -> judge with the shared evaluator -> replay a violation once -> only then
 * is it a finding.
 *
 * Every candidate leaves a trace that answers two questions: *where did the
 * pipeline stop* (`stages`) and *why was this behavior tested at all*
 * (`chain`, source line to verdict). When the link between source and page
 * can't be established, the answer is `unknown` and no finding — never a guess.
 */

import type { Page } from "playwright";
import { EventBus } from "../eventBus.js";
import { evaluateInvariant } from "../invariant.js";
import type { Verdict } from "../invariant.js";
import { compileCandidate, evalPredicate } from "./compile.js";
import { binderFor } from "./drivers.js";
import { collectServedJs, type EvidenceChunk } from "./evidence.js";
import { inferFromEvidence } from "./infer.js";
import { planExperiment } from "./plan.js";
import type {
  BindingRecord,
  DiscoveryRunReport,
  DiscoveryTrace,
  ExperimentObservation,
  InvariantCandidate,
  PipelineStage,
  StageOutcome,
} from "./types.js";

const MAX_CANDIDATES = 6;

export interface InvariantDiscoveryOptions {
  dryRun?: boolean;
  maxCandidates?: number;
  /** Evidence the caller already collected — repo source and/or the live git
   * diff — merged with what the page serves. */
  extraEvidence?: EvidenceChunk[];
}

const STAGE_ORDER: PipelineStage[] = [
  "evidence_extracted",
  "invariant_inferred",
  "runtime_bound",
  "experiment_planned",
  "experiment_executed",
  "observation_captured",
  "verdict",
];

/** Progress a candidate made, from which its stage table is built. The first
 * stage that didn't happen is `failed`; everything after it is `skipped`. */
export interface Progress {
  planned: boolean;
  bound: boolean;
  executed: boolean;
  observed: boolean;
  concluded: boolean;
  /** Why the chain stopped, attached to the first failed stage. */
  why?: string;
}

export function stageTable(p: Progress): StageOutcome[] {
  // evidence + inference are what made a candidate exist at all.
  const reached: Record<PipelineStage, boolean> = {
    evidence_extracted: true,
    invariant_inferred: true,
    experiment_planned: p.planned,
    runtime_bound: p.bound,
    experiment_executed: p.executed,
    observation_captured: p.observed,
    verdict: p.concluded,
  };
  // Planning precedes binding in execution, binding precedes it in reporting.
  const executionOrder: PipelineStage[] = [
    "evidence_extracted",
    "invariant_inferred",
    "experiment_planned",
    "runtime_bound",
    "experiment_executed",
    "observation_captured",
    "verdict",
  ];
  const firstFail = executionOrder.find((s) => !reached[s]);
  const failedAt = firstFail ? executionOrder.indexOf(firstFail) : -1;
  return STAGE_ORDER.map((stage) => {
    const at = executionOrder.indexOf(stage);
    if (failedAt < 0 || at < failedAt) return { stage, outcome: "ok" as const };
    if (at === failedAt) return { stage, outcome: "failed" as const, ...(p.why ? { detail: p.why } : {}) };
    return { stage, outcome: "skipped" as const };
  });
}

function chainFor(trace: DiscoveryTrace, binding: BindingRecord[]): string[] {
  const c = trace.candidate;
  const chain = [
    `${c.evidence.source} ${c.evidence.location ?? "?"}${c.evidence.changed ? " (changed)" : ""}: ${c.evidence.signals[0] ?? ""}`,
    `rule: ${c.description}`,
  ];
  if (binding.length > 0) chain.push("runtime: " + binding.map((b) => `${b.role} ${b.name} → ${b.matched}`).join("; "));
  if (trace.plan) {
    chain.push(
      `experiment (${trace.plan.family}): ` +
        trace.plan.states.map((s) => `${s.label}${s.action ? ` [${s.action}]` : ""}`).join(", ")
    );
  }
  for (const o of trace.observations) {
    const steps = o.actions.map((a) => a.target).join(" > ");
    chain.push(
      `observed ${o.label}: ${JSON.stringify(o.before.flags ?? {})} → ${JSON.stringify(o.after.flags ?? {})}` +
        `${steps ? ` via ${steps}` : ""} = ${o.verdict}${o.reproduced ? " (reproduced)" : ""}`
    );
  }
  chain.push(`verdict: ${trace.verdict}${trace.stoppedBecause ? ` (${trace.stoppedBecause})` : ""}`);
  return chain;
}

export async function invariantDiscovery(
  page: Page,
  bus: EventBus,
  opts: InvariantDiscoveryOptions = {}
): Promise<{ candidates: number; statesRun: number; findings: number; traces: DiscoveryTrace[]; report: DiscoveryRunReport }> {
  const traces: DiscoveryTrace[] = [];
  let statesRun = 0;
  let findings = 0;

  const served = await collectServedJs(page);
  const evidence = [...served, ...(opts.extraEvidence ?? [])];
  const candidates: InvariantCandidate[] = inferFromEvidence(evidence);
  const limit = opts.maxCandidates ?? MAX_CANDIDATES;
  const report: DiscoveryRunReport = {
    evidence: evidence.map((e) => ({
      source: e.source,
      location: e.location,
      chars: e.content.length,
      ...(e.changedLines ? { changedLines: e.changedLines.length } : {}),
    })),
    candidatesInferred: candidates.length,
    candidatesAttempted: Math.min(candidates.length, limit),
    candidatesCapped: Math.max(0, candidates.length - limit),
  };

  for (const candidate of candidates.slice(0, limit)) {
    const t0 = Date.now();
    const trace: DiscoveryTrace = {
      candidate,
      reachedStage: "inference",
      observations: [],
      verdict: "unknown",
      stages: [],
      durationMs: 0,
    };
    const progress: Progress = { planned: false, bound: false, executed: false, observed: false, concluded: false };
    traces.push(trace);
    const finish = (why?: string) => {
      if (why) trace.stoppedBecause = why;
      progress.why = trace.stoppedBecause;
      trace.stages = stageTable(progress);
      trace.chain = chainFor(trace, trace.binding ?? []);
      trace.durationMs = Date.now() - t0;
    };

    const plan = planExperiment(candidate);
    if (!plan) {
      progress.why = "the rule fits no experiment family (no ordered numeric precondition, no state plus action)";
      finish("planning: " + progress.why);
      continue;
    }
    trace.plan = plan;
    trace.reachedStage = "planning";
    progress.planned = true;

    const session = await binderFor(plan)(page, candidate, plan);
    if ("reason" in session) {
      finish("binding: " + session.reason);
      continue;
    }
    trace.reachedStage = "binding";
    trace.binding = session.binding;
    progress.bound = true;
    if (opts.dryRun) {
      finish("dry run");
      continue;
    }

    const spec = compileCandidate(candidate);
    const observable = (after: Parameters<typeof evalPredicate>[1]) =>
      candidate.expectation.every((p) => evalPredicate(p, after) !== undefined);

    for (const st of plan.states) {
      const run = await session.drive(st);
      statesRun++;
      if ("failed" in run) {
        trace.observations.push({
          label: st.label,
          applicable: st.applicable,
          actions: [],
          before: {},
          after: {},
          verdict: "unknown",
          ...(st.mustReach ? { controlOk: false } : {}),
          note: run.failed,
        });
        continue;
      }
      trace.reachedStage = "execution";
      progress.executed = true;

      let verdict: Verdict = "unknown";
      let note: string | undefined;
      if (!observable(run.after)) {
        note = "the outcome was not readable; not judged";
      } else {
        progress.observed = true;
        verdict = evaluateInvariant(spec, run.before, run.actions, run.after, [{ label: "state", value: st.label }]).verdict;
        if (verdict === "unknown") note = "precondition not met in this state; control only";
      }
      trace.reachedStage = "evaluation";

      const obs: ExperimentObservation = {
        label: st.label,
        applicable: st.applicable,
        actions: run.actions,
        before: run.before,
        after: run.after,
        verdict,
        note,
      };
      if (st.mustReach) {
        obs.controlOk = run.after.flags?.[st.mustReach.field] === st.mustReach.value;
        if (!obs.controlOk) obs.note = `control: expected ${st.mustReach.field} to reach "${st.mustReach.value}"`;
      }

      if (verdict === "violated") {
        // Replay once: proof means it happens again, not once.
        const again = await session.drive(st);
        obs.reproduced =
          !("failed" in again) &&
          observable(again.after) &&
          evaluateInvariant(spec, again.before, again.actions, again.after).verdict === "violated";
        statesRun++;
      }
      trace.observations.push(obs);
    }
    await session.restore();

    const proven = trace.observations.find((o) => o.verdict === "violated" && o.reproduced);
    if (proven) {
      trace.verdict = "violated";
    } else if (
      trace.observations.some((o) => o.verdict === "preserved") &&
      !trace.observations.some((o) => o.verdict === "violated")
    ) {
      // "Preserved" is only worth saying when the experiment is known to be
      // able to fail: every control that was supposed to move, moved.
      const unvouched = plan.states.some(
        (s) => s.mustReach && !trace.observations.some((o) => o.label === s.label && o.controlOk === true)
      );
      if (unvouched) trace.stoppedBecause = "control: the action was never seen to work where it is allowed, so a refusal can't be told from a no-op";
      else trace.verdict = "preserved";
    }

    if (!progress.executed) trace.stoppedBecause ??= "execution: no planned state could be driven (" + (trace.observations[0]?.note ?? "unknown") + ")";
    else if (!progress.observed) trace.stoppedBecause ??= "observation: the outcome was never readable";
    progress.concluded = trace.verdict !== "unknown";
    finish();

    if (proven) {
      const st = plan.states.find((s) => s.label === proven.label)!;
      const run = { before: proven.before, after: proven.after, actions: proven.actions };
      // The message carries the chain, so whoever reads the finding can see why
      // this behavior was tested without opening the telemetry.
      trace.findingMessage =
        "Discovered invariant violated: " + candidate.description + ". " +
        session.explain(st, run) + ". " +
        "Evidence: " + candidate.evidence.signals[0] +
        "\nTrace:\n  " + (trace.chain ?? []).join("\n  ");
      findings++;
      bus.emit("telemetry", { type: "business_logic_violation", rawMessage: trace.findingMessage, rawStack: "" });
    }
  }

  return { candidates: candidates.length, statesRun, findings, traces, report };
}
