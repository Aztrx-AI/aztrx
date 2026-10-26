// Development fixture for the Karnezz interface smoke tests (bench/karnezz/smoke.ts).
// Usage: node notes-app.mjs <port> [--bug]   (--bug: the counter ignores deletions)
import http from "node:http";

const port = Number(process.argv[2] ?? 0);
const bug = process.argv.includes("--bug");
const notes = [];
let shown = 0;

const page = () => {
  const n = bug ? shown : notes.length;
  return `<!doctype html><title>Notes</title><h1>My notes</h1><p id="count">${n} notes</p>
<form method="post" action="/add"><label>Note text <input name="text"></label><button>Save note</button></form>
<ul>${notes.map((t, i) => `<li>${t} <form method="post" action="/delete?i=${i}" style="display:inline"><button>Delete</button></form></li>`).join("")}</ul>`;
};

http
  .createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && u.pathname === "/__reset") { notes.length = 0; shown = 0; return void res.writeHead(204).end(); }
      if (req.method === "POST" && u.pathname === "/add") {
        const t = new URLSearchParams(body).get("text")?.trim();
        if (t) { notes.push(t); shown++; }
      } else if (req.method === "POST" && u.pathname === "/delete") notes.splice(Number(u.searchParams.get("i")), 1);
      if (req.method === "POST") return void res.writeHead(303, { location: "/" }).end();
      res.writeHead(200, { "content-type": "text/html" }).end(page());
    });
  })
  .listen(port, "127.0.0.1", function () {
    console.log(`listening ${this.address().port}`);
  });
