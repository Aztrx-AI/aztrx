import type { DiscoveryTrace } from "../discovery/types.js";

/** Telemetry payload schema — the data-flywheel columnar tuple. Flat on purpose
 * so a record can be appended to a JSONL dataset as-is and loaded into any
 * columnar store later. Everything in here has already passed the sanitizer. */

export interface FrameworkMetadata {
  /** Detected framework name, e.g. "Next.js", "Vite", "unknown". */
  framework: string;
  /** The installed version range from package.json, e.g. "^16.3.2". */
  version?: string;
}

export interface TelemetryTuple {
  /** Stable stack fingerprint — already a hash, carries no source text. */
  crash_fingerprint: string;
  /** Sanitized minimized Playwright spec (repro steps), or null if none. */
  min_repro_spec: string | null;
  /** Sanitized verified patch diff, or null if healing didn't produce a fix. */
  verified_patch: string | null;
  framework_metadata: FrameworkMetadata;
  /** The model tier that produced the winning patch, or null. */
  model_tier_used: string | null;
}

export interface TelemetryEnvelope {
  schema: "aztrx.telemetry/1";
  /** ISO timestamp. */
  sentAt: string;
  tuples: TelemetryTuple[];
}

/** What happened to a mission's hypothesis — distinct from `ReproVerdict`
 * (`types.ts`), which asks how reliably an already-confirmed finding
 * replays. `verified_bug`/`disproven` only fire when the mission actually
 * ran its probe to completion; a crashed browser or an exhausted budget is
 * `environment_failure`/`invalid_test`, never a silent `disproven` — a
 * negative-example dataset is only as good as that distinction. */
export type EpisodeVerdict =
  | "verified_bug"
  | "disproven"
  | "flaky"
  | "duplicate"
  | "invalid_test"
  | "environment_failure"
  | "unknown";

/** One mission's attempt to test one hypothesis, logged regardless of
 * outcome — the negative examples (`disproven`) are the point as much as the
 * positive ones. Sanitized the same way as `TelemetryTuple` before it ever
 * touches disk. */
export interface EpisodeRecord {
  schema_version: 1;
  record_type: "episode";
  mission_id: string;
  role_id: string;
  /** The role's mission text (its goal/hypothesis), sanitized. */
  hypothesis: string;
  /** Coarse, human-read-able signals about the mission (role/mode/behavior) —
   * not a chain-of-thought dump. */
  signals: string[];
  actions_attempted: number;
  verdict: EpisodeVerdict;
  /** Fingerprints of any findings this mission produced. */
  finding_ids: string[];
  duration_ms: number;
  /** Sanitized exception message, when the mission didn't complete cleanly. */
  error: string | null;
  /** Invariant-discovery stages, when the mission ran that behavior: evidence
   * observed, inferred invariant + confidence, experiment plan, actions,
   * before/after state and verdict per state. Additive; absent otherwise. */
  discovery?: DiscoveryTrace[];
}

export interface EpisodeEnvelope {
  schema: "aztrx.episode/1";
  sentAt: string;
  episodes: EpisodeRecord[];
}
