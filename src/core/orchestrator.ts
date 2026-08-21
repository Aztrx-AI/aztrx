import * as path from "path";
import { chromium } from "playwright";
import pc from "picocolors";
import { EventBus } from "./eventBus.js";
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
}

const SEVERITY_MARK = {
  crash: pc.red("● crash "),
  error: pc.red("● error "),
  warning: pc.yellow("○ warning "),
  noise: pc.dim("○ noise "),
} as const;

function printFinding(f: Finding): void {
  console.log(SEVERITY_MARK[f.severity] + pc.bold(f.rawMessage));
  if (f.mappedLocation) {
    console.log(
      pc.dim(`   ${f.mappedLocation.filePath}:${f.mappedLocation.line}:${f.mappedLocation.column}`)
    );
    console.log(pc.dim(f.mappedLocation.codeContext));
  }
  if (f.occurrences > 1) console.log(pc.dim(`   (×${f.occurrences})`));
  console.log("");
}

/**
 * The run's finite state machine: launch → (guard) → intercept → act (walk or
 * fuzz) → classify → map → report → repro (minimize/compile/validate). Modules
 * communicate only through the EventBus; the orchestrator is the single place
 * that wires them together.
 */
export async function run(options: RunOptions): Promise<Finding[]> {
  const { url, repoRoot } = options;
  const maxActions = options.maxActions ?? 100;
  const guardOn = Boolean(options.fuzz || options.repro);
  const allowHosts = allowHostsFrom(url, options.allowHosts ?? []);

  console.log(pc.cyan("\n⚡ Aztrx v0.1.0 — Runtime Detector"));
  console.log(pc.dim(`Target: ${url}`));
  console.log(pc.dim(`Repo:   ${repoRoot}`));
  if (options.fuzz) console.log(pc.dim(`Mode:   fuzz (seed ${options.seed ?? 42})`));
  if (options.repro) console.log(pc.dim(`Mode:   repro (${options.reproRuns ?? 3} runs)`));
  if (guardOn) console.log(pc.dim(`Net:    deny-by-default → allow ${[...allowHosts].join(", ") || "origin"}`));
  console.log("");

  const bus = new EventBus();
  const classifier = new SignalClassifier(await loadBaseline(repoRoot));
  const recorder = new ActionRecorder();

  bus.on("action", (a: RecordedAction) => recorder.record(a));
  bus.on("telemetry", async (payload: TelemetryErrorPayload) => {
    const finding = classifier.classify(payload);
    if (!finding) return;
    finding.actionHistory = recorder.snapshot();
    if (finding.severity === "noise") return;

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
    printFinding(finding);
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  attachInterceptor(page, bus);
  if (guardOn) {
    await attachNetworkGuard(page, {
      allowHosts,
      onBlock: (u) => console.log(pc.dim(`  [guard] blocked ${u}`)),
    });
  }

  let loaded = true;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => {
    loaded = false;
    console.log(pc.red("Failed to load target: ") + pc.dim(e.message));
  });

  if (loaded && options.crashTest) {
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("Aztrx test: Cannot read properties of undefined (reading 'token')");
      }, 300);
    });
    await page.waitForTimeout(800);
  }

  if (loaded) {
    const acted = options.fuzz
      ? await fuzz(page, bus, { seed: options.seed, maxActions, dryRun: options.dryRun })
      : await walkDom(page, bus, { maxActions, dryRun: options.dryRun });
    console.log(pc.dim(`\n${options.fuzz ? "Fuzzed" : "Walked"} ${acted} action(s).\n`));
  }

  await page.waitForTimeout(500);
  await browser.close();

  const findings = classifier.findings();

  // F7 → F8 → F9: minimize each finding, compile an executable spec, validate
  // the flake rate. Only crash/error findings with a recorded action history.
  if (options.repro) {
    const engine = new ReplayEngine({
      attachGuard: async (p) => attachNetworkGuard(p, { allowHosts }),
    });
    try {
      const targets = findings.filter(
        (f) => (f.severity === "crash" || f.severity === "error") && f.actionHistory.length > 0
      );
      if (targets.length) {
        console.log(pc.cyan("— Repro pipeline (minimize → compile → validate) —"));
      }
      for (const f of targets) {
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

        const mark =
          v.verdict === "deterministic"
            ? pc.green("  ✓ deterministic")
            : v.verdict === "flaky"
              ? pc.yellow("  ◐ flaky")
              : pc.red("  ✗ unreliable");
        console.log(
          `${mark}  ${pc.bold(f.rawMessage.split("\n")[0].slice(0, 60))}  (${minimal.length}/${f.actionHistory.length} steps, ${v.reproductions}/${v.runs} runs)`
        );
        console.log(pc.dim(`        spec: ${path.relative(repoRoot, specPath)}`));
      }
    } finally {
      await engine.close();
    }
  }

  const reportPath = writeReport(repoRoot, url, findings);
  console.log(pc.dim(`Report: ${path.relative(repoRoot, reportPath)}`));

  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  console.log(pc.dim("────────────────────────────────────────────"));
  console.log(pc.cyan(`${findings.length} unique finding(s)`));
  console.log(
    pc.dim(`crash: ${counts.crash ?? 0}   error: ${counts.error ?? 0}   warning: ${counts.warning ?? 0}`)
  );
  return findings;
}
