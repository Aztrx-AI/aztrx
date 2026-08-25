/**
 * Ingest schema for the Aztrx cloud API (api.aztrx.app). These types are the
 * wire contract; the CLI side mirrors them in `src/core/cloud/index.ts`. Every
 * field arriving here has already passed the CLI sanitizer, but the server
 * treats payloads as untrusted and stores them verbatim — it never interprets
 * them, only keys the dedup store off the fingerprint.
 */

export interface OrgKey {
  /** Stable org slug — the dashboard namespace for a paying team. */
  org: string;
  /** Human label shown in the dashboard. */
  label?: string;
}

export interface ReproSummary {
  verdict: string;
  rate: number;
  runs: number;
  reproductions: number;
  /** Sanitized Playwright spec source, or null. */
  spec: string | null;
}

export interface FindingUpload {
  /** Stable stack fingerprint — the dedup key. */
  fingerprint: string;
  severity: string;
  type: string;
  /** Sanitized headline message. */
  message: string;
  location?: { file: string; line: number; column: number };
  repro?: ReproSummary;
  /** Sanitized unified patch diff, or null. */
  patch?: string | null;
  /** Model tier that produced the patch, or null. */
  model_tier?: string | null;
}

export interface RunUpload {
  schema: "aztrx.run/1";
  sentAt: string;
  framework: string;
  framework_version?: string;
  /** Sanitized target URL. */
  target: string;
  mode: string;
  counts: Record<string, number>;
  findings: FindingUpload[];
}

export interface TelemetryTupleUpload {
  crash_fingerprint: string;
  min_repro_spec: string | null;
  verified_patch: string | null;
  framework_metadata: { framework: string; version?: string };
  model_tier_used: string | null;
}

export interface TelemetryEnvelopeUpload {
  schema: "aztrx.telemetry/1";
  sentAt: string;
  tuples: TelemetryTupleUpload[];
}

/** Canonical, deduplicated finding record — one per fingerprint per org. */
export interface StoredFinding {
  fingerprint: string;
  first_seen: string;
  last_seen: string;
  /** Total sightings of this fingerprint across all team runs. */
  occurrences: number;
  /** Number of distinct runs that carried this fingerprint. */
  seen_runs: number;
  latest: FindingUpload & { run_id: string; seen_at: string };
}
