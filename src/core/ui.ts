import type { ReproVerdict, Severity } from "./types.js";

// The single "crash seismograph" identity — shared by the HTML report, Local
// Studio, and (later) the cloud dashboard so they can't drift apart. Tokens
// mirror web/app/globals.css.
export const PALETTE = {
  bg: "#07090d",
  surface: "#0d1117",
  surface2: "#12161e",
  border: "#232a36",
  fg: "#e9edf4",
  muted: "#a6aebb",
  dim: "#5b6573",
  azure: "#4cc2ff",
  azureBright: "#8ad9ff",
  red: "#ff5a5f",
  amber: "#f5a623",
  green: "#43e58a",
} as const;

export const SEVERITY_COLOR: Record<Severity, string> = {
  crash: PALETTE.red,
  error: PALETTE.red,
  warning: PALETTE.amber,
  noise: PALETTE.dim,
};

export const REPRO_COLOR: Record<ReproVerdict, string> = {
  deterministic: PALETTE.green,
  flaky: PALETTE.amber,
  unreliable: PALETTE.red,
};

export const BASE_CSS = `
:root{color-scheme:dark;--bg:#07090d;--surface:#0d1117;--surface-2:#12161e;--border:#232a36;--fg:#e9edf4;--muted:#a6aebb;--dim:#5b6573;--azure:#4cc2ff;--azure-bright:#8ad9ff;--red:#ff5a5f;--amber:#f5a623;--green:#43e58a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.65 ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;background-image:linear-gradient(rgba(76,194,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(76,194,255,.035) 1px,transparent 1px);background-size:44px 44px}
main{max-width:920px;margin:0 auto;padding:40px 24px 80px}
.hero{margin-bottom:26px}
.hero svg{width:100%;height:64px;display:block}
.brand-row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-top:16px}
h1{margin:0;font-size:20px;font-weight:700;letter-spacing:.02em}
h1 .brand{color:var(--azure)}
h1 .brand-sub{color:var(--dim)}
.target{color:var(--dim);font-size:13px;margin-top:4px;word-break:break-all}
.live{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);margin-top:6px}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
.bar{display:flex;gap:10px;margin:0 0 24px;flex-wrap:wrap}
.count{font:600 13px/1 ui-monospace,monospace;border:1px solid var(--border);border-radius:8px;padding:7px 12px;color:var(--dim);background:var(--surface)}
.count b{color:var(--fg);font-weight:600}
.count b.crash{color:var(--red)}
.count b.error{color:var(--red)}
.count b.warning{color:var(--amber)}
.finding{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--sev,var(--azure));border-radius:10px;padding:16px 18px;margin-bottom:14px;animation:line-in .35s ease both}
.finding header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sev{font:600 11px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--sev);border:1px solid var(--sev);border-radius:999px;padding:3px 9px;flex:none}
h2{font-size:15px;margin:0;font-weight:600;word-break:break-word}
.loc{color:var(--dim);font-size:12.5px;margin-top:8px}
.snippet{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;overflow-x:auto;font:12px/1.6 ui-monospace,monospace;color:var(--muted);margin:12px 0 0;white-space:pre}
.occ{color:var(--dim);font-size:12px;margin-top:8px}
.repro{display:inline-flex;align-items:center;gap:8px;font-size:12px;margin-top:12px;padding:4px 10px;border-radius:6px;border:1px solid}
.repro.deterministic{color:var(--green);border-color:rgba(67,229,138,.35);background:rgba(67,229,138,.07)}
.repro.flaky{color:var(--amber);border-color:rgba(245,166,35,.35);background:rgba(245,166,35,.07)}
.repro.unreliable{color:var(--red);border-color:rgba(255,90,95,.35);background:rgba(255,90,95,.07)}
details{margin-top:12px;color:var(--dim);font-size:12.5px;border-top:1px solid var(--border);padding-top:10px}
summary{cursor:pointer;color:var(--muted)}
details ol{margin:8px 0 0;padding-left:22px;display:flex;flex-direction:column;gap:4px}
details code{color:var(--fg)}
.empty{color:var(--dim);border:1px dashed var(--border);border-radius:10px;padding:24px;text-align:center}
.foot{color:var(--dim);font-size:12.5px;margin-top:24px}
a{color:var(--azure)}
@keyframes line-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
`;

/**
 * The crash seismograph: an azure trace with one red spike per crash. The
 * spikes live inside `<g id="spikes">` so the Studio can append them live as
 * crashes stream in; the report pre-fills them.
 */
export function seismograph(crashes: number): string {
  const pts: string[] = [];
  for (let i = 0; i <= 400; i++) {
    const x = (i / 400) * 800;
    const y = 32 + Math.sin(i * 0.12) * 4 + Math.sin(i * 0.045) * 3 + Math.sin(i * 0.27) * 1.2;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }

  const spikes: string[] = [];
  const n = Math.max(0, Math.min(crashes, 8));
  for (let k = 0; k < n; k++) {
    const x = 80 + ((k + 0.5) / n) * 640;
    spikes.push(
      `<path d="M ${x.toFixed(1)} 32 L ${x.toFixed(1)} 12" stroke="${PALETTE.red}" stroke-width="2" stroke-linecap="round" fill="none" style="filter:drop-shadow(0 0 4px ${PALETTE.red})"/>`
    );
  }

  return `<svg viewBox="0 0 800 64" preserveAspectRatio="none" role="img" aria-label="crash seismograph">
    <line x1="0" y1="32" x2="800" y2="32" stroke="${PALETTE.azure}" stroke-opacity="0.14" stroke-width="1"/>
    <polyline points="${pts.join(" ")}" fill="none" stroke="${PALETTE.azure}" stroke-opacity="0.5" stroke-width="1.5"/>
    <g id="spikes">${spikes.join("")}</g>
  </svg>`;
}
