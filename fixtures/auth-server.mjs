import { createServer } from "http";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";

const dir = fileURLToPath(new URL(".", import.meta.url));

const CREDENTIALS = { email: "test@example.com", password: "secret" };

function serve(res, file) {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(readFileSync(join(dir, file)));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const authed = (req.headers.cookie ?? "").includes("aztrx_session=1");

  if (req.method === "POST" && url.pathname === "/login") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const ok =
        params.get("email") === CREDENTIALS.email && params.get("password") === CREDENTIALS.password;
      if (ok) {
        res.writeHead(302, { "Set-Cookie": "aztrx_session=1; Path=/", Location: "/" });
      } else {
        res.writeHead(302, { Location: "/" });
      }
      res.end();
    });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/app") {
    serve(res, authed ? "app.html" : "login.html");
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(8902, () => console.log("serving auth fixtures on http://localhost:8902"));
