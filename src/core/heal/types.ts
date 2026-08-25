import type { Finding, RecordedAction } from "../types.js";

export type HealStatus =
  | "healed" // patch applied in sandbox and verified (bug no longer reproduces)
  | "unfixed" // patch applied but the bug still reproduces
  | "rejected" // AST safety gates rejected the patch
  | "compile-failed" // tsc --noEmit rejected the patch
  | "apply-failed" // hunks did not match exactly (or were ambiguous)
  | "skipped" // no healable target (no own-code location / no deterministic repro)
  | "no-llm"; // no LLM configured and no injected patch generator

/** One Search & Replace edit. `search` is an exact, unique substring of the
 * source file; `replace` is its replacement. */
export interface PatchHunk {
  search: string;
  replace: string;
}

export interface Patch {
  explanation: string;
  hunks: PatchHunk[];
}

export interface GateViolation {
  rule: string;
  detail: string;
}

export interface GateResult {
  ok: boolean;
  violations: GateViolation[];
}

/** Context handed to the patch generator. `redactedContent` is what may leave
 * the machine; `fileContent` is the raw bytes used for applying the edit. */
export interface HealContext {
  finding: Finding;
  filePath: string;
  fileContent: string;
  redactedContent: string;
}

export interface VerifyResult {
  runs: number;
  reproductions: number;
  fixed: boolean;
}

export interface HealOptions {
  repoRoot: string;
  url: string;
  /** Minimized repro actions (F7 output). */
  actions: RecordedAction[];
  fingerprint: string;
  allowHosts: string[];
  /** Fallback model (the last tier tried). Defaults to `claude-sonnet-5`. */
  model?: string;
  /** Fast/cheap first tier. Defaults to `claude-haiku-4-5` (`AZTRX_FAST_MODEL`). */
  fastModel?: string;
  /** Inject a patch generator for testing/demo (bypasses the network LLM). */
  patchFn?: (ctx: HealContext) => Promise<Patch>;
  /** Inject an app server for the patched code. Default: static file server. */
  serve?: (worktreeDir: string, filePath: string) => Promise<{ url: string; close: () => Promise<void> }>;
  verifyRuns?: number;
}

export interface HealResult {
  status: HealStatus;
  findingId: string;
  filePath: string;
  explanation?: string;
  hunks: PatchHunk[];
  violations: GateViolation[];
  verification?: VerifyResult;
  /** Path to the saved unified-diff patch artifact (.aztrx/heal/…, gitignored). */
  patchPath?: string;
  error?: string;
  /** Model that produced the returned patch (the winning tier). */
  model?: string;
  /** All tiers attempted, in order, for observability in the PR bot. */
  tiers?: string[];
}
