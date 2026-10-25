/**
 * Stage 2: hypotheses. The only place a model is asked to think about the
 * product; everything after this is deterministic.
 *
 * The prompt's central demand is independence: an expectation has to come from
 * the project's own words (docs, test names, UI text) or from a property that
 * holds of any software of this kind. "The app currently does X" is never an
 * expectation — that would make every behavior correct by definition.
 */

import type { ExpectationKind, Hypothesis, Inventory, PropertyKind, Read, Relation, Step, Target } from "./types.js";

export type Completer = (req: { system: string; prompt: string; maxTokens: number }) => Promise<string>;

const SYSTEM = `You design experiments that expose behavioral defects in a running web application, using only what a user could see and do.

You will be given an inventory: the project's documentation, the names of its own tests, and what its UI shows. You are NOT told of any bug and must not assume one exists.

Rules for every hypothesis:
1. State a user-visible behavior that SHOULD hold, and say where that expectation comes from:
   - "doc":  the documentation promises it (quote the exact sentence)
   - "test": a test name in the inventory promises it (quote the name)
   - "ui":   text the product itself shows promises it (quote it)
   - "universal": any application of this kind should do this, regardless of this one (e.g. what you add then remove is gone; what you save survives a reload; a count equals the number of listed items; sorting by X orders by X; doing an idempotent action twice equals doing it once)
   Quotes must be copied verbatim from the inventory. NEVER use "the app currently behaves like this" as an expectation.
2. Design a short script (at most 12 steps) a browser can run that would reveal a violation, with snapshots at the moments you want to compare, and reads that say what to measure at each snapshot.
3. Express the expectation as relations between snapshot readings. Compare a reading with another reading wherever possible, not with a constant you guessed.
4. Stay inside the product: only same-origin pages, only data you create yourself with obviously synthetic values. No login attempts, no deleting pre-existing data, no payments, no scanning, no attacks.
5. Prefer hypotheses where you are genuinely unsure of the outcome and a failure would matter to users. Do not propose a check you are certain will pass.

Reply with ONLY a JSON array (no prose, no code fence) of objects:
{
 "behavior": string,
 "property": "round-trip"|"persistence"|"consistency"|"idempotence"|"ordering"|"documented"|"other",
 "expectation": {"kind": "doc"|"test"|"ui"|"universal", "quote": string (omit for universal)},
 "impact": 1-5,
 "steps": [ {"op":"goto","path":"/x"} | {"op":"click","target":T} | {"op":"fill","target":T,"value":string} | {"op":"press","key":string} | {"op":"reload"} | {"op":"snapshot","label":string} ],
 "reads": [ {"name":string,"what":"count"|"text"|"value"|"visible","target":T} ],
 "expect": [ {"kind":"equals"|"not_equals","left":"label.name","right":"label.name"|string|number} | {"kind":"increased_by","left":"label.name","base":"label.name","by":number} | {"kind":"contains"|"not_contains","left":"label.name","right":string} ]
}
where T is an object with any of: text, label, placeholder, role, selector (prefer text/label/role over selector).
Every read is taken at every snapshot. "count" counts elements matching T; "text" is the visible text of the first match; "value" is an input's value; "visible" is true/false.`;

export function buildPrompt(inv: Inventory, maxHypotheses: number): string {
  return `Propose up to ${maxHypotheses} hypotheses.\n\n=== INVENTORY ===\n${inv.text}\n=== END INVENTORY ===`;
}

const PROPERTIES = new Set<PropertyKind>(["round-trip", "persistence", "consistency", "idempotence", "ordering", "documented", "other"]);
const KINDS = new Set<ExpectationKind>(["doc", "test", "ui", "universal"]);
const WHATS = new Set(["count", "text", "value", "visible"]);
const REL = new Set(["equals", "not_equals", "increased_by", "contains", "not_contains"]);

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function asTarget(x: unknown): Target | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  const t: Target = {};
  for (const k of ["text", "label", "placeholder", "role", "selector"] as const) {
    if (typeof o[k] === "string" && (o[k] as string).trim()) t[k] = o[k] as string;
  }
  return Object.keys(t).length ? t : undefined;
}

function asStep(x: unknown): Step | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  switch (o.op) {
    case "goto":
      return typeof o.path === "string" && o.path.startsWith("/") && !o.path.startsWith("//") ? { op: "goto", path: o.path } : undefined;
    case "click": {
      const target = asTarget(o.target);
      return target ? { op: "click", target } : undefined;
    }
    case "fill": {
      const target = asTarget(o.target);
      return target && typeof o.value === "string" ? { op: "fill", target, value: o.value } : undefined;
    }
    case "press":
      return typeof o.key === "string" && o.key.length <= 20 ? { op: "press", key: o.key } : undefined;
    case "reload":
      return { op: "reload" };
    case "snapshot":
      return typeof o.label === "string" && /^[\w-]{1,24}$/.test(o.label) ? { op: "snapshot", label: o.label } : undefined;
  }
  return undefined;
}

