import { createServer } from "http";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from "fs";
import { join, normalize } from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { run } from "../dist/core/orchestrator.js";
import type { Finding } from "../dist/core/types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CASES_DIR = join(HERE, "cases");
const OUT_DIR = join(HERE, ".out");

interface SeededBug {
  id: string;
  severity: "crash" | "error" | "warning";
  type: string;
  /** Substring matched against `Finding.rawMessage`. */
  message: string;
  trigger: string;
}
interface Manifest {
  id: string;
  name: string;
  archetype: string;
  framework: string;
  seeded: SeededBug[];
}

const args = process.argv.slice(2);
const OPT = {
  repro: args.includes("--repro"),
  seed: Number(args[args.indexOf("--seed") + 1] ?? 42),
  maxActions: Number(args[args.indexOf("--max-actions") + 1] ?? 80),
};

function serve(root: string, port: number): Promise<() => void> {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".css": "text/css",
    ".svg": "image/svg+xml",
  };
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let p = normalize(join(root, pathname));
    if (!p.startsWith(root)) {
      res.statusCode = 403;
      return res.end("forbidden");
    }
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
    try {
      const body = readFileSync(p);
      const ext = p.slice(p.lastIndexOf("."));
      res.setHeader("Content-Type", types[ext] ?? "text/plain");
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(() => server.close())));
}

const match = (msg: string, needle: string) => msg.toLowerCase().includes(needle.toLowerCase());

async function main() {
  const ids = readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  mkdirSync(OUT_DIR, { recursive: true });

  const port = 8910;
  const close = await serve(CASES_DIR, port);

  const rows: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const manifest: Manifest = JSON.parse(readFileSync(join(CASES_DIR, id, "manifest.json"), "utf8"));
    const url = `http://localhost:${port}/${id}/index.html`;
    console.log(`\n${pc.cyan("▶")} ${manifest.name} ${pc.dim(`(${id})`)}`);

    const findings: Finding[] = await run({
      url,
      repoRoot: join(OUT_DIR, id),
      fuzz: true,
      seed: OPT.seed,
      maxActions: OPT.maxActions,
      repro: OPT.repro,
      ui: true, // silence the orchestrator's own logging
    });

    const found: Array<{ bug: SeededBug; finding: Finding }> = [];
    const missed: SeededBug[] = [];
    for (const bug of manifest.seeded) {
      const f = findings.find((x) => match(x.rawMessage, bug.message));
      if (f) found.push({ bug, finding: f });
      else missed.push(bug);
    }
    const falsePos = findings.filter((f) => !manifest.seeded.some((b) => match(f.rawMessage, b.message)));

    rows.push({
      id,
      name: manifest.name,
      archetype: manifest.archetype,
      seeded: manifest.seeded.length,
      found: found.length,
      missed: missed.map((b) => b.id),
      falsePositives: falsePos.length,
      falsePosMessages: falsePos.map((f) => f.rawMessage.split("\n")[0].slice(0, 90)),
    });

    const ok = missed.length === 0;
    console.log(
      `   ${ok ? pc.green("✓") : pc.red("✗")} detected ${found.length}/${manifest.seeded.length}` +
        (falsePos.length ? pc.yellow(`  · ${falsePos.length} extra`) : "")
    );
  }

  close();

  const seeded = rows.reduce((s, r) => s + (r.seeded as number), 0);
  const found = rows.reduce((s, r) => s + (r.found as number), 0);
  const fp = rows.reduce((s, r) => s + (r.falsePositives as number), 0);
  const rate = seeded ? (found / seeded) * 100 : 0;

  writeFileSync(
    join(OUT_DIR, "results.json"),
    JSON.stringify({ totals: { seeded, found, rate: +rate.toFixed(1), falsePositives: fp }, cases: rows }, null, 2)
  );

  console.log("\n" + "═".repeat(58));
  console.log(pc.bold(`Detection  ${found}/${seeded}  (${rate.toFixed(1)}%)`) + pc.dim(`   ·   ${fp} false positive(s)`));
  console.log("═".repeat(58));
  for (const r of rows) {
    console.log(
      `  ${(r.missed as string[]).length ? pc.red("✗") : pc.green("✓")} ${(r.id as string).padEnd(24)} ${r.found}/${r.seeded}` +
        (r.falsePositives ? pc.yellow(`   +${r.falsePositives} fp`) : "")
    );
    for (const m of r.missed as string[]) console.log(pc.red(`      missed  ${m}`));
    for (const m of r.falsePosMessages as string[]) console.log(pc.dim(`      extra   ${m}`));
  }
  console.log("");
}

main();
