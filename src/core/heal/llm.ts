/**
 * F10 — LLM patch generator. Turns a redacted bug report into a minimal
 * Search & Replace diff. The transport is Anthropic's Messages API (key from
 * `ANTHROPIC_API_KEY`, model from `AZTRX_MODEL` or a sensible default); a
 * `patchFn` can be injected instead, which is how the loop is unit-tested and
 * how a future provider (local model, proxy) plugs in without touching this
 * module's callers.
 */

import { redact } from "./redact.js";
import { complete, primaryModel, fastModel } from "../llm.js";
import type { HealContext, Patch, PatchHunk, SpendBudget } from "./types.js";

export interface ModelTier {
  model: string;
  label: "fast" | "sonnet";
}

/**
 * The Smart Cloud Router's tier plan: fast/cheap first, then the capable model
 * as the fallback. Collapses to a single tier when the two resolve to the same
 * model (e.g. `AZTRX_FAST_MODEL=claude-sonnet-5`). Consumers loop over this in
 * order and stop at the first `healed` result.
 */
export function modelTiers(fallbackModel?: string, fastFallback?: string): ModelTier[] {
  const fast = fastFallback || fastModel();
  const primary = fallbackModel || primaryModel();
  if (!primary) return []; // no model configured — the caller reports no-llm

  const tiers: ModelTier[] = [];
  if (fast && fast !== primary) tiers.push({ model: fast, label: "fast" });
  tiers.push({ model: primary, label: "sonnet" });
  // Extra models for multi-model consensus (`AZTRX_CONSENSUS_MODELS`), deduped.
  for (const m of (process.env.AZTRX_CONSENSUS_MODELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!tiers.some((t) => t.model === m)) tiers.push({ model: m, label: "sonnet" });
  }
  return tiers;
}

const SYSTEM = `You are a meticulous bug-fixing engineer. You are given a single source file and a runtime error that occurs in it. Produce a MINIMAL fix as a unified diff.

Return ONLY a unified diff block, no prose outside it:
\`\`\`diff
--- <file path>
@@ -<line>,<n> +<line>,<n> @@
-<original lines>
+<fixed lines>
\`\`\`

(For full compatibility a JSON Search & Replace object is also accepted:
{ "explanation": "one sentence", "edits": [ { "search": "<exact substring>", "replace": "<fixed version>" } ] }
— but prefer the unified diff.)

Hard rules:
- Every removed line must appear EXACTLY as shown in the file (include enough surrounding unchanged lines to be unique).
- Change as little as possible. Do not reformat unrelated code.
- Do NOT add any new import/require/import(). Do NOT use eval or new Function. Do NOT write an empty catch block (catch {}). Do NOT touch child_process, exec, spawn, fork, process.exit.
- If you see __AZTRX_REDACTED_N__ placeholders, treat them as opaque tokens and carry them through unchanged — do not invent values for them.
- If you cannot fix the bug, return an empty diff (no -/+ lines).`;

export interface GenerateOptions {
  model?: string;
  patchFn?: (ctx: HealContext) => Promise<Patch>;
  budget?: SpendBudget;
}

/** Thrown when the shared session budget has no paid generations left. Heal
 * maps this to a `budget-exhausted` status rather than a transport error. */
export class BudgetExhaustedError extends Error {
  constructor() {
    super("spend budget exhausted");
    this.name = "BudgetExhaustedError";
  }
}

