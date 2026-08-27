import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import pc from "picocolors";
import { BASE_CSS, SEVERITY_COLOR, seismograph } from "./ui.js";

export interface StudioOptions {
  repoRoot: string;
  port?: number;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function send(res: http.ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function sendFile(res: http.ServerResponse, filePath: string, contentType: string): void {
  try {
    const body = fs.readFileSync(filePath, "utf-8");
    send(res, 200, contentType, body);
  } catch {
    send(res, 404, "text/plain; charset=utf-8", "not found");
  }
}

/**
 * SSE tail of the run log. Replays the current log from byte 0 (so a studio
 * opened after a run still shows its history), then pushes new lines as they
 * land, every 500ms.
 */
function sseHandler(req: http.IncomingMessage, res: http.ServerResponse, eventsFile: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);

  let offset = 0;
  let closed = false;
  const tick = (): void => {
    if (closed) return;
    let text = "";
    try {
      text = fs.readFileSync(eventsFile, "utf-8");
    } catch {
      text = "";
    }
    if (text.length > offset) {
      const chunk = text.slice(offset);
      offset = text.length;
      for (const line of chunk.split("\n")) {
        if (line.trim()) res.write(`data: ${line}\n\n`);
      }
    }
  };

  const timer = setInterval(tick, 500);
  tick();
  req.on("close", () => {
    closed = true;
    clearInterval(timer);
  });
}

function dashboardScript(): string {
  return `const list = document.getElementById("list");
const target = document.getElementById("target");
const foot = document.getElementById("foot");
const spikes = document.getElementById("spikes");
const counts = { crash: 0, error: 0, warning: 0 };
const sevColor = ${JSON.stringify(SEVERITY_COLOR)};
const byFingerprint = new Map();
const pendingRepro = new Map();
let first = true;

function setCount(k, v) {
  counts[k] = v;
  const b = document.getElementById("c-" + k);
  if (b) b.textContent = String(v);
}

function addSpike() {
  if (!spikes) return;
  const n = spikes.children.length + 1;
  const x = 80 + (((n - 1) % 8) + 0.5) / 8 * 640;
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M " + x.toFixed(1) + " 32 L " + x.toFixed(1) + " 12");
  p.setAttribute("stroke", "#ff5a5f");
  p.setAttribute("stroke-width", "2");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("fill", "none");
  p.setAttribute("style", "filter:drop-shadow(0 0 4px #ff5a5f)");
  spikes.appendChild(p);
}

function applyRepro(fp, r) {
  const card = byFingerprint.get(fp);
  if (!card) { pendingRepro.set(fp, r); return; }
  let el = card.querySelector(".repro");
  if (!el) {
    el = document.createElement("div");
    card.appendChild(el);
  }
  el.className = "repro " + r.verdict;
  el.textContent = r.verdict + " · " + r.reproductions + "/" + r.runs + " runs · spec " + r.specPath;
}

function addFinding(f) {
  if (counts[f.severity] !== undefined) setCount(f.severity, counts[f.severity] + 1);
  if (f.severity === "crash") addSpike();

  const card = document.createElement("article");
  card.className = "finding";
  card.style.setProperty("--sev", sevColor[f.severity] || "#4cc2ff");

  const header = document.createElement("header");
  const chip = document.createElement("span");
  chip.className = "sev";
  chip.textContent = f.severity;
  const h2 = document.createElement("h2");
  h2.textContent = f.rawMessage.split("\\n")[0];
  header.appendChild(chip);
  header.appendChild(h2);
  card.appendChild(header);

  if (f.mappedLocation) {
    const loc = document.createElement("div");
    loc.className = "loc";
    loc.textContent = f.mappedLocation.filePath + ":" + f.mappedLocation.line + ":" + f.mappedLocation.column;
    card.appendChild(loc);
  }

  byFingerprint.set(f.fingerprint, card);
  if (pendingRepro.has(f.fingerprint)) {
    applyRepro(f.fingerprint, pendingRepro.get(f.fingerprint));
    pendingRepro.delete(f.fingerprint);
  }

  if (first) { list.innerHTML = ""; first = false; }
  list.insertBefore(card, list.firstChild);
}

const es = new EventSource("/events");
es.onmessage = (e) => {
  const evt = JSON.parse(e.data);
  if (evt.type === "run_start") {
    target.textContent = evt.url;
    list.innerHTML = "";
    foot.textContent = "";
    byFingerprint.clear();
    pendingRepro.clear();
    first = true;
    setCount("crash", 0); setCount("error", 0); setCount("warning", 0);
    while (spikes && spikes.firstChild) spikes.removeChild(spikes.firstChild);
  } else if (evt.type === "finding") {
    addFinding(evt.finding);
  } else if (evt.type === "repro") {
    applyRepro(evt.fingerprint, evt);
  } else if (evt.type === "run_end") {
    const c = evt.counts || {};
    foot.textContent = "run complete — " + (c.crash || 0) + " crash · " + (c.error || 0) + " error · " + (c.warning || 0) + " warning";
  }
};`;
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aztrx AI Studio</title>
<style>${BASE_CSS}</style>
</head>
<body>
<main>
  <div class="hero">
    ${seismograph(0)}
    <div class="brand-row">
      <h1><span class="brand">aztrx</span> <span class="brand-sub">studio</span></h1>
    </div>
    <div class="target" id="target">waiting for a run…</div>
    <div class="live"><span class="live-dot"></span> streaming .aztrx/events.jsonl</div>
  </div>
  <div class="bar">
    <span class="count">crash <b class="crash" id="c-crash">0</b></span>
    <span class="count">error <b class="error" id="c-error">0</b></span>
    <span class="count">warning <b class="warning" id="c-warning">0</b></span>
  </div>
  <div id="list"><p class="empty">Run <code>aztrx &lt;url&gt; --repo .</code> to stream findings here live.</p></div>
  <p class="foot" id="foot"></p>
  <p class="foot">Full report: <a href="/report">.aztrx/report.html</a></p>
</main>
<script>${dashboardScript()}</script>
</body>
</html>`;
}

export function startStudio(opts: StudioOptions): http.Server {
  const repoRoot = path.resolve(opts.repoRoot);
  const port = opts.port ?? 7331;
  const aztrxDir = path.join(repoRoot, ".aztrx");
  const eventsFile = path.join(aztrxDir, "events.jsonl");

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/events") return sseHandler(req, res, eventsFile);
    if (url === "/" || url === "/index.html") return send(res, 200, "text/html; charset=utf-8", dashboardHtml());
    if (url === "/report" || url === "/report.html")
      return sendFile(res, path.join(aztrxDir, "report.html"), "text/html; charset=utf-8");
    if (url.startsWith("/repro/"))
      return sendFile(res, path.join(aztrxDir, "repro", path.basename(url)), "text/plain; charset=utf-8");
    return send(res, 404, "text/plain; charset=utf-8", "not found");
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(pc.cyan("\nAztrx AI Studio"));
    console.log(pc.dim(`   → http://localhost:${port}`));
    console.log(pc.dim(`   watching ${path.relative(process.cwd(), eventsFile)}`));
    console.log(pc.dim("   Ctrl+C to stop\n"));
  });

  return server;
}
