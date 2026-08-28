import * as fs from "fs";
import * as path from "path";
import type { Finding, RecordedAction } from "./types.js";
import { sanitizeSecrets } from "./heal/redact.js";

/**
 * F-report — the PR bot's markdown comment. Same findings as the HTML report,
 * reshaped for a GitHub PR: a status badge, one `<details>` per finding, the
 * minimized reproduction steps, the compiled Playwright spec inlined, and the
 * gated patch as a `diff` view. Self-contained — no external data beyond the
 * shields.io badges, which GitHub renders natively.
 */

const SEV_ORDER = ["crash", "error", "warning", "noise"] as const;

const SEV_BADGE: Record<string, string> = {
  crash: "ff5a5f",
  error: "ff5a5f",
  warning: "f5a623",
  noise: "5b6573",
};

/** Shields.io badge-path escaping: literal `-` → `--`, `/` → `%2F`, space → `_`. */
function shield(s: string): string {
  return s.replace(/-/g, "--").replace(/\//g, "%2F").replace(/ /g, "_");
}

function badge(label: string, value: string, color: string): string {
  return `![${label}: ${value}](https://img.shields.io/badge/${shield(label)}-${shield(value)}-${shield(color)})`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Wrap `code` in a backtick fence one longer than any run inside it, so the
 * content can never close the fence (blocks markdown breakout from a hostile
 * sourcemap snippet or patch). */
function fence(code: string, lang = ""): string {
  const runs = code.match(/`+/g) ?? [];
  const maxRun = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const delim = "`".repeat(Math.max(3, maxRun + 1));
  return `${delim}${lang}\n${code.trimEnd()}\n${delim}`;
}

/** Inline code that can't be broken out of — backticks/newlines are stripped. */
function inlineCode(s: string): string {
  return "`" + s.replace(/`/g, "").replace(/[\r\n]/g, " ") + "`";
}

/** Scrub secrets and strip markdown-breakout chars for anything inlined into a
 * heading or inline-code span. The PR comment renders untrusted stack/snippet
 * text — a secret in it (or a stray backtick) must never leak or break out. */
function cleanInline(s: string): string {
  return sanitizeSecrets(s).replace(/`/g, "").replace(/[\r\n]/g, " ");
}

/** Hard cap on the server body inlined into a PR comment — a 500 page can be
 * huge, and only the first line or two are ever diagnostic. */
const SERVER_BODY_CAP = 2000;

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function describeAction(a: RecordedAction): string {
  const sel = a.selectors[0] ? ` ${inlineCode(sanitizeSecrets(a.selectors[0]))}` : "";
  const val = a.value ? ` ${inlineCode(sanitizeSecrets(a.value))}` : "";
  return `**${a.type}**${val}${sel}`;
}

function healBlock(f: Finding): string {
  const h = f.heal;
  if (!h) return "";

  const labels: Record<string, { text: string; color: string }> = {
    healed: { text: "healed", color: "43e58a" },
    unfixed: { text: "unfixed", color: "f5a623" },
    rejected: { text: "rejected", color: "ff5a5f" },
    "compile-failed": { text: "compile-failed", color: "ff5a5f" },
    "test-failed": { text: "test-failed", color: "ff5a5f" },
    "apply-failed": { text: "apply-failed", color: "ff5a5f" },
    skipped: { text: "skipped", color: "5b6573" },
    "no-llm": { text: "no-llm", color: "5b6573" },
  };
  const meta = labels[h.status] ?? { text: h.status, color: "5b6573" };
  const via = h.model ? ` · \`${h.model}\`` : "";
  const tiers = h.tiers && h.tiers.length > 1 ? ` · router: ${h.tiers.join(" → ")}` : "";

  const body: string[] = [];

  // The saved unified diff is only produced for a patch that reached verify.
  const diff = h.patchPath ? readIfExists(path.resolve(h.patchPath)) : null;
  if (diff) {
    body.push(fence(diff, "diff"));
  } else if (h.explanation) {
    body.push(`> ${h.explanation}`);
  }
  if (h.test?.ran) {
    body.push(`**tests** ${inlineCode(h.test.command)} — ${h.test.ok ? "passed" : "failed"}`);
  }
  if (h.error) body.push(`\n_${escapeHtml(h.error)}_`);

  return `\n<details>\n<summary>${badge("heal", meta.text, meta.color)} proposed patch${via}${tiers}</summary>\n\n${body.join("\n")}\n</details>`;
}

function reproBlock(f: Finding): string {
  const r = f.repro;
  if (!r || !r.specPath) return "";

  const verdict = badge("repro", `${r.verdict} ${r.reproductions}/${r.runs}`, r.verdict === "deterministic" ? "43e58a" : "f5a623");
  const steps = r.actions.length
    ? `\n${r.actions.map((a, i) => `${i + 1}. ${describeAction(a)}`).join("\n")}`
    : "";

  const spec = readIfExists(path.resolve(r.specPath));
  const specBlock = spec ? `\n${fence(spec, "ts")}` : "";

  return `\n<details>\n<summary>▶ ${verdict} · ${r.actions.length} step(s)</summary>\n\n**Reproduce**${steps}${specBlock}\n</details>`;
}

function findingBlock(f: Finding): string {
  const sev = f.severity;
  const first = sanitizeSecrets(f.rawMessage.split("\n")[0]);
  const loc = f.mappedLocation
    ? `\n**Location** \`${cleanInline(f.mappedLocation.filePath)}:${f.mappedLocation.line}:${f.mappedLocation.column}\``
    : "";
  const snippet = f.mappedLocation?.codeContext
    ? `\n\n${fence(sanitizeSecrets(f.mappedLocation.codeContext), path.extname(f.mappedLocation.filePath).replace(".", "") || "ts")}`
    : "";
  const serverErr = f.serverError
    ? `\n**Server** ${escapeHtml(sanitizeSecrets(f.serverError.message))}` +
      (f.serverError.body
        ? `\n\n${fence(sanitizeSecrets(f.serverError.body.slice(0, SERVER_BODY_CAP)), "text")}`
        : "")
    : "";

  return `<details open>\n<summary><code>${escapeHtml(sev)}</code> — ${escapeHtml(first)}</summary>\n${loc}${snippet}${serverErr}${reproBlock(f)}${healBlock(f)}\n</details>`;
}

export function renderPrComment(targetUrl: string, findings: Finding[], opts: { repoRoot?: string } = {}): string {
  void opts;
  const sorted = [...findings].sort(
    (a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity)
  );

  const counts: Record<string, number> = { crash: 0, error: 0, warning: 0, noise: 0 };
  for (const f of sorted) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  const critical = (counts.crash ?? 0) + (counts.error ?? 0);
  const healed = sorted.filter((f) => f.heal?.status === "healed").length;
  const repros = sorted.filter((f) => f.repro?.specPath).length;
  const deterministic = sorted.filter((f) => f.repro?.verdict === "deterministic").length;

  const statusBadge = critical
    ? badge("aztrx", `${critical} critical`, "ff5a5f")
    : badge("aztrx", "clean", "43e58a");

  const summaryBadges = [
    statusBadge,
    repros ? badge("repro", `${deterministic}/${repros} deterministic`, deterministic === repros ? "43e58a" : "f5a623") : "",
    healed ? badge("heal", `${healed} patched`, "43e58a") : "",
  ]
    .filter(Boolean)
    .join("  ");

  const body = sorted.length
    ? sorted.map(findingBlock).join("\n\n")
    : "> No crash, error, or warning surfaced — the app survived this pass.";

  return `<!-- aztrx -->
## Aztrx AI — runtime stress-test

${summaryBadges}

**Target** \`${cleanInline(targetUrl)}\` · **${counts.crash ?? 0} crash** · **${counts.error ?? 0} error** · **${counts.warning ?? 0} warning**

---

${body}
`;
}

export function writePrComment(
  repoRoot: string,
  targetUrl: string,
  findings: Finding[],
  filePath?: string
): string {
  const file = filePath ?? path.join(repoRoot, ".aztrx", "pr-comment.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderPrComment(targetUrl, findings, { repoRoot }), "utf-8");
  return file;
}
