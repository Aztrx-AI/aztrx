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
