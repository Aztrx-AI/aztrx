/**
 * The three tools, their schemas, and the handlers behind them.
 *
 * `aztrx_scan` finds and proves; `aztrx_repro` shows one finding's steps;
 * `aztrx_fix` patches and verifies. The split is about the agent's context
 * budget, not about the code: a `Finding` carries a whole minimized action
 * sequence and a compiled spec, and a fix carries a diff — inlining all of that
 * into every scan response is how a useful call becomes an expensive one. The
 * scan returns a compact projection and a handle; detail is fetched by handle.
 *
 * Sessions are gone from the protocol in `2026-07-28` and never existed in this
 * design. Cross-call state is an explicit, opaque, server-minted `scanId` held in
 * a bounded in-memory map — which is easier to reason about than hidden state, and
 * is exactly what the spec recommends for stateful tools.
 *
 * Nothing here imports the orchestrator, Playwright, or the heal stack. Those are
 * `await import()`ed on first use, because an editor kills a server that is slow
 * to answer `initialize` and `core/orchestrator.js` costs ~1.7s to load.
 */

import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { HealOptions, HealResult } from "../core/heal/types.js";
import type { RunOptions } from "../core/orchestrator.js";
import type { Finding, RecordedAction } from "../core/types.js";
import { ProtocolError, INVALID_PARAMS } from "./protocol.js";

/** How many scans stay addressable. An editor session is one developer and a
 * handful of scans; older handles fall off the end, oldest first, and a call
 * against an evicted one says so and asks for a re-scan. */
const MAX_RECORDS = 8;

/** Boot can legitimately take a while (cold Next.js compile). Matches the CLI's
 * own ceiling in `core/devServer.ts`. */
const BOOT_TIMEOUT_MS = 90_000;

export interface TextBlock {
  type: "text";
  text: string;
}

/** A tool result. `isError` marks a tool that *ran* and could not do the job —
 * distinct from a protocol error, which is about the request itself. */
