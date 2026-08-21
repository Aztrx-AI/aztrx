import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import pc from "picocolors";

export interface StudioOptions {
  repoRoot: string;
  port?: number;
}

const SEV_COLOR: Record<string, string> = {
  crash: "#e5484d",
  error: "#e5484d",
  warning: "#f5a623",
  noise: "#8b8d98",
};

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
    "Access-Control-Allow-Origin": "*",
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

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aztrx Studio</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --fg:#e6e8ee; --dim:#8b8d98; --card:#171a21; --border:#262b36; --accent:#4cc2ff; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:860px; margin:0 auto; padding:32px 24px 64px; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:16px; flex-wrap:wrap; }
  h1 { font-size:20px; margin:0; }
  h1 .dot { color:var(--accent); }
  .target { color:var(--dim); font-size:13px; }
  .bar { display:flex; gap:10px; margin:20px 0; }
  .count { font:600 13px/1 ui-monospace,monospace; border:1px solid var(--border); border-radius:8px; padding:6px 12px; color:var(--dim); }
  .count b { color:var(--fg); }
  .finding { background:var(--card); border:1px solid var(--border); border-left:3px solid var(--sev,#4cc2ff); border-radius:8px; padding:12px 16px; margin-bottom:12px; }
  .finding header { display:flex; align-items:baseline; gap:10px; }
  .sev { font:600 11px/1 ui-monospace,monospace; text-transform:uppercase; letter-spacing:.06em; color:var(--sev); border:1px solid var(--sev); border-radius:999px; padding:2px 8px; }
  h2 { font-size:15px; margin:0; }
  .loc { color:var(--dim); font:13px ui-monospace,monospace; margin-top:6px; }
  .empty { color:var(--dim); }
  .foot { color:var(--dim); font-size:13px; margin-top:20px; }
  a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <header>
    <h1><span class="dot">●</span> Aztrx Studio</h1>
    <span class="target" id="target">waiting for a run…</span>
  </header>
  <div class="bar">
    <span class="count">crash <b id="c-crash">0</b></span>
    <span class="count">error <b id="c-error">0</b></span>
    <span class="count">warning <b id="c-warning">0</b></span>
  </div>
  <div id="list"><p class="empty">Run <code>aztrx &lt;url&gt; --repo .</code> to stream findings here live.</p></div>
  <p class="foot">Full report: <a href="/report">.aztrx/report.html</a></p>
</main>
<script>
  const list = document.getElementById("list");
  const target = document.getElementById("target");
  const counts = { crash: 0, error: 0, warning: 0 };
  const sevColor = ${JSON.stringify(SEV_COLOR)};
  let first = true;

  const es = new EventSource("/events");
  es.onmessage = (e) => {
    const evt = JSON.parse(e.data);
    if (evt.type === "run_start") {
      target.textContent = evt.url;
      list.innerHTML = "";
      first = true;
      counts.crash = counts.error = counts.warning = 0;
    } else if (evt.type === "finding") {
      const f = evt.finding;
      if (counts[f.severity] !== undefined) counts[f.severity]++;
      for (const k in counts) document.getElementById("c-" + k).textContent = counts[k];
      const el = document.createElement("article");
      el.className = "finding";
      el.style.setProperty("--sev", sevColor[f.severity] || "#4cc2ff");
      const h = document.createElement("header");
      h.innerHTML = \`<span class="sev">\${f.severity}</span><h2></h2>\`;
      h.querySelector("h2").textContent = f.rawMessage.split("\\n")[0];
      el.appendChild(h);
      if (f.mappedLocation) {
        const loc = document.createElement("div");
        loc.className = "loc";
        loc.textContent = \`\${f.mappedLocation.filePath}:\${f.mappedLocation.line}:\${f.mappedLocation.column}\`;
        el.appendChild(loc);
      }
      if (first) { list.innerHTML = ""; first = false; }
      list.insertBefore(el, list.firstChild);
    }
  };
</script>
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

  server.listen(port, () => {
    console.log(pc.cyan("\n⚡ Aztrx Studio"));
    console.log(pc.dim(`   → http://localhost:${port}`));
    console.log(pc.dim(`   watching ${path.relative(process.cwd(), eventsFile)}`));
    console.log(pc.dim("   Ctrl+C to stop\n"));
  });

  return server;
}
