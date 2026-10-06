/**
 * Stage 4: experiment planning.
 *
 * Not a universal planner: two generic plan families, picked from the *form*
 * of the candidate and nothing else.
 *
 *   numeric-boundary   the rule has an ordered numeric precondition, so its
 *                      bugs live at the boundary: probe the threshold, one
 *                      step either side, and one value clearly inside.
 *   state-transition   the rule says an action must not move the system out
 *                      of a discrete state: reach that state, take the
 *                      action, expect the state to hold — and, as a control,
 *                      take the same action where the evidence says it is
 *                      allowed, so "nothing happened" can't pass for "refused".
 *
 * Nothing here knows what `total`, `shipping`, `cancelled` or `fulfill`
 * mean. A candidate that fits neither form has no plan.
 */

import { evalPredicate } from "./compile.js";
import type {
  ExperimentPlan,
  InvariantCandidate,
  NumericBoundaryPlan,
  PlanFamily,
  PlannedState,
  StatePredicate,
  StateTransitionPlan,
} from "./types.js";

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

const isOrderedNumeric = (p: StatePredicate) => typeof p.value === "number" && p.op !== "==" && p.op !== "!=";
const isDiscreteState = (p: StatePredicate) => p.op === "==" && typeof p.value === "string";

/** Which plan family a candidate's form calls for, or null if none fits. */
export function planFamily(c: InvariantCandidate): PlanFamily | null {
  if (c.preconditions.some(isOrderedNumeric)) return "numeric-boundary";
  if (c.action && c.context?.transitionTable && c.preconditions.some(isDiscreteState)) return "state-transition";
  return null;
}

function planNumericBoundary(c: InvariantCandidate): NumericBoundaryPlan | null {
  const pre = c.preconditions.find(isOrderedNumeric);
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
  return { family: "numeric-boundary", candidateId: c.id, variable: { field: pre.field, path: pre.path }, threshold, states };
}

function planStateTransition(c: InvariantCandidate): StateTransitionPlan | null {
  const pre = c.preconditions.find(isDiscreteState);
  const table = c.context?.transitionTable;
  if (!pre || !table || !c.action) return null;
  const from = pre.value as string;
  const action = c.action.name;

  const states: PlannedState[] = [{ label: "forbidden", assign: { [pre.field]: from }, action, applicable: true }];

  // A state where the evidence says the same action IS allowed. If it works
  // there, the page's controls are demonstrably wired to it.
  const allowedIn = Object.keys(table.transitions).find((s) => s !== from && action in table.transitions[s]);
  if (allowedIn) {
    states.push({
      label: "allowed-control",
      assign: { [pre.field]: allowedIn },
      action,
      mustReach: { field: pre.field, value: table.transitions[allowedIn][action] },
      applicable: false,
    });
  }
  return { family: "state-transition", candidateId: c.id, variable: { field: pre.field, path: pre.path }, graph: table, from, action, states };
}

/** Returns null when the candidate fits no plan family — the caller records
 * that as a planning stop. */
export function planExperiment(c: InvariantCandidate): ExperimentPlan | null {
  switch (planFamily(c)) {
    case "numeric-boundary":
      return planNumericBoundary(c);
    case "state-transition":
      return planStateTransition(c);
    default:
      return null;
  }
}
