/**
 * AztrxBench invariant-discovery v0 — one capability, scored by stage.
 *
 * The other corpora ask "was the seeded bug found". This one asks the
 * questions the capability is actually made of, separately:
 *
 *   invariant discovered?  experiment executed?  violation proven?
 *   unexpected findings?   time-to-proof
 *
 * aztrx gets nothing but the URL. `expected_candidate` in the manifest is
 * ground truth for scoring the inferred rule, never fed to the run. The full
 * role catalog runs, so "unexpected findings" means everything else the swarm
 * said about the page, not just the new role.
 *
 * A case may ship a `server.mjs` (default export: URL -> {status,type,body}
 * | null) for the one dynamic endpoint it needs. The harness stays generic.
 */
import { createServer } from "http";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync, rmSync } from "fs";
import { join, normalize, extname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import pc from "picocolors";
import { run } from "../../dist/core/orchestrator.js";
import { ROLE_CATALOG } from "../../dist/core/roles.js";
import type { Finding } from "../../dist/core/types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CASES_DIR = join(HERE, "cases");
const OUT_DIR = join(HERE, ".out");
const ALL_ROLES = ROLE_CATALOG.map((r: { id: string }) => r.id);

interface Manifest {
  id: string;
  name: string;
  category: string;
  expected_invariant: string;
  expected_candidate: {
    pre: { field: string; op: string; value: number };
    expect: { field: string; op: string; value: number };
  };
  expected_verdict: "violated" | "preserved";
  violating_state?: string;
  expected_role: string;
  seeded: Array<{ id: string; category: string; message: string }>;
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

type Handler = (url: URL) => { status: number; type: string; body: string } | null;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
};

/** Static files from the cases dir; `/api/*` is routed to the case's own
 * `server.mjs`, resolved from the first path segment of the Referer. */
async function serve(root: string, port: number): Promise<() => void> {
  const handlers = new Map<string, Handler>();
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = join(root, d.name, "server.mjs");
    if (existsSync(f)) handlers.set(d.name, (await import(pathToFileURL(f).href)).default as Handler);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");

    if (url.pathname.startsWith("/api/")) {
      const caseId = new URL(String(req.headers.referer ?? "http://x/")).pathname.split("/")[1];
      const hit = handlers.get(caseId)?.(url);
      if (!hit) {
        res.statusCode = 404;
        return res.end("not found");
      }
      res.statusCode = hit.status;
      res.setHeader("Content-Type", hit.type);
      return res.end(hit.body);
    }

    let p = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!p.startsWith(root)) {
      res.statusCode = 403;
      return res.end("forbidden");
    }
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
    try {
      const body = readFileSync(p);
      res.setHeader("Content-Type", TYPES[extname(p)] ?? "text/plain");
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(() => server.close())));
}

const AMBIENT_NOISE_RE = /Failed to load resource:.*\b(404|403)\b/i;
const match = (msg: string, needle: string) => msg.toLowerCase().includes(needle.toLowerCase());

interface Trace {
  candidate: {
    description: string;
    confidence: number;
    evidence: { source: string; location?: string; signals: string[] };
    preconditions: Array<{ field: string; op: string; value: number }>;
    expectation: Array<{ field: string; op: string; value: number }>;
  };
  reachedStage: string;
  plan?: { states: Array<{ label: string; assign: Record<string, number>; applicable: boolean }> };
  observations: Array<{ label: string; verdict: string; reproduced?: boolean; after: { flags?: Record<string, unknown> } }>;
  verdict: string;
  stoppedBecause?: string;
  durationMs: number;
}

/** Discovery traces the invariant-discoverer's episode logged, read back
 * from the same local episode telemetry every other role writes to. */
function discoveryTraces(repoRoot: string): Trace[] {
  const file = join(repoRoot, ".aztrx", "telemetry", "episodes.jsonl");
  if (!existsSync(file)) return [];
  const out: Trace[] = [];
  for (const line of readFileSync(file, "utf-8").trim().split("\n").filter(Boolean)) {
    try {
      const rec = JSON.parse(line);
      if (rec.role_id === "invariant-discoverer" && Array.isArray(rec.discovery)) out.push(...rec.discovery);
    } catch {
      // a malformed line shouldn't fail the whole run
    }
  }
  return out;
}

const sameRule = (a: { field: string; op: string; value: number }, b: { field: string; op: string; value: number }) =>
  a.field === b.field && a.op === b.op && a.value === b.value;

