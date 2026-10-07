/**
 * Real Project Validation — aztrx against software that was not shaped around
 * aztrx's fixtures: a real framework app (Next.js), whose source files *are*
 * the running app, with the change under test arriving as a real uncommitted
 * `git diff`.
 *
 * For each scenario the harness:
 *   1. makes a git repository of `fixtures/orders-app` (the committed state),
 *   2. applies a patch to the working tree — the developer's uncommitted change,
 *   3. boots the real `next dev` server for that working tree,
 *   4. runs aztrx with the URL, the repo, and `--diff`. Nothing else: no rule,
 *      no invariant name, no hint about what the patch did.
 *
 * Scored per scenario: did it find the change's evidence, infer rules, bind
 * them to the running page, plan, execute, observe, and conclude — with the
 * stage each candidate stopped at. Ground truth in `SCENARIOS` is read only
 * after the run.
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { run } from "../../dist/core/orchestrator.js";
import type { Finding } from "../../dist/core/types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP = join(HERE, "..", "..", "fixtures", "orders-app");
const RUNS = join(APP, ".runs");
const OUT = join(HERE, ".out");
const NEXT_BIN = join(APP, "node_modules", "next", "dist", "bin", "next");

interface Scenario {
  id: string;
  title: string;
  /** Patch applied as an uncommitted edit; null = the working tree is clean. */
  patch: string | null;
  /** Ground truth, never fed to the run. */
  expect: { violated?: { action: string; from: string }; none?: boolean; location?: string };
}

const SCENARIOS: Scenario[] = [
  {
    id: "orders-clean",
    title: "No uncommitted change (empty diff on a real app)",
    patch: null,
    expect: { none: true },
  },
  {
    id: "orders-correct",
    title: "Feature: customers can reopen a cancelled order (implemented correctly)",
    patch: "reopen-correct.patch",
    expect: { location: "lib/workflow.ts:12" },
  },
  {
    id: "orders-regressed",
    title: "Same feature, plus a 'hot path' that skips the transition table for complete",
    patch: "reopen-regressed.patch",
    expect: { violated: { action: "complete", from: "cancelled" }, location: "lib/workflow.ts:12" },
  },
];

const PORT = 3137;

