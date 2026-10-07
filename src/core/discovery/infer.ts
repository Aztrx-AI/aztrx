/**
 * Stage 2: invariant inference.
 *
 * Reads an `EvidenceChunk` — it neither knows nor cares whether the text was
 * served to a browser, read from the repo, or is the current side of a diff —
 * and turns literal statements into `InvariantCandidate`s. Two statement
 * forms are recognised, each only when the text states every part of it:
 *
 *   threshold rule     if (cart.total >= 50) { shipping = 0; }
 *                      shipping = total >= FREE_AT ? 0 : 5.99;   // FREE_AT = 50
 *
 *   transition table   const orderMachine = {
 *                        pending:   { pay: "paid", cancel: "cancelled" },
 *                        paid:      { fulfill: "fulfilled" },
 *                        cancelled: {},                 // no way out
 *                      };
 *                      — an event that exists in the table but has no edge
 *                      out of a state must not move that state.
 *
 * It never fills a gap with a prior about what apps usually do. If the text
 * doesn't say it, there is no candidate.
 *
 * Changed code: on a chunk that carries `changedLines`, a rule only exists if
 * some line it was read from (the statement itself, or a constant it
 * resolves through, or the table row) is one of them.
 */

import { SOURCE_PRIORITY, type EvidenceChunk } from "./evidence.js";
import type { InvariantCandidate, PredicateOp, StatePredicate, TransitionTable } from "./types.js";

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
const TABLE_DECL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*\{/g;

const leaf = (path: string): string => path.slice(path.lastIndexOf(".") + 1);

// ---- positions -------------------------------------------------------------

/** Maps offsets in `chunk.content` to 1-based lines of the file it came from. */
function lineMapper(chunk: EvidenceChunk): (index: number) => number {
  const starts = [0];
  for (let i = 0; i < chunk.content.length; i++) if (chunk.content.charCodeAt(i) === 10) starts.push(i + 1);
  const first = chunk.firstLine ?? 1;
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return first + lo;
  };
}

interface Ctx {
  chunk: EvidenceChunk;
  lineOf: (index: number) => number;
  /** Did any of these lines change? `undefined` when the chunk isn't a diff. */
  touched: (lines: number[]) => boolean | undefined;
}

function context(chunk: EvidenceChunk): Ctx {
  const changed = chunk.changedLines ? new Set(chunk.changedLines) : null;
  return {
    chunk,
    lineOf: lineMapper(chunk),
    touched: (lines) => (changed ? lines.some((l) => changed.has(l)) : undefined),
  };
}

const span = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from) + 1 }, (_, i) => from + i);

// ---- threshold rules -------------------------------------------------------

function resolveConsts(ctx: Ctx): Map<string, { value: number; line: number }> {
  const consts = new Map<string, { value: number; line: number }>();
  for (const m of ctx.chunk.content.matchAll(CONST_DECL)) {
    consts.set(m[1], { value: Number(m[2]), line: ctx.lineOf(m.index ?? 0) });
  }
  return consts;
}

