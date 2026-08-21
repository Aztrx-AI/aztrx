import type { Finding, RecordedAction, ReproVerdict } from "./types.js";
import type { ReplayEngine } from "./replay.js";

export interface ValidateResult {
  runs: number;
  reproductions: number;
  rate: number;
  verdict: ReproVerdict;
}

/**
 * F9 — repro validator. Replays the minimized sequence `runs` times and gates
 * on the flake rate: 100% → deterministic, ≥60% → flaky, else unreliable. This
 * is the difference between "we saw an error" and "we proved the bug".
 */
export async function validate(
  engine: ReplayEngine,
  url: string,
  finding: Finding,
  actions: RecordedAction[],
  runs = 3
): Promise<ValidateResult> {
  let reproductions = 0;
  for (let i = 0; i < runs; i++) {
    const res = await engine.run(url, actions, finding.fingerprint);
    if (res.reproduced) reproductions += 1;
  }
  const rate = runs === 0 ? 0 : reproductions / runs;
  const verdict: ReproVerdict = rate === 1 ? "deterministic" : rate >= 0.6 ? "flaky" : "unreliable";
  return { runs, reproductions, rate, verdict };
}
