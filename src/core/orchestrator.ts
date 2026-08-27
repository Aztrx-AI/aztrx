import * as path from "path";
import { chromium } from "playwright";
import pc from "picocolors";
import { EventBus } from "./eventBus.js";
import type { RunPhase } from "./eventBus.js";
import { attachInterceptor } from "./interceptor.js";
import { SignalClassifier, loadBaseline } from "./classifier.js";
import { ActionRecorder } from "./recorder.js";
import { walkDom } from "./domWalker.js";
import { fuzz } from "./fuzzer.js";
import { attachNetworkGuard, allowHostsFrom } from "./networkGuard.js";
import { resolveFrame } from "./resolver.js";
import { ReplayEngine } from "./replay.js";
import { minimize } from "./minimizer.js";
import { writeSpec } from "./specCompiler.js";
import { validate } from "./validator.js";
import { writeReport } from "./report.js";
import { RunLog } from "./events.js";
import { heal } from "./heal/index.js";
import { submitTelemetry } from "./telemetry/index.js";
import { submitRun } from "./cloud/index.js";
import type { Finding, RecordedAction, TelemetryErrorPayload } from "./types.js";

export interface RunOptions {
  url: string;
  repoRoot: string;
  maxActions?: number;
  dryRun?: boolean;
  crashTest?: boolean;
  fuzz?: boolean;
  repro?: boolean;
  seed?: number;
  allowHosts?: string[];
  reproRuns?: number;
  /** Path to a Playwright storage-state JSON (cookies + localStorage) so the
   * session starts authenticated. Produced by `playwright codegen --save-storage`. */
  storageState?: string;
  /** F10: attempt closed-loop healing for crash/error findings. Needs
   * `ANTHROPIC_API_KEY` (or an injected patchFn) and `repro: true`. */
  heal?: boolean;
  /** LLM model override for healing (the fallback tier). */
  healModel?: string;
  /** Fast/cheap first tier for the Smart Cloud Router (`AZTRX_FAST_MODEL`). */
  healFastModel?: string;
  /** Override the test command run against a healed patch (default: `npm test`). */
  testCommand?: string;
  /** Timeout for the heal test gate, ms. */
  testTimeoutMs?: number;
  /** Skip the heal test gate. */
  skipTest?: boolean;
  /** F11: collect + persist anonymized telemetry locally (opt-in). */
  telemetry?: boolean;
  /** F11: additionally upload the sanitized tuple to the telemetry endpoint. */
  shareData?: boolean;
  /** Override the telemetry endpoint (`AZTRX_TELEMETRY_URL`). */
  telemetryUrl?: string;
  /** F12: upload the run's findings to the Aztrx AI cloud dashboard (opt-in). */
  upload?: boolean;
  /** API key for cloud + telemetry uploads (`AZTRX_API_KEY`). */
  apiKey?: string;
  /** Override the cloud ingest base URL (`AZTRX_CLOUD_URL`). */
  cloudUrl?: string;
  /** Inject an external bus (the TUI subscribes to it). */
  bus?: EventBus;
  /** When true, suppress console output — the caller renders from bus events. */
  ui?: boolean;
}

const SEVERITY_MARK = {
  crash: pc.red("● crash "),
  error: pc.red("● error "),
  warning: pc.yellow("○ warning "),
  noise: pc.dim("○ noise "),
} as const;

function printFinding(f: Finding, write: (s: string) => void): void {
  write(SEVERITY_MARK[f.severity] + pc.bold(f.rawMessage));
  if (f.mappedLocation) {
    write(
      pc.dim(`   ${f.mappedLocation.filePath}:${f.mappedLocation.line}:${f.mappedLocation.column}`)
    );
    write(pc.dim(f.mappedLocation.codeContext));
  }
  if (f.occurrences > 1) write(pc.dim(`   (×${f.occurrences})`));
  write("");
}

