/**
 * Print where invariant discovery stopped, from a run's local telemetry.
 *
 *   tsx bench/real-project/report.ts <repoRoot>
 *
 * Reads <repoRoot>/.aztrx/telemetry/episodes.jsonl (written by `--telemetry`)
 * and prints, for the invariant-discoverer's episode: what evidence there was,
 * how many rules were inferred, and for every candidate the outcome of each
 * pipeline stage and the source-to-verdict chain. It exists so an external run
 * can be read honestly — including the runs that find nothing.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const root = process.argv[2];
if (!root) {
  console.error("usage: tsx bench/real-project/report.ts <repoRoot>");
  process.exit(2);
}
const file = join(root, ".aztrx", "telemetry", "episodes.jsonl");
if (!existsSync(file)) {
  console.error(`no telemetry at ${file} (run aztrx with --telemetry)`);
  process.exit(1);
}

interface Rec {
  role_id: string;
  discovery_run?: {
    evidence: Array<{ source: string; location: string; chars: number; changedLines?: number }>;
    candidatesInferred: number;
    candidatesAttempted: number;
    candidatesCapped: number;
    environment?: Array<{ origin: string; error: string; count: number; example: string }>;
  };
  discovery?: Array<{
    candidate: { id: string; confidence: number; evidence: { source: string; location?: string; changed?: boolean } };
    verdict: string;
    stoppedBecause?: string;
    stages: Array<{ stage: string; outcome: string; detail?: string }>;
    chain?: string[];
    findingId?: string;
  }>;
}

const recs: Rec[] = readFileSync(file, "utf-8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Rec)
  .filter((r) => r.role_id === "invariant-discoverer");

if (recs.length === 0) {
  console.log("no invariant-discoverer episode in this run");
  process.exit(0);
}

for (const r of recs) {
  const run = r.discovery_run;
  if (run) {
    const by = new Map<string, { n: number; changed: number }>();
    for (const e of run.evidence) {
      const cur = by.get(e.source) ?? { n: 0, changed: 0 };
      cur.n++;
      cur.changed += e.changedLines ?? 0;
      by.set(e.source, cur);
    }
    console.log("evidence_extracted:");
    for (const [src, v] of by) console.log(`  ${src}: ${v.n} chunk(s)${v.changed ? `, ${v.changed} changed line(s)` : ""}`);
    for (const e of run.evidence.filter((x) => x.source === "git_diff")) console.log(`    diff: ${e.location} (${e.changedLines} changed)`);
    console.log(`invariant_inferred: ${run.candidatesInferred} (attempted ${run.candidatesAttempted}, over budget ${run.candidatesCapped})`);
    for (const e of run.environment ?? []) {
      console.log(`environment: dependency unavailable — ${e.origin} (${e.error}) ×${e.count}, e.g. ${e.example} — not a finding`);
    }
  }
  const traces = r.discovery ?? [];
  if (traces.length === 0) console.log("candidates: none — the pipeline stopped at invariant_inferred");
  for (const t of traces) {
    console.log(`\ncandidate ${t.candidate.id}  [${t.candidate.evidence.source} @ ${t.candidate.evidence.location}${t.candidate.evidence.changed ? ", changed" : ""}]  confidence ${t.candidate.confidence}`);
    for (const s of t.stages) console.log(`  ${s.outcome === "ok" ? "✓" : s.outcome === "failed" ? "✗" : "·"} ${s.stage}${s.detail ? ` — ${s.detail}` : ""}`);
    console.log(`  verdict: ${t.verdict}${t.findingId ? ` (finding ${t.findingId})` : ""}`);
    if (t.chain) for (const c of t.chain) console.log(`    ${c}`);
  }
}
