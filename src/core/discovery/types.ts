/**
 * Invariant Discovery — the shapes that flow between its stages:
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

/** Where a piece of program text came from. Inference never branches on
 * this — it only decides provenance, and which copy of a rule wins when the
 * same rule is stated in more than one place (see `evidence.ts`). */
export type EvidenceSource = "served_js" | "repo_source" | "git_diff";

/** A state machine the rule was read from: state -> event -> next state.
 * Carried on the candidate so the planner can route to a state using only
 * transitions the evidence itself declares. */
export interface TransitionTable {
  /** The identifier the table was declared under (`orderMachine`). */
  name: string;
  transitions: Record<string, Record<string, string>>;
}

export interface InvariantCandidate {
  id: string;
  description: string;
  evidence: {
    source: EvidenceSource;
    /** `file:line` of the statement the rule was read from, in the file as it
     * is now (for a diff, the new side). */
    location?: string;
    /** The literal fragments the rule was read from — never paraphrased. */
    signals: string[];
    /** True when the statement sits on a line the diff touched. Set only for
     * git_diff evidence. */
    changed?: boolean;
    /** Other places the same rule was stated (`source@file:line`). */
    alsoSeenIn?: string[];
  };
  preconditions: StatePredicate[];
  /** The action whose effect the rule constrains, when the rule is about a
   * transition rather than a value. */
  action?: { name: string };
  /** Structure the rule was read from, when more than the rule itself is
   * needed to plan an experiment. */
  context?: { transitionTable: TransitionTable };
  expectation: StatePredicate[];
  /** Heuristic, uncalibrated: how directly the evidence states the rule.
   * Not a probability. */
  confidence: number;
}

/** One state the experiment will drive the system into. */
export interface PlannedState {
  /** Role in the experiment, e.g. "below" | "boundary" | "forbidden" | "allowed-control". */
  label: string;
  /** Values the experiment must establish first (field → value). */
  assign: Record<string, number | string>;
  /** The action to take once `assign` holds, for transition plans. */
  action?: string;
  /** For a control that is *expected to succeed*: the value the field must
   * reach, proving the action is observable at all. Controls are never judged
   * against the candidate; they only vouch for the experiment. */
  mustReach?: { field: string; value: string | number };
  /** Whether the candidate's preconditions hold in this state — states where
   * they don't are executed only as controls, never judged. */
  applicable: boolean;
}

/** Which generic experiment shape a plan is. Chosen from the *form* of the
 * invariant (an ordered numeric precondition, or a discrete state plus an
 * action) — never from what the feature is called. */
export type PlanFamily = "numeric-boundary" | "state-transition";

interface PlanBase {
  candidateId: string;
  /** The field being varied (numeric) or observed (transition). */
  variable: { field: string; path: string };
  states: PlannedState[];
}

export interface NumericBoundaryPlan extends PlanBase {
  family: "numeric-boundary";
  threshold: number;
}

export interface StateTransitionPlan extends PlanBase {
  family: "state-transition";
  graph: TransitionTable;
  /** The state the rule is about, and the action it must not honour there. */
  from: string;
  action: string;
}

export type ExperimentPlan = NumericBoundaryPlan | StateTransitionPlan;

export interface ExperimentObservation {
  label: string;
  applicable: boolean;
  actions: ExecutedAction[];
  before: ObservedState;
  after: ObservedState;
  /** `unknown` also covers "could not observe" — see `note`. */
  verdict: Verdict;
  /** Set on a control that was expected to succeed: did it? A rule is only
   * ever called preserved when its controls moved. */
  controlOk?: boolean;
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
  /** The message the finding was emitted with, when one was. */
  findingMessage?: string;
  /** Fingerprint of the finding this trace produced — the reproduction id.
   * Attached once the classifier has minted it. */
  findingId?: string;
  durationMs: number;
}
