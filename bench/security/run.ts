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
import { join, normalize, dirname, basename, extname } from "path";
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

interface OwnershipGuard {
  param: string;
  cookie: string;
  owners: Record<string, string>;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * A minimal, declarative "server" for cases that need a real per-id
 * difference or a real ownership check — the detector must see an actual
 * difference across requests, not a client-rendered illusion of one.
 *
 * `?id=N` against `name.ext` first tries `name.id-N.ext` next to it — the id
 * resolves server-side, the way a real backend would. A `guard.json` next to
 * the file ({param, cookie, owners}) additionally enforces that the request's
 * `cookie` matches `owners[id]` before serving the variant — a 403 otherwise.
 * This lives only in the bench harness; `security.ts` knows nothing about it.
 */
function serve(root: string, port: number): Promise<() => void> {
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8" };
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://x");
    const pathname = decodeURIComponent(reqUrl.pathname);
    let p = normalize(join(root, pathname));
    if (!p.startsWith(root)) {
      res.statusCode = 403;
      return res.end("forbidden");
    }
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");

    const id = reqUrl.searchParams.get("id");
    if (id && /^[\w-]+$/.test(id) && existsSync(p)) {
      const dir = dirname(p);
      const ext = extname(p);
      const base = basename(p, ext);

      const guardPath = join(dir, "guard.json");
      if (existsSync(guardPath)) {
        const guard: OwnershipGuard = JSON.parse(readFileSync(guardPath, "utf-8"));
        if (id in guard.owners) {
          const cookies = parseCookies(req.headers.cookie);
          if (cookies[guard.cookie] !== guard.owners[id]) {
            res.statusCode = 403;
            return res.end("Forbidden");
          }
        }
      }

      const variant = join(dir, `${base}.id-${id}${ext}`);
      if (existsSync(variant)) p = variant;
    }

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

/** Known infrastructure noise, not a detector misfire: a role's probe
 * (sitemap, a tampered header, a mutated query) legitimately gets a
 * 403/404, and the browser's own ambient network-error listener logs it as
 * a generic finding. Separated from genuine unexplained findings so this
 * number doesn't quietly drift as the catalog grows — see RESULTS.md. */
const AMBIENT_NOISE_RE = /Failed to load resource:.*\b(404|403)\b/i;

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
    const unexplained = findings.filter((f) => !manifest.seeded.some((b) => match(f.rawMessage, b.message)));
    const ambientNoise = unexplained.filter((f) => AMBIENT_NOISE_RE.test(f.rawMessage));
    const falsePos = unexplained.filter((f) => !AMBIENT_NOISE_RE.test(f.rawMessage));
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
      ambientNoise: ambientNoise.length,
      ambientNoiseMessages: ambientNoise.map((f) => f.rawMessage.split("\n")[0].slice(0, 90)),
      durationMs,
      expectedRole: manifest.expected_role,
      episodeVerdict,
    });

    const ok = missed.length === 0;
    console.log(
      `   ${ok ? pc.green("✓") : pc.red("✗")} found ${found.length}/${manifest.seeded.length}` +
        (falsePos.length ? pc.red(`  · ${falsePos.length} UNEXPLAINED`) : "") +
        (ambientNoise.length ? pc.dim(`  · ${ambientNoise.length} ambient noise`) : "") +
        (episodeVerdict ? pc.dim(`  · episode: ${episodeVerdict}`) : "")
    );
  }

  close();

  const seeded = rows.reduce((s, r) => s + (r.seeded as number), 0);
  const found = rows.reduce((s, r) => s + (r.found as number), 0);
  const fp = rows.reduce((s, r) => s + (r.falsePositives as number), 0);
  const noise = rows.reduce((s, r) => s + (r.ambientNoise as number), 0);
  const rate = seeded ? (found / seeded) * 100 : 0;
  const medianMs = [...rows].map((r) => r.durationMs as number).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0;

  writeFileSync(
    join(OUT_DIR, "results.json"),
    JSON.stringify(
      {
        totals: {
          seeded,
          found,
          rate: +rate.toFixed(1),
          engineFindings: found,
          benchmarkFalsePositives: fp,
          ambientNoise: noise,
          medianDurationMs: medianMs,
        },
        cases: rows,
      },
      null,
      2
    )
  );

  console.log("\n" + "═".repeat(58));
  console.log(
    pc.bold(`Found      ${found}/${seeded}  (${rate.toFixed(1)}%)`) +
      pc.dim(`   ·   ${fp} unexplained   ·   ${noise} ambient noise`)
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
