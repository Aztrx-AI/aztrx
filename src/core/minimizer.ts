import type { RecordedAction } from "./types.js";
import type { ReplayEngine } from "./replay.js";

export interface MinimizeOptions {
  url: string;
  fingerprint: string;
  maxReplays?: number;
}

/**
 * F7 — ddmin (delta debugging). Shrinks the failing action sequence to a
 * minimal subset that still reproduces `fingerprint`. Best-effort under a
 * replay budget; a sequence shorter than 2 actions is returned as-is.
 */
export async function minimize(
  engine: ReplayEngine,
  actions: RecordedAction[],
  opts: MinimizeOptions
): Promise<RecordedAction[]> {
  let current = [...actions];
  if (current.length < 2) return current;

  let budget = opts.maxReplays ?? 15;
  const fails = async (subset: RecordedAction[]): Promise<boolean> => {
    if (budget <= 0) return false;
    budget -= 1;
    const res = await engine.run(opts.url, subset, opts.fingerprint);
    return res.reproduced;
  };

  // Sanity: does the full sequence even reproduce?
  if (!(await fails(current))) return actions;

  while (current.length >= 2 && budget > 0) {
    let n = 2;
    let reducedThisPass = false;
    while (n <= current.length && budget > 0) {
      const chunkSize = Math.ceil(current.length / n);
      let reduced = false;
      for (let i = 0; i < current.length; i += chunkSize) {
        const complement = current.slice(0, i).concat(current.slice(i + chunkSize));
        if (complement.length === 0 || complement.length === current.length) continue;
        if (await fails(complement)) {
          current = complement;
          reduced = true;
          reducedThisPass = true;
          break; // restart partitioning from n=2
        }
      }
      if (reduced) break;
      if (n >= current.length) break;
      n = Math.min(n * 2, current.length);
    }
    if (!reducedThisPass) break;
  }

  return current;
}