function buildPrompt(ctx: HealContext): string {
  const loc = ctx.finding.mappedLocation;
  const msg = redact(ctx.finding.rawMessage).text;
  const stack = redact(ctx.finding.rawStack).text;

  const parts: string[] = [];
  parts.push(`File: ${ctx.filePath}`);
  if (loc) parts.push(`Bug location: line ${loc.line}, column ${loc.column}`);
  parts.push(`Error: ${msg.split("\n")[0].slice(0, 200)}`);
  if (stack) parts.push(`Stack (truncated):\n${stack.split("\n").slice(0, 12).join("\n")}`);

  // The business risk and the exact repro steps — the model fixes the bug,
  // but it must understand what the bug costs and how it was reached.
  if (ctx.finding.businessRisk) parts.push(`Business risk: ${ctx.finding.businessRisk}`);
  const steps = ctx.finding.actionHistory
    .slice(0, 8)
    .map((a, i) => {
      switch (a.type) {
        case "navigate":
          return `${i + 1}. open ${a.value}`;
        case "click":
          return `${i + 1}. click ${a.selectors[0] ?? "the element"}`;
        case "input":
          return `${i + 1}. type ${JSON.stringify(a.value ?? "")} into ${a.selectors[0] ?? "the field"}`;
        case "keypress":
          return `${i + 1}. press ${a.value ?? "Enter"}`;
        case "request":
          return `${i + 1}. send ${a.request?.method ?? "GET"} ${a.request?.url ?? ""}`;
        default:
          return null;
      }
    })
    .filter((s): s is string => Boolean(s));
  if (steps.length) parts.push(`Repro steps:\n${steps.join("\n")}`);

  parts.push(`--- file: ${ctx.filePath} ---`);
  parts.push(ctx.redactedContent);
  parts.push("--- end file ---");
  parts.push("Return the unified diff that fixes this error.");
  return parts.join("\n");
}

/** Convert a unified diff block into a single Search & Replace hunk. */
function parseUnifiedDiff(text: string): PatchHunk[] | null {
  const lines = text.split("\n");
  let inHunk = false;
  const search: string[] = [];
  const replace: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("-")) search.push(line.slice(1));
    else if (line.startsWith("+")) replace.push(line.slice(1));
    else {
      search.push(line);
      replace.push(line);
    }
  }
  if (search.length === 0 && replace.length === 0) return null;
  // A unified diff without context lines cannot apply exactly — refuse it
  // rather than produce an apply-failed round trip.
  if (search.length === 0) return null;
  return [{ search: search.join("\n"), replace: replace.join("\n") }];
}

/** Parse a model reply into a Patch. Tolerates markdown fences, leading text,
 * unified diff blocks, and the legacy JSON Search & Replace shape. */
