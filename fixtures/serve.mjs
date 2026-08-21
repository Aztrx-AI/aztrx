import { createServer } from "http";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, normalize } from "path";

const dir = fileURLToPath(new URL(".", import.meta.url));

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const file = normalize(join(dir, url.pathname === "/" ? "crash.html" : url.pathname));
  if (!file.startsWith(dir)) {
    res.statusCode = 403;
    return res.end("forbidden");
  }
  try {
    res.setHeader("Content-Type", file.endsWith(".html") ? "text/html" : "text/plain");
    res.end(readFileSync(file));
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});

server.listen(8901, () => console.log("serving fixtures on http://localhost:8901"));
