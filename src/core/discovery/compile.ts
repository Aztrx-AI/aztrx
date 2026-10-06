/**
 * Compile an `InvariantCandidate` into the shared `InvariantSpec`, so the
 * verdict still comes from `evaluateInvariant` — the evaluator learns
 * nothing about discovery, and discovery contains no verdict logic of its
 * own. Predicates read `ObservedState.flags`.
 */

import type { InvariantSpec, ObservedState } from "../invariant.js";
import type { InvariantCandidate, StatePredicate } from "./types.js";

/** `undefined` when the field was never observed — callers must treat that
 * as "no evidence", not as false. */
export function evalPredicate(p: StatePredicate, state: ObservedState): boolean | undefined {
  const actual = state.flags?.[p.field];
  if (actual === undefined) return undefined;
  switch (p.op) {
    case "==":
      return actual === p.value;
    case "!=":
      return actual !== p.value;
  }
  if (typeof actual !== "number" || typeof p.value !== "number") return undefined;
  switch (p.op) {
    case ">=":
      return actual >= p.value;
    case ">":
      return actual > p.value;
    case "<=":
      return actual <= p.value;
    case "<":
      return actual < p.value;
  }
}

export function compileCandidate(c: InvariantCandidate): InvariantSpec {
  return {
    id: `discovered:${c.id}`,
    subject: c.description,
    precondition: (before) => c.preconditions.every((p) => evalPredicate(p, before) === true),
    expectation: (_before, after) => c.expectation.every((p) => evalPredicate(p, after) === true),
  };
}
