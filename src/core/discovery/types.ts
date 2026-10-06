/**
 * Invariant Discovery v0 — the shapes that flow between its stages:
 *
 *   evidence → InvariantCandidate → ExperimentPlan → observations → verdict
 *
 * Every field a stage fills in must be traceable to something the stage
 * actually saw. A candidate with no `evidence.signals` does not exist.
 */

import type { ExecutedAction, ObservedState, Verdict } from "../invariant.js";

export type PredicateOp = "==" | "!=" | ">=" | ">" | "<=" | "<";

/** A condition on one named field of an `ObservedState`. `field` is the
 * leaf identifier (`total` for `cart.total`) and lives in `state.flags`;
 * `path` keeps the original expression for humans and for binding. */
export interface StatePredicate {
  field: string;
  path: string;
  op: PredicateOp;
  value: number | string | boolean;
}

export type EvidenceSource = "diff" | "code" | "ui" | "test" | "runtime";

export interface InvariantCandidate {
  id: string;
  description: string;
  evidence: {
    source: EvidenceSource;
    location?: string;
    /** The literal fragments the rule was read from — never paraphrased. */
    signals: string[];
  };
  preconditions: StatePredicate[];
  expectation: StatePredicate[];
  /** Heuristic, uncalibrated: how directly the evidence states the rule.
   * Not a probability. */
  confidence: number;
}

/** One state the experiment will drive the system into. */
export interface PlannedState {
  /** Boundary role, e.g. "below" | "boundary" | "just-above" | "clearly-above". */
  label: string;
  /** Values to assign to the controllable fields (field → value). */
  assign: Record<string, number>;
  /** Whether the candidate's preconditions hold in this state — states where
   * they don't are executed only as controls, never judged. */
  applicable: boolean;
}

export interface ExperimentPlan {
  candidateId: string;
  /** The field being varied and the threshold the plan was built around. */
  variable: { field: string; path: string };
  threshold: number;
  states: PlannedState[];
}

export interface ExperimentObservation {
  label: string;
  applicable: boolean;
  actions: ExecutedAction[];
  before: ObservedState;
  after: ObservedState;
  /** `unknown` also covers "could not observe" — see `note`. */
  verdict: Verdict;
  /** A violated state is replayed once; the finding is only emitted if the
   * replay violates again. Unset for states that weren't violated. */
  reproduced?: boolean;
  note?: string;
}

export type DiscoveryStage =
  | "evidence"
  | "inference"
  | "binding"
  | "planning"
  | "execution"
  | "observation"
  | "evaluation";

/** The full trace of one candidate through every stage — what episode
 * telemetry stores, and what a benchmark miss is diagnosed from. */
export interface DiscoveryTrace {
  candidate: InvariantCandidate;
  /** Where the chain ended: the last stage that completed. */
  reachedStage: DiscoveryStage;
  plan?: ExperimentPlan;
  observations: ExperimentObservation[];
  verdict: Verdict;
  /** Set when the chain stopped early, naming why. */
  stoppedBecause?: string;
  /** Finding fingerprint is attached by the swarm once the classifier has
   * minted one; the message is what the finding was emitted with. */
  findingMessage?: string;
  durationMs: number;
}
