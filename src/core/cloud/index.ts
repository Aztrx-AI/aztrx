/**
 * F12 — opt-in cloud sync. Streams a completed run's findings to the Aztrx
 * ingest API (`POST /api/runs`) for the team dashboard and server-side
 * deduplication by crash fingerprint. Mirrors the telemetry module's contract:
 * fire-and-forget, bounded by a short abort, and never affects the exit code.
 * Everything is sanitized before packaging (secrets, URLs, repo paths).
 */

import * as fs from "fs";
import type { Finding } from "../types.js";
import { detectFrameworkMeta } from "../init.js";
import { createSanitizer } from "../telemetry/sanitize.js";

const DEFAULT_CLOUD_URL = process.env.AZTRX_CLOUD_URL || "https://api.aztrx.app";
const UPLOAD_TIMEOUT_MS = 2000;

/** In-flight uploads, drained by `flushCloud()` before the CLI exits. */
const pendingUploads: Promise<void>[] = [];

export interface CloudOptions {
  repoRoot: string;
  url: string;
  /** API key presented as `x-api-key` (falls back to `AZTRX_API_KEY`). */
  apiKey?: string;
  /** Ingest base URL, e.g. `https://api.aztrx.app` (falls back to `AZTRX_CLOUD_URL`). */
  endpoint?: string;
  /** Human-readable run mode, shown in the dashboard. */
  mode: string;
  counts: Record<string, number>;
}

export interface CloudFinding {
  fingerprint: string;
  severity: string;
  type: string;
  message: string;
  location?: { file: string; line: number; column: number };
  repro?: {
    verdict: string;
    rate: number;
    runs: number;
    reproductions: number;
    spec: string | null;
  };
  patch?: string | null;
  model_tier?: string | null;
}

export interface RunPayload {
  schema: "aztrx.run/1";
  sentAt: string;
  framework: string;
  framework_version?: string;
  target: string;
  mode: string;
  counts: Record<string, number>;
  findings: CloudFinding[];
}

function readFileIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function buildPayload(findings: Finding[], opts: CloudOptions): RunPayload {
  const sanitize = createSanitizer(opts.repoRoot);
  const meta = detectFrameworkMeta(opts.repoRoot);

  const cloudFindings: CloudFinding[] = [];
  for (const f of findings) {
    if (f.severity !== "crash" && f.severity !== "error") continue;

    const specRaw = f.repro?.specPath ? readFileIfExists(f.repro.specPath) : null;
    const patchRaw =
      f.heal?.status === "healed" && f.heal.patchPath
        ? readFileIfExists(f.heal.patchPath)
        : null;

    cloudFindings.push({
      fingerprint: f.fingerprint,
      severity: f.severity,
      type: f.type,
      message: sanitize.text(f.rawMessage),
      location: f.mappedLocation
        ? {
            file: sanitize.text(f.mappedLocation.filePath),
            line: f.mappedLocation.line,
            column: f.mappedLocation.column,
          }
        : undefined,
      repro: f.repro
        ? {
            verdict: f.repro.verdict,
            rate: f.repro.rate,
            runs: f.repro.runs,
            reproductions: f.repro.reproductions,
            spec: specRaw ? sanitize.text(specRaw) : null,
          }
        : undefined,
      patch: patchRaw ? sanitize.text(patchRaw) : null,
      model_tier: f.heal?.model ?? null,
    });
  }

  return {
    schema: "aztrx.run/1",
    sentAt: new Date().toISOString(),
    framework: meta.framework,
    framework_version: meta.version,
    target: sanitize.url(opts.url),
    mode: opts.mode,
    counts: opts.counts,
    findings: cloudFindings,
  };
}

/** Fire-and-forget upload. Never rejects; bounded by a short abort. */
export function dispatchUpload(payload: RunPayload, endpoint: string, apiKey?: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  return fetch(`${endpoint}/api/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  })
    .then(() => {})
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

/** Build the sanitized payload and detach an upload. A clean run (zero
 * findings) still uploads — the dashboard tracks green runs too. */
export function submitRun(findings: Finding[], opts: CloudOptions): void {
  const endpoint = opts.endpoint ?? DEFAULT_CLOUD_URL;
  const apiKey = opts.apiKey ?? process.env.AZTRX_API_KEY;
  const payload = buildPayload(findings, opts);
  pendingUploads.push(dispatchUpload(payload, endpoint, apiKey));
}

/** Await all in-flight uploads (each already bounded). Called right before the
 * CLI exits so a pending `--upload` isn't killed mid-flight; never affects exit
 * code. */
export async function flushCloud(): Promise<void> {
  while (pendingUploads.length) {
    const batch = pendingUploads.splice(0);
    await Promise.allSettled(batch);
  }
}
