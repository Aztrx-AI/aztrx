/**
 * F-modernize — the "code translator". Rewrites a legacy JS/TS file into modern
 * idiomatic form (const/let over var, async/await over callbacks and promise
 * chains, arrow functions, optional chaining) while preserving behavior. This is
 * a *static* transform, unlike the rest of Aztrx's runtime detection, so it's its
 * own command rather than a `run` flag.
 *
 * Safety model: the model's output is gated by a re-parse (`ts.transpileModule`
 * reports syntax errors without running a full tsc), and the caller applies it to
 * the working tree only after the user confirms — never automatically.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

export type Lang = "ts" | "js";

const MODEL = process.env.AZTRX_MODEL || "claude-sonnet-5";
const API_URL = "https://api.anthropic.com/v1/messages";

export function detectLang(filePath: string): Lang | null {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "ts";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "js";
  return null;
}

export interface ParseGateResult {
  ok: boolean;
  errors: string[];
}

/** Syntax gate: does the output still parse? In-process (no tsc subprocess). */
export function parseGate(source: string, lang: Lang): ParseGateResult {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
    },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? [])
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  return { ok: errors.length === 0, errors };
}

export interface ModernizeResult {
  ok: boolean;
  original: string;
  modernized?: string;
  changes: string[];
  lang?: Lang;
  error?: string;
}

const SYSTEM =
  "You are a careful code-modernization engineer. You rewrite legacy JavaScript/TypeScript into modern idiomatic form while preserving behavior exactly. You never change logic, control flow, or behavior — only syntax and idioms.";

function buildPrompt(source: string, lang: Lang): string {
  const language = lang === "ts" ? "TypeScript" : "JavaScript";
  return [
    `Rewrite the following ${language} file into modern idiomatic form:`,
    `- prefer const/let over var`,
    `- prefer async/await over callbacks and promise .then chains`,
    `- prefer arrow functions, optional chaining, and nullish coalescing where they do not change behavior`,
    `- do NOT change any logic, control flow, or behavior — only modernize syntax and idioms`,
    `- do NOT add imports; only remove an import if it is genuinely unused`,
    ``,
    `Return ONLY a JSON object, no markdown fences, no prose. Shape:`,
    `{ "modernized": "<the full modernized file content>", "changes": ["short human-readable change", "..."] }`,
    ``,
    `--- file (${language}) ---`,
    source,
    `--- end file ---`,
  ].join("\n");
}

function parseReply(raw: string): { modernized: string; changes: string[] } {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

  const data = JSON.parse(text) as { modernized?: unknown; changes?: unknown };
  const modernized = typeof data.modernized === "string" ? data.modernized : "";
  const changes = Array.isArray(data.changes)
    ? data.changes.filter((c): c is string => typeof c === "string").slice(0, 20)
    : [];
  return { modernized, changes };
}

export async function modernizeFile(repoRoot: string, filePath: string): Promise<ModernizeResult> {
  const lang = detectLang(filePath);
  if (!lang) {
    return { ok: false, original: "", changes: [], error: `unsupported file type (only JS/TS): ${filePath}` };
  }

  const abs = path.resolve(repoRoot, filePath);
  let original: string;
  try {
    original = fs.readFileSync(abs, "utf-8");
  } catch (e) {
    return { ok: false, original: "", changes: [], error: `cannot read ${filePath}: ${(e as Error).message}` };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { ok: false, original, changes: [], lang, error: "ANTHROPIC_API_KEY is not set" };
  }

  let reply: string;
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8192,
        temperature: 0,
        system: SYSTEM,
        messages: [{ role: "user", content: buildPrompt(original, lang) }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, original, changes: [], lang, error: `LLM request failed (${res.status}): ${body.slice(0, 300)}` };
    }
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    reply = (data.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  } catch (e) {
    return { ok: false, original, changes: [], lang, error: `LLM request failed: ${(e as Error).message}` };
  }

  let parsed: { modernized: string; changes: string[] };
  try {
    parsed = parseReply(reply);
  } catch {
    return { ok: false, original, changes: [], lang, error: "could not parse the model reply" };
  }

  if (!parsed.modernized.trim()) {
    return { ok: false, original, changes: [], lang, error: "model returned an empty file" };
  }

  const gate = parseGate(parsed.modernized, lang);
  if (!gate.ok) {
    return {
      ok: false,
      original,
      changes: parsed.changes,
      lang,
      error: `modernized output does not parse: ${gate.errors[0] ?? "syntax error"}`,
    };
  }

  return { ok: true, original, modernized: parsed.modernized, changes: parsed.changes, lang };
}