export interface ToolCallResult {
  content: TextBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const SCAN_ID_DESC = "The `scanId` returned by aztrx_scan.";

export const TOOLS: ToolDefinition[] = [
  {
    name: "aztrx_scan",
    title: "Scan a running web app for runtime crashes",
    description:
      "Drive the app in a real browser, interact with it, and report the runtime crashes and " +
      "errors it produced. With no `url`, aztrx detects the framework, boots the dev server " +
      "itself, and stops it again afterwards. Returns a compact list; each finding has an `id` " +
      "that aztrx_repro and aztrx_fix take. A scan that could not run returns an error — it " +
      "never reports 'no findings' for an app it never reached. Takes tens of seconds. Results " +
      "are held in memory for the last 8 scans.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: {
          type: "string",
          description:
            "Project root to scan (defaults to the directory the server was started in).",
        },
        url: {
          type: "string",
          description:
            "Dev server to scan, e.g. http://localhost:3000. Omit and aztrx finds a running " +
            "server or boots the project's own.",
        },
        maxActions: {
          type: "integer",
          minimum: 1,
          maximum: 5000,
          description: "How many interactions to attempt in one pass (default 100).",
        },
        runs: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Replay iterations used to judge each finding reproducible (default 3).",
        },
        seed: {
          type: "integer",
          minimum: 0,
          maximum: 2147483647,
          description: "RNG seed. The same seed walks the app the same way (default 42).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "aztrx_repro",
    title: "Show how to reproduce one finding",
    description:
      "The minimized action sequence that reproduces one finding from a scan, the reproducibility " +
      "verdict (deterministic | flaky | unreliable), and the compiled Playwright spec. Reads the " +
      "scan that already ran — it re-runs nothing, and is free.",
    inputSchema: {
      type: "object",
      properties: {
        scanId: { type: "string", description: SCAN_ID_DESC },
        findingId: { type: "string", description: "A finding `id` from that scan." },
      },
      required: ["scanId", "findingId"],
      additionalProperties: false,
    },
  },
  {
    name: "aztrx_fix",
    title: "Patch a finding and verify the crash is gone",
    description:
      "Closed loop for one finding: generate a patch, apply it inside a git worktree, then replay " +
      "the repro against the patched app to check the crash is actually gone. Your working tree is " +
      "touched only when you pass `apply: true`, and aztrx never commits. Needs ANTHROPIC_API_KEY — " +
      "without one the status comes back `no-llm` and nothing is attempted. Costs a model call and " +
      "takes minutes; the result is cached, so a second call with `apply: true` reuses it.",
    inputSchema: {
      type: "object",
      properties: {
        scanId: { type: "string", description: SCAN_ID_DESC },
        findingId: { type: "string", description: "A finding `id` from that scan." },
        apply: {
          type: "boolean",
          description:
            "Write the verified patch into your working tree (default false — the diff is returned " +
            "either way). Only a patch that verified is ever applied.",
        },
      },
      required: ["scanId", "findingId"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A tool result carrying both the readable summary and the machine shape.
 *
 * The serialized JSON also goes into a text block because that is what the spec
 * asks of any tool returning `structuredContent` — a client on an older revision
 * has no `structuredContent` to read and would otherwise get the summary alone. */
function ok(summary: string, structured: unknown): ToolCallResult {
  return {
    content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(structured, null, 2)}` }],
    structuredContent: structured,
  };
}

/** A tool execution error: actionable feedback the model can retry on.
 *
 * Deliberately carries no `structuredContent`. A failed scan must never be
 * readable as a result — an agent that sees `counts: {crash: 0}` and an error
 * message will act on the zero. "Nothing is broken" and "nothing was looked at"
 * are different sentences, and this is the place that keeps them apart. */
function fail(message: string): ToolCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function readText(file: string | undefined): string | null {
  if (!file) return null;
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** `value` is undefined when the argument was simply absent. A failure is a
 * message, never a throw: a bad argument is something the model can fix. */
type Arg<T> = { ok: true; value: T | undefined } | { ok: false; error: string };

function argString(args: Record<string, unknown>, key: string, max = 4096): Arg<string> {
  const raw = args[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return { ok: false, error: `\`${key}\` must be a string, got ${typeof raw}.` };
  }
  if (raw.length > max) return { ok: false, error: `\`${key}\` is longer than ${max} characters.` };
  return { ok: true, value: raw };
}

function argInt(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): Arg<number> {
  const raw = args[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return { ok: false, error: `\`${key}\` must be an integer.` };
  }
  if (raw < min || raw > max) {
    return { ok: false, error: `\`${key}\` must be between ${min} and ${max}.` };
  }
  return { ok: true, value: raw };
}

function argBool(args: Record<string, unknown>, key: string): Arg<boolean> {
  const raw = args[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "boolean") return { ok: false, error: `\`${key}\` must be true or false.` };
  return { ok: true, value: raw };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface ScanRecord {
  scanId: string;
  repoRoot: string;
  url: string;
  findings: Finding[];
  /** Heal results already paid for, so `apply: true` after a review call does not
   * buy the same patch twice. */
  heals: Map<string, HealResult>;
  createdAt: number;
}

export type RunFn = (opts: RunOptions) => Promise<Finding[]>;
export type HealFn = (finding: Finding, opts: HealOptions) => Promise<HealResult>;

export interface RuntimeDeps {
  /** Loaded on first use, never at module load. Injectable so the dispatch and
   * purity tests can run without a browser. */
  loadRun?: () => Promise<RunFn>;
  loadHeal?: () => Promise<HealFn>;
  /** Project used when a tool call does not name one. */
  defaultRepoRoot?: string;
}

type TargetResolution =
  | { ok: true; url: string; close?: () => Promise<void> }
  | { ok: false; error: string };

export class McpRuntime {
  private records = new Map<string, ScanRecord>();
  /** Dev servers this process booted and has not yet stopped. The server tears
   * these down on shutdown — a scan interrupted by a closing editor must not
   * leave a dev server holding its port. */
  private openTargets = new Set<() => Promise<void>>();
  /** Scans and fixes run one at a time; see `serialize`. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private deps: RuntimeDeps = {}) {}

  async call(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    switch (name) {
      case "aztrx_scan":
        return this.scan(args);
      case "aztrx_repro":
        return this.repro(args);
      case "aztrx_fix":
        return this.fix(args);
      default:
        throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${name}`);
    }
  }

  /** Stop every dev server this process started. Idempotent. */
  async closeAll(): Promise<void> {
    const pending = [...this.openTargets];
    this.openTargets.clear();
    await Promise.all(pending.map((close) => close().catch(() => {})));
  }

  /** One scanning run at a time.
   *
   * `run()` truncates `.aztrx/events.jsonl` and rewrites `.aztrx/report.html` and
   * `.aztrx/repro/<id>.spec.ts`, and a zero-config scan boots a dev server on a
   * port it picked. Two overlapping runs in one repo therefore corrupt each
   * other's artifacts and race for the port — and an MCP client can pipeline
   * requests, so this is a real case rather than a theoretical one. `heal`
   * creates git worktrees and boots servers of its own, so it shares the queue. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private defaultRepo(): string {
    return this.deps.defaultRepoRoot ?? process.cwd();
  }

  private async loadRun(): Promise<RunFn> {
    if (this.deps.loadRun) return this.deps.loadRun();
    return (await import("../core/orchestrator.js")).run;
  }

  private async loadHeal(): Promise<HealFn> {
    if (this.deps.loadHeal) return this.deps.loadHeal();
    return (await import("../core/heal/index.js")).heal;
  }

  private remember(record: ScanRecord): void {
    this.records.set(record.scanId, record);
    while (this.records.size > MAX_RECORDS) {
      const oldest = [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      this.records.delete(oldest.scanId);
    }
  }

  // -------------------------------------------------------------------------
  // aztrx_scan
  // -------------------------------------------------------------------------

  private async scan(args: Record<string, unknown>): Promise<ToolCallResult> {
    const repoArg = argString(args, "repoPath");
    if (!repoArg.ok) return fail(repoArg.error);
    const urlArg = argString(args, "url", 2048);
    if (!urlArg.ok) return fail(urlArg.error);
    const maxActions = argInt(args, "maxActions", 1, 5000);
    if (!maxActions.ok) return fail(maxActions.error);
    const runs = argInt(args, "runs", 1, 20);
    if (!runs.ok) return fail(runs.error);
    const seed = argInt(args, "seed", 0, 2147483647);
    if (!seed.ok) return fail(seed.error);

    const repoRoot = path.resolve(repoArg.value ?? this.defaultRepo());
    if (!fs.existsSync(repoRoot)) return fail(`repoPath does not exist: ${repoRoot}`);

    const url = urlArg.value;
    if (url !== undefined) {
      try {
        new URL(url);
      } catch {
        return fail(`\`url\` is not a valid URL: ${url}`);
      }
    }

    return this.serialize(async () => {
      let targetUrl = url;
      let bootedClose: (() => Promise<void>) | undefined;
      let how = "given";
      try {
        if (targetUrl === undefined) {
          const resolved = await this.bootOrAttach(repoRoot);
          if (!resolved.ok) {
            // Not a clean scan. The caller gets an error, never an empty finding
            // list — see the note on `fail`.
            return fail(resolved.error);
          }
          targetUrl = resolved.url;
          how = resolved.close ? "booted" : "attached";
          if (resolved.close) {
            bootedClose = resolved.close;
            this.openTargets.add(resolved.close);
          }
        }

        const run = await this.loadRun();
        const findings = await run({
          url: targetUrl,
          repoRoot,
          // "Emit nothing; the caller renders" — which here means "the caller
          // speaks a protocol on stdout". See the purity guard in index.ts.
          ui: true,
          // Repro is on because `aztrx_repro` and `aztrx_fix` read what this
          // produced. Healing is off: it is a separate, paid, minutes-long call.
          repro: true,
          maxActions: maxActions.value,
          reproRuns: runs.value,
          seed: seed.value,
        });

        const scanId = randomUUID();
        this.remember({
          scanId,
          repoRoot,
          url: targetUrl,
          findings,
          heals: new Map(),
          createdAt: Date.now(),
        });

        const counts = {
          crash: findings.filter((f) => f.severity === "crash").length,
          error: findings.filter((f) => f.severity === "error").length,
          warning: findings.filter((f) => f.severity === "warning").length,
        };
        const structured = {
          scanId,
          url: targetUrl,
          repoRoot,
          counts,
          findings: findings.map(projectFinding),
        };

        const critical = counts.crash + counts.error;
        const where = how === "attached" ? "attached to" : how === "booted" ? "booted" : "scanned";
        const head =
          critical === 0
            ? `Clean scan — ${where} ${targetUrl}, no crash or error.`
            : `Found ${counts.crash} crash and ${counts.error} error (${counts.warning} warning) — ${where} ${targetUrl}.`;
        const next =
          findings.length > 0
            ? `\nNext: aztrx_repro { scanId: "${scanId}", findingId } for the steps, aztrx_fix for a patch.`
            : "";
        return ok(head + next, structured);
      } catch (e) {
        return fail(`The scan failed: ${(e as Error).message}`);
      } finally {
        // The app was only needed for the scan. `heal` boots the *worktree*, not
        // this server, so holding it open between calls would just be an orphan
        // dev server on the developer's machine.
        if (bootedClose) await this.release(bootedClose);
      }
    });
  }

  /** Find a running app, or start the project's own.
   *
   * `core/devServer.ts`'s `resolveTarget` does this too, but it also arms
   * `process.once("SIGINT"/"SIGTERM")` handlers that are never removed and that
   * call `process.exit` themselves. That is right for a CLI about to exit, and
   * wrong for a process that will serve an editor for hours: the sixth scan trips
   * MaxListenersExceededWarning, and the first Ctrl-C kills the server before it
   * can tear the dev server down. So the same three steps are run here, and the
   * close hook is handed back instead of wired to a signal. */
  private async bootOrAttach(repoRoot: string): Promise<TargetResolution> {
    const [{ planBoot, findRunning }, { bootServer }] = await Promise.all([
      import("../core/devServer.js"),
      import("../core/heal/boot.js"),
    ]);

    const plan = planBoot(repoRoot);
    const running = await findRunning(repoRoot, plan);
    if (running) return { ok: true, url: running };

    if (!plan) {
      return {
        ok: false,
        error:
          "No dev server is running and package.json has no `dev` or `start` script to boot. " +
          "Pass `url`, or run `aztrx-cli init` in the project first.",
      };
    }

    try {
      const server = await bootServer({
        worktreeDir: repoRoot,
        repoRoot,
        startCommand: plan.startCommand,
        timeoutMs: BOOT_TIMEOUT_MS,
        port: plan.port,
        // The developer's own app on their own machine — it gets the real
        // environment, exactly as the CLI's zero-config boot does. `heal` keeps
        // the isolated default, because it runs a patch a model wrote.
        env: "inherit",
      });
      return { ok: true, url: server.url, close: server.close };
    } catch (e) {
      return { ok: false, error: `Could not start \`${plan.startCommand}\`: ${(e as Error).message}` };
    }
  }

  private async release(close: () => Promise<void>): Promise<void> {
    this.openTargets.delete(close);
    await close().catch(() => {});
  }

  // -------------------------------------------------------------------------
  // aztrx_repro / aztrx_fix
  // -------------------------------------------------------------------------

  /** Resolve a `{scanId, findingId}` pair to the finding, or to the message the
   * model needs. A stale handle is an ordinary, recoverable answer. */
  private resolve(
    args: Record<string, unknown>
  ): { failure: ToolCallResult } | { record: ScanRecord; finding: Finding } {
    const scanId = argString(args, "scanId", 128);
    if (!scanId.ok) return { failure: fail(scanId.error) };
    const findingId = argString(args, "findingId", 256);
    if (!findingId.ok) return { failure: fail(findingId.error) };

    if (!scanId.value) return { failure: fail("`scanId` is required — call aztrx_scan first.") };
    if (!findingId.value) return { failure: fail("`findingId` is required — ids come from aztrx_scan.") };

    const record = this.records.get(scanId.value);
    if (!record) {
      const known = [...this.records.keys()];
      return {
        failure: fail(
          `Unknown scanId ${scanId.value}. ` +
            (known.length ? `Known: ${known.join(", ")}. ` : "") +
            `Scans are held in memory for the last ${MAX_RECORDS} runs — call aztrx_scan again.`
        ),
      };
    }

    const finding = record.findings.find((f) => f.id === findingId.value);
    if (!finding) {
      const ids = record.findings.map((f) => f.id);
      return {
        failure: fail(
          `Scan ${scanId.value} has no finding ${findingId.value}. ` +
            (ids.length ? `It has: ${ids.join(", ")}.` : "It found nothing.") +
            " Note that a clean scan has no findings to fetch."
        ),
      };
    }
    return { record, finding };
  }

  private repro(args: Record<string, unknown>): ToolCallResult {
    const resolved = this.resolve(args);
    if ("failure" in resolved) return resolved.failure;
    const { record, finding } = resolved;

    const r = finding.repro;
    if (!r) {
      return fail(
        `${finding.id} carries no repro report, so there are no steps to show. ` +
          "Re-scan: aztrx always requests one, so this means the report was lost."
      );
    }

    const spec = readText(r.specPath);
    const structured = {
      scanId: record.scanId,
      findingId: finding.id,
      verdict: r.verdict,
      rate: r.rate,
      runs: r.runs,
      reproductions: r.reproductions,
      actions: r.actions,
      specPath: r.specPath ? path.relative(record.repoRoot, r.specPath).replace(/\\/g, "/") : null,
      spec,
    };

    const steps = r.actions.map((a, i) => `${i + 1}. ${describeAction(a)}`).join("\n");
    const summary =
      `${finding.id}: ${r.verdict} — reproduced in ${r.reproductions}/${r.runs} replays.\n` +
      (steps ? `\n${steps}` : "\nNo actions — the fault happens on load.") +
      (spec ? `\n\nSpec: ${structured.specPath}` : "");
    return ok(summary, structured);
  }

  private async fix(args: Record<string, unknown>): Promise<ToolCallResult> {
    const resolved = this.resolve(args);
    if ("failure" in resolved) return resolved.failure;
    const applyArg = argBool(args, "apply");
    if (!applyArg.ok) return fail(applyArg.error);
    const apply = applyArg.value === true;
    const { record, finding } = resolved;

    let healResult = record.heals.get(finding.id);
    if (!healResult) {
      // The gates `heal` applies internally, checked here so the answer is a
      // sentence about the finding rather than a `skipped` status the model has
      // to decode.
      if (!finding.mappedLocation?.isOwnCode) {
        return fail(
          `${finding.id} has no own-code source location to patch — the stack maps into a ` +
            "dependency or was never resolved to a file. Nothing to edit."
        );
      }
      if (!finding.repro || finding.repro.verdict === "unreliable") {
        return fail(
          `${finding.id} has no deterministic repro, so there is nothing to prove a patch ` +
            "against. A fix that cannot be verified is not a fix."
        );
      }

      return this.serialize(async () => {
        const healFn = await this.loadHeal();
        try {
          healResult = await healFn(finding, await this.healOptions(record, finding));
        } catch (e) {
          // `heal` creates its git worktree outside its own try/finally, so a
          // failure there rejects rather than coming back as a status. Say which
          // it was instead of letting it look like a broken tool.
          return fail(
            `Healing ${finding.id} failed before it could report a status: ${(e as Error).message}`
          );
        }
        record.heals.set(finding.id, healResult);
        return this.finishFix(record, finding, healResult, apply);
      });
    }
    return this.finishFix(record, finding, healResult, apply);
  }

  private async healOptions(record: ScanRecord, finding: Finding): Promise<HealOptions> {
    const { bootServer, detectStartCommand } = await import("../core/heal/boot.js");
    const startCommand = detectStartCommand(record.repoRoot);
    return {
      repoRoot: record.repoRoot,
      url: record.url,
      // The minimized actions the verdict was measured on, not a re-derivation.
      actions: finding.repro?.actions ?? [],
      fingerprint: finding.fingerprint,
      // Required by the type, unread by heal today. Kept because dropping a field
      // from a caller's obligation is a decision for `heal`, not for its caller.
      allowHosts: [],
      // Heal's built-in default serves the worktree as static files and addresses
      // the edited file by its repo-relative path — correct for a static fixture
      // (`index.html`), wrong for everything else, where `src/App.tsx` is not a
      // URL. So when the project has a dev script, boot the patched worktree the
      // way the app is really started; otherwise leave the default to do the job
      // it was written for. `env` stays at bootServer's isolated default.
      serve: startCommand
        ? (dir: string) =>
            bootServer({ worktreeDir: dir, repoRoot: record.repoRoot, startCommand })
        : undefined,
    };
  }

  private async finishFix(
    record: ScanRecord,
    finding: Finding,
    healResult: HealResult,
    apply: boolean
  ): Promise<ToolCallResult> {
    let applied: Array<{ filePath: string; hunkCount: number }> = [];
    let conflicts: Array<{ filePath: string; error: string }> = [];

    if (apply) {
      if (healResult.status !== "healed") {
        // Not a tool error: the answer to "fix it" is that the patch did not
        // verify, and the status names the gate that stopped it. Applying an
        // unverified patch is the one thing the gate exists to prevent.
        return this.reportFix(record, finding, healResult, [], [], apply);
      }
      const { applyVerifiedPatches } = await import("../core/heal/apply.js");
      const res = applyVerifiedPatches(record.repoRoot, [{ ...finding, heal: healResult }]);
      applied = res.applied;
      conflicts = res.conflicts;
    }
    return this.reportFix(record, finding, healResult, applied, conflicts, apply);
  }

  private reportFix(
    record: ScanRecord,
    finding: Finding,
    healResult: HealResult,
    applied: Array<{ filePath: string; hunkCount: number }>,
    conflicts: Array<{ filePath: string; error: string }>,
    apply: boolean
  ): ToolCallResult {
    const diff = readText(healResult.patchPath);
    const structured = {
      scanId: record.scanId,
      findingId: finding.id,
      status: healResult.status,
      filePath: healResult.filePath,
      explanation: healResult.explanation ?? null,
      diff,
      applied: applied.length ? applied : null,
      conflicts: conflicts.length ? conflicts : null,
      tests: healResult.test ?? null,
      model: healResult.model ?? null,
      error: healResult.error ?? null,
    };

    const hunks = healResult.hunks.length;
    const file = healResult.filePath ? healResult.filePath.replace(/\\/g, "/") : "(no file)";
    let summary: string;

    if (healResult.status === "healed" && applied.length) {
      summary =
        `Applied ${hunks} edit${hunks === 1 ? "" : "s"} to ${file} — the crash no longer ` +
        `reproduces under replay. Review with \`git diff\`; aztrx never commits.`;
    } else if (healResult.status === "healed" && apply) {
      summary = `The patch verified but could not be applied to your working tree — see conflicts.`;
    } else if (healResult.status === "healed") {
      summary =
        `Patch verified: ${hunks} edit${hunks === 1 ? "" : "s"} to ${file}, and the crash no ` +
        `longer reproduces under replay. Call again with \`apply: true\` to write it into your ` +
        `working tree.\n\n${diff ?? ""}`;
    } else {
      const why = healResult.error ? `: ${healResult.error}` : "";
      summary =
        `No patch — status \`${healResult.status}\`${why}.` +
        (healResult.status === "no-llm"
          ? " Set ANTHROPIC_API_KEY and call again to attempt a fix."
          : "");
    }

    if (conflicts.length) {
      summary +=
        `\nConflicts (skipped, the .patch artifact is kept for review):\n` +
        conflicts.map((c) => `  ${c.filePath}: ${c.error}`).join("\n");
    }
    return ok(summary, structured);
  }
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/** What a scan returns per finding: enough to decide, nothing more. */
function projectFinding(f: Finding): Record<string, unknown> {
  return {
    id: f.id,
    severity: f.severity,
    type: f.type,
    // First line only. The rest of a stack is noise at this level, and the repro
    // has the detail.
    message: f.rawMessage.split("\n")[0].slice(0, 500),
    occurrences: f.occurrences,
    location: f.mappedLocation
      ? {
          file: f.mappedLocation.filePath.replace(/\\/g, "/"),
          line: f.mappedLocation.line,
          column: f.mappedLocation.column,
          ownCode: f.mappedLocation.isOwnCode,
        }
      : null,
    reproVerdict: f.repro?.verdict ?? null,
    hasRepro: Boolean(f.repro),
  };
}

/** One repro step, in the shape a person would type into a terminal. */
function describeAction(a: RecordedAction): string {
  const value = a.value ? ` "${a.value}"` : "";
  const selector = a.selectors[0] ? ` → ${a.selectors[0]}` : "";
  return `${a.type}${value}${selector}`;
}
