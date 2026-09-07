import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { Finding, FindingType, Severity, TelemetryErrorPayload } from "./types.js";

// Unambiguous framework files. NOTE: `/_next/static/chunks/` is NOT here —
// in Next.js dev, user code is served from there too, so URL path alone can't
// distinguish it. This is an approximation; the sourcemap resolver does the
// precise own-code mapping separately.
const DEP_FRAGMENTS = [
  "node_modules",
  "react-dom",
  "react.development",
  "react.production",
  "scheduler.development",
  "scheduler.production",
  "next/dist",
  "webpack-internal",
];

const NOISE_FRAGMENTS = [
  "Download the React DevTools",
  "react_devtools_backend",
];

// Dev-tooling artifacts that are not the app under test — the Next.js dev
// overlay's "launch editor" source-resolver request, etc. Suppressed regardless
// of signal type so they neither count as findings nor enter the repro pipeline.
const DEV_TOOLING_NOISE = ["__nextjs_launch-editor"];

// React 18/19 hydration mismatches (Next.js 15 App Router included). These are
// boundary-level divergences between server and client render that stress runs
// surface constantly but that aren't deterministic bugs in the app's logic —
// letting them through would poison the repro pipeline. Suppressed as noise.
const HYDRATION_NOISE = [
  "Hydration failed",
  "There was an error while hydrating",
  "Text content does not match server-rendered HTML",
  "A tree hydrated but some attributes of the server rendered HTML",
  "An error occurred during hydration",
  "Hydration completed but contained mismatches",
];

