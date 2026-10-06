/**
 * The shared language behind the "business-logic" security primitives.
 *
 * Five bug classes (auth bypass, role escalation, IDOR, repeated single-use
 * actions, flow-prerequisite skips) look like five different scanners, but
 * each one is actually asking the same question: an app has an invariant
 * ("a protected resource requires authentication", "a used coupon can't
 * discount again"), and `security.ts` is trying to find an action that
 * violates it. This module is that shared question, factored out —
 * `ObservedState`, a before/after pair, and a predicate over both.
 *
 * Deliberately NOT an attempt at a general world model. State here only
 * ever holds what a primitive directly *observed* (a cookie, a response
 * body, a rendered dollar figure) — never something inferred or guessed.
 * "Did payment happen?" is answered by a `flags.paid` value read off real
 * evidence, never assumed. If a primitive has no evidence for a field, it
 * leaves it `undefined` rather than fabricate a default.
 *
 * This is a thin layer OVER the existing primitives, not a replacement for
 * them: `objectRefAudit`/`repeatUseAudit`/`flowSkipAudit` still do all the
 * primitive-specific work (discovering a sibling id, clicking twice,
 * crawling for evidence) — only the before/after comparison and verdict
 * now go through one evaluator instead of three separate ad-hoc checks.
 */

export interface ObservedState {
  url?: string;
  session?: {
    authenticated?: boolean;
    userId?: string;
    role?: string;
  };
  resource?: {
    id?: string;
    ownerId?: string;
  };
  money?: {
    /** Raw `$`-figures read off the page, in document order — comparing
     * the whole list catches "changed" without having to parse which
     * figure means what. */
    figures?: string[];
  };
  flags?: Record<string, boolean | string | number>;
  http?: {
    status?: number;
  };
  /** Free-text evidence strings a primitive matched — an identity value,
   * a gate phrase, a terminal-content marker. Not meant to be parsed. */
  contentSignals?: string[];
}

export type ActionKind =
  | "navigate"
  | "click"
  | "submit"
  | "request"
  | "mutateIdentifier"
  | "repeat"
  | "switchUser"
  | "setInput";

export interface ExecutedAction {
  kind: ActionKind;
  /** Url or selector/label — whatever identifies what the action hit. */
  target: string;
  detail?: string;
}

export type Verdict = "preserved" | "violated" | "unknown";

export interface Evidence {
  label: string;
  value: string;
}

export interface InvariantSpec {
  id: string;
  /** One line, human-readable — becomes part of the finding message. */
  subject: string;
  /** Must hold of `before` for the invariant to apply at all — e.g. "the
   * resource was reachable," "a token was present." Skipped (and the
   * episode comes back `unknown`) rather than guessed. */
  precondition?: (before: ObservedState) => boolean;
  /** Must hold between `before` and `after` for the invariant to be
   * PRESERVED. Takes both states because almost none of these are
   * properties of `after` alone — IDOR, repeat-use, and flow-skip are all
   * fundamentally "did something change that shouldn't have." */
  expectation: (before: ObservedState, after: ObservedState) => boolean;
}

export interface InvariantEpisode {
  invariant: { id: string; subject: string };
  before: ObservedState;
  actions: ExecutedAction[];
  after: ObservedState;
  verdict: Verdict;
  evidence: Evidence[];
}

/** Evaluate one invariant over one before/after observation. Never throws,
 * never guesses past what `before`/`after` actually hold. */
export function evaluateInvariant(
  spec: InvariantSpec,
  before: ObservedState,
  actions: ExecutedAction[],
  after: ObservedState,
  evidence: Evidence[] = []
): InvariantEpisode {
  const invariant = { id: spec.id, subject: spec.subject };
  if (spec.precondition && !spec.precondition(before)) {
    return { invariant, before, actions, after, verdict: "unknown", evidence };
  }
  const verdict: Verdict = spec.expectation(before, after) ? "preserved" : "violated";
  return { invariant, before, actions, after, verdict, evidence };
}
