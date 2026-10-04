/**
 * AztrxBench security v0 — the crash benches (`bench/`, `bench/frameworks/`)
 * only score runtime-crash recall. This corpus scores the swarm's other job:
 * proving a business-logic/security hypothesis end to end. Three cases,
 * deliberately: one good case beats ten unfinished ones, and each case here
 * has exactly one seeded bug with an unambiguous oracle.
 *
 * aztrx gets nothing but the URL — the manifest's `known_exploit_path` is
 * ground truth for scoring, never fed to the run.
 */
import { createServer } from "http";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from "fs";
import { join, normalize } from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { run } from "../../dist/core/orchestrator.js";
import { ROLE_CATALOG } from "../../dist/core/roles.js";
import type { Finding } from "../../dist/core/types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CASES_DIR = join(HERE, "cases");
const OUT_DIR = join(HERE, ".out");
const ALL_ROLES = ROLE_CATALOG.map((r: { id: string }) => r.id);

interface SeededBug {
  id: string;
  category: string;
  /** Substring matched against `Finding.rawMessage`. */
  message: string;
}
interface Manifest {
  id: string;
  name: string;
  category: string;
  expected_invariant: string;
  known_exploit_path: string;
  expected_role: string | null;
  seeded: SeededBug[];
}

const args = process.argv.slice(2);
const arg = (name: string, fallback: number): number => {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) {
    const n = Number(args[i + 1]);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
};
const OPT = { seed: arg("--seed", 42), maxActions: arg("--max-actions", 80) };

function serve(root: string, port: number): Promise<() => void> {
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8" };
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

/** The mission-level episode verdict for the role that was actually meant to
 * catch this case — a cheap cross-check against the finding-based score,
 * reusing F11 episode logging instead of adding new instrumentation. */
function episodeVerdictFor(repoRoot: string, roleId: string | null): string | null {
  if (!roleId) return null;
  const file = join(repoRoot, ".aztrx", "telemetry", "episodes.jsonl");
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.role_id === roleId) return rec.verdict;
    } catch {
      // skip a malformed line rather than fail the whole bench run
    }
  }
  return null;
}

async function main() {
  const ids = readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  mkdirSync(OUT_DIR, { recursive: true });

  const port = 8911;
  const close = await serve(CASES_DIR, port);

  const rows: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const manifest: Manifest = JSON.parse(readFileSync(join(CASES_DIR, id, "manifest.json"), "utf8"));
    const url = `http://localhost:${port}/${id}/index.html`;
    const repoRoot = join(OUT_DIR, id);
    console.log(`\n${pc.cyan("▶")} ${manifest.name} ${pc.dim(`(${id})`)}`);

    const startedAt = Date.now();
    const findings: Finding[] = await run({
      url,
      repoRoot,
      roles: ALL_ROLES,
      seed: OPT.seed,
      maxActions: OPT.maxActions,
      telemetry: true, // dogfood F11 episode logging — see episodeVerdictFor
      ui: true,
    });
    const durationMs = Date.now() - startedAt;

    const found: Array<{ bug: SeededBug; finding: Finding }> = [];
    const missed: SeededBug[] = [];
    for (const bug of manifest.seeded) {
      const f = findings.find((x) => match(x.rawMessage, bug.message));
      if (f) found.push({ bug, finding: f });
      else missed.push(bug);
    }
    const falsePos = findings.filter((f) => !manifest.seeded.some((b) => match(f.rawMessage, b.message)));
    const episodeVerdict = episodeVerdictFor(repoRoot, manifest.expected_role);

    rows.push({
      id,
      name: manifest.name,
      category: manifest.category,
      seeded: manifest.seeded.length,
      found: found.length,
      missed: missed.map((b) => b.id),
      falsePositives: falsePos.length,
      falsePosMessages: falsePos.map((f) => f.rawMessage.split("\n")[0].slice(0, 90)),
      durationMs,
      expectedRole: manifest.expected_role,
      episodeVerdict,
    });

    const ok = missed.length === 0;
    console.log(
      `   ${ok ? pc.green("✓") : pc.red("✗")} found ${found.length}/${manifest.seeded.length}` +
        (falsePos.length ? pc.yellow(`  · ${falsePos.length} extra`) : "") +
        (episodeVerdict ? pc.dim(`  · episode: ${episodeVerdict}`) : "")
    );
  }

  close();

  const seeded = rows.reduce((s, r) => s + (r.seeded as number), 0);
  const found = rows.reduce((s, r) => s + (r.found as number), 0);
  const fp = rows.reduce((s, r) => s + (r.falsePositives as number), 0);
  const rate = seeded ? (found / seeded) * 100 : 0;
  const medianMs = [...rows].map((r) => r.durationMs as number).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0;

  writeFileSync(
    join(OUT_DIR, "results.json"),
    JSON.stringify(
      {
        totals: { seeded, found, rate: +rate.toFixed(1), falsePositives: fp, medianDurationMs: medianMs },
        cases: rows,
      },
      null,
      2
    )
  );

  console.log("\n" + "═".repeat(58));
  console.log(
    pc.bold(`Found      ${found}/${seeded}  (${rate.toFixed(1)}%)`) + pc.dim(`   ·   ${fp} false positive(s)`)
  );
  console.log(pc.dim(`Median mission time: ${(medianMs / 1000).toFixed(1)}s`));
  console.log("═".repeat(58));
  for (const r of rows) {
    console.log(
      `  ${(r.missed as string[]).length ? pc.red("✗") : pc.green("✓")} ${(r.id as string).padEnd(22)} ${r.found}/${r.seeded}` +
        pc.dim(`  [${r.category}]`) +
        (r.falsePositives ? pc.yellow(`   +${r.falsePositives} fp`) : "")
    );
  }
  console.log("");
}

main();
