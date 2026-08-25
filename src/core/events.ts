import * as fs from "fs";
import * as path from "path";
import type { Finding, ReproVerdict } from "./types.js";

export type RunEvent =
  | { type: "run_start"; url: string; ts: number }
  | { type: "finding"; finding: Finding }
  | {
      type: "repro";
      fingerprint: string;
      verdict: ReproVerdict;
      runs: number;
      reproductions: number;
      steps: number;
      totalSteps: number;
      specPath: string;
    }
  | { type: "run_end"; counts: Record<string, number>; ts: number };

/**
 * Append-only JSON-lines run log. Every run writes its lifecycle + findings
 * here so a live surface (Local Studio, later the cloud sink) can tail it
 * without coupling to the orchestrator's console output.
 */
export class RunLog {
  private readonly file: string;

  constructor(repoRoot: string) {
    const dir = path.join(repoRoot, ".aztrx");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "events.jsonl");
  }

  append(event: RunEvent): void {
    fs.appendFileSync(this.file, JSON.stringify(event) + "\n", "utf-8");
  }

  /** Truncate so the log represents the latest run only (live-tail semantics). */
  reset(): void {
    fs.writeFileSync(this.file, "", "utf-8");
  }

  get path(): string {
    return this.file;
  }
}
