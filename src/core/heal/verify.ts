/**
 * F10 — automated verification. Reuses the repro engine (F9) but inverts the
 * question: the bug must *stop* reproducing against the patched code. If the
 * fingerprint is still seen after the fix, the loop rejects the patch rather
 * than handing the human a lie.
 */

import { ReplayEngine } from "../replay.js";
import type { ReplayResult } from "../replay.js";
import type { FindingType, RecordedAction } from "../types.js";
import type { Finding } from "../types.js";
import { SECRET_PATTERNS } from "../security.js";
import type { VerifyResult } from "./types.js";

/** The slice of the replay engine verification depends on. Production passes a
 * real browser-backed `ReplayEngine`; tests inject a stub so the pass/fail logic
 * is exercised without launching Chromium. */
export interface Verifier {
  run(
    url: string,
    actions: RecordedAction[],
    targetFingerprint: string,
    opts?: { targetType?: FindingType }
  ): Promise<ReplayResult>;
  close(): Promise<void>;
}

export interface VerifyOptions {
  /** The URL the finding was recorded against. Retained for callers/reporting;
   * replays run against the served URL, never this origin. */
  url: string;
  actions: RecordedAction[];
  fingerprint: string;
  runs?: number;
  /** Start the patched app and return its URL + a close hook. */
  serve: () => Promise<{ url: string; close: () => Promise<void> }>;
  /** For network findings: verify by signal type (origin-agnostic) instead of the
   * exact fingerprint. */
  targetType?: FindingType;
  /** Replay engine override — tests only. Defaults to a real browser-backed one. */
  engine?: Verifier;
  /** State-Graph handoff: the replay engine boots into this state first. */
  seedState?: import("../graph.js").StateSnapshot;
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
  const engine: Verifier = opts.engine ?? new ReplayEngine({ seedState: opts.seedState });
  try {
    // Never zero. `fixed` is derived from the reproduction count, so a caller that
    // asks for 0 runs would otherwise get "fixed: true" out of *no attempts at
    // all* — a patch declared verified on the strength of never having been run.
    const runs = Math.max(1, Math.trunc(opts.runs ?? 3));
    let reproductions = 0;
    let loaded = 0;
    // Every recorded URL is rewritten to the served origin — for client findings
    // too, not just network ones. The repro was recorded against the original
    // app, so a `navigate` action left as-is would send the replay straight back
    // to the *unpatched* server, where the bug reproduces no matter what the
    // patch says. That reads as "unfixed" at best; when the fingerprint happens
    // to be absent there, it reads as a verified fix that was never exercised.
    const actions = opts.actions.map((a) => {
      if (a.type === "request" && a.request) {
        return { ...a, request: { ...a.request, url: rewriteOrigin(a.request.url, serveUrl) } };
      }
      if (a.type === "navigate" && a.value) {
        return { ...a, value: rewriteOrigin(a.value, serveUrl) };
      }
      return a;
    });
    for (let i = 0; i < runs; i++) {
      const res = opts.targetType
        ? await engine.run(serveUrl, actions, opts.fingerprint, { targetType: opts.targetType })
        : await engine.run(serveUrl, actions, opts.fingerprint);
      if (res.loaded) loaded += 1;
      if (res.reproduced) reproductions += 1;
    }
    // "Did not reproduce" only means "fixed" if the app was actually there to
    // reproduce against. If no run loaded, this verification proved nothing about
    // the patch — so it must not report success, or the caller writes an
    // unverified patch into the user's working tree on the strength of it.
    return { runs, reproductions, loaded, fixed: loaded > 0 && reproductions === 0 };
  } finally {
    await engine.close();
    await close().catch(() => {});
  }
}

export interface SecretVerifyOptions {
  /** Serves the patched worktree (same contract as VerifyOptions.serve). */
  serve: () => Promise<{ url: string; close: () => Promise<void> }>;
  /** The finding whose secret kind must be gone from the patched page. */
  finding: Finding;
}

/**
 * Verification for secret leaks — the replay engine cannot re-drive a static
 * scan, so the honest equivalent is to re-run the scan against the patched
 * page: fetch the patched HTML and check the exact secret kind the finding
 * reported no longer matches. "Fixed" requires the page to load AND the
 * pattern to be gone — same discipline as the replay path.
 */
export async function verifySecretFix(opts: SecretVerifyOptions): Promise<VerifyResult> {
  const { url: serveUrl, close } = await opts.serve();
  try {
    const kind = SECRET_PATTERNS.find((p) => opts.finding.rawMessage.includes(p.name));
    if (!kind) return { runs: 0, reproductions: 0, loaded: 0, fixed: false };

    // The route the leak was seen on: the recorded trace's last navigation,
    // or the mapped file served directly.
    let route = "";
    for (let i = opts.finding.actionHistory.length - 1; i >= 0; i--) {
      const a = opts.finding.actionHistory[i];
      if (a.type === "navigate" && a.value) {
        try {
          route = new URL(a.value).pathname;
        } catch {
          route = a.value;
        }
        break;
      }
    }
    if (!route && opts.finding.mappedLocation) {
      route = "/" + opts.finding.mappedLocation.filePath.replace(/\\/g, "/").split("/").pop();
    }
    if (!route) return { runs: 0, reproductions: 0, loaded: 0, fixed: false };

    const html = await fetch(serveUrl + route).then((r) => r.text()).catch(() => "");
    if (!html) return { runs: 1, reproductions: 0, loaded: 0, fixed: false };

    const stillLeaks = kind.regex.test(html);
    return { runs: 1, reproductions: stillLeaks ? 1 : 0, loaded: 1, fixed: !stillLeaks };
  } finally {
    await close().catch(() => {});
  }
}
