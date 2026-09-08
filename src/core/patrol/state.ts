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
  private readonly cooldownMs: number;
  private data: PatrolFile;

  constructor(repoRoot: string, url: string, cooldownMs = 30 * 60 * 1000) {
    const dir = path.join(repoRoot, ".aztrx");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "patrol.json");
    this.cooldownMs = cooldownMs;
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

  /**
   * A fingerprint is "handled" while its PR is open, or while an `unfixed` mark
   * is still within its cooldown. Once the cooldown lapses, an `unfixed` bug
   * becomes retry-eligible again — it stops being "handled" and `run()` heals it
   * afresh rather than skipping it forever.
   */
  isHandled(fp: string, now = Date.now()): boolean {
    const e = this.data.fingerprints[fp];
    if (!e) return false;
    if (e.status === "pr-opened") return true;
    return now - Date.parse(e.lastSeen) < this.cooldownMs;
  }

  /** Every currently-handled fingerprint, so the supervisor can tell `run()` to skip healing them. */
  handled(now = Date.now()): string[] {
    return Object.keys(this.data.fingerprints).filter((fp) => this.isHandled(fp, now));
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
