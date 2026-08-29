/**
 * F-swarm — parallel detection. Runs N workers at once, each with its own
 * browser context, event bus, action recorder, and classifier, so the action
 * history attached to a finding belongs to the worker that saw it (never
 * interleaved). Workers attack different sides: a deterministic walk, several
 * chaos-fuzz seeds, and — optionally — the server-side HTTP fuzzer.
 *
 * Findings are merged by fingerprint at the end (occurrences summed, the richest
 * action history / source mapping kept); the caller then runs repro/heal on the
 * merged set as usual.
 */

import * as fs from "fs";
import * as path from "path";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { EventBus } from "./eventBus.js";
import { attachInterceptor } from "./interceptor.js";
import { establishLogin } from "./auth.js";
import { SignalClassifier } from "./classifier.js";
import { ActionRecorder } from "./recorder.js";
import { walkDom } from "./domWalker.js";
import { fuzz } from "./fuzzer.js";
import { httpFuzz } from "./httpFuzzer.js";
import { attachNetworkGuard } from "./networkGuard.js";
import { resolveFrame, resolveServerFrame } from "./resolver.js";
import type { Finding, RecordedAction, TelemetryErrorPayload } from "./types.js";

export type WorkerStrategy =
  | { kind: "walk" }
  | { kind: "fuzz"; seed: number }
  | { kind: "http-fuzz" };

export interface DetectResult {
  findings: Finding[];
  actions: number;
  /** Auth-state path saved by worker 0 (used to authenticate replays). */
  replayStorageState?: string;
}

export interface DetectWorkerOptions {
  url: string;
  repoRoot: string;
  allowHosts: Set<string>;
  maxActions: number;
  dryRun?: boolean;
  guardOn: boolean;
  storageState?: string;
  login?: boolean;
  loginEmail?: string;
  loginPassword?: string;
  loginUrl?: string;
  crashTest?: boolean;
  saveAuthState?: boolean;
  httpFuzzMutations?: boolean;
  baseline: string[];
  log: (msg: string) => void;
}

/**
 * Run one worker's detection pass and return its findings. All internal events
 * flow through a local bus (isolation); only `action`/`route`/`noise` are
 * forwarded to `forwardBus` so a live panel can aggregate, never per-worker
 * findings (those are merged by the caller first).
 */
export async function detectWorker(
  browser: Browser,
  opts: DetectWorkerOptions,
  strategy: WorkerStrategy,
  forwardBus?: EventBus
): Promise<DetectResult> {
  const workerBus = new EventBus();
  const recorder = new ActionRecorder();
  const classifier = new SignalClassifier(opts.baseline);

  workerBus.on("action", (a: RecordedAction) => {
    recorder.record(a);
    forwardBus?.emit("action", a);
  });
  workerBus.on("route", (r) => forwardBus?.emit("route", r));
  workerBus.on("noise", (n) => forwardBus?.emit("noise", n));

  // Classify telemetry with THIS worker's recorder, so action history is correct.
  workerBus.on("telemetry", async (payload: TelemetryErrorPayload) => {
    const finding = classifier.classify(payload);
    if (!finding) return;
    finding.actionHistory = recorder.snapshot();
    if (finding.severity === "noise") {
      workerBus.emit("noise", { ts: Date.now() });
      return;
    }

    if (payload.serverError) {
      finding.serverError = { message: payload.serverError.message, body: payload.serverError.body };
    }

    if (payload.url && payload.line) {
      const resolved = await resolveFrame(
        { url: payload.url, line: payload.line, column: payload.column ?? 0, message: payload.rawMessage },
        opts.repoRoot
      );
      finding.mappedLocation = {
        filePath: resolved.sourceFile,
        line: resolved.line,
        column: resolved.column,
        codeContext: resolved.codeSnippet,
        isOwnCode: resolved.resolvedFrom !== "unresolved",
      };
    } else if (payload.serverError?.frame) {
      const resolved = resolveServerFrame(payload.serverError.frame, opts.repoRoot);
      finding.mappedLocation = {
        filePath: resolved.sourceFile,
        line: resolved.line,
        column: resolved.column,
        codeContext: resolved.codeSnippet,
        isOwnCode: resolved.resolvedFrom !== "unresolved",
      };
    }
  });

  const context = await browser.newContext(
    opts.storageState ? { storageState: opts.storageState } : {}
  );
  const page = await context.newPage();
  attachInterceptor(page, workerBus);
  if (opts.guardOn) {
    await attachNetworkGuard(page, {
      allowHosts: opts.allowHosts,
      onBlock: (u) => opts.log(`[guard] blocked ${u}`),
    });
  }
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) workerBus.emit("route", { url: frame.url(), ts: Date.now() });
  });

  let loaded = true;
  await page.goto(opts.url, { waitUntil: "load", timeout: 30000 }).catch((e) => {
    loaded = false;
    opts.log(`Failed to load target: ${(e as Error).message}`);
  });

  if (loaded) {
    // Settle for hydration and mount-time effects before acting.
    await page.waitForTimeout(2000);
  }

  // Auto-login (best-effort). The server-side HTTP fuzzer uses Node-side fetch,
  // so it doesn't benefit from a browser session — skip it there.
  let replayStorageState: string | undefined;
  if (loaded && strategy.kind !== "http-fuzz" && opts.login && opts.loginEmail && opts.loginPassword) {
    const res = await establishLogin(page, {
      email: opts.loginEmail,
      password: opts.loginPassword,
      loginUrl: opts.loginUrl,
    });
    if (res.ok) {
      if (opts.saveAuthState) {
        const state = await context.storageState();
        const authStatePath = path.join(opts.repoRoot, ".aztrx", "auth-state.json");
        fs.mkdirSync(path.dirname(authStatePath), { recursive: true });
        fs.writeFileSync(authStatePath, JSON.stringify(state, null, 2), "utf-8");
        replayStorageState = authStatePath;
        opts.log(`[auth] logged in → ${path.relative(opts.repoRoot, authStatePath)}`);
      } else {
        opts.log("[auth] logged in");
      }
      await page.goto(opts.url, { waitUntil: "load", timeout: 30000 }).catch(() => {});
    } else {
      opts.log(`[auth] skipped: ${res.reason}`);
    }
  }

  if (loaded && opts.crashTest) {
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("Aztrx test: Cannot read properties of undefined (reading 'token')");
      }, 300);
    });
    await page.waitForTimeout(800);
  }

  let actions = 0;
  if (loaded) {
    if (strategy.kind === "walk") {
      actions = await walkDom(page, workerBus, { maxActions: opts.maxActions, dryRun: opts.dryRun });
    } else if (strategy.kind === "fuzz") {
      actions = await fuzz(page, workerBus, { seed: strategy.seed, maxActions: opts.maxActions, dryRun: opts.dryRun });
    } else {
      actions = await httpFuzz(page, opts.url, workerBus, {
        maxRequests: opts.maxActions,
        dryRun: opts.dryRun,
        allowHosts: opts.allowHosts,
        mutations: opts.httpFuzzMutations,
      });
    }
  }

  await page.waitForTimeout(500);
  await context.close();

  return { findings: classifier.findings(), actions, replayStorageState };
}