function thresholdCandidates(ctx: Ctx): InvariantCandidate[] {
  const text = ctx.chunk.content;
  const consts = resolveConsts(ctx);
  const out: InvariantCandidate[] = [];

  const operand = (raw: string): { value: number; line?: number } | null => {
    if (new RegExp(`^${NUM}$`).test(raw)) return { value: Number(raw) };
    return consts.get(raw) ?? null; // unresolved identifier — not evidence of a number
  };

  const make = (
    m: RegExpMatchArray,
    lhsPath: string,
    op: PredicateOp,
    thresholdRaw: string,
    targetPath: string,
    targetValue: number
  ) => {
    const th = operand(thresholdRaw);
    if (!th) return;
    const start = m.index ?? 0;
    const startLine = ctx.lineOf(start);
    const endLine = ctx.lineOf(start + m[0].length - 1);
    const lines = span(startLine, endLine);
    if (th.line !== undefined) lines.push(th.line);
    const changed = ctx.touched(lines);
    if (ctx.chunk.changedLines && !changed) return; // diff evidence = the rule comes from the change

    const literal = thresholdRaw === String(th.value);
    const preconditions: StatePredicate[] = [{ field: leaf(lhsPath), path: lhsPath, op, value: th.value }];
    const expectation: StatePredicate[] = [{ field: leaf(targetPath), path: targetPath, op: "==", value: targetValue }];
    const signals = [m[0].trim()];
    if (!literal) signals.push(`${thresholdRaw} = ${th.value}`);
    out.push({
      id: `${lhsPath}${op}${th.value}=>${targetPath}==${targetValue}`,
      description: `${ctx.chunk.location} says ${lhsPath} ${op} ${th.value} sets ${targetPath} to ${targetValue}`,
      evidence: {
        source: ctx.chunk.source,
        location: `${ctx.chunk.location}:${startLine}`,
        signals,
        ...(changed !== undefined ? { changed } : {}),
      },
      preconditions,
      expectation,
      // Literal threshold stated inline is the most direct statement; a
      // resolved constant is one hop indirect.
      confidence: literal ? 0.8 : 0.7,
    });
  };

  for (const m of text.matchAll(IF_RULE)) make(m, m[1], m[2] as PredicateOp, m[3], m[4], Number(m[5]));
  for (const m of text.matchAll(TERNARY_RULE)) make(m, m[2], m[3] as PredicateOp, m[4], m[1], Number(m[5]));
  return out;
}

// ---- transition tables -----------------------------------------------------

type Node =
  | { kind: "obj"; entries: Array<{ key: string; from: number; to: number; value: Node }> }
  | { kind: "arr"; items: Node[] }
  | { kind: "str"; value: string }
  | { kind: "other" };

const MAX_TABLE_CHARS = 20_000;
const MAX_DEPTH = 4;

/** A deliberately small literal parser: objects, string literals, and
 * "anything else" as an opaque value. It fails (null) on shorthand properties,
 * methods, spreads and computed keys rather than guessing what they mean. */
function parseObject(text: string, at: number): { node: Node; end: number } | null {
  let i = at;
  const n = Math.min(text.length, at + MAX_TABLE_CHARS);

  const ws = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text.startsWith("//", i)) {
        while (i < n && text[i] !== "\n") i++;
      } else if (text.startsWith("/*", i)) {
        const e = text.indexOf("*/", i + 2);
        if (e < 0 || e >= n) return;
        i = e + 2;
      } else return;
    }
  };

  const str = (): string | null => {
    const q = text[i];
    if (q !== '"' && q !== "'" && q !== "`") return null;
    let j = i + 1;
    let out = "";
    while (j < n && text[j] !== q) {
      if (text[j] === "\\") j++;
      else if (q === "`" && text[j] === "$" && text[j + 1] === "{") return null;
      out += text[j];
      j++;
    }
    if (j >= n) return null;
    i = j + 1;
    return out;
  };

  const opaque = (): boolean => {
    let depth = 0;
    const start = i;
    while (i < n) {
      const c = text[i];
      if (c === '"' || c === "'" || c === "`") {
        if (str() === null) return false;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
      i++;
    }
    return i > start;
  };

  const value = (depth: number): Node | null => {
    ws();
    if (text[i] === "{") return depth >= MAX_DEPTH ? null : object(depth + 1);
    if (text[i] === "[") return depth >= MAX_DEPTH ? null : array(depth + 1);
    if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const s = str();
      if (s === null) return null;
      ws();
      // `"a" + x` or `"a".toUpperCase()` is not a plain literal.
      return text[i] === "," || text[i] === "}" || text[i] === "]" ? { kind: "str", value: s } : opaque() ? { kind: "other" } : null;
    }
    return opaque() ? { kind: "other" } : null;
  };

  const array = (depth: number): Node | null => {
    if (text[i] !== "[") return null;
    i++;
    const items: Node[] = [];
    for (;;) {
      ws();
      if (i >= n) return null;
      if (text[i] === "]") {
        i++;
        return { kind: "arr", items };
      }
      const v = value(depth);
      if (!v) return null;
      items.push(v);
      ws();
      if (text[i] === ",") i++;
      else if (text[i] !== "]") return null;
    }
  };

  const object = (depth: number): Node | null => {
    if (text[i] !== "{") return null;
    i++;
    const entries: Array<{ key: string; from: number; to: number; value: Node }> = [];
    for (;;) {
      ws();
      if (i >= n) return null;
      if (text[i] === "}") {
        i++;
        return { kind: "obj", entries };
      }
      const from = i;
      let key: string | null;
      if (text[i] === '"' || text[i] === "'") key = str();
      else {
        const m = /^[A-Za-z_$][\w$]*|^\d+/.exec(text.slice(i, i + 64));
        key = m ? m[0] : null;
        if (m) i += m[0].length;
      }
      if (key === null) return null;
      ws();
      if (text[i] !== ":") return null; // shorthand, method, or spread
      i++;
      const v = value(depth);
      if (!v) return null;
      ws();
      const to = i;
      entries.push({ key, from, to, value: v });
      if (text[i] === ",") i++;
      else if (text[i] !== "}") return null;
    }
  };

  const node = object(1);
  return node ? { node, end: i } : null;
}