function git(cwd: string, ...a: string[]) {
  const r = spawnSync("git", ["-c", "user.email=bench@aztrx.local", "-c", "user.name=bench", "-c", "core.autocrlf=false", ...a], {
    cwd,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** The app as a standalone git repository with its own node_modules — the
 * shape a real checkout has, and the one Turbopack needs (it bounds its
 * workspace root at the nearest git repo). Built once; every scenario resets
 * it to the base commit and applies its patch as an uncommitted edit. */
function makeRepo(_id: string, patch: string | null): string {
  const dir = join(RUNS, "work");
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    const skip = new Set(["node_modules", ".next", ".runs", ".aztrx", "next-env.d.ts"]);
    for (const e of readdirSync(APP, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      cpSync(join(APP, e.name), join(dir, e.name), { recursive: true });
    }
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
  }
  if (!existsSync(join(dir, "node_modules"))) cpSync(join(APP, "node_modules"), join(dir, "node_modules"), { recursive: true });
  git(dir, "reset", "-q", "--hard", "HEAD");
  git(dir, "clean", "-fdq");
  for (const stale of [".next", ".aztrx", "next-env.d.ts"]) rmSync(join(dir, stale), { recursive: true, force: true });
  if (patch) git(dir, "apply", "--whitespace=nowarn", join(HERE, "scenarios", patch));
  return dir;
}

async function bootNext(dir: string, port: number): Promise<{ stop: () => void; log: () => string }> {
  let out = "";
  const child: ChildProcess = spawn(process.execPath, [NEXT_BIN, "dev", "-p", String(port)], {
    cwd: dir,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  const stop = () => {
    if (child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    child.kill();
  };
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (Date.now() > deadline) {
      stop();
      throw new Error("next dev did not become ready:\n" + out.slice(-1500));
    }
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { stop, log: () => out };
}

interface Stage {
  stage: string;
  outcome: string;
  detail?: string;
}
interface Trace {
  candidate: {
    id: string;
    description: string;
    confidence: number;
    action?: { name: string };
    preconditions: Array<{ field: string; value: unknown }>;
    evidence: { source: string; location?: string; changed?: boolean; signals: string[] };
  };
  plan?: { family: string };
  verdict: string;
  stoppedBecause?: string;
  stages: Stage[];
  binding?: Array<{ role: string; name: string; matched: string }>;
  chain?: string[];
  findingId?: string;
  observations: Array<{ label: string; verdict: string; reproduced?: boolean; controlOk?: boolean }>;
  durationMs: number;
}

function readEpisodes(repoRoot: string): { traces: Trace[]; runReport: unknown } {
  const file = join(repoRoot, ".aztrx", "telemetry", "episodes.jsonl");
  const traces: Trace[] = [];
  let runReport: unknown = null;
  if (!existsSync(file)) return { traces, runReport };
  for (const line of readFileSync(file, "utf-8").trim().split("\n").filter(Boolean)) {
    try {
      const rec = JSON.parse(line);
      if (rec.role_id !== "invariant-discoverer") continue;
      if (Array.isArray(rec.discovery)) traces.push(...rec.discovery);
      if (rec.discovery_run) runReport = rec.discovery_run;
    } catch {
      /* ignore a malformed line */
    }
  }
  return { traces, runReport };
}

async function main() {
  if (!existsSync(NEXT_BIN)) throw new Error("fixtures/orders-app has no node_modules — run `npm install` there first");
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  const results: Array<Record<string, unknown>> = [];
  for (const sc of SCENARIOS.filter((s) => only.length === 0 || only.includes(s.id))) {
    console.log(`\n${pc.cyan("▶")} ${sc.title} ${pc.dim(`(${sc.id})`)}`);
    const dir = makeRepo(sc.id, sc.patch);
    const diffStat = git(dir, "diff", "--stat").trim().split("\n").pop() ?? "(no diff)";
    console.log(pc.dim(`   repo ${dir}\n   working tree: ${diffStat || "clean"}`));

    const server = await bootNext(dir, PORT);
    let findings: Finding[] = [];
    const t0 = Date.now();
    try {
      findings = await run({
        url: `http://localhost:${PORT}/`,
        repoRoot: dir,
        roles: ["invariant-discoverer"],
        seed: 42,
        maxActions: 60,
        telemetry: true,
        ui: true,
        evidence: { diff: true },
      });
    } finally {
      server.stop();
    }
    const missionMs = Date.now() - t0;

    const { traces, runReport } = readEpisodes(dir);
    const discovery = findings.filter((f) => f.rawMessage.includes("Discovered invariant violated"));
    const other = findings.filter((f) => !f.rawMessage.includes("Discovered invariant violated"));

    const want = sc.expect;
    const violatedTraces = traces.filter((t) => t.verdict === "violated");
    const hit = want.violated
      ? violatedTraces.find((t) => t.candidate.action?.name === want.violated!.action && t.candidate.preconditions.some((p) => p.value === want.violated!.from))
      : undefined;
    const locationOk = !want.location || traces.some((t) => t.candidate.evidence.location === want.location);
    let pass: boolean;
    if (want.none) pass = traces.length === 0 && discovery.length === 0;
    else if (want.violated) {
      pass =
        Boolean(hit?.observations.some((o) => o.reproduced)) &&
        violatedTraces.length === 1 &&
        discovery.length === 1 &&
        locationOk;
    } else pass = discovery.length === 0 && traces.length > 0 && locationOk && traces.every((t) => t.verdict !== "violated");

    console.log(`   run report: ${JSON.stringify(runReport)}`);
    for (const t of traces) {
      const stages = t.stages.map((s) => `${s.outcome === "ok" ? pc.green("✓") : s.outcome === "failed" ? pc.red("✗") : pc.dim("·")}${s.stage.replace(/_.*/, "")}`).join(" ");
      console.log(
        `   - ${t.candidate.id}  [${t.candidate.evidence.source}@${t.candidate.evidence.location}${t.candidate.evidence.changed ? " changed" : ""}]  ` +
          `${pc.bold(t.verdict)}  ${stages}` +
          (t.stoppedBecause ? pc.yellow(`\n       stopped: ${t.stoppedBecause}`) : "")
      );
    }
    if (hit?.chain) console.log(pc.dim("   trace of the violated rule:\n     " + hit.chain.join("\n     ")));
    console.log(
      `   ${pass ? pc.green("✓ pass") : pc.red("✗ FAIL")}  candidates=${traces.length} violated=${violatedTraces.length} ` +
        `discovery findings=${discovery.length} other findings=${other.length} (${(missionMs / 1000).toFixed(0)}s)`
    );
    results.push({
      id: sc.id,
      pass,
      candidates: traces.length,
      violated: violatedTraces.map((t) => t.candidate.id),
      discoveryFindings: discovery.length,
      otherFindings: other.map((f) => f.rawMessage.split("\n")[0].slice(0, 120)),
      runReport,
      traces: traces.map((t) => ({
        id: t.candidate.id,
        source: t.candidate.evidence.source,
        location: t.candidate.evidence.location,
        verdict: t.verdict,
        stages: t.stages,
        binding: t.binding,
        stoppedBecause: t.stoppedBecause,
        findingId: t.findingId,
        chain: t.chain,
        durationMs: t.durationMs,
      })),
      missionMs,
    });
  }

  writeFileSync(join(OUT, "results.json"), JSON.stringify({ scenarios: results }, null, 2));
  const passed = results.filter((r) => r.pass).length;
  console.log("\n" + "═".repeat(58));
  console.log(pc.bold(`Real project: ${passed}/${results.length}`));
  console.log("═".repeat(58));
  for (const r of results) console.log(`  ${r.pass ? pc.green("✓") : pc.red("✗")} ${r.id}  candidates=${r.candidates} violated=${(r.violated as string[]).length}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