async function main() {
  const ids = readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const port = 8913;
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
      telemetry: true,
      ui: true,
    });
    const durationMs = Date.now() - startedAt;

    const traces = discoveryTraces(repoRoot);
    const want = manifest.expected_candidate;
    const trace = traces.find(
      (t) =>
        t.candidate.preconditions.some((p) => sameRule(p, want.pre)) &&
        t.candidate.expectation.some((p) => sameRule(p, want.expect))
    );

    const discovered = Boolean(trace);
    const executed = Boolean(trace && trace.observations.length > 0);
    const proven = Boolean(trace && trace.observations.some((o) => o.verdict === "violated" && o.reproduced));
    const verdict = trace?.verdict ?? "none";
    const violatingStates = (trace?.observations ?? []).filter((o) => o.verdict === "violated").map((o) => o.label);

    const discoveryFindings = findings.filter((f) => match(f.rawMessage, "Discovered invariant violated"));
    const unexplained = findings.filter((f) => !manifest.seeded.some((b) => match(f.rawMessage, b.message)));
    const ambient = unexplained.filter((f) => AMBIENT_NOISE_RE.test(f.rawMessage));
    const unexpected = unexplained.filter((f) => !AMBIENT_NOISE_RE.test(f.rawMessage));

    const expectViolation = manifest.expected_verdict === "violated";
    const stageOk = discovered && executed;
    const outcomeOk = expectViolation
      ? proven && discoveryFindings.length === 1 && violatingStates.join() === (manifest.violating_state ?? violatingStates.join())
      : verdict === "preserved" && discoveryFindings.length === 0;
    const pass = stageOk && outcomeOk && unexpected.length === 0;

    // Name the weakest stage on a miss, not just the fact of it.
    let failedStage: string | null = null;
    if (!pass) {
      if (!discovered) failedStage = traces.length === 0 ? "evidence extraction / inference" : "inference (a different rule was inferred)";
      else if (trace?.stoppedBecause) failedStage = trace.stoppedBecause;
      else if (!executed) failedStage = "execution";
      else if (!outcomeOk) failedStage = "observation / evaluation";
      else failedStage = "unexpected findings";
    }

    rows.push({
      id,
      name: manifest.name,
      category: manifest.category,
      expectedVerdict: manifest.expected_verdict,
      discovered,
      confidence: trace?.candidate.confidence ?? null,
      evidenceSource: trace?.candidate.evidence.source ?? null,
      evidenceLocation: trace?.candidate.evidence.location ?? null,
      planStates: trace?.plan?.states.map((s) => `${s.label}=${Object.values(s.assign)[0]}`) ?? [],
      executed,
      proven,
      verdict,
      violatingStates,
      discoveryFindings: discoveryFindings.length,
      unexpectedFindings: unexpected.length,
      unexpectedMessages: unexpected.map((f) => f.rawMessage.split("\n")[0].slice(0, 100)),
      ambientNoise: ambient.length,
      timeToProofMs: proven ? trace!.durationMs : null,
      missionMs: durationMs,
      pass,
      failedStage,
    });

    const yn = (b: boolean) => (b ? pc.green("yes") : pc.red("no"));
    console.log(
      `   rule discovered: ${yn(discovered)}   experiment executed: ${yn(executed)}   ` +
        (expectViolation ? `violation proven: ${yn(proven)}   ` : `verdict: ${verdict}   `) +
        `unexpected: ${unexpected.length ? pc.red(String(unexpected.length)) : "0"}` +
        (ambient.length ? pc.dim(`  · ${ambient.length} ambient noise`) : "") +
        (proven ? pc.dim(`  · time-to-proof ${(trace!.durationMs / 1000).toFixed(1)}s`) : "")
    );
    if (failedStage) console.log(`   ${pc.red("✗")} weakest stage: ${failedStage}`);
  }

  close();

  const pass = rows.filter((r) => r.pass).length;
  writeFileSync(
    join(OUT_DIR, "results.json"),
    JSON.stringify(
      {
        totals: {
          cases: rows.length,
          passed: pass,
          discovered: rows.filter((r) => r.discovered).length,
          executed: rows.filter((r) => r.executed).length,
          violationsProven: rows.filter((r) => r.proven).length,
          unexpectedFindings: rows.reduce((s, r) => s + (r.unexpectedFindings as number), 0),
          ambientNoise: rows.reduce((s, r) => s + (r.ambientNoise as number), 0),
        },
        cases: rows,
      },
      null,
      2
    )
  );

  console.log("\n" + "═".repeat(58));
  console.log(pc.bold(`Passed ${pass}/${rows.length}`));
  console.log("═".repeat(58));
  for (const r of rows) {
    console.log(
      `  ${r.pass ? pc.green("✓") : pc.red("✗")} ${(r.id as string).padEnd(28)} discovered=${r.discovered} executed=${r.executed} ` +
        `proven=${r.proven} verdict=${r.verdict}` +
        (r.unexpectedFindings ? pc.yellow(`  +${r.unexpectedFindings} unexpected`) : "")
    );
  }
  console.log("");
  if (pass !== rows.length) process.exitCode = 1;
}

main();