/** Dedup findings across workers by fingerprint: sum occurrences, keep the richest. */
export function mergeFindings(arrays: Finding[][]): Finding[] {
  const byFingerprint = new Map<string, Finding>();
  for (const arr of arrays) {
    for (const f of arr) {
      const existing = byFingerprint.get(f.fingerprint);
      if (!existing) {
        byFingerprint.set(f.fingerprint, { ...f, actionHistory: [...f.actionHistory] });
        continue;
      }
      existing.occurrences += f.occurrences;
      if (!existing.mappedLocation && f.mappedLocation) existing.mappedLocation = f.mappedLocation;
      if (existing.actionHistory.length < f.actionHistory.length) existing.actionHistory = f.actionHistory;
    }
  }
  return [...byFingerprint.values()];
}

/** Build the worker roster for a run. `workers = 1` with no http-fuzz is the
 * legacy single pass; `--http-fuzz` and/or `workers > 1` fan out. */
function buildStrategies(opts: {
  workers: number;
  fuzz?: boolean;
  httpFuzz?: boolean;
  seed: number;
}): WorkerStrategy[] {
  const strategies: WorkerStrategy[] = [];
  if (opts.httpFuzz) strategies.push({ kind: "http-fuzz" });

  const w = Math.max(1, opts.workers);
  if (w === 1) {
    strategies.push(opts.fuzz ? { kind: "fuzz", seed: opts.seed } : { kind: "walk" });
    return strategies;
  }

  if (opts.fuzz) {
    for (let i = 0; i < w; i++) strategies.push({ kind: "fuzz", seed: opts.seed + i });
  } else {
    strategies.push({ kind: "walk" });
    for (let i = 1; i < w; i++) strategies.push({ kind: "fuzz", seed: opts.seed + i });
  }
  return strategies;
}

export interface SwarmOptions {
  url: string;
  repoRoot: string;
  maxActions: number;
  dryRun?: boolean;
  fuzz?: boolean;
  httpFuzz?: boolean;
  httpFuzzMutations?: boolean;
  seed: number;
  workers: number;
  allowHosts: Set<string>;
  storageState?: string;
  login?: boolean;
  loginEmail?: string;
  loginPassword?: string;
  loginUrl?: string;
  crashTest?: boolean;
  baseline: string[];
  guardOn: boolean;
  log: (msg: string) => void;
}

export interface SwarmResult {
  findings: Finding[];
  replayStorageState?: string;
  totalActions: number;
  workerCount: number;
}

/** Launch one browser, run the worker roster concurrently, merge findings. */
export async function swarmDetect(opts: SwarmOptions): Promise<SwarmResult> {
  const strategies = buildStrategies(opts);
  const browser = await chromium.launch({ headless: true });

  try {
    const settled = await Promise.allSettled(
      strategies.map((strategy, i) =>
        detectWorker(
          browser,
          {
            url: opts.url,
            repoRoot: opts.repoRoot,
            allowHosts: opts.allowHosts,
            maxActions: opts.maxActions,
            dryRun: opts.dryRun,
            guardOn: opts.guardOn,
            storageState: opts.storageState,
            login: opts.login,
            loginEmail: opts.loginEmail,
            loginPassword: opts.loginPassword,
            loginUrl: opts.loginUrl,
            crashTest: i === 0 ? opts.crashTest : false,
            saveAuthState: i === 0,
            httpFuzzMutations: opts.httpFuzzMutations,
            baseline: opts.baseline,
            log: (m) => opts.log(strategies.length > 1 ? `[w${i}] ${m}` : m),
          },
          strategy
        )
      )
    );

    const results: DetectResult[] = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") results.push(r.value);
      else opts.log(`worker ${i} failed: ${(r.reason as Error)?.message ?? String(r.reason)}`);
    });

    let replayStorageState: string | undefined;
    for (const r of results) if (r.replayStorageState) replayStorageState = r.replayStorageState;

    const findings = mergeFindings(results.map((r) => r.findings));
    const totalActions = results.reduce((sum, r) => sum + r.actions, 0);
    return { findings, replayStorageState, totalActions, workerCount: strategies.length };
  } finally {
    await browser.close();
  }
}
