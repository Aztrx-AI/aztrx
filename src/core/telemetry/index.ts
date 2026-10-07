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
import pc from "picocolors";
import type { Finding } from "../types.js";
import type { DiscoveryRunReport, DiscoveryTrace } from "../discovery/types.js";
import { detectFrameworkMeta } from "../init.js";
import { createSanitizer } from "./sanitize.js";
import type {
  EpisodeEnvelope,
  EpisodeRecord,
  EpisodeVerdict,
  FrameworkMetadata,
  TelemetryEnvelope,
  TelemetryTuple,
} from "./types.js";

const DEFAULT_ENDPOINT =
  process.env.AZTRX_TELEMETRY_URL || "https://api.aztrx.app/api/telemetry";
const UPLOAD_TIMEOUT_MS = 2000;

/** One dim line on stderr — the only place a detached upload can report. */
function warn(msg: string): void {
  process.stderr.write(pc.dim(`aztrx: ${msg}\n`));
}

/** In-flight uploads, drained by `flushTelemetry()` before the CLI exits. */
const pendingUploads: Promise<void>[] = [];

export interface SubmitOptions {
  repoRoot: string;
  url: string;
  telemetry: boolean;
  shareData: boolean;
  endpoint?: string;
  /** API key presented as `x-api-key` (falls back to `AZTRX_CLOUD_API_KEY`).
   *  Deliberately not `AZTRX_API_KEY` — that one is a model provider credential
   *  (`llm.ts:29,35`) and must never travel as an upload auth header. */
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

/** Fire-and-forget upload, shared by the telemetry-tuple and episode envelopes.
 * Never rejects; bounded by a short abort. Failures are reported on stderr
 * rather than discarded — silence here reads as success. */
function postEnvelope(label: string, envelope: unknown, endpoint: string, apiKey?: string): Promise<void> {
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
    .then((res) => {
      // `fetch` resolves on 4xx/5xx too — without this check a rejected upload
      // is indistinguishable from a delivered one.
      if (!res.ok) warn(`${label} upload rejected — HTTP ${res.status} from ${endpoint}`);
    })
    .catch((e: unknown) => {
      const why =
        e instanceof Error && e.name === "AbortError"
          ? `no response within ${UPLOAD_TIMEOUT_MS}ms`
          : e instanceof Error
            ? e.message
            : String(e);
      warn(`${label} upload failed — ${why}`);
    })
    .finally(() => clearTimeout(timer));
}

/** Fire-and-forget upload. Never rejects; bounded by a short abort. */
export function dispatchTelemetry(
  envelope: TelemetryEnvelope,
  endpoint: string,
  apiKey?: string
): Promise<void> {
  return postEnvelope("telemetry", envelope, endpoint, apiKey);
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
    const apiKey = opts.apiKey ?? process.env.AZTRX_CLOUD_API_KEY;
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

export interface EpisodeSubmitOptions {
  repoRoot: string;
  telemetry: boolean;
  shareData: boolean;
  endpoint?: string;
  apiKey?: string;
}

/** Raw, unsanitized inputs for one mission's episode — `submitEpisode` sanitizes
 * `hypothesis`/`error` the same way `buildTuples` sanitizes repro specs. */
export interface RawEpisode {
  missionId: string;
  roleId: string;
  hypothesis: string;
  signals: string[];
  actionsAttempted: number;
  verdict: EpisodeVerdict;
  findingIds: string[];
  /** Raw discovery traces; every string in them is sanitized before it is persisted or shared. */
  discovery?: DiscoveryTrace[];
  discoveryRun?: DiscoveryRunReport;
  durationMs: number;
  error?: string | null;
}

/** Deep-copy a JSON-shaped value with every string passed through the sanitizer.
 * Discovery traces carry code fragments and urls, which must clear the same
 * boundary as every other episode field. */
function sanitizeDeep<T>(value: T, text: (s: string) => string): T {
  if (typeof value === "string") return text(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, text)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeDeep(v, text);
    return out as T;
  }
  return value;
}

function persistEpisodes(repoRoot: string, records: EpisodeRecord[]): void {
  if (records.length === 0) return;
  const dir = path.join(repoRoot, ".aztrx", "telemetry");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "episodes.jsonl");
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(file, lines, "utf-8");
}

/** Finalize + persist one mission's episode, and (under `--share-data`)
 * dispatch it. Called from the mission pool's `finally` so a crashed browser
 * or an exhausted budget still leaves a record — only `submitTelemetry`'s
 * caller waits for findings to exist first; this one doesn't get to wait. */
export function submitEpisode(raw: RawEpisode, opts: EpisodeSubmitOptions): void {
  if (!opts.telemetry && !opts.shareData) return;

  const sanitize = createSanitizer(opts.repoRoot);
  const record: EpisodeRecord = {
    schema_version: 1,
    record_type: "episode",
    mission_id: raw.missionId,
    role_id: raw.roleId,
    hypothesis: sanitize.text(raw.hypothesis),
    signals: raw.signals,
    actions_attempted: raw.actionsAttempted,
    verdict: raw.verdict,
    finding_ids: raw.findingIds,
    duration_ms: raw.durationMs,
    error: raw.error ? sanitize.text(raw.error) : null,
    ...(raw.discoveryRun ? { discovery_run: sanitizeDeep(raw.discoveryRun, (s) => sanitize.text(s)) } : {}),
    ...(raw.discovery && raw.discovery.length > 0
      ? { discovery: sanitizeDeep(raw.discovery, (s) => sanitize.text(s)) }
      : {}),
  };

  persistEpisodes(opts.repoRoot, [record]);

  if (opts.shareData) {
    const envelope: EpisodeEnvelope = {
      schema: "aztrx.episode/1",
      sentAt: new Date().toISOString(),
      episodes: [record],
    };
    const apiKey = opts.apiKey ?? process.env.AZTRX_CLOUD_API_KEY;
    const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    pendingUploads.push(postEnvelope("episode", envelope, endpoint, apiKey));
  }
}
