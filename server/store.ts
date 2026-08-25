import * as fs from "fs";
import * as path from "path";
import type { FindingUpload, RunUpload, StoredFinding, TelemetryTupleUpload } from "./types.js";

/** Sanitize a path segment so org slugs and fingerprints can't traverse the
 * data dir or inject separators. */
function safeSegment(s: string): string {
  const seg = s.replace(/[^a-zA-Z0-9._-]/g, "_");
  return seg === "" ? "_" : seg;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

export interface DedupResult {
  fingerprint: string;
  isNew: boolean;
  occurrences: number;
}

export interface RunRecord {
  run_id: string;
  sentAt: string;
  framework: string;
  framework_version?: string;
  target: string;
  mode: string;
  counts: Record<string, number>;
  findings: string[];
}

/**
 * JSON-file-backed store. One canonical record per crash fingerprint per org —
 * the dedup layer. Re-seeing a fingerprint across runs bumps `occurrences` /
 * `seen_runs` and refreshes `latest`; run records always list which
 * fingerprints they carried, so the dashboard can rebuild the timeline.
 */
export class Store {
  constructor(private readonly dataDir: string) {}

  private findingsDir(org: string): string {
    return path.join(this.dataDir, "orgs", safeSegment(org), "findings");
  }

  private runsDir(org: string): string {
    return path.join(this.dataDir, "orgs", safeSegment(org), "runs");
  }

  private telemetryDir(org: string): string {
    return path.join(this.dataDir, "orgs", safeSegment(org), "telemetry");
  }

  recordRun(org: string, runId: string, run: RunUpload): DedupResult[] {
    const record: RunRecord = {
      run_id: runId,
      sentAt: run.sentAt,
      framework: run.framework,
      framework_version: run.framework_version,
      target: run.target,
      mode: run.mode,
      counts: run.counts,
      findings: run.findings.map((f) => f.fingerprint),
    };
    writeJson(path.join(this.runsDir(org), `${safeSegment(runId)}.json`), record);

    const results: DedupResult[] = [];
    for (const f of run.findings) {
      const file = path.join(this.findingsDir(org), `${safeSegment(f.fingerprint)}.json`);
      const existing = readJson<StoredFinding | null>(file, null);
      if (existing) {
        existing.last_seen = run.sentAt;
        existing.occurrences += 1;
        existing.seen_runs += 1;
        existing.latest = { ...f, run_id: runId, seen_at: run.sentAt };
        writeJson(file, existing);
        results.push({ fingerprint: f.fingerprint, isNew: false, occurrences: existing.occurrences });
      } else {
        const created: StoredFinding = {
          fingerprint: f.fingerprint,
          first_seen: run.sentAt,
          last_seen: run.sentAt,
          occurrences: 1,
          seen_runs: 1,
          latest: { ...f, run_id: runId, seen_at: run.sentAt },
        };
        writeJson(file, created);
        results.push({ fingerprint: f.fingerprint, isNew: true, occurrences: 1 });
      }
    }
    return results;
  }

  recordTelemetry(org: string, tuples: TelemetryTupleUpload[]): DedupResult[] {
    const dir = this.telemetryDir(org);
    const results: DedupResult[] = [];
    for (const t of tuples) {
      const fp = t.crash_fingerprint;
      const file = path.join(dir, `${safeSegment(fp)}.json`);
      const now = new Date().toISOString();
      const existing = readJson<{ occurrences: number; latest: TelemetryTupleUpload } | null>(file, null);
      if (existing) {
        existing.occurrences += 1;
        existing.latest = t;
        writeJson(file, { ...existing, last_seen: now });
        results.push({ fingerprint: fp, isNew: false, occurrences: existing.occurrences });
      } else {
        writeJson(file, { fingerprint: fp, occurrences: 1, first_seen: now, last_seen: now, latest: t });
        results.push({ fingerprint: fp, isNew: true, occurrences: 1 });
      }
    }
    return results;
  }

  listFindings(org: string): StoredFinding[] {
    const dir = this.findingsDir(org);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => readJson<StoredFinding | null>(path.join(dir, n), null))
      .filter((f): f is StoredFinding => f !== null)
      .sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
  }

  listRuns(org: string): RunRecord[] {
    const dir = this.runsDir(org);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => readJson<RunRecord | null>(path.join(dir, n), null))
      .filter((r): r is RunRecord => r !== null)
      .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
  }
}