/** A table is a state machine only if it says so structurally: every row is
 * either an object of action -> state, or a list of states, and every state
 * named is itself a row. A config blob that merely nests objects or lists does
 * not qualify, and a table that mixes the two forms is not read. */
function asTransitionTable(name: string, root: Node): TransitionTable | null {
  if (root.kind !== "obj" || root.entries.length < 2) return null;
  const states = new Set(root.entries.map((e) => e.key));
  const transitions: Record<string, Record<string, string>> = {};
  const successors: Record<string, string[]> = {};
  let form: TransitionTable["form"] | null = null;
  let edges = 0;

  for (const row of root.entries) {
    const v = row.value;
    if (v.kind !== "obj" && v.kind !== "arr") return null;
    // An empty row is compatible with either form; a non-empty one decides it.
    const rowForm: TransitionTable["form"] | null =
      v.kind === "obj" ? (v.entries.length > 0 ? "action-map" : null) : v.items.length > 0 ? "successor-list" : null;
    if (rowForm) {
      if (form && form !== rowForm) return null;
      form = rowForm;
    }
    const events: Record<string, string> = {};
    const next: string[] = [];
    if (v.kind === "obj") {
      for (const ev of v.entries) {
        if (ev.value.kind !== "str" || !states.has(ev.value.value)) return null;
        events[ev.key] = ev.value.value;
        if (!next.includes(ev.value.value)) next.push(ev.value.value);
        edges++;
      }
    } else {
      for (const item of v.items) {
        if (item.kind !== "str" || !states.has(item.value)) return null;
        if (!next.includes(item.value)) next.push(item.value);
        edges++;
      }
    }
    transitions[row.key] = events;
    successors[row.key] = next;
  }
  return edges > 0 && form ? { name, form, transitions, successors } : null;
}