function asRead(x: unknown): Read | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  const target = asTarget(o.target);
  return typeof o.name === "string" && /^[\w-]{1,24}$/.test(o.name) && typeof o.what === "string" && WHATS.has(o.what) && target
    ? { name: o.name, what: o.what as Read["what"], target }
    : undefined;
}

const REF = /^[\w-]+\.[\w-]+$/;

function asRelation(x: unknown): Relation | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  if (typeof o.kind !== "string" || !REL.has(o.kind) || typeof o.left !== "string" || !REF.test(o.left)) return undefined;
  const scalar = (v: unknown): v is string | number => typeof v === "string" || typeof v === "number";
  switch (o.kind) {
    case "equals":
    case "not_equals":
      return scalar(o.right) ? ({ kind: o.kind, left: o.left, right: o.right } as Relation) : undefined;
    case "increased_by":
      return typeof o.base === "string" && REF.test(o.base) && typeof o.by === "number" ? { kind: "increased_by", left: o.left, base: o.base, by: o.by } : undefined;
    default:
      return typeof o.right === "string" ? ({ kind: o.kind, left: o.left, right: o.right } as Relation) : undefined;
  }
}

/** Pull a JSON array out of a reply, tolerating a code fence or stray prose. */
function jsonArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export interface Rejected {
  index: number;
  why: string;
}

/**
 * Turn a model reply into hypotheses the executor can run. Malformed ones are
 * dropped with a reason rather than repaired — a hypothesis we had to guess at
 * is not the model's hypothesis. A cited quote that is not in the inventory
 * demotes the expectation to `universal`, because the model never saw it.
 */
export function parseHypotheses(reply: string, inv: Inventory): { accepted: Hypothesis[]; rejected: Rejected[] } {
  const hay = norm(inv.text);
  const accepted: Hypothesis[] = [];
  const rejected: Rejected[] = [];
  jsonArray(reply).forEach((raw, index) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const steps = Array.isArray(o.steps) ? o.steps.map(asStep) : [];
    const reads = Array.isArray(o.reads) ? o.reads.map(asRead) : [];
    const expect = Array.isArray(o.expect) ? o.expect.map(asRelation) : [];
    const exp = (o.expectation ?? {}) as Record<string, unknown>;
    if (typeof o.behavior !== "string" || !o.behavior.trim()) return void rejected.push({ index, why: "no behavior" });
    if (typeof o.property !== "string" || !PROPERTIES.has(o.property as PropertyKind)) return void rejected.push({ index, why: "unknown property kind" });
    if (typeof exp.kind !== "string" || !KINDS.has(exp.kind as ExpectationKind)) return void rejected.push({ index, why: "no expectation source" });
    if (!steps.length || steps.length > 12 || steps.some((s) => !s)) return void rejected.push({ index, why: "steps missing, too many, or malformed" });
    if (!reads.length || reads.some((r) => !r)) return void rejected.push({ index, why: "reads missing or malformed" });
    if (!expect.length || expect.some((r) => !r)) return void rejected.push({ index, why: "expectations missing or malformed" });

    const snaps = new Set((steps as Step[]).filter((s) => s.op === "snapshot").map((s) => (s as { label: string }).label));
    const names = new Set((reads as Read[]).map((r) => r.name));
    // `left` and `base` are always readings. `right` is a reading only when its
    // label is a declared snapshot; otherwise it is a literal that happens to
    // contain a dot.
    const resolves = (ref: string) => {
      const [l, n] = ref.split(".");
      return snaps.has(l) && names.has(n);
    };
    const bad = (expect as Relation[])
      .flatMap((r) => [r.left, ...("base" in r ? [r.base] : []), ...("right" in r && typeof r.right === "string" && snaps.has(r.right.split(".")[0]) && REF.test(r.right) ? [r.right] : [])])
      .find((ref) => !resolves(ref));
    if (bad) return void rejected.push({ index, why: `relation refers to unknown snapshot/read: ${bad}` });

    let kind = exp.kind as ExpectationKind;
    let quote = typeof exp.quote === "string" ? exp.quote.trim() : undefined;
    if (kind !== "universal" && (!quote || quote.length < 6 || !hay.includes(norm(quote)))) {
      kind = "universal";
      quote = undefined;
    }
    accepted.push({
      id: `h${accepted.length + 1}`,
      behavior: o.behavior.trim(),
      property: o.property as PropertyKind,
      expectation: { kind, ...(quote ? { quote } : {}) },
      impact: Math.min(5, Math.max(1, Math.round(Number(o.impact) || 3))),
      steps: steps as Step[],
      reads: reads as Read[],
      expect: expect as Relation[],
    });
  });
  return { accepted, rejected };
}

export async function generateHypotheses(
  inv: Inventory,
  complete: Completer,
  maxHypotheses = 12,
  maxTokens = 6000
): Promise<{ accepted: Hypothesis[]; rejected: Rejected[]; prompt: string; reply: string }> {
  const prompt = buildPrompt(inv, maxHypotheses);
  const reply = await complete({ system: SYSTEM, prompt, maxTokens });
  return { ...parseHypotheses(reply, inv), prompt, reply };
}
