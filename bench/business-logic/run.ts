/**
 * AztrxBench business-logic v0 — the FIRST pass, deliberately run with zero
 * new detection code. The point of this run is to find out WHERE the swarm
 * breaks on a business-logic invariant ("this should only happen once",
 * "this state must be reached in order") before writing anything to fix
 * it: hypothesis (does any role even attempt the right action?), execution
 * (does the attempt happen but fail for an unrelated reason?), or oracle
 * (does it happen and succeed, but nothing recognizes the result as wrong?).
 *
 * aztrx gets nothing but the URL — manifest ground truth is scoring-only.
 */
import { createServer } from "http";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from "fs";
import { join, normalize, dirname, basename } from "path";
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

interface LockConfig {
  cookie: string;
  value: string;
  locked: string;
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
 * A minimal, declarative lock for cases that need a real prerequisite
 * check — the detector must see an actual gate, not a client-rendered
 * illusion of one (a raw `fetch()` never runs a page's own `<script>`).
 * A `lock.json` next to a file maps that file's own name to
 * `{cookie, value, locked}`: serve `locked` instead unless the request's
 * cookie matches. Lives only in the bench harness; `security.ts` knows
 * nothing about it.
 */
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

    const lockPath = join(dirname(p), "lock.json");
    if (existsSync(p) && existsSync(lockPath)) {
      const locks: Record<string, LockConfig> = JSON.parse(readFileSync(lockPath, "utf-8"));
      const lock = locks[basename(p)];
      if (lock) {
        const cookies = parseCookies(req.headers.cookie);
        if (cookies[lock.cookie] !== lock.value) p = join(dirname(p), lock.locked);
      }
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

async function main() {
  const ids = readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  mkdirSync(OUT_DIR, { recursive: true });

  const port = 8920;
  const close = await serve(CASES_DIR, port);

  const rows: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const manifest: Manifest = JSON.parse(readFileSync(join(CASES_DIR, id, "manifest.json"), "utf8"));
    const url = `http://localhost:${port}/${id}/index.html`;
    const repoRoot = join(OUT_DIR, id);
    console.log(`\n${pc.cyan("▶")} ${manifest.name} ${pc.dim(`(${id})`)}`);

    const findings: Finding[] = await run({
      url,
      repoRoot,
      roles: ALL_ROLES,
      seed: OPT.seed,
      maxActions: OPT.maxActions,
      ui: true,
    });

    const found = manifest.seeded.filter((bug) => findings.some((f) => match(f.rawMessage, bug.message)));
    const falsePos = findings.filter((f) => !manifest.seeded.some((b) => match(f.rawMessage, b.message)));

    rows.push({
      id,
      name: manifest.name,
      found: found.length,
      seeded: manifest.seeded.length,
      falsePositives: falsePos.length,
      falsePosMessages: falsePos.map((f) => f.rawMessage.split("\n")[0].slice(0, 90)),
      allFindings: findings.map((f) => `${f.severity}/${f.type}: ${f.rawMessage.split("\n")[0].slice(0, 90)}`),
    });

    const ok = found.length === manifest.seeded.length;
    console.log(`   ${ok ? pc.green("✓") : pc.red("✗")} found ${found.length}/${manifest.seeded.length}`);
    if (!ok) {
      console.log(pc.dim(`   all findings this case produced (${findings.length}):`));
      for (const f of findings) console.log(pc.dim(`     - ${f.severity}/${f.type}: ${f.rawMessage.split("\n")[0].slice(0, 90)}`));
    }
  }

  close();
  writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify(rows, null, 2));

  console.log("\n" + "═".repeat(58));
  for (const r of rows) {
    console.log(`  ${(r.found as number) === (r.seeded as number) ? pc.green("✓") : pc.red("✗")} ${r.id} ${r.found}/${r.seeded}`);
  }
  console.log("");
}

main();
