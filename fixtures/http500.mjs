import { createServer } from "http";

// Smoke fixture for `--http-fuzz`: a minimal app whose /api/data route 500s on
// a non-positive `id` query param — the exact class of server-side bug the HTTP
// mutation fuzzer hunts for. The root page links to and fetches /api/data so the
// fuzzer's endpoint harvester discovers it without blind probing.

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><body>
      <a href="/api/data">data</a>
      <script>fetch("/api/data")</script>
    </body></html>`);
    return;
  }

  if (url.pathname === "/api/data") {
    const id = url.searchParams.get("id");
    if (id !== null && Number(id) <= 0) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end('{"error":"invalid id"}');
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true}');
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

const port = Number(process.env.PORT || 8910);
server.listen(port, () => console.log(`serving http500 fixture on http://localhost:${port}`));
