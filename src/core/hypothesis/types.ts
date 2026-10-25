/**
 * No-hint hypothesis discovery — the shapes that flow between its stages:
 *
 *   inventory → Hypothesis → (priority order) → Experiment run → Outcome
 *
 * Nothing here knows what an application is about. A hypothesis is a claim
 * about observable behavior plus a script that would expose it, and every claim
 * must say where its expectation came from — because "the app does X" is only
 * a bug if something *other than the app* says it should not.
 */

/** Where the expected behavior was read from. Ordered by how independent it is
 * of the implementation under test. */
export type ExpectationKind =
  | "doc" //       the project's own documentation says so
  | "test" //      an existing test of the project asserts it
  | "ui" //        the product's own visible text promises it (a label, a message)
  | "universal"; // a property any such software should have (round-trip, persistence…)

export interface ExpectationSource {
  kind: ExpectationKind;
  /** Verbatim text from the inventory that the expectation rests on. For `doc`,
   * `test` and `ui` it must occur in the inventory or the source is downgraded
   * to `universal` — a quote that was never shown to the model is invented. */
  quote?: string;
}

/** A place on the page, stated the way a user would find it. */
export interface Target {
  text?: string;
  label?: string;
  placeholder?: string;
  role?: string;
  selector?: string;
}

export type Step =
  | { op: "goto"; path: string }
  | { op: "click"; target: Target }
  | { op: "fill"; target: Target; value: string }
  | { op: "press"; key: string }
  | { op: "reload" }
  /** Record what `reads` show right now under this label. */
  | { op: "snapshot"; label: string };

export interface Read {
  name: string;
  what: "count" | "text" | "value" | "visible";
  target: Target;
}

/** A claim over snapshot readings, addressed `label.name`. */
export type Relation =
  | { kind: "equals"; left: string; right: string | number }
  | { kind: "not_equals"; left: string; right: string | number }
  | { kind: "increased_by"; left: string; base: string; by: number }
  | { kind: "contains"; left: string; right: string }
  | { kind: "not_contains"; left: string; right: string };

export type PropertyKind = "round-trip" | "persistence" | "consistency" | "idempotence" | "ordering" | "documented" | "other";

export interface Hypothesis {
  id: string;
  /** One sentence, in the user's terms: what should be true. */
  behavior: string;
  property: PropertyKind;
  expectation: ExpectationSource;
  /** 1 (cosmetic) … 5 (data loss, wrong money, broken core flow). Model-stated. */
  impact: number;
  steps: Step[];
  reads: Read[];
  expect: Relation[];
}

export type Outcome =
  | "supported_violation" // the expectation failed, twice, in fresh sessions
  | "disproven" //            the experiment ran fully and the expectation held
  | "unknown" //              could not be run, read, or reproduced — says nothing
  | "environment"; //         a dependency of the app failed; not product behavior

export interface Reading {
  label: string;
  name: string;
  value: string | number | boolean | null;
}

export interface RunTrace {
  /** Each step as executed, with what happened. */
  steps: Array<{ step: Step; ok: boolean; error?: string }>;
  readings: Reading[];
  relations: Array<{ relation: Relation; held: boolean | null }>;
  environment: string[];
}

export interface HypothesisResult {
  hypothesis: Hypothesis;
  priority: number;
  outcome: Outcome;
  reason: string;
  /** First run, and the replay when the first one violated. */
  runs: RunTrace[];
  durationMs: number;
}

export interface Inventory {
  /** Everything the generator is shown, as one text. Hashed into the ledger. */
  text: string;
  /** Source of each section, so a quote can be traced to where it came from. */
  sections: Array<{ source: string; chars: number }>;
}
