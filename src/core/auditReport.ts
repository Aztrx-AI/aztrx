/**
 * The audit report — the four-block answer the spec demands:
 *
 *   [Статус Роя]     what the agents did, in one line
 *   [Находка]        the bug in business language (what happens if unfixed)
 *   [Доказательство] a curl command or the exact steps that break it
 *   [Патч]           the diff, or the one command that produces it
 *
 * Used by the MCP `aztrx_audit` tool (and available to the CLI's `--json`
 * consumers). Concise by design — the developer gets a decision, not a log.
 */

import type { Finding, RecordedAction } from "./types.js";
import type { RoleStat } from "./swarm.js";

export interface AuditStats {
  totalActions: number;
  workerCount: number;
  roleStats: RoleStat[];
  routes?: number;
}

type Lang = "en" | "ru";

const LABELS: Record<Lang, { swarm: string; finding: string; proof: string; patch: string }> = {
  en: { swarm: "Swarm status", finding: "Finding", proof: "Proof", patch: "Patch" },
  ru: { swarm: "Статус роя", finding: "Находка", proof: "Доказательство", patch: "Патч" },
};

/** The exact curl a human can run to re-break the server (HTTP findings only). */
function curlFor(f: Finding): string | null {
  const req = [...f.actionHistory].reverse().find((a) => a.type === "request" && a.request)?.request;
  if (!req) return null;
  const headers = Object.entries(req.headers ?? {})
    .map(([k, v]) => `-H '${k}: ${v.replace(/'/g, "'\\''")}'`)
    .join(" ");
  const body = req.body ? ` -d '${req.body.replace(/'/g, "'\\''")}'` : "";
  return `curl -X ${req.method}${body} ${headers} '${req.url}'`;
}

/** The human-readable steps for browser findings (from the recorded trace). */
function stepsFor(f: Finding): string | null {
  const steps = f.actionHistory
    .slice(0, 6)
    .map((a: RecordedAction) => {
      switch (a.type) {
        case "navigate":
          return `open ${a.value}`;
        case "click":
          return `click ${a.selectors[0] ?? "the element"}`;
        case "input":
          return `type ${JSON.stringify(a.value ?? "")} into ${a.selectors[0] ?? "the field"}`;
        case "keypress":
          return `press ${a.value ?? "Enter"}`;
        case "request":
          return `send ${a.request?.method ?? "GET"} ${a.request?.url ?? ""}`;
        default:
          return null;
      }
    })
    .filter((s): s is string => Boolean(s));
  if (steps.length === 0) return null;
  return steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
}

/** The patch block: a diff when healing already produced one, otherwise the
 * single command that generates it. Never a patch that wasn't verified. */
function patchFor(f: Finding, lang: Lang): string {
  if (f.heal && f.heal.status === "healed" && f.heal.hunks.length > 0) {
    const diff = f.heal.hunks
      .map((h) => `--- ${f.heal!.filePath}\n-${h.search}\n+${h.replace}`)
      .join("\n");
    return `${lang === "ru" ? "Проверенный патч (прошёл тесты):" : "Verified patch (passed your tests):"}\n${diff}`;
  }
  if (f.heal?.status === "healed" && f.heal.hunks.length === 0) {
    return lang === "ru"
      ? "Патч не потребовался — проблема ушла сама (или была в тестовом окружении)."
      : "No patch needed — the issue resolved itself (or was test-env only).";
  }
  return lang === "ru"
    ? `Готово к фиксу — я сгенерирую и проверю патч по одному нажатию (aztrx_fix).`
    : `Ready to fix — I'll generate and verify the patch in one step (aztrx_fix).`;
}

/** Assemble the four-block audit report for a set of findings. */
export function formatAuditReport(findings: Finding[], stats: AuditStats, lang: string = "ru"): string {
  const l = LABELS[lang === "en" ? "en" : "ru"];
  const lines: string[] = [];

  const rolesDone = stats.roleStats.length > 0 ? stats.roleStats.length : stats.workerCount;
  const swarmLine =
    lang === "ru"
      ? `Проверено ${stats.routes ?? "все"} маршрут(ы), ${stats.totalActions} симуляций, ${rolesDone} ролей. Подтверждено: ${findings.length}.`
      : `Checked ${stats.routes ?? "all"} route(s), ${stats.totalActions} simulations, ${rolesDone} roles. Confirmed: ${findings.length}.`;
  lines.push(`**[${l.swarm}]** ${swarmLine}`);

  for (const f of findings.slice(0, 5)) {
    lines.push("");
    lines.push(`**[${l.finding}]** ${f.businessRisk ?? f.rawMessage.split("\n")[0]}`);
    if (f.mappedLocation) {
      lines.push(`_${f.mappedLocation.filePath}:${f.mappedLocation.line}_`);
    }
    const proof = curlFor(f) ?? stepsFor(f);
    if (proof) lines.push(`**[${l.proof}]**\n\`\`\`\n${proof}\n\`\`\``);
    lines.push(`**[${l.patch}]** ${patchFor(f, lang === "en" ? "en" : "ru")}`);
  }

  if (findings.length === 0) {
    lines.push("");
    lines.push(lang === "ru" ? "Рой не нашёл ничего, что можно сломать. Пока." : "The swarm found nothing breakable. Yet.");
  }
  if (findings.length > 5) {
    lines.push("");
    lines.push(lang === "ru" ? `…и ещё ${findings.length - 5} в отчёте.` : `…and ${findings.length - 5} more in the report.`);
  }

  return lines.join("\n");
}
