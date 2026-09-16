/**
 * Agent missions — one role, one browser context, one behavior run.
 *
 * A mission is the runtime instantiation of a role spec (roles.ts): the same
 * detection prologue as the legacy single pass (context, interceptor,
 * classifier, recorder), then the role's behavior primitive drives the page.
 * Every finding a mission produces is tagged with the role's id so the merged
 * report can say who found what.
 *
 * Race roles open TWO contexts on the same target, load both, and run the
 * behavior concurrently from a synchronized start — races and lost updates
 * surface as one hand tripping a crash the other caused.
 */

import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { EventBus } from "./eventBus.js";
import { attachInterceptor } from "./interceptor.js";
import { establishLogin } from "./auth.js";
import { SignalClassifier } from "./classifier.js";
import { ActionRecorder } from "./recorder.js";
import { walkDom } from "./domWalker.js";
import { fuzz } from "./fuzzer.js";
import { httpFuzz } from "./httpFuzzer.js";
import { keyboardWalk } from "./keyboardWalk.js";
import { observe } from "./observe.js";
import { ssrKeyScan, tokenTamper, paywallBypass } from "./security.js";
import { attachNetworkGuard } from "./networkGuard.js";
import { resolveFrame, resolveServerFrame } from "./resolver.js";
import type { Role } from "./roles.js";
import type { Finding, RecordedAction, TelemetryErrorPayload } from "./types.js";

export interface Mission {
  role: Role;
  seed: number;
  /** Effective per-mission budget. Defaults to the role spec's budget; the
   * scheduler shrinks it when scaling to thousands of missions so the total
   * action count stays bounded. */
  budget?: number;
}

export interface AgentOptions {
  url: string;
  repoRoot: string;
  allowHosts: Set<string>;
  dryRun?: boolean;
  guardOn: boolean;
  storageState?: string;
  login?: boolean;
  loginEmail?: string;
  loginPassword?: string;
  loginUrl?: string;
  crashTest?: boolean;
  saveAuthState?: boolean;
  allowDestructive?: boolean;
  /** Fold the HTTP fuzzer in as a post-pass on this mission's page. */
  httpFuzz?: boolean;
  httpFuzzMutations?: boolean;
  baseline: string[];
  log: (msg: string) => void;
}

export interface MissionResult {
  findings: Finding[];
  actions: number;
  /** New JS code ranges covered by the mission's fuzz pass (0 otherwise). */
  newCoverage: number;
  /** Whether the mission encountered a login form (a password input). */
  sawLoginForm: boolean;
  roleId: string;
  /** Auth-state path saved by the first mission (used to authenticate replays). */
  replayStorageState?: string;
}

interface WiredPage {
  context: import("playwright").BrowserContext;
  page: Page;
  classifier: SignalClassifier;
  recorder: ActionRecorder;
  workerBus: EventBus;
  observedUrls: Set<string>;
  /** Auth-state path saved when this mission did the auto-login. */
  replayStorageState?: string;
}

/**
 * The detection prologue shared by every mission: open a context + page,
 * wire the local bus through recorder/classifier (isolation — findings are
 * merged by the caller), attach the interceptor and network guard, load the
 * target, settle for hydration, and auto-login when asked.
 */
