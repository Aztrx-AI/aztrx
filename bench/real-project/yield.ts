import { spawnSync } from "node:child_process";
import { parseUnifiedDiff } from "../../src/core/discovery/evidence.js";
import { inferFromEvidence } from "../../src/core/discovery/infer.js";
const g = (cwd: string, a: string[]) => spawnSync("git", ["-c","core.quotepath=off",...a], { cwd, encoding: "utf-8", maxBuffer: 64e6 }).stdout ?? "";
const CODE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/;
for (const repo of process.argv.slice(2)) {
  const shas = g(repo, ["log", "--no-merges", "--format=%h", "-n", "40"]).split("\n").filter(Boolean);
  let withCode = 0, withRule = 0, rules = 0; const hits: string[] = [];
  for (const sha of shas) {
    const diff = g(repo, ["diff", "--no-color", "-U0", `${sha}~1`, sha, "--"]);
    const chunks = [];
    for (const f of parseUnifiedDiff(diff)) {
      if (!CODE.test(f.file) || f.added.length === 0) continue;
      const content = g(repo, ["show", `${sha}:${f.file}`]);
      if (content) chunks.push({ source: "git_diff" as const, location: f.file, content, changedLines: f.added });
    }
    if (!chunks.length) continue;
    withCode++;
    const c = inferFromEvidence(chunks);
    if (c.length) { withRule++; rules += c.length; hits.push(`${sha}:${c.length}`); }
  }
  console.log(`${repo.split(/[\/]/).pop()}: commits=${shas.length} code-changing=${withCode} with-rule=${withRule} rules=${rules} ${hits.join(" ")}`);
}
