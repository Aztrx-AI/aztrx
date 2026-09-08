/**
 * Cross-run memory for `aztrx patrol`. Where `RunLog` is append-only and reset
 * every run, this is a small index of "have I seen this fingerprint before, and
 * what happened to it?" — the thing that stops an autonomous loop from re-fixing
 * the same bug and re-opening the same PR on every cycle.
 *
 * Lives at `.aztrx/patrol.json` (already gitignored via `.aztrx/`). A fingerprint
 * absent from the map is implicitly "new".
 */

import * as fs from "fs";
import * as path from "path";

export type FingerprintStatus = "pr-opened" | "unfixed";

export interface FingerprintEntry {
  status: FingerprintStatus;
  firstSeen: string;
  lastSeen: string;
  prUrl?: string;
  branch?: string;
  attempts: number;
}

interface PatrolFile {
  url: string;
  fingerprints: Record<string, FingerprintEntry>;
}

export class PatrolState {
  private readonly file: string;
  private data: PatrolFile;

  constructor(repoRoot: string, url: string) {
    const dir = path.join(repoRoot, ".aztrx");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "patrol.json");
    this.data = this.read();
    this.data.url = url;
  }

  private read(): PatrolFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      return { url: raw.url ?? "", fingerprints: raw.fingerprints ?? {} };
    } catch {
      return { url: "", fingerprints: {} };
    }
  }

  /** A fingerprint is "handled" once a PR is open or it's been marked unfixable. */
  isHandled(fp: string): boolean {
    return this.data.fingerprints[fp] !== undefined;
  }

  markPr(fp: string, prUrl: string, branch: string): void {
    this.data.fingerprints[fp] = {
      status: "pr-opened",
      firstSeen: this.firstSeen(fp),
      lastSeen: new Date().toISOString(),
      prUrl,
      branch,
      attempts: this.attempts(fp) + 1,
    };
  }

  markUnfixed(fp: string): void {
    this.data.fingerprints[fp] = {
      status: "unfixed",
      firstSeen: this.firstSeen(fp),
      lastSeen: new Date().toISOString(),
      attempts: this.attempts(fp) + 1,
    };
  }

  private firstSeen(fp: string): string {
    return this.data.fingerprints[fp]?.firstSeen ?? new Date().toISOString();
  }

  private attempts(fp: string): number {
    return this.data.fingerprints[fp]?.attempts ?? 0;
  }

  save(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + "\n", "utf-8");
  }
}