function transitionCandidates(ctx: Ctx): InvariantCandidate[] {
  const text = ctx.chunk.content;
  const out: InvariantCandidate[] = [];

  for (const decl of text.matchAll(TABLE_DECL)) {
    const open = (decl.index ?? 0) + decl[0].length - 1;
    const parsed = parseObject(text, open);
    if (!parsed || parsed.node.kind !== "obj") continue;
    const table = asTransitionTable(decl[1], parsed.node);
    if (!table) continue;

    const states = Object.keys(table.successors);
    const events: string[] = [];
    for (const row of Object.values(table.transitions)) for (const e of Object.keys(row)) if (!events.includes(e)) events.push(e);

    for (const row of parsed.node.entries) {
      const state = row.key;
      const rowText = text.slice(row.from, row.to).trim().replace(/,$/, "");
      const startLine = ctx.lineOf(row.from);
      const lines = span(startLine, ctx.lineOf(Math.max(row.from, row.to - 1)));
      const changed = ctx.touched(lines);
      if (ctx.chunk.changedLines && !changed) continue;
      // A row declared empty is an explicit "no way out"; an omitted move is
      // the same fact read from a gap.
      const terminal = table.successors[state].length === 0;
      const pre: StatePredicate = { field: "state", path: table.name, op: "==", value: state };
      const where = {
        source: ctx.chunk.source,
        location: `${ctx.chunk.location}:${startLine}`,
        ...(changed !== undefined ? { changed } : {}),
      };

      if (table.form === "action-map") {
        for (const event of events) {
          if (event in table.transitions[state]) continue;
          // The row where the event *is* allowed — the other half of the evidence.
          const witness = parsed.node.entries.find((r) => event in table.transitions[r.key]);
          const signals = [rowText];
          if (witness) signals.push(text.slice(witness.from, witness.to).trim().replace(/,$/, ""));
          out.push({
            id: `${table.name}:${state}+${event}=>stays(${state})`,
            description:
              `${ctx.chunk.location} declares ${table.name}: in "${state}" the action "${event}" has no transition, ` +
              `so it must not change the state`,
            evidence: { ...where, signals },
            preconditions: [pre],
            action: { name: event },
            context: { transitionTable: table },
            expectation: [{ ...pre }],
            confidence: terminal ? 0.7 : 0.6,
          });
        }
      } else {
        // Successor list: the row names the states this one may move to. Moving
        // to any other state is not declared, so it must not change the state.
        for (const target of states) {
          if (target === state || table.successors[state].includes(target)) continue;
          out.push({
            id: `${table.name}:${state}->${target}=>stays(${state})`,
            description:
              `${ctx.chunk.location} declares ${table.name}: "${state}" lists no transition to "${target}", ` +
              `so moving there must not change the state`,
            evidence: { ...where, signals: [rowText] },
            preconditions: [pre],
            target: { state: target },
            context: { transitionTable: table },
            expectation: [{ ...pre }],
            confidence: terminal ? 0.7 : 0.6,
          });
        }
      }
    }
  }
  return out;
}

// ---- entry points ----------------------------------------------------------

/** Infer candidates from one chunk of program text. Pure — no I/O. */
export function inferCandidates(chunk: EvidenceChunk): InvariantCandidate[] {
  const ctx = context(chunk);
  const seen = new Set<string>();
  const out: InvariantCandidate[] = [];
  for (const c of [...thresholdCandidates(ctx), ...transitionCandidates(ctx)]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

const origin = (c: InvariantCandidate) => `${c.evidence.source}@${c.evidence.location ?? "?"}`;

/** Infer across every chunk and merge the same rule stated in several places:
 * the copy closest to the change is the primary one, the rest are recorded as
 * corroboration. Candidates read from changed code come first so a per-run
 * cap can never drop the rule the change introduced. */
export function inferFromEvidence(chunks: EvidenceChunk[]): InvariantCandidate[] {
  const byId = new Map<string, InvariantCandidate>();
  for (const chunk of chunks) {
    for (const c of inferCandidates(chunk)) {
      const prior = byId.get(c.id);
      if (!prior) {
        byId.set(c.id, c);
        continue;
      }
      const [keep, other] = SOURCE_PRIORITY[c.evidence.source] > SOURCE_PRIORITY[prior.evidence.source] ? [c, prior] : [prior, c];
      byId.set(c.id, {
        ...keep,
        evidence: { ...keep.evidence, alsoSeenIn: [...(keep.evidence.alsoSeenIn ?? []), origin(other), ...(other.evidence.alsoSeenIn ?? [])] },
      });
    }
  }
  const all = [...byId.values()];
  const fromChange = all.filter((c) => c.evidence.changed);
  return [...fromChange, ...all.filter((c) => !c.evidence.changed)];
}
