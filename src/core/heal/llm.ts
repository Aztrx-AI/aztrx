/**
 * F10 — LLM patch generator. Turns a redacted bug report into a minimal
 * Search & Replace diff. The transport is Anthropic's Messages API (key from
 * `ANTHROPIC_API_KEY`, model from `AZTRX_MODEL` or a sensible default); a
 * `patchFn` can be injected instead, which is how the loop is unit-tested and
 * how a future provider (local model, proxy) plugs in without touching this
 * module's callers.
 */

import { redact } from "./redact.js";
import type { HealContext, Patch, PatchHunk } from "./types.js";

const DEFAULT_MODEL = process.env.AZTRX_MODEL || "claude-sonnet-5";
/** Cheap/fast first tier for the Smart Cloud Router. The idea: most one-line
 * fixes are trivial, so try the small model before paying for the big one. */
const FAST_MODEL = process.env.AZTRX_FAST_MODEL || "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";

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
export function modelTiers(fallbackModel?: string): ModelTier[] {
  const fast = process.env.AZTRX_FAST_MODEL || FAST_MODEL;
  const sonnet = fallbackModel || DEFAULT_MODEL;
  if (fast === sonnet) return [{ model: sonnet, label: "sonnet" }];
  return [
    { model: fast, label: "fast" },
    { model: sonnet, label: "sonnet" },
  ];
}

const SYSTEM = `You are a meticulous bug-fixing engineer. You are given a single source file and a runtime error that occurs in it. Produce a MINIMAL fix as a Search & Replace diff.

Return ONLY a JSON object, no markdown fences, no prose. Shape:
{ "explanation": "one sentence", "edits": [ { "search": "<exact substring from the file>", "replace": "<the fixed version>" } ] }

Hard rules:
- "search" must be an EXACT, unique substring of the file you were shown (include enough surrounding lines to be unique).
- "replace" is the corrected version of exactly that substring.
- Change as little as possible. Do not reformat unrelated code.
- Do NOT add any new import/require/import(). Do NOT use eval or new Function. Do NOT write an empty catch block (catch {}). Do NOT touch child_process, exec, spawn, fork, process.exit.
- If you see __AZTRX_REDACTED_N__ placeholders, treat them as opaque tokens and carry them through unchanged — do not invent values for them.
- If you cannot fix the bug, return { "explanation": "cannot fix", "edits": [] }.`;

export interface GenerateOptions {
  model?: string;
  patchFn?: (ctx: HealContext) => Promise<Patch>;
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
  parts.push(`--- file: ${ctx.filePath} ---`);
  parts.push(ctx.redactedContent);
  parts.push("--- end file ---");
  parts.push("Return the JSON Search & Replace diff that fixes this error.");
  return parts.join("\n");
}

/** Parse a model reply into a Patch. Tolerates markdown fences and leading text. */
export function parsePatch(raw: string): Patch {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

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
}

export async function generatePatch(ctx: HealContext, opts: GenerateOptions = {}): Promise<Patch> {
  if (opts.patchFn) return opts.patchFn(ctx);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("heal: ANTHROPIC_API_KEY is not set (and no patchFn was injected)");
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: 2048,
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: "user", content: buildPrompt(ctx) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`heal: LLM request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = (data.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  return parsePatch(text);
}
