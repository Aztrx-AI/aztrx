/**
 * F11 — opt-in telemetry / data flywheel. Collects the anonymized
 * `[crash_fingerprint, min_repro_spec, verified_patch, framework_metadata,
 * model_tier_used]` tuple for each crash/error finding, appends it to a local
 * JSONL dataset, and — only under `--share-data` — dispatches an envelope to the
 * telemetry endpoint.
 *
 * Privacy: everything is opt-in. `--telemetry` collects and persists locally
 * only; `--share-data` additionally uploads. The dispatch is fire-and-forget,
 * bounded by a 2s abort, and can never change the CLI exit code.
 */

import * as fs from "fs";
import * as path from "path";
import type { Finding } from "../types.js";
import { detectFrameworkMeta } from "../init.js";
import { createSanitizer } from "./sanitize.js";
import type { FrameworkMetadata, TelemetryEnvelope, TelemetryTuple } from "./types.js";

const DEFAULT_ENDPOINT =
  process.env.AZTRX_TELEMETRY_URL || "https://api.aztrx.app/api/telemetry";
const UPLOAD_TIMEOUT_MS = 2000;

/** In-flight uploads, drained by `flushTelemetry()` before the CLI exits. */
const pendingUploads: Promise<void>[] = [];

export interface SubmitOptions {
  repoRoot: string;
  url: string;
  telemetry: boolean;
  shareData: boolean;
  endpoint?: string;
  /** API key presented as `x-api-key` (falls back to `AZTRX_API_KEY`). */
  apiKey?: string;
}

function readFileIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function buildTuples(findings: Finding[], repoRoot: string): TelemetryTuple[] {
  const sanitize = createSanitizer(repoRoot);
  const framework_metadata: FrameworkMetadata = detectFrameworkMeta(repoRoot);
  const tuples: TelemetryTuple[] = [];

  for (const f of findings) {
    if (f.severity !== "crash" && f.severity !== "error") continue;

    const specRaw = f.repro?.specPath ? readFileIfExists(f.repro.specPath) : null;
    const patchRaw =
      f.heal?.status === "healed" && f.heal.patchPath
        ? readFileIfExists(f.heal.patchPath)
        : null;

    tuples.push({
      crash_fingerprint: f.fingerprint,
      min_repro_spec: specRaw ? sanitize.text(specRaw) : null,
      verified_patch: patchRaw ? sanitize.text(patchRaw) : null,
      framework_metadata,
      model_tier_used: f.heal?.model ?? null,
    });
  }

  return tuples;
}

function persistDataset(repoRoot: string, tuples: TelemetryTuple[]): string | null {
  if (tuples.length === 0) return null;
  const dir = path.join(repoRoot, ".aztrx", "telemetry");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "dataset.jsonl");
  const lines = tuples.map((t) => JSON.stringify(t)).join("\n") + "\n";
  fs.appendFileSync(file, lines, "utf-8");
  return file;
}

/** Fire-and-forget upload. Never rejects; bounded by a short abort. */
export function dispatchTelemetry(
  envelope: TelemetryEnvelope,
  endpoint: string,
  apiKey?: string
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  return fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
    signal: ctrl.signal,
  })
    .then(() => {})
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

/** Collect + sanitize + persist, and (under `--share-data`) dispatch. Sync on
 * the local path; the upload is detached so the run never waits on the network. */
export function submitTelemetry(findings: Finding[], opts: SubmitOptions): void {
  const share = Boolean(opts.shareData);
  if (!opts.telemetry && !share) return;

  const tuples = buildTuples(findings, opts.repoRoot);
  if (tuples.length === 0) return;

  persistDataset(opts.repoRoot, tuples);

  if (share) {
    const envelope: TelemetryEnvelope = {
      schema: "aztrx.telemetry/1",
      sentAt: new Date().toISOString(),
      tuples,
    };
    const apiKey = opts.apiKey ?? process.env.AZTRX_API_KEY;
    pendingUploads.push(dispatchTelemetry(envelope, opts.endpoint ?? DEFAULT_ENDPOINT, apiKey));
  }
}

/** Await all in-flight uploads (each already bounded). Called right before the
 * CLI exits so a pending upload isn't killed mid-flight; never affects exit code. */
export async function flushTelemetry(): Promise<void> {
  while (pendingUploads.length) {
    const batch = pendingUploads.splice(0);
    await Promise.allSettled(batch);
  }
}