async function openAgentPage(browser: Browser, opts: AgentOptions, forwardBus?: EventBus): Promise<WiredPage> {
  const workerBus = new EventBus();
  const recorder = new ActionRecorder();
  const classifier = new SignalClassifier(opts.baseline);

  workerBus.on("action", (a: RecordedAction) => {
    recorder.record(a);
    forwardBus?.emit("action", a);
  });
  workerBus.on("route", (r) => forwardBus?.emit("route", r));
  workerBus.on("noise", (n) => forwardBus?.emit("noise", n));

  // Classify telemetry with THIS mission's recorder, so action history is correct.
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

  const context = await browser.newContext(opts.storageState ? { storageState: opts.storageState } : {});
  const page = await context.newPage();
  attachInterceptor(page, workerBus);

  // Collect every same-origin URL the page issues — including `fetch()` fired
  // from click handlers — so the folded HTTP fuzzer can probe endpoints a fresh
  // page never sees (performance resources only capture on-load fetches).
  const observedUrls = new Set<string>();
  const targetOrigin = new URL(opts.url).origin;
  page.on("request", (req) => {
    try {
      if (new URL(req.url()).origin === targetOrigin) observedUrls.add(req.url());
    } catch {
      // malformed URL — skip
    }
  });

  if (opts.guardOn) {
    await attachNetworkGuard(page, {
      allowHosts: opts.allowHosts,
      onBlock: (u) => opts.log(`[guard] blocked ${u}`),
    });
  }

  // The last URL this listener recorded as a `navigate`, to drop the duplicate.
  // Playwright fires `framenavigated` twice for a single `page.goto` — measured
  // against Chromium, not assumed: one goto to `/agents` produced two events
  // for the same URL. Recording both would put a redundant full page load in
  // every trace, and the buffer is only 25 actions deep.
  let lastNavUrl = "";
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return; // an iframe's URL is not the page's
    const url = frame.url();
    workerBus.emit("route", { url, ts: Date.now() });

    // A trace has to say which page it was on — see swarm.ts history for the
    // repro that proved `unreliable` without it. `navigate` is understood by
    // replayActions, the spec compiler and heal; only the producer was missing.
    if (!/^https?:/i.test(url)) return; // about:blank, and the first empty frame
    if (url === lastNavUrl) return; // the second of the pair described above
    lastNavUrl = url;
    workerBus.emit("action", { type: "navigate", selectors: [], value: url, timestamp: Date.now() });
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

  // Auto-login (best-effort).
  let replayStorageState: string | undefined;
  if (loaded && opts.login && opts.loginEmail && opts.loginPassword) {
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

  return { context, page, classifier, recorder, workerBus, observedUrls, replayStorageState };
}

/** Emulate a 3G-ish connection via CDP: 400ms RTT, ~750kbps down, ~250kbps up. */
async function throttleSlow(page: Page, context: import("playwright").BrowserContext): Promise<void> {
  const client = await context.newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 400,
    downloadThroughput: (750 * 1024) / 8,
    uploadThroughput: (250 * 1024) / 8,
  });
}

/** Run the mission's behavior primitive against a wired page. */
async function runBehavior(
  wired: WiredPage,
  mission: Mission,
  opts: AgentOptions,
  budget: number
): Promise<{ actions: number; newCoverage: number; sawLoginForm: boolean }> {
  const { page, workerBus } = wired;
  const kind = mission.role.behaviors[0]?.kind ?? "walk";
  const payloads = mission.role.behaviors[0]?.payloads;

  switch (kind) {
    case "fuzz": {
      const fr = await fuzz(page, workerBus, {
        seed: mission.seed,
        maxActions: budget,
        dryRun: opts.dryRun,
        allowDestructive: opts.allowDestructive,
        payloads,
      });
      return { actions: fr.actions, newCoverage: fr.newCoverage, sawLoginForm: false };
    }
    case "keyboard": {
      const kr = await keyboardWalk(page, workerBus, { maxActions: budget, dryRun: opts.dryRun });
      return { actions: kr.actions, newCoverage: 0, sawLoginForm: kr.sawLoginForm };
    }
    case "chaosReload": {
      const wr = await walkDom(page, workerBus, {
        maxActions: budget,
        dryRun: opts.dryRun,
        allowDestructive: opts.allowDestructive,
        chaos: { seed: mission.seed, chance: 0.25 },
      });
      return { actions: wr.actions, newCoverage: 0, sawLoginForm: wr.sawLoginForm };
    }
    case "observe": {
      const or = await observe(page, workerBus, { maxRoutes: budget, dryRun: opts.dryRun });
      if (or.longTasks > 0) opts.log(`[observe] ${or.longTasks} long task(s) total`);
      return { actions: or.actions, newCoverage: 0, sawLoginForm: false };
    }
    case "slowWalk": {
      await throttleSlow(page, wired.context);
      const wr = await walkDom(page, workerBus, {
        maxActions: budget,
        dryRun: opts.dryRun,
        allowDestructive: opts.allowDestructive,
      });
      return { actions: wr.actions, newCoverage: 0, sawLoginForm: wr.sawLoginForm };
    }
    case "httpStorm": {
      const actions = await httpFuzz(page, opts.url, workerBus, {
        maxRequests: budget,
        dryRun: opts.dryRun,
        allowHosts: opts.allowHosts,
        mutations: true,
        allowDestructive: opts.allowDestructive,
      });
      return { actions, newCoverage: 0, sawLoginForm: false };
    }
    case "ssrScan": {
      const sr = await ssrKeyScan(page, workerBus, { maxRoutes: budget, dryRun: opts.dryRun });
      if (sr.leaks > 0) opts.log(`[key-hunt] ${sr.leaks} secret(s) across ${sr.routes} route(s)`);
      return { actions: sr.routes, newCoverage: 0, sawLoginForm: false };
    }
    case "tokenTamper": {
      const tr = await tokenTamper(page, workerBus, { maxTokens: budget, dryRun: opts.dryRun });
      if (tr.tokens === 0) opts.log("[forger] no JWTs in storage — nothing to tamper");
      return { actions: tr.tokens, newCoverage: 0, sawLoginForm: false };
    }
    case "paywallBypass": {
      const pr = await paywallBypass(page, workerBus, { maxRoutes: budget, dryRun: opts.dryRun });
      if (pr.routes === 0) opts.log("[free-rider] no premium markers found");
      return { actions: pr.routes, newCoverage: 0, sawLoginForm: false };
    }
    case "walk":
    default: {
      const wr = await walkDom(page, workerBus, {
        maxActions: budget,
        dryRun: opts.dryRun,
        allowDestructive: opts.allowDestructive,
      });
      return { actions: wr.actions, newCoverage: 0, sawLoginForm: wr.sawLoginForm };
    }
  }
}

