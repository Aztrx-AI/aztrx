/**
 * AztrxBench invariant-discovery — one capability, scored by stage and by rule
 * family.
 *
 * The other corpora ask "was the seeded bug found". This one asks the
 * questions the capability is actually made of, separately:
 *
 *   invariant discovered?   from the right evidence source?   plan generated?
 *   experiment executed?    violation proven / rule cleared?
 *   unexpected findings?    time-to-proof
 *
 * and reports them per family — numeric threshold ⇒ constant, and
 * state ⇒ allowed/forbidden transition — each with broken and safe controls.
 *
 * aztrx gets nothing but the URL (plus, for diff / repo cases, the project
 * directory it is run in). `expected_*` in the manifest is ground truth for
 * scoring and is never fed to the run. The full role catalog runs, so
 * "unexpected findings" means everything else the swarm said about the page.
 *
 * A case may ship:
 *   server.mjs   default export: URL -> {status,type,body} | null — the
 *                running app, for the one dynamic endpoint it needs.
 *   repo/commit/ the project's source as of the last commit.
 *   repo/working/ edits layered on top, uncommitted — the "latest change".
 * The harness turns repo/ into a real git repository, so `--diff` reads a
 * real `git diff`. The harness stays generic.
 */
import { createServer } from "http";
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync, rmSync, cpSync, utimesSync } from "fs";
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

type Pred = { field: string; op: string; value: number | string };

interface Manifest {
  id: string;
  name: string;
  category: string;
  family: "numeric-threshold" | "state-transition";
  /** Where the rule must be read from; null when no rule may be found at all. */
  expected_evidence: "served_js" | "repo_source" | "git_diff" | null;
  /** `file:line` the evidence trace must point at, when the case pins one. */
  expected_location?: string;
  /** What the run is asked to read besides the page. */
  evidence_request?: { diff?: boolean; repo?: boolean };
  expected_invariant: string;
  expected_candidate: { pre: Pred; action?: string; expect: Pred } | null;
  expected_verdict: "violated" | "preserved" | "none";
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

/** Lay out the case's project directory. With a `repo/` it becomes a real git
 * repository: `commit/` is committed, then `working/` is copied over it
 * uncommitted, so the change under test is a genuine `git diff`. */
function setupRepo(caseDir: string, repoRoot: string): void {
  mkdirSync(repoRoot, { recursive: true });
  const commit = join(caseDir, "repo", "commit");
  if (!existsSync(commit)) return;
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=bench@aztrx.local", "-c", "user.name=bench", "-c", "commit.gpgsign=false", ...a], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed: ${r.stderr}`);
  };
  cpSync(commit, repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, ".gitignore"), ".aztrx/\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
  const working = join(caseDir, "repo", "working");
  if (!existsSync(working)) return;
  cpSync(working, repoRoot, { recursive: true });
  // The copy keeps the fixture's old mtime; a same-size edit with an unchanged
  // mtime is invisible to git's stat cache. A real edit has a fresh mtime.
  const touch = (dir: string, rel = "") => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (e.isDirectory()) touch(dir, join(rel, e.name));
      else utimesSync(join(repoRoot, rel, e.name), new Date(), new Date());
    }
  };
  touch(working);
}

const AMBIENT_NOISE_RE = /Failed to load resource:.*\b(404|403)\b/i;
const match = (msg: string, needle: string) => msg.toLowerCase().includes(needle.toLowerCase());

