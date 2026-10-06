/**
 * Stage 1–2: evidence extraction and invariant inference.
 *
 * Reads program text (served JS, or the added lines of a diff) and turns
 * literal conditional rules into `InvariantCandidate`s. It recognises a
 * rule only when the text states all three parts — a variable, a numeric
 * threshold, and a value that variable's consequence is set to:
 *
 *   if (cart.total >= 50) { shipping = 0; }
 *   shipping = total >= FREE_AT ? 0 : 5.99;      // FREE_AT = 50 resolved
 *
 * It never fills a gap with a prior about what apps usually do. If the text
 * doesn't say it, there is no candidate.
 */

import type { EvidenceSource, InvariantCandidate, PredicateOp, StatePredicate } from "./types.js";

export interface TextEvidence {
  source: EvidenceSource;
  location: string;
  text: string;
}

const IDENT = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;
const NUM = String.raw`-?\d+(?:\.\d+)?`;
const OPERAND = String.raw`(?:${NUM}|${IDENT})`;
const CMP = String.raw`(>=|<=|>|<)`;

const IF_RULE = new RegExp(
  String.raw`if\s*\(\s*(${IDENT})\s*${CMP}\s*(${OPERAND})\s*\)\s*\{?\s*(${IDENT})\s*=\s*(${NUM})\s*;?`,
  "g"
);
const TERNARY_RULE = new RegExp(
  String.raw`(${IDENT})\s*=\s*\(?\s*(${IDENT})\s*${CMP}\s*(${OPERAND})\s*\)?\s*\?\s*(${NUM})\s*:`,
  "g"
);
const CONST_DECL = new RegExp(String.raw`(?:const|let|var)\s+(${IDENT})\s*=\s*(${NUM})\s*[;,\n]`, "g");

const leaf = (path: string): string => path.slice(path.lastIndexOf(".") + 1);

function resolveConsts(text: string): Map<string, number> {
  const consts = new Map<string, number>();
  for (const m of text.matchAll(CONST_DECL)) consts.set(m[1], Number(m[2]));
  return consts;
}

/** Strip a unified diff down to the lines it adds. Context and removed
 * lines are not evidence of what the program does *now*. */
export function addedLines(unifiedDiff: string): string {
  return unifiedDiff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function candidateFrom(
  ev: TextEvidence,
  matched: string,
  index: number,
  lhsPath: string,
  op: PredicateOp,
  threshold: number,
  thresholdSignal: string,
  targetPath: string,
  targetValue: number
): InvariantCandidate {
  const preconditions: StatePredicate[] = [{ field: leaf(lhsPath), path: lhsPath, op, value: threshold }];
  const expectation: StatePredicate[] = [{ field: leaf(targetPath), path: targetPath, op: "==", value: targetValue }];
  const literal = thresholdSignal === String(threshold);
  const signals = [matched.trim()];
  if (!literal) signals.push(`${thresholdSignal} = ${threshold}`);
  return {
    id: `${ev.location}:${lineOf(ev.text, index)}:${lhsPath}${op}${threshold}=>${targetPath}==${targetValue}`,
    description: `${ev.location} says ${lhsPath} ${op} ${threshold} sets ${targetPath} to ${targetValue}`,
    evidence: { source: ev.source, location: `${ev.location}:${lineOf(ev.text, index)}`, signals },
    preconditions,
    expectation,
    // Literal threshold stated inline is the most direct statement; a
    // resolved constant is one hop indirect.
    confidence: literal ? 0.8 : 0.7,
  };
}

/** Infer candidates from one blob of program text. Pure — no I/O. */
export function inferCandidates(ev: TextEvidence): InvariantCandidate[] {
  const consts = resolveConsts(ev.text);
  const out: InvariantCandidate[] = [];
  const seen = new Set<string>();

  const operandValue = (raw: string): number | null => {
    if (new RegExp(`^${NUM}$`).test(raw)) return Number(raw);
    return consts.get(raw) ?? null;
  };

  const push = (c: InvariantCandidate) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    out.push(c);
  };

  for (const m of ev.text.matchAll(IF_RULE)) {
    const threshold = operandValue(m[3]);
    if (threshold === null) continue; // unresolved identifier — not evidence of a number
    push(candidateFrom(ev, m[0], m.index ?? 0, m[1], m[2] as PredicateOp, threshold, m[3], m[4], Number(m[5])));
  }
  for (const m of ev.text.matchAll(TERNARY_RULE)) {
    const threshold = operandValue(m[4]);
    if (threshold === null) continue;
    push(candidateFrom(ev, m[0], m.index ?? 0, m[2], m[3] as PredicateOp, threshold, m[4], m[1], Number(m[5])));
  }
  return out;
}
