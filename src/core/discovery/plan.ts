/**
 * Stage 4: experiment planning, v0.
 *
 * Not a universal planner. It knows one generic idea — a rule with an
 * ordered numeric threshold has its bugs at the boundary — and picks states
 * around that threshold. Nothing here knows what the field means: `total`,
 * `age`, `quantity` are all just numbers with a boundary.
 */

import { evalPredicate } from "./compile.js";
import type { ExperimentPlan, InvariantCandidate, PlannedState, StatePredicate } from "./types.js";

function decimals(n: number): number {
  const s = String(n);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/** Candidate values around a threshold, as (label, value) pairs: the
 * adjacent step on each side, the threshold itself, and one value clearly
 * inside the region where the rule applies. */
export function boundaryValues(threshold: number, op: StatePredicate["op"]): Array<{ label: string; value: number }> {
  const d = decimals(threshold);
  const step = 10 ** -d;
  const round = (n: number) => Number(n.toFixed(d));
  const clear = Math.max(Math.abs(threshold), 10 * step);
  const appliesAbove = op === ">=" || op === ">";
  return [
    { label: "below", value: round(threshold - step) },
    { label: "boundary", value: round(threshold) },
    { label: "just-above", value: round(threshold + step) },
    appliesAbove
      ? { label: "clearly-above", value: round(threshold + clear) }
      : { label: "clearly-below", value: round(threshold - clear) },
  ];
}

/** Returns null when the candidate has no ordered numeric precondition to
 * build a boundary around — the caller records that as a planning stop. */
export function planExperiment(c: InvariantCandidate): ExperimentPlan | null {
  const pre = c.preconditions.find((p) => typeof p.value === "number" && p.op !== "==" && p.op !== "!=");
  if (!pre) return null;
  const threshold = pre.value as number;

  const states: PlannedState[] = boundaryValues(threshold, pre.op).map(({ label, value }) => {
    const probe = { flags: { [pre.field]: value } };
    return {
      label,
      assign: { [pre.field]: value },
      applicable: c.preconditions.every((p) => evalPredicate(p, probe) === true),
    };
  });
  return { candidateId: c.id, variable: { field: pre.field, path: pre.path }, threshold, states };
}
