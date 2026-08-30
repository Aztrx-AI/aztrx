/**
 * F13 — the "X-ray report": a plain-language summary of a run's findings,
 * instead of a wall of stack traces. Two engines behind one entry point:
 *
 *   - LLM (Anthropic Messages API) when `ANTHROPIC_API_KEY` is set — friendly
 *     prose in the requested language, mirroring the transport in `heal/llm.ts`.
 *   - deterministic template when there is no key (or the call fails) — a
 *     readable, structured list that needs no network.
 *
 * An empty run short-circuits to the template (no reason to pay for "all clear").
 * The offer-to-apply line is emitted only when verified fixes are actually ready,
 * so `--explain` (no healing) never promises a fix it doesn't have.
 */

import type { Finding, FindingType, Severity } from "./types.js";
import { complete, hasLlmKey } from "./llm.js";

export type Lang = "en" | "ru";

function normalizeLang(lang?: string): Lang {
  return lang === "ru" ? "ru" : "en";
}

/** Russian plural form picker: [one, few, many]. */
function ruPlural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

interface Phrases {
  none: string;
  found: (n: number) => string;
  offer: (n: number) => string;
  severity: Record<Severity, string>;
  type: Record<FindingType, string>;
  repro: string;
  fix: string;
  healed: string;
}

const PHRASES: Record<Lang, Phrases> = {
  en: {
    none: "No problems found — the app survived this pass.",
    found: (n) => `I scanned your code and found ${n} problem${n === 1 ? "" : "s"}:`,
    offer: (n) => `I've prepared ${n} verified fix${n === 1 ? "" : "es"}.`,
    severity: { crash: "crash", error: "error", warning: "warning", noise: "noise" },
    type: {
      uncaught_exception: "uncaught exception",
      unhandled_rejection: "unhandled promise rejection",
      console_error: "console error",
      network_5xx: "server error (5xx)",
      network_timeout: "network timeout",
    },
    repro: "repro",
    fix: "fix",
    healed: "healed",
  },
  ru: {
    none: "Проблем не найдено — приложение пережило этот проход.",
    found: (n) => `Привет! Я просканировал твой код и нашёл ${n} ${ruPlural(n, ["проблему", "проблемы", "проблем"])}:`,
    offer: (n) => `Я подготовил ${n} ${ruPlural(n, ["исправление", "исправления", "исправлений"])}, каждое проверено тестами.`,
    severity: { crash: "краш", error: "ошибка", warning: "предупреждение", noise: "шум" },
    type: {
      uncaught_exception: "необработанное исключение",
      unhandled_rejection: "необработанный reject промиса",
      console_error: "ошибка в консоли",
      network_5xx: "ошибка сервера (5xx)",
      network_timeout: "таймаут сети",
    },
    repro: "воспроизведение",
    fix: "фикс",
    healed: "вылечено",
  },
};

function location(f: Finding): string {
  const m = f.mappedLocation;
  if (!m || !m.filePath) return "";
  return `${m.filePath}:${m.line}:${m.column}`;
}

function shortMessage(f: Finding): string {
  const line = f.rawMessage.split("\n")[0].trim();
  return line.length > 120 ? line.slice(0, 117) + "…" : line;
}

/** One bullet for the template engine: location, kind, and the one-line message. */
function describeFinding(f: Finding, p: Phrases): string {
  const loc = location(f);
  const head = loc ? `${loc} — ` : "";
  const kind = `${p.type[f.type]} (${p.severity[f.severity]})`;
  const lines: string[] = [`${head}${kind}: "${shortMessage(f)}"`];

  const tail: string[] = [];
  if (f.repro && f.repro.verdict !== "unreliable") {
    tail.push(`${p.repro}: ${f.repro.verdict} (${f.repro.reproductions}/${f.repro.runs})`);
  }
  if (f.heal) {
    tail.push(`${p.fix}: ${f.heal.status === "healed" ? p.healed : f.heal.status}`);
  }
  if (tail.length) lines.push(`  ${tail.join(" · ")}`);

  return lines.join("\n");
}

/** Deterministic, offline summary. Used as the no-key fallback and for empty runs. */
export function summarizeFindingsTemplate(findings: Finding[], lang: Lang = "en"): string {
  const p = PHRASES[lang];
  if (findings.length === 0) return p.none;

  const healed = findings.filter((f) => f.heal?.status === "healed");
  const bullets = findings
    .map((f, i) => `  ${i + 1}. ${describeFinding(f, p)}`)
    .join("\n");

  const lines = [p.found(findings.length), "", bullets];
  if (healed.length) lines.push("", p.offer(healed.length));
  return lines.join("\n");
}

function buildLlmPrompt(findings: Finding[], lang: Lang, hasHealed: boolean): string {
  const rows = findings
    .map((f) => {
      const loc = location(f) || "(no source location)";
      const repro = f.repro ? `${f.repro.verdict} ${f.repro.reproductions}/${f.repro.runs}` : "none";
      const heal = f.heal
        ? f.heal.status + (f.heal.explanation ? ` — ${f.heal.explanation}` : "")
        : "n/a";
      return `- ${loc} | ${f.type} | severity=${f.severity} | "${shortMessage(f)}" | repro=${repro} | heal=${heal}`;
    })
    .join("\n");

  const fixLine = hasHealed
    ? "Verified fixes ARE ready to apply — mention that they are prepared."
    : "No fixes were prepared — do not offer to apply anything.";

  return [
    `A QA tool scanned a web app and found the following findings:`,
    rows,
    "",
    `Write a short, friendly, plain-language summary for a developer (${lang}): what was found, what each problem means in simple words, and — per the note below — whether fixes are ready. Do not invent details that are not listed. Keep it to a few short paragraphs or a tight bullet list.`,
    fixLine,
  ].join("\n");
}

const SYSTEM =
  "You are the plain-spoken explainer for a QA tool called Aztrx AI. You turn raw runtime-finding data into a concise, human-language summary for a developer. Never invent details absent from the data. Respond in the requested language only.";

async function summarizeFindingsLlm(findings: Finding[], lang: Lang): Promise<string> {
  const hasHealed = findings.some((f) => f.heal?.status === "healed");
  const text = (
    await complete({
      system: SYSTEM,
      prompt: buildLlmPrompt(findings, lang, hasHealed),
      maxTokens: 1024,
      temperature: 0.2,
    })
  ).trim();
  return text || summarizeFindingsTemplate(findings, lang);
}

export interface SummarizeOptions {
  lang?: string;
}

/**
 * Entry point. Empty run → template (no API cost). Otherwise LLM when a key is
 * present; falls back to the deterministic template on any transport failure, so
 * the report never crashes the run.
 */
export async function summarizeFindings(findings: Finding[], opts: SummarizeOptions = {}): Promise<string> {
  const lang = normalizeLang(opts.lang);
  if (findings.length === 0) return summarizeFindingsTemplate(findings, lang);
  if (!hasLlmKey()) return summarizeFindingsTemplate(findings, lang);
  try {
    return await summarizeFindingsLlm(findings, lang);
  } catch {
    return summarizeFindingsTemplate(findings, lang);
  }
}
