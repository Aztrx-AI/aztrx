/**
 * F10 — automated verification. Reuses the repro engine (F9) but inverts the
 * question: the bug must *stop* reproducing against the patched code. If the
 * fingerprint is still seen after the fix, the loop rejects the patch rather
 * than handing the human a lie.
 */

import { ReplayEngine } from "../replay.js";
import type { RecordedAction } from "../types.js";
import type { VerifyResult } from "./types.js";

export interface VerifyOptions {
  url: string;
  actions: RecordedAction[];
  fingerprint: string;
  runs?: number;
  /** Start the patched app and return its URL + a close hook. */
  serve: () => Promise<{ url: string; close: () => Promise<void> }>;
}

export async function verifyFix(opts: VerifyOptions): Promise<VerifyResult> {
  const { url: serveUrl, close } = await opts.serve();
  const engine = new ReplayEngine();
  try {
    const runs = opts.runs ?? 3;
    let reproductions = 0;
    for (let i = 0; i < runs; i++) {
      const res = await engine.run(serveUrl, opts.actions, opts.fingerprint);
      if (res.reproduced) reproductions += 1;
    }
    return { runs, reproductions, fixed: reproductions === 0 };
  } finally {
    await engine.close();
    await close().catch(() => {});
  }
}