function tagFindings(findings: Finding[], roleId: string): Finding[] {
  for (const f of findings) f.roles = [roleId];
  return findings;
}

/** One role, one context, one behavior run. */
export async function runAgentMission(
  browser: Browser,
  opts: AgentOptions,
  mission: Mission,
  forwardBus?: EventBus
): Promise<MissionResult> {
  const budget = mission.budget ?? mission.role.behaviors[0]?.budget ?? 100;
  const wired = await openAgentPage(browser, opts, forwardBus);

  try {
    const result = await runBehavior(wired, mission, opts, budget);

    // Folded HTTP fuzzer (legacy `--http-fuzz`): post-pass on this same page,
    // seeded with every URL the mission actually issued — including
    // JS-fetch-only endpoints a standalone pass would never discover. The
    // httpStorm behavior IS the fuzzer, so it skips the fold.
    let extraActions = 0;
    const kind = mission.role.behaviors[0]?.kind ?? "walk";
    if (opts.httpFuzz && kind !== "httpStorm") {
      extraActions = await httpFuzz(wired.page, opts.url, wired.workerBus, {
        maxRequests: budget,
        dryRun: opts.dryRun,
        allowHosts: opts.allowHosts,
        mutations: opts.httpFuzzMutations,
        allowDestructive: opts.allowDestructive,
        seedUrls: [...wired.observedUrls],
        navigate: false,
      });
    }

    await wired.page.waitForTimeout(500);
    return {
      findings: tagFindings(wired.classifier.findings(), mission.role.id),
      actions: result.actions + extraActions,
      newCoverage: result.newCoverage,
      sawLoginForm: result.sawLoginForm,
      roleId: mission.role.id,
      replayStorageState: wired.replayStorageState,
    };
  } finally {
    await wired.context.close();
  }
}

/**
 * Race mode: TWO contexts on the same target, both loaded and settled, then
 * the behavior runs in both from a synchronized start. One hand's crash is the
 * other hand's doing — findings from either recorder carry the role tag.
 */
export async function runRaceMission(
  browser: Browser,
  opts: AgentOptions,
  mission: Mission,
  forwardBus?: EventBus
): Promise<MissionResult> {
  const budget = mission.budget ?? mission.role.behaviors[0]?.budget ?? 100;
  const a = await openAgentPage(browser, opts, forwardBus);
  const b = await openAgentPage(browser, opts, forwardBus);

  try {
    const kind = mission.role.behaviors[0]?.kind ?? "walk";
    const payloads = mission.role.behaviors[0]?.payloads;
    const drive = async (wired: WiredPage): Promise<{ actions: number; newCoverage: number; sawLoginForm: boolean }> => {
      if (kind === "fuzz") {
        const fr = await fuzz(wired.page, wired.workerBus, {
          seed: mission.seed,
          maxActions: budget,
          dryRun: opts.dryRun,
          allowDestructive: opts.allowDestructive,
          payloads,
        });
        return { actions: fr.actions, newCoverage: fr.newCoverage, sawLoginForm: false };
      }
      const wr = await walkDom(wired.page, wired.workerBus, {
        maxActions: budget,
        dryRun: opts.dryRun,
        allowDestructive: opts.allowDestructive,
      });
      return { actions: wr.actions, newCoverage: 0, sawLoginForm: wr.sawLoginForm };
    };

    // Synchronized start: both hands are loaded and settled, then act at once.
    const [ra, rb] = await Promise.all([drive(a), drive(b)]);

    await a.page.waitForTimeout(500);
    await b.page.waitForTimeout(500);

    const findings = tagFindings(
      [...a.classifier.findings(), ...b.classifier.findings()],
      mission.role.id
    );
    return {
      findings,
      actions: ra.actions + rb.actions,
      newCoverage: ra.newCoverage + rb.newCoverage,
      sawLoginForm: ra.sawLoginForm || rb.sawLoginForm,
      roleId: mission.role.id,
      replayStorageState: a.replayStorageState ?? b.replayStorageState,
    };
  } finally {
    await Promise.allSettled([a.context.close(), b.context.close()]);
  }
}
