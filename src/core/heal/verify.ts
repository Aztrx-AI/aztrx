/**
 * F10 — automated verification. Reuses the repro engine (F9) but inverts the
 * question: the bug must *stop* reproducing against the patched code. If the
 * fingerprint is still seen after the fix, the loop rejects the patch rather
 * than handing the human a lie.
 */

import { ReplayEngine } from "../replay.js";
import type { FindingType, RecordedAction } from "../types.js";
import type { VerifyResult } from "./types.js";

export interface VerifyOptions {
  url: string;
  actions: RecordedAction[];
  fingerprint: string;
  runs?: number;
  /** Start the patched app and return its URL + a close hook. */
  serve: () => Promise<{ url: string; close: () => Promise<void> }>;
  /** For network findings: verify by signal type (origin-agnostic) instead of the
   * exact fingerprint, and rewrite replay URLs to the booted server's origin so
   * the *patched* code actually runs. */
  targetType?: FindingType;
}

/** Rewrite an absolute URL's origin to `serveUrl`'s origin, keeping path + query.
 * The booted server runs on a fresh port (and possibly host), so a replayed
 * request addressed to the original origin would hit the *unpatched* app. */
function rewriteOrigin(raw: string, serveUrl: string): string {
  try {
    const u = new URL(raw);
    const s = new URL(serveUrl);
    u.protocol = s.protocol;
    u.hostname = s.hostname;
    u.port = s.port;
    return u.toString();
  } catch {
    return raw;
  }
}

export async function verifyFix(opts: VerifyOptions): Promise<VerifyResult> {
  const { url: serveUrl, close } = await opts.serve();
  const engine = new ReplayEngine();
  try {
    const runs = opts.runs ?? 3;
    let reproductions = 0;
    const actions = opts.targetType
      ? opts.actions.map((a) => {
          if (a.type === "request" && a.request) {
            return { ...a, request: { ...a.request, url: rewriteOrigin(a.request.url, serveUrl) } };
          }
          if (a.type === "navigate" && a.value) {
            return { ...a, value: rewriteOrigin(a.value, serveUrl) };
          }
          return a;
        })
      : opts.actions;
    for (let i = 0; i < runs; i++) {
      const res = opts.targetType
        ? await engine.run(serveUrl, actions, opts.fingerprint, { targetType: opts.targetType })
        : await engine.run(serveUrl, actions, opts.fingerprint);
      if (res.reproduced) reproductions += 1;
    }
    return { runs, reproductions, fixed: reproductions === 0 };
  } finally {
    await engine.close();
    await close().catch(() => {});
  }
}
