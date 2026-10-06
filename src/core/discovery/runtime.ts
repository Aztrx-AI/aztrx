/**
 * Stages 1, 3, 5-7 against a live page: gather evidence, bind the rule's
 * variables to what the page actually has, drive the planned states, and hand
 * every observation to `evaluateInvariant`.
 *
 * Everything family-specific lives behind a `Binder` (see `drivers.ts`); the
 * loop here is the same for every rule shape: bind -> drive each planned state
 * -> judge with the shared evaluator -> replay a violation once -> only then
 * is it a finding.
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
import type { DiscoveryTrace, ExperimentObservation, InvariantCandidate } from "./types.js";

const MAX_CANDIDATES = 6;

export interface InvariantDiscoveryOptions {
  dryRun?: boolean;
  maxCandidates?: number;
  /** Evidence the caller already collected — repo source and/or the live git
   * diff — merged with what the page serves. */
  extraEvidence?: EvidenceChunk[];
}

export async function invariantDiscovery(
  page: Page,
  bus: EventBus,
  opts: InvariantDiscoveryOptions = {}
): Promise<{ candidates: number; statesRun: number; findings: number; traces: DiscoveryTrace[] }> {
  const traces: DiscoveryTrace[] = [];
  let statesRun = 0;
  let findings = 0;

  const evidence = [...(await collectServedJs(page)), ...(opts.extraEvidence ?? [])];
  const candidates: InvariantCandidate[] = inferFromEvidence(evidence);

  for (const candidate of candidates.slice(0, opts.maxCandidates ?? MAX_CANDIDATES)) {
    const t0 = Date.now();
    const trace: DiscoveryTrace = { candidate, reachedStage: "inference", observations: [], verdict: "unknown", durationMs: 0 };
    traces.push(trace);
    const stop = (why: string) => {
      trace.stoppedBecause = why;
      trace.durationMs = Date.now() - t0;
    };

    const plan = planExperiment(candidate);
    if (!plan) {
      stop("planning: the rule fits no experiment family (no ordered numeric precondition, no state plus action)");
      continue;
    }
    trace.plan = plan;
    trace.reachedStage = "planning";

    const session = await binderFor(plan)(page, candidate, plan);
    if ("reason" in session) {
      stop("binding: " + session.reason);
      continue;
    }
    trace.reachedStage = "binding";
    if (opts.dryRun) {
      stop("dry run");
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

      let verdict: Verdict = "unknown";
      let note: string | undefined;
      if (!observable(run.after)) {
        note = "the outcome was not readable; not judged";
      } else {
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
      const st = plan.states.find((s) => s.label === proven.label)!;
      const run = { before: proven.before, after: proven.after, actions: proven.actions };
      trace.findingMessage =
        "Discovered invariant violated: " + candidate.description + ". " +
        session.explain(st, run) + ". " +
        "Evidence: " + candidate.evidence.signals[0];
      findings++;
      bus.emit("telemetry", { type: "business_logic_violation", rawMessage: trace.findingMessage, rawStack: "" });
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
    trace.durationMs = Date.now() - t0;
  }

  return { candidates: candidates.length, statesRun, findings, traces };
}