function normalize(message: string): string {
  return message
    .replace(/^(?:TypeError|ReferenceError|RangeError|SyntaxError|URIError|EvalError|Error):\s*/g, "")
    .replace(/\b\d+\b/g, "<N>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "<TS>")
    .replace(/0x[0-9a-f]+/gi, "<HEX>")
    .replace(/\s+/g, " ");
}

function extractFrameUrls(stack: string): string[] {
  const urls: string[] = [];
  const re = /https?:\/\/[^\s)"']+?:\d+:\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stack)) !== null) urls.push(m[0]);
  return urls;
}

function isDepFrame(frame: string): boolean {
  return DEP_FRAGMENTS.some((d) => frame.includes(d));
}

function stripPos(frame: string): string {
  return frame.replace(/:\d+:\d+$/, "");
}

function hasOwnFrame(stack: string): boolean {
  const frames = extractFrameUrls(stack);
  if (frames.length === 0) return false;
  return frames.some((f) => !isDepFrame(f));
}

export function fingerprintOf(payload: TelemetryErrorPayload): string {
  const frames = extractFrameUrls(payload.rawStack);
  const own = frames.filter((f) => !isDepFrame(f)).slice(0, 3).map(stripPos);
  const key = `${payload.type}|${normalize(payload.rawMessage)}|${own.join("|")}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/** Pull the resource URL out of a network finding's message ("HTTP 500 <url>"
 * or "Request failed: <url> (...)"). Fragment is stripped; the URL is the root
 * cause's identity, not its fragment. */
function extractUrlFromMessage(msg: string): string | null {
  const m = msg.match(/https?:\/\/[^\s)"']+/);
  return m ? m[0].split("#")[0] : null;
}

/**
 * Cross-signal root-cause key. Distinct capture paths for the SAME fault
 * collapse onto one key even though their `type` differs:
 *
 *   - a thrown JS error surfaces via `pageerror` (`uncaught_exception`) AND the
 *     forwarded `unhandledrejection` hook (`unhandled_rejection`) → keyed by the
 *     type-independent fingerprint (normalized message + own frames). The
 *     leading `Error:` prefix is normalized away, so the two channels match.
 *   - a failed request surfaces via `response` (`network_5xx`), `requestfailed`
 *     (`network_timeout`), and the console's "Failed to load resource"
 *     (`console_error`) → keyed by the resource URL (for `console_error`, the
 *     URL is `msg.location().url`, the failed resource).
 *
 * Falls back to the exact fingerprint when no cross-signal rule applies, so a
 * finding with no natural group still dedups only against itself.
 */
export function rootKeyOf(payload: TelemetryErrorPayload): string {
  if (payload.type === "uncaught_exception" || payload.type === "unhandled_rejection") {
    const frames = extractFrameUrls(payload.rawStack);
    const own = frames.filter((f) => !isDepFrame(f)).slice(0, 3).map(stripPos);
    return `throw:${normalize(payload.rawMessage)}|${own.join("|")}`;
  }
  if (payload.type === "network_5xx" || payload.type === "network_timeout") {
    const url = extractUrlFromMessage(payload.rawMessage);
    if (url) return `net:${url}`;
  } else if (payload.type === "console_error" && /Failed to load resource/i.test(payload.rawMessage)) {
    if (payload.url) return `net:${payload.url.split("#")[0]}`;
  }
  return fingerprintOf(payload);
}

function classifySeverity(payload: TelemetryErrorPayload, isOwnCode: boolean): Severity {
  if (DEV_TOOLING_NOISE.some((n) => payload.rawMessage.includes(n))) return "noise";
  if (HYDRATION_NOISE.some((n) => payload.rawMessage.includes(n))) return "noise";
  switch (payload.type) {
    case "uncaught_exception":
      return isOwnCode ? "crash" : "error";
    case "unhandled_rejection":
    case "network_5xx":
    case "network_timeout":
      return "error";
    case "console_error":
      if (NOISE_FRAGMENTS.some((n) => payload.rawMessage.includes(n))) return "noise";
      return "warning";
  }
}

/**
 * F3 — Signal classifier. Fingerprints, dedups, assigns severity, and
 * suppresses a baseline of already-known fingerprints. Returns a Finding on
 * first sight, `null` on duplicate or suppressed.
 */
export class SignalClassifier {
  private seen = new Map<string, Finding>();
  private baseline = new Set<string>();

  constructor(baselineFingerprints: string[] = []) {
    for (const f of baselineFingerprints) this.baseline.add(f);
  }

  classify(payload: TelemetryErrorPayload): Finding | null {
    const fingerprint = fingerprintOf(payload);
    if (this.baseline.has(fingerprint)) return null;

    const existing = this.seen.get(fingerprint);
    if (existing) {
      existing.occurrences += 1;
      return null; // dedup — count, don't re-emit
    }

    const isOwnCode = hasOwnFrame(payload.rawStack);
    const finding: Finding = {
      id: fingerprint,
      fingerprint,
      rootKey: rootKeyOf(payload),
      occurrences: 1,
      severity: classifySeverity(payload, isOwnCode),
      type: payload.type,
      rawMessage: payload.rawMessage,
      rawStack: payload.rawStack,
      actionHistory: [],
    };
    this.seen.set(fingerprint, finding);
    return finding;
  }

  /** Unique findings, noise suppressed. */
  findings(): Finding[] {
    return [...this.seen.values()].filter((f) => f.severity !== "noise");
  }
}

const SEVERITY_RANK: Record<Severity, number> = { crash: 3, error: 2, warning: 1, noise: 0 };

/** The richer of two findings: higher severity wins; ties break toward an
 * own-code source location, then the longer action history. */
function richer(a: Finding, b: Finding): Finding {
  if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) {
    return SEVERITY_RANK[a.severity] > SEVERITY_RANK[b.severity] ? a : b;
  }
  const aOwn = a.mappedLocation?.isOwnCode === true;
  const bOwn = b.mappedLocation?.isOwnCode === true;
  if (aOwn !== bOwn) return aOwn ? a : b;
  return a.actionHistory.length >= b.actionHistory.length ? a : b;
}

/**
 * Collapse findings that share a root cause across capture paths into a single
 * finding. Runs after fingerprint dedup + worker merge; groups by `rootKey`,
 * keeps the richest representative, and sums occurrences. Safe by construction:
 * the key only groups paths that are the same underlying fault (the same thrown
 * error, or the same failing URL), never distinct bugs.
 */
export function collapseSignals(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding>();
  for (const f of findings) {
    const key = f.rootKey ?? f.fingerprint;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...f, actionHistory: [...f.actionHistory] });
      continue;
    }
    const winner = richer(existing, f);
    const merged: Finding = {
      ...winner,
      occurrences: existing.occurrences + f.occurrences,
      actionHistory:
        existing.actionHistory.length >= f.actionHistory.length
          ? existing.actionHistory
          : f.actionHistory,
      rawStack:
        (existing.rawStack?.length ?? 0) >= (f.rawStack?.length ?? 0)
          ? existing.rawStack
          : f.rawStack,
      mappedLocation: existing.mappedLocation ?? f.mappedLocation,
      serverError: existing.serverError ?? f.serverError,
    };
    groups.set(key, merged);
  }
  return [...groups.values()];
}

export async function loadBaseline(repoRoot: string): Promise<string[]> {
  const p = path.join(repoRoot, ".aztrx", "baseline.json");
  try {
    const arr = JSON.parse(fs.readFileSync(p, "utf-8"));
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
