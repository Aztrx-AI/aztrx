import * as fs from "fs";
import * as path from "path";
import type { Finding } from "./types.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SEV_ORDER = ["crash", "error", "warning", "noise"] as const;
const SEV_COLOR: Record<string, string> = {
  crash: "#e5484d",
  error: "#e5484d",
  warning: "#f5a623",
  noise: "#8b8d98",
};

/**
 * F-report — standalone offline HTML report. Self-contained (inline CSS, no
 * CDN), renders every finding with its source snippet, severity, repro verdict
 * and action history. This is the first "app-shaped" surface of the product.
 */
export function renderReport(targetUrl: string, findings: Finding[]): string {
  const sorted = [...findings].sort(
    (a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity)
  );

  const cards = sorted
    .map((f) => {
      const loc = f.mappedLocation
        ? `${escapeHtml(f.mappedLocation.filePath)}:${f.mappedLocation.line}:${f.mappedLocation.column}`
        : "";
      const snippet = f.mappedLocation ? escapeHtml(f.mappedLocation.codeContext) : "";
      const repro = f.repro
        ? `<div class="repro ${f.repro.verdict}">${f.repro.verdict} · ${f.repro.reproductions}/${f.repro.runs} runs · ${f.repro.actions.length} step(s) · <code>${escapeHtml(path.basename(f.repro.specPath))}</code></div>`
        : "";
      const steps = f.actionHistory.length
        ? `<details><summary>action history (${f.actionHistory.length})</summary><ol>${f.actionHistory
            .map((a) => `<li><code>${escapeHtml(a.type)}</code> ${escapeHtml(a.selectors[0] ?? "")}</li>`)
            .join("")}</ol></details>`
        : "";
      return `
    <article class="finding">
      <header>
        <span class="sev" style="--sev:${SEV_COLOR[f.severity]}">${escapeHtml(f.severity)}</span>
        <h2>${escapeHtml(f.rawMessage.split("\n")[0])}</h2>
      </header>
      ${loc ? `<div class="loc">${loc}</div>` : ""}
      ${snippet ? `<pre class="snippet">${snippet}</pre>` : ""}
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
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --fg:#e6e8ee; --dim:#8b8d98; --card:#171a21; --border:#262b36; --accent:#4cc2ff; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:900px; margin:0 auto; padding:32px 24px 64px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .meta { color:var(--dim); font-size:13px; margin-bottom:24px; }
  .finding { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin-bottom:16px; }
  .finding header { display:flex; align-items:baseline; gap:10px; }
  .sev { font:600 11px/1 ui-monospace,monospace; text-transform:uppercase; letter-spacing:.06em; color:var(--sev); border:1px solid var(--sev); border-radius:999px; padding:3px 8px; }
  h2 { font-size:15px; margin:0; }
  .loc { color:var(--dim); font:13px ui-monospace,monospace; margin-top:8px; }
  .snippet { background:#0a0c10; border:1px solid var(--border); border-radius:8px; padding:12px; overflow-x:auto; font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:#d7dae2; margin:12px 0 0; }
  .occ { color:var(--dim); font-size:12px; margin-top:8px; }
  .repro { display:inline-block; font-size:12px; margin-top:12px; padding:4px 10px; border-radius:6px; }
  .repro.deterministic { color:#4ade80; background:rgba(74,222,128,.08); }
  .repro.flaky { color:#f5a623; background:rgba(245,166,35,.08); }
  .repro.unreliable { color:#e5484d; background:rgba(229,72,77,.08); }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  details { margin-top:12px; color:var(--dim); font-size:13px; }
  details ol { margin:8px 0 0; padding-left:20px; }
  .empty { color:var(--dim); }
</style>
</head>
<body>
<main>
  <h1>aztrx report</h1>
  <div class="meta">${escapeHtml(targetUrl)}</div>
  ${sorted.length ? cards : `<p class="empty">No findings.</p>`}
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
