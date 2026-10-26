// usage: node container.mjs <image> <name> <hostPort>   -> (re)creates a fresh container and waits until it serves
import { execFileSync } from "node:child_process";
const [image, name, port] = process.argv.slice(2);
try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); } catch {}
execFileSync("docker", ["run", "-d", "--name", name, "-p", `127.0.0.1:${port}:5005`, image], { stdio: "ignore" });
const t0 = Date.now();
for (;;) {
  try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.ok) break; } catch {}
  if (Date.now() - t0 > 60000) { console.error("container did not come up"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`up ${name} :${port} in ${Date.now() - t0}ms`);
