/**
 * Stage 4: experiment planning.
 *
 * Not a universal planner: two generic plan families, picked from the *form*
 * of the candidate and nothing else.
 *
 *   numeric-boundary   the rule has an ordered numeric precondition, so its
 *                      bugs live at the boundary: probe the threshold, one
 *                      step either side, and one value clearly inside.
 *   state-transition   the rule says an attempted move must not take the
 *                      system out of a discrete state: reach that state,
 *                      attempt the move, expect the state to hold — and, as a
 *                      control, attempt a move the evidence says is allowed, so
 *                      "nothing happened" can't pass for "refused".
 *
 * A move is stated as an *intent* — "do this action" or "go to that state" —
 * and never as a control. Whether a page offers it as a button, a link, a
 * select option or a menu is the runtime binder's business, not the planner's.
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
  TransitionIntent,
  TransitionTable,
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
  if ((c.action || c.target) && c.context?.transitionTable && c.preconditions.some(isDiscreteState)) return "state-transition";
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
  if (!pre || !table) return null;
  const from = pre.value as string;

  let intent: TransitionIntent;
  if (c.action) intent = { kind: "action", name: c.action.name };
  else if (c.target) intent = { kind: "target", state: c.target.state };
  else return null;

  const states: PlannedState[] = [{ label: "forbidden", assign: { [pre.field]: from }, intent, applicable: true }];

  // A move the evidence says IS allowed, from some other state. If it works
  // there, the page's controls are demonstrably wired to the machine.
  const control = allowedMove(table, from, intent);
  if (!control) return null; // nothing to vouch for the experiment: no honest verdict is possible
  states.push({
    label: "allowed-control",
    assign: { [pre.field]: control.in },
    intent: control.intent,
    mustReach: { field: pre.field, value: control.reaches },
    applicable: false,
  });
  return { family: "state-transition", candidateId: c.id, variable: { field: pre.field, path: pre.path }, graph: table, from, intent, states };
}

/** Pick a permitted move to use as the control. Prefer the very same move
 * (same action, or same target) from another state; otherwise any permitted
 * move, so the control still shows the page can move the machine at all. */
function allowedMove(
  table: TransitionTable,
  from: string,
  intent: TransitionIntent
): { in: string; intent: TransitionIntent; reaches: string } | null {
  const states = Object.keys(table.successors);
  if (intent.kind === "action") {
    const s = states.find((x) => x !== from && intent.name in table.transitions[x]);
    return s ? { in: s, intent, reaches: table.transitions[s][intent.name] } : null;
  }
  const same = states.find((x) => x !== from && x !== intent.state && table.successors[x].includes(intent.state));
  if (same) return { in: same, intent, reaches: intent.state };
  for (const x of states) {
    if (x === from) continue;
    const t = table.successors[x].find((y) => y !== x);
    if (t) return { in: x, intent: { kind: "target", state: t }, reaches: t };
  }
  return null;
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