interface Trace {
  candidate: {
    description: string;
    confidence: number;
    evidence: { source: string; location?: string; signals: string[]; changed?: boolean; alsoSeenIn?: string[] };
    preconditions: Pred[];
    action?: { name: string };
    expectation: Pred[];
  };
  reachedStage: string;
  plan?: { family: string; states: Array<{ label: string; assign: Record<string, number | string>; applicable: boolean }> };
  observations: Array<{
    label: string;
    verdict: string;
    reproduced?: boolean;
    controlOk?: boolean;
    note?: string;
    after: { flags?: Record<string, unknown> };
  }>;
  verdict: string;
  stoppedBecause?: string;
  findingId?: string;
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

const samePred = (a: Pred, b: Pred) => a.field === b.field && a.op === b.op && a.value === b.value;

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
    setupRepo(join(CASES_DIR, id), repoRoot);
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
      evidence: manifest.evidence_request,
    });
    const durationMs = Date.now() - startedAt;

    const traces = discoveryTraces(repoRoot);
    const want = manifest.expected_candidate;
    const trace = want
      ? traces.find(
          (t) =>
            t.candidate.preconditions.some((p) => samePred(p, want.pre)) &&
            t.candidate.expectation.some((p) => samePred(p, want.expect)) &&
            (want.action === undefined || t.candidate.action?.name === want.action)
        )
      : undefined;

    const expectNone = manifest.expected_verdict === "none";
    const discovered = Boolean(trace);
    const sourceOk = Boolean(
      trace &&
        trace.candidate.evidence.source === manifest.expected_evidence &&
        (manifest.expected_location === undefined || trace.candidate.evidence.location === manifest.expected_location) &&
        (manifest.expected_evidence !== "git_diff" || trace.candidate.evidence.changed === true)
    );
    const planned = Boolean(trace?.plan);
    const executed = Boolean(trace && trace.observations.length > 0);
    const proven = Boolean(trace && trace.observations.some((o) => o.verdict === "violated" && o.reproduced));
    const verdict = trace?.verdict ?? "none";
    const violatingStates = (trace?.observations ?? []).filter((o) => o.verdict === "violated").map((o) => o.label);

    const discoveryFindings = findings.filter((f) => match(f.rawMessage, "Discovered invariant violated"));
    const unexplained = findings.filter((f) => !manifest.seeded.some((b) => match(f.rawMessage, b.message)));
    const ambient = unexplained.filter((f) => AMBIENT_NOISE_RE.test(f.rawMessage));
    const unexpected = unexplained.filter((f) => !AMBIENT_NOISE_RE.test(f.rawMessage));

    const expectViolation = manifest.expected_verdict === "violated";
    let outcomeOk: boolean;
    let stageOk: boolean;
    if (expectNone) {
      // Nothing changed, so nothing may be inferred, planned, or reported.
      stageOk = traces.length === 0;
      outcomeOk = discoveryFindings.length === 0;
    } else {
      stageOk = discovered && sourceOk && planned && executed;
      outcomeOk = expectViolation
        ? proven && discoveryFindings.length === 1 && violatingStates.join() === (manifest.violating_state ?? violatingStates.join())
        : verdict === "preserved" && discoveryFindings.length === 0;
    }
    const pass = stageOk && outcomeOk && unexpected.length === 0;

    // Name the weakest stage on a miss, not just the fact of it.
    let failedStage: string | null = null;
    if (!pass) {
      if (expectNone) failedStage = traces.length > 0 ? "a rule was inferred from an empty diff" : "unexpected findings";
      else if (!discovered) failedStage = traces.length === 0 ? "evidence extraction / inference" : "inference (a different rule was inferred)";
      else if (!sourceOk) failedStage = `evidence trace (${trace?.candidate.evidence.source} @ ${trace?.candidate.evidence.location})`;
      else if (trace?.stoppedBecause) failedStage = trace.stoppedBecause;
      else if (!planned) failedStage = "planning";
      else if (!executed) failedStage = "execution";
      else if (!outcomeOk) failedStage = "observation / evaluation";
      else failedStage = "unexpected findings";
    }

    rows.push({
      id,
      name: manifest.name,
      category: manifest.category,
      family: manifest.family,
      expectedVerdict: manifest.expected_verdict,
      expectedEvidence: manifest.expected_evidence,
      discovered,
      confidence: trace?.candidate.confidence ?? null,
      evidenceSource: trace?.candidate.evidence.source ?? null,
      evidenceLocation: trace?.candidate.evidence.location ?? null,
      evidenceSourceOk: sourceOk,
      candidatesInferred: traces.length,
      planFamily: trace?.plan?.family ?? null,
      planned,
      planStates: trace?.plan?.states.map((s) => `${s.label}=${Object.values(s.assign)[0]}`) ?? [],
      executed,
      proven,
      verdict,
      violatingStates,
      findingId: trace?.findingId ?? null,
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
      expectNone
        ? `   candidates inferred: ${traces.length === 0 ? pc.green("0") : pc.red(String(traces.length))}   ` +
            `discovery findings: ${discoveryFindings.length === 0 ? "0" : pc.red(String(discoveryFindings.length))}   ` +
            `unexpected: ${unexpected.length ? pc.red(String(unexpected.length)) : "0"}`
        : `   rule discovered: ${yn(discovered)}   evidence ${trace?.candidate.evidence.source ?? "-"}@${trace?.candidate.evidence.location ?? "-"}: ${yn(sourceOk)}   ` +
            `plan: ${trace?.plan?.family ?? pc.red("none")}   experiment executed: ${yn(executed)}   ` +
            (expectViolation ? `violation proven: ${yn(proven)}   ` : `verdict: ${verdict}   `) +
            `unexpected: ${unexpected.length ? pc.red(String(unexpected.length)) : "0"}` +
            (ambient.length ? pc.dim(`  · ${ambient.length} ambient noise`) : "") +
            (proven ? pc.dim(`  · time-to-proof ${(trace!.durationMs / 1000).toFixed(1)}s`) : "")
    );
    if (failedStage) console.log(`   ${pc.red("✗")} weakest stage: ${failedStage}`);
  }

  close();

  const count = (rs: typeof rows, f: (r: Record<string, unknown>) => boolean) => rs.filter(f).length;
  const familyTotals = (rs: typeof rows) => ({
    cases: rs.length,
    passed: count(rs, (r) => r.pass as boolean),
    discovered: count(rs, (r) => r.discovered as boolean),
    correctEvidenceSource: count(rs, (r) => r.evidenceSourceOk as boolean),
    planned: count(rs, (r) => r.planned as boolean),
    executed: count(rs, (r) => r.executed as boolean),
    violationsProven: count(rs, (r) => r.proven as boolean),
    ruleCleared: count(rs, (r) => r.verdict === "preserved"),
    unexpectedFindings: rs.reduce((s, r) => s + (r.unexpectedFindings as number), 0),
    ambientNoise: rs.reduce((s, r) => s + (r.ambientNoise as number), 0),
  });

  const byFamily: Record<string, ReturnType<typeof familyTotals>> = {};
  for (const fam of [...new Set(rows.map((r) => r.family as string))]) byFamily[fam] = familyTotals(rows.filter((r) => r.family === fam));

  const pass = rows.filter((r) => r.pass).length;
  writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify({ totals: familyTotals(rows), byFamily, cases: rows }, null, 2));

  console.log("\n" + "═".repeat(58));
  console.log(pc.bold(`Passed ${pass}/${rows.length}`));
  console.log("═".repeat(58));
  for (const r of rows) {
    console.log(
      `  ${r.pass ? pc.green("✓") : pc.red("✗")} ${(r.id as string).padEnd(32)} discovered=${r.discovered} src=${r.evidenceSource ?? "-"} ` +
        `executed=${r.executed} proven=${r.proven} verdict=${r.verdict}` +
        (r.unexpectedFindings ? pc.yellow(`  +${r.unexpectedFindings} unexpected`) : "")
    );
  }
  console.log("");
  for (const [fam, t] of Object.entries(byFamily)) {
    console.log(
      `  ${fam.padEnd(18)} ${t.passed}/${t.cases} pass · discovered ${t.discovered} · right source ${t.correctEvidenceSource} · ` +
        `planned ${t.planned} · executed ${t.executed} · proven ${t.violationsProven} · cleared ${t.ruleCleared} · unexpected ${t.unexpectedFindings}`
    );
  }
  console.log("");
  if (pass !== rows.length) process.exitCode = 1;
}

main();