export function parsePatch(raw: string): Patch {
  let text = raw.trim();
  const fence = text.match(/```(?:json|diff)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  // Unified diff first — the model's preferred format.
  if (/^---\s+/.test(text) || text.includes("\n-") || text.includes("\n+")) {
    const hunks = parseUnifiedDiff(text);
    if (hunks) {
      const m = text.match(/^---\s+(\S+)/m);
      return { explanation: m ? `Patch for ${m[1]}` : "Unified diff patch", hunks };
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

  // A reply that is neither a diff nor JSON (prose, an apology, an empty
  // fence) is "cannot fix", not a parse crash — the caller reports it as
  // `rejected` with the model's own words instead of a JSON error.
  try {
    const data = JSON.parse(text) as {
      explanation?: string;
      edits?: Array<{ search?: unknown; replace?: unknown }>;
    };
    const hunks: PatchHunk[] = (data.edits ?? [])
      .filter(
        (e): e is { search: string; replace: string } =>
          typeof e?.search === "string" && e.search.length > 0 && typeof e?.replace === "string"
      )
      .map((e) => ({ search: e.search, replace: e.replace }));
    return { explanation: typeof data.explanation === "string" ? data.explanation : "", hunks };
  } catch {
    return {
      explanation: "the model did not return a patch",
      hunks: [],
    };
  }
}

/** Sentinel model name for the free, no-key rule-based fixer. */
export const RULE_TIER = "__rule__";

// Matches "Cannot read properties of undefined|null (reading 'X')".
const NULL_DEREF = /Cannot read properties of (undefined|null)(?: \(reading '([^']+)'\))?/;

/** Index of the first real assignment `=` — skipping `==`, `=>`, `<=`, `>=`,
 * `!=`, and the compound forms `+=`/`-=`/etc. Returns -1 when there is none. */
function firstAssignment(line: string): number {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== "=") continue;
    const prev = line[i - 1];
    const next = line[i + 1];
    if (prev === "=" || next === "=") continue; // ==
    if (prev === "!" || prev === "<" || prev === ">") continue; // != <= >=
    if (next === ">") continue; // =>
    if (/[+\-*/%&|^!<>]/.test(prev ?? "") ) continue; // += -= *= … — compound
    return i;
  }
  return -1;
}

/**
 * Rule-based fix for the most common crash — a null/undefined property access.
 * Adds `?.` (optional chaining) at the failing access. Returns null when the
 * error isn't a null/undefined deref or the line can't be located. Free and
 * offline: no LLM, no key, no network — so `--fix` works out of the box for the
 * most frequent frontend crashes.
 */
export function generateRulePatch(ctx: HealContext): Patch | null {
  const m = ctx.finding.rawMessage.match(NULL_DEREF);
  if (!m) return null;
  const kind = m[1]; // "undefined" | "null"
  const prop = m[2]; // the property that was read
  const line = ctx.finding.mappedLocation?.line;
  if (!prop || line == null) return null;

  const src = ctx.fileContent.split("\n")[line - 1];
  if (!src || !src.includes("." + prop)) return null;

  // Optional-chain every `.identifier` access on the line (not just the failing
  // one) so a chain like `d.agents.map(…)` becomes `d?.agents?.map(…)`.
  //
  // The lookbehind is the whole point, and it is not cosmetic. A bare
  // `/\.(?=[a-zA-Z_$])/` also matches the dots in a spread and in chaining that
  // is already optional, so `{ ...s, [id]: result.ok }` became
  // `{ ..?.s, [id]: result.ok }` and `d?.agents` became `d??.agents`. Both are
  // syntax errors, which the AST gate then refused — correctly, but the effect
  // was that the free fixer declined every line containing a spread or an
  // existing `?.`, which is most React code, and the finding was reported as
  // `rejected` with no hint that the rule engine was at fault.
  //
  // Known limit: this is a regex on a line of source, not a lexer, so a `.name`
  // *inside a string literal or regex* on the failing line is rewritten too.
  // That cannot make the file unparseable (the gate above still runs), but it
  // can change behaviour, and no gate here would catch it.
  // Optional-chain only the RIGHT-hand side of an assignment: `x.y = z.w`
  // must become `x.y = z?.w`, never `x?.y = z?.w` — assignment through an
  // optional chain is a syntax error, and a script that dies on parse makes
  // the crash "disappear" along with the whole app (a lie verification
  // cannot see). No `=` in sight → the whole line is fair game.
  const eqIdx = firstAssignment(src);
  const lhs = eqIdx >= 0 ? src.slice(0, eqIdx) : "";
  const rhs = eqIdx >= 0 ? src.slice(eqIdx) : src;
  const replace = lhs + rhs.replace(/(?<![.?])\.(?=[a-zA-Z_$])/g, "?.");
  if (replace === src) return null;

  return {
    explanation: `Guard against a ${kind} access on \`.${prop}\` with optional chaining.`,
    hunks: [{ search: src, replace }],
  };
}

export async function generatePatch(ctx: HealContext, opts: GenerateOptions = {}): Promise<Patch> {
  if (opts.patchFn) return opts.patchFn(ctx);

  if (opts.model === RULE_TIER) {
    const rulePatch = generateRulePatch(ctx);
    if (rulePatch) return rulePatch;
    throw new Error("no rule-based fix applicable");
  }

  // Paid path — enforce the shared session budget before spending, and charge it
  // on success. The free rule tier above never reaches this, so a spent budget
  // still lets free fixes through.
  if (opts.budget && opts.budget.remaining <= 0) {
    throw new BudgetExhaustedError();
  }
  const text = await complete({
    system: SYSTEM,
    prompt: buildPrompt(ctx),
    model: opts.model,
    // A patch is a few hundred tokens, but a reasoning model spends this budget
    // on its thinking *first* — at 2048 a reasoner like cohere/north-mini-code
    // hit the cap before emitting any text at all, so healing reported "no
    // content (finish_reason: length)" and gave up without ever producing a
    // patch. This is a ceiling, not a charge: cost is per token actually
    // emitted, so the headroom is free for models that do not reason.
    maxTokens: 8192,
    temperature: 0,
  });
  if (process.env.AZTRX_DEBUG_LLM) {
    process.stderr.write(`[llm-debug] model reply (${text.length} chars):\n${text.slice(0, 1200)}\n--- end reply ---\n`);
  }
  if (opts.budget) opts.budget.remaining -= 1;
  return parsePatch(text);
}