/** Human-readable run mode, surfaced in the cloud dashboard. */
function runMode(o: RunOptions): string {
  if (o.fuzz) return `fuzz (seed ${o.seed ?? 42})`;
  if (o.heal) return "repro → heal";
  if (o.repro) return "repro";
  return "deterministic walk";
}

/**
 * The run's finite state machine: launch → (guard) → intercept → act (walk or
 * fuzz) → classify → map → report → repro (minimize/compile/validate). Modules
 * communicate only through the EventBus; the orchestrator is the single place
 * that wires them together. In `ui` mode it emits structured events (phase,
 * action, finding, repro, route, noise) and stays silent on stdout, so a
 * terminal renderer (Ink) can draw the live panel instead of log lines.
 */
export async function run(options: RunOptions): Promise<Finding[]> {
  const { url, repoRoot } = options;
  const maxActions = options.maxActions ?? 100;
  const guardOn = Boolean(options.fuzz || options.repro);
  const allowHosts = allowHostsFrom(url, options.allowHosts ?? []);
  const ui = options.ui === true;
  const bus = options.bus ?? new EventBus();

  const say = (...parts: string[]) => {
    if (!ui) console.log(parts.join(" "));
  };
  const emitPhase = (phase: RunPhase, detail?: string) =>
    bus.emit("phase", { phase, detail, ts: Date.now() });

  say(pc.cyan("\n⚡ Aztrx AI v0.1.0 — Runtime Detector"));
  say(pc.dim(`Target: ${url}`));
  say(pc.dim(`Repo:   ${repoRoot}`));
  if (options.fuzz) say(pc.dim(`Mode:   fuzz (seed ${options.seed ?? 42})`));
  if (options.repro) say(pc.dim(`Mode:   repro (${options.reproRuns ?? 3} runs)`));
  if (guardOn) say(pc.dim(`Net:    deny-by-default → allow ${[...allowHosts].join(", ") || "origin"}`));
  if (options.storageState) say(pc.dim(`Auth:   ${options.storageState}`));
  say("");

  emitPhase("launch", url);

  const classifier = new SignalClassifier(await loadBaseline(repoRoot));
  const recorder = new ActionRecorder();
  const runLog = new RunLog(repoRoot);
  runLog.reset();
  runLog.append({ type: "run_start", url, ts: Date.now() });

  bus.on("action", (a: RecordedAction) => recorder.record(a));
  bus.on("telemetry", async (payload: TelemetryErrorPayload) => {
    const finding = classifier.classify(payload);
    if (!finding) return;
    finding.actionHistory = recorder.snapshot();
    if (finding.severity === "noise") {
      bus.emit("noise", { ts: Date.now() });
      return;
    }
    runLog.append({ type: "finding", finding });

    if (payload.url && payload.line) {
      const resolved = await resolveFrame(
        { url: payload.url, line: payload.line, column: payload.column ?? 0, message: payload.rawMessage },
        repoRoot
      );
      finding.mappedLocation = {
        filePath: resolved.sourceFile,
        line: resolved.line,
        column: resolved.column,
        codeContext: resolved.codeSnippet,
        isOwnCode: resolved.resolvedFrom !== "unresolved",
      };
    }
    bus.emit("finding", finding);
    printFinding(finding, say);
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(
    options.storageState ? { storageState: options.storageState } : {}
  );
  const page = await context.newPage();
  attachInterceptor(page, bus);
  if (guardOn) {
    await attachNetworkGuard(page, {
      allowHosts,
      onBlock: (u) => say(pc.dim(`  [guard] blocked ${u}`)),
    });
  }
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) bus.emit("route", { url: frame.url(), ts: Date.now() });
  });

  let loaded = true;
  await page.goto(url, { waitUntil: "load", timeout: 30000 }).catch((e) => {
    loaded = false;
    say(pc.red("Failed to load target: ") + pc.dim(e.message));
  });

  if (loaded) {
    // Settle: wait for hydration and mount-time effects (async fetches,
    // unhandled rejections, React warnings) to fire before we act. A page whose
    // only bugs are mount-time would otherwise be closed before they happen —
    // and a page with no interactive elements fuzzes zero actions, so it relies
    // on this window.
    await page.waitForTimeout(2000);
  }

  if (loaded && options.crashTest) {
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("Aztrx test: Cannot read properties of undefined (reading 'token')");
      }, 300);
    });
    await page.waitForTimeout(800);
  }

  if (loaded) {
    emitPhase(options.fuzz ? "fuzz" : "walk");
    const acted = options.fuzz
      ? await fuzz(page, bus, { seed: options.seed, maxActions, dryRun: options.dryRun })
      : await walkDom(page, bus, { maxActions, dryRun: options.dryRun });
    say(pc.dim(`\n${options.fuzz ? "Fuzzed" : "Walked"} ${acted} action(s).\n`));
  }

  await page.waitForTimeout(500);
  await browser.close();

  const findings = classifier.findings();

  // F7 → F8 → F9: minimize each finding, compile an executable spec, validate
  // the flake rate. Only crash/error findings with a recorded action history.
  if (options.repro) {
    const engine = new ReplayEngine({
      attachGuard: async (p) => attachNetworkGuard(p, { allowHosts }),
      storageState: options.storageState,
    });
    try {
      const targets = findings.filter(
        (f) => (f.severity === "crash" || f.severity === "error") && f.actionHistory.length > 0
      );
      if (targets.length) say(pc.cyan("— Repro pipeline (minimize → compile → validate) —"));
      emitPhase("repro");
      for (const f of targets) {
        try {
          const minimal = await minimize(engine, f.actionHistory, { url, fingerprint: f.fingerprint });
          const specPath = writeSpec(repoRoot, f, minimal, url);
          const v = await validate(engine, url, f, minimal, options.reproRuns ?? 3);
          f.repro = {
            actions: minimal,
            specPath,
            verdict: v.verdict,
            rate: v.rate,
            runs: v.runs,
            reproductions: v.reproductions,
          };

          bus.emit("repro", {
            finding: f,
            verdict: v.verdict,
            runs: v.runs,
            reproductions: v.reproductions,
            steps: minimal.length,
            totalSteps: f.actionHistory.length,
            specPath: path.relative(repoRoot, specPath),
          });
          runLog.append({
            type: "repro",
            fingerprint: f.fingerprint,
            verdict: v.verdict,
            runs: v.runs,
            reproductions: v.reproductions,
            steps: minimal.length,
            totalSteps: f.actionHistory.length,
            specPath: path.relative(repoRoot, specPath),
          });

          const mark =
            v.verdict === "deterministic"
              ? pc.green("  ✓ deterministic")
              : v.verdict === "flaky"
                ? pc.yellow("  ◐ flaky")
                : pc.red("  ✗ unreliable");
          say(
            `${mark}  ${pc.bold(f.rawMessage.split("\n")[0].slice(0, 60))}  (${minimal.length}/${f.actionHistory.length} steps, ${v.reproductions}/${v.runs} runs)`
          );
          say(pc.dim(`        spec: ${path.relative(repoRoot, specPath)}`));
        } catch (e) {
          // One finding's repro failing must not abort the whole run — record it
          // as unreliable and move on to the next target.
          f.repro = { actions: [], specPath: "", verdict: "unreliable", rate: 0, runs: 0, reproductions: 0 };
          bus.emit("repro", {
            finding: f,
            verdict: "unreliable",
            runs: 0,
            reproductions: 0,
            steps: 0,
            totalSteps: f.actionHistory.length,
            specPath: "",
          });
          runLog.append({
            type: "repro",
            fingerprint: f.fingerprint,
            verdict: "unreliable",
            runs: 0,
            reproductions: 0,
            steps: 0,
            totalSteps: f.actionHistory.length,
            specPath: "",
          });
          say(pc.red(`  ✗ repro failed: ${(e as Error).message.split("\n")[0]}`));
        }
      }
    } finally {
      await engine.close();
    }
  }

  // F10 — closed-loop healing. For each crash/error finding with an own-code
  // source location and a deterministic repro, generate a patch, gate it, apply
  // it in a sandboxed worktree, and verify the bug stops reproducing. Opt-in;
  // the patch is only ever handed to a human for review, never committed.
  if (options.heal) {
    const healTargets = findings.filter(
      (f) =>
        (f.severity === "crash" || f.severity === "error") &&
        f.mappedLocation?.isOwnCode &&
        f.repro &&
        f.repro.verdict !== "unreliable"
    );
    if (healTargets.length) {
      say(pc.cyan("— Closed-loop healing (redact → generate → gate → sandbox → test → verify) —"));
      emitPhase("heal");
      for (const f of healTargets) {
        say(pc.dim(`  healing: ${f.rawMessage.split("\n")[0].slice(0, 60)}`));
        try {
          const result = await heal(f, {
            repoRoot,
            url,
            actions: f.repro!.actions,
            fingerprint: f.fingerprint,
            allowHosts: [...allowHosts],
            model: options.healModel,
            fastModel: options.healFastModel,
            testCommand: options.testCommand,
            testTimeoutMs: options.testTimeoutMs,
            skipTest: options.skipTest,
          });
          f.heal = result;
          bus.emit("heal", {
            finding: f,
            status: result.status,
            patchPath: result.patchPath,
            error: result.error,
          });
          runLog.append({
            type: "heal",
            fingerprint: f.fingerprint,
            status: result.status,
            patchPath: result.patchPath,
            error: result.error,
          });

          const mark =
            result.status === "healed"
              ? pc.green("  ✓ healed")
              : result.status === "unfixed"
                ? pc.yellow("  ◐ unfixed")
                : pc.red(`  ✗ ${result.status}`);
          say(`${mark}  ${pc.bold(f.rawMessage.split("\n")[0].slice(0, 60))}`);
          if (result.patchPath) say(pc.dim(`        patch: ${path.relative(repoRoot, result.patchPath)}`));
          if (result.error) say(pc.dim(`        ${result.error}`));
        } catch (e) {
          f.heal = {
            status: "skipped",
            findingId: f.id,
            filePath: f.mappedLocation?.filePath ?? "",
            hunks: [],
            violations: [],
            error: (e as Error).message,
          };
          bus.emit("heal", { finding: f, status: "skipped", error: (e as Error).message });
          runLog.append({ type: "heal", fingerprint: f.fingerprint, status: "skipped", error: (e as Error).message });
          say(pc.dim(`  ✗ heal error: ${(e as Error).message}`));
        }
      }
    }
  }

  const reportPath = writeReport(repoRoot, url, findings);
  say(pc.dim(`Report: ${path.relative(repoRoot, reportPath)}`));

  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  // F11 — opt-in telemetry. Local-only under `--telemetry`; uploads under
  // `--share-data`. Fire-and-forget, sanitized, and never affects exit codes.
  if (options.telemetry || options.shareData) {
    submitTelemetry(findings, {
      repoRoot,
      url,
      telemetry: Boolean(options.telemetry),
      shareData: Boolean(options.shareData),
      endpoint: options.telemetryUrl,
      apiKey: options.apiKey,
    });
  }

  // F12 — opt-in cloud sync. Streams the sanitized run results to the ingest
  // API for the team dashboard; dedup happens server-side by fingerprint.
  if (options.upload) {
    submitRun(findings, {
      repoRoot,
      url,
      apiKey: options.apiKey,
      endpoint: options.cloudUrl,
      mode: runMode(options),
      counts,
    });
  }

  runLog.append({ type: "run_end", counts, ts: Date.now() });

  say(pc.dim("────────────────────────────────────────────"));
  say(pc.cyan(`${findings.length} unique finding(s)`));
  say(
    pc.dim(`crash: ${counts.crash ?? 0}   error: ${counts.error ?? 0}   warning: ${counts.warning ?? 0}`)
  );

  emitPhase("done");
  return findings;
}
