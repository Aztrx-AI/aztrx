import * as fs from "fs";
import * as path from "path";
import type { Finding } from "./types.js";
import { BASE_CSS, SEVERITY_COLOR, seismograph } from "./ui.js";
import { sanitizeSecrets } from "./heal/redact.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** HTML-escape AND scrub secrets — the report renders untrusted stack/snippet
 * text, so a secret that survives into it must not reach the file. */
function clean(s: string): string {
  return escapeHtml(sanitizeSecrets(s));
}

const SEV_ORDER = ["crash", "error", "warning", "noise"] as const;

/**
 * F-report — standalone offline HTML report. Self-contained (inline CSS, no
 * CDN), rendered in the shared "crash seismograph" identity: one red spike per
 * crash, severity chips, and colored repro verdicts.
 */
export function renderReport(targetUrl: string, findings: Finding[]): string {
  const sorted = [...findings].sort(
    (a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity)
  );

  const counts: Record<string, number> = { crash: 0, error: 0, warning: 0 };
  for (const f of sorted) if (counts[f.severity] !== undefined) counts[f.severity]++;

  const cards = sorted
    .map((f) => {
      const loc = f.mappedLocation
        ? `${clean(f.mappedLocation.filePath)}:${f.mappedLocation.line}:${f.mappedLocation.column}`
        : "";
      const snippet = f.mappedLocation ? clean(f.mappedLocation.codeContext) : "";
      const serverErr = f.serverError
        ? `<div class="server">server: ${clean(f.serverError.message)}</div>` +
          (f.serverError.body
            ? `<pre class="server-body">${clean(f.serverError.body)}</pre>`
            : "")
        : "";
      const repro = f.repro
        ? `<div class="repro ${f.repro.verdict}">${f.repro.verdict} · ${f.repro.reproductions}/${f.repro.runs} runs · ${f.repro.actions.length} step(s) · <code>${escapeHtml(path.basename(f.repro.specPath))}</code></div>`
        : "";
      const steps = f.actionHistory.length
        ? `<details><summary>action history (${f.actionHistory.length})</summary><ol>${f.actionHistory
            .map((a) => {
              const detail = a.value ? ` <span>${clean(a.value)}</span>` : "";
              const sel = a.selectors[0] ? ` ${clean(a.selectors[0])}` : "";
              return `<li><code>${escapeHtml(a.type)}${detail}</code>${sel}</li>`;
            })
            .join("")}</ol></details>`
        : "";
      return `
    <article class="finding">
      <header>
        <span class="sev" style="--sev:${SEVERITY_COLOR[f.severity]}">${escapeHtml(f.severity)}</span>
        <h2>${clean(f.rawMessage.split("\n")[0])}</h2>
      </header>
      ${loc ? `<div class="loc">${loc}</div>` : ""}
      ${snippet ? `<pre class="snippet">${snippet}</pre>` : ""}
      ${serverErr}
      ${f.occurrences > 1 ? `<div class="occ">seen ×${f.occurrences}</div>` : ""}
      ${repro}
      ${steps}
    </article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aztrx report</title>
<style>${BASE_CSS}</style>
</head>
<body>
<main>
  <div class="hero">
    ${seismograph(counts.crash ?? 0)}
    <div class="brand-row">
      <h1><span class="brand">aztrx</span> <span class="brand-sub">report</span></h1>
    </div>
    <div class="target">${clean(targetUrl)}</div>
  </div>
  <div class="bar">
    <span class="count">crash <b class="crash">${counts.crash ?? 0}</b></span>
    <span class="count">error <b class="error">${counts.error ?? 0}</b></span>
    <span class="count">warning <b class="warning">${counts.warning ?? 0}</b></span>
  </div>
  ${sorted.length ? cards : `<p class="empty">No findings — the app survived this pass.</p>`}
</main>
</body>
</html>`;
}

export function writeReport(repoRoot: string, targetUrl: string, findings: Finding[]): string {
  const dir = path.join(repoRoot, ".aztrx");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "report.html");
  fs.writeFileSync(file, renderReport(targetUrl, findings), "utf-8");
  return file;
}
