/**
 * The swarm scheduler — turns the role catalog into agent missions and runs
 * them against the target.
 *
 * "A thousand agents" means a thousand MISSIONS per session, not a thousand
 * simultaneous browsers (that would be 50–100 GB of RAM). Missions are tasks:
 * each is one role instantiation (seed + budget) executed by agent.ts in its
 * own browser context, bounded by a concurrency pool. Race roles are a pair
 * of synchronized contexts inside one mission.
 *
 * Without `--swarm`/`--roles` this keeps the legacy shape: one deterministic
 * walk, or `--workers N` fan-out of walk + chaos-fuzz seeds, wrapped as
 * synthetic single-behavior missions so both paths share the same merge.
 *
 * Findings are merged by fingerprint at the end (occurrences summed, the
 * richest action history / source mapping kept, role tags unioned); the caller
 * then runs repro/heal on the merged set as usual.
 */

import type { Browser } from "playwright";
import { launchChromium } from "./browser.js";
import { EventBus } from "./eventBus.js";
import { collapseSignals } from "./classifier.js";
import type { BehaviorKind, Role } from "./roles.js";
import { resolveRoles } from "./roles.js";
import type { AgentOptions, Mission, MissionResult } from "./agent.js";
import { runAgentMission, runRaceMission } from "./agent.js";
import type { Finding } from "./types.js";

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
  /** `--roles novice,hostile` — run these catalog roles. Empty = legacy mode. */
  roles?: string[];
  /** `--agents N` — total missions across the selected roles (default: 1 per role). */
  agents?: number;
  /** Max concurrent browser contexts (default: min(missions, 8)). */
  concurrency?: number;
  allowHosts: Set<string>;
  storageState?: string;
  login?: boolean;
  loginEmail?: string;
  loginPassword?: string;
  loginUrl?: string;
  crashTest?: boolean;
  /** Opt-in: include destructive controls/endpoints (delete/pay/logout/…). */
  allowDestructive?: boolean;
  baseline: string[];
  guardOn: boolean;
  log: (msg: string) => void;
  /** Forwarded to the orchestrator's bus so a live panel can aggregate action/route counts. */
  forwardBus?: EventBus;
}

export interface RoleStat {
  roleId: string;
  label: string;
  missions: number;
  actions: number;
  findings: number;
}

export interface SwarmResult {
  findings: Finding[];
  replayStorageState?: string;
  totalActions: number;
  totalCoverage: number;
  workerCount: number;
  roles: string[];
  /** Per-role totals — who did what, for the summary and the dashboard. */
  roleStats: RoleStat[];
  sawLoginForm: boolean;
}

/** A synthetic role for the legacy (non-catalog) modes. */
function syntheticRole(id: string, label: string, kind: BehaviorKind, budget: number): Role {
  return { id, name: label, emoji: "", mission: "", mode: "solo", behaviors: [{ kind, budget }] };
}

/**
 * Build the mission roster for a run.
 * - Catalog mode (`--swarm`/`--roles`): one mission per role, scaled by
 *   `--agents N` (round-robin across roles, each with its own seed).
 * - Legacy mode: `workers = 1` is the single walk; `workers > 1` fans out as
 *   walk + fuzz seeds (`--fuzz` makes every worker fuzz). `--http-fuzz` is not
 *   a mission — it folds into the walk/fuzz mission as before.
 */
export function buildMissions(opts: SwarmOptions): Mission[] {
  const missions: Mission[] = [];

  if (opts.roles && opts.roles.length > 0) {
    const catalog = resolveRoles(opts.roles);
    const total = opts.agents ?? catalog.length;
    for (let i = 0; i < total; i++) {
      missions.push({ role: catalog[i % catalog.length], seed: opts.seed + i });
    }
    return missions;
  }

  const w = Math.max(1, opts.workers);
  if (w === 1) {
    missions.push({
      role: syntheticRole(opts.fuzz ? "fuzz" : "walk", opts.fuzz ? `fuzz seed ${opts.seed}` : "walk", opts.fuzz ? "fuzz" : "walk", opts.maxActions),
      seed: opts.seed,
    });
    return missions;
  }

  if (opts.fuzz) {
    for (let i = 0; i < w; i++) {
      missions.push({
        role: syntheticRole(`fuzz-${i}`, `fuzz seed ${opts.seed + i}`, "fuzz", opts.maxActions),
        seed: opts.seed + i,
      });
    }
  } else {
    missions.push({ role: syntheticRole("walk", "walk", "walk", opts.maxActions), seed: opts.seed });
    for (let i = 1; i < w; i++) {
      missions.push({
        role: syntheticRole(`fuzz-${i}`, `fuzz seed ${opts.seed + i}`, "fuzz", opts.maxActions),
        seed: opts.seed + i,
      });
    }
  }
  return missions;
}

/** Dedup findings across missions by fingerprint: sum occurrences, keep the
 * richest action history/source mapping, union the role tags. */
export function mergeFindings(arrays: Finding[][]): Finding[] {
  const byFingerprint = new Map<string, Finding>();
  for (const arr of arrays) {
    for (const f of arr) {
      const existing = byFingerprint.get(f.fingerprint);
      if (!existing) {
        // Keep untagged findings untagged — a solo run's report has no `roles`.
        const roles = f.roles?.length ? [...f.roles] : undefined;
        byFingerprint.set(f.fingerprint, { ...f, actionHistory: [...f.actionHistory], roles });
        continue;
      }
      existing.occurrences += f.occurrences;
      if (!existing.mappedLocation && f.mappedLocation) existing.mappedLocation = f.mappedLocation;
      if (existing.actionHistory.length < f.actionHistory.length) existing.actionHistory = f.actionHistory;
      const roles = new Set(existing.roles ?? []);
      for (const r of f.roles ?? []) roles.add(r);
      existing.roles = [...roles];
    }
  }
  return [...byFingerprint.values()];
}

/** Run `fn` over `items` with at most `limit` concurrent calls. */
async function runPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(lanes);
}

/** Build the mission roster, run it through a bounded context pool, merge. */
export async function swarmDetect(opts: SwarmOptions): Promise<SwarmResult> {
  const missions = buildMissions(opts);
  const catalogMode = Boolean(opts.roles?.length);
  // `--workers` overrides the pool size; otherwise catalog mode caps at 8
  // contexts (a desktop-size default), legacy mode runs exactly its roster.
  const concurrency =
    opts.concurrency ?? (opts.workers > 1 ? opts.workers : Math.min(missions.length, catalogMode ? 8 : missions.length));

  const browser = await launchChromium();
  const results = new Map<number, MissionResult>();

  try {
    await runPool(missions, concurrency, async (mission, i) => {
      const agentOpts: AgentOptions = {
        url: opts.url,
        repoRoot: opts.repoRoot,
        allowHosts: opts.allowHosts,
        dryRun: opts.dryRun,
        guardOn: opts.guardOn,
        storageState: opts.storageState,
        login: opts.login,
        loginEmail: opts.loginEmail,
        loginPassword: opts.loginPassword,
        loginUrl: opts.loginUrl,
        crashTest: i === 0 ? opts.crashTest : false,
        saveAuthState: i === 0,
        allowDestructive: opts.allowDestructive,
        baseline: opts.baseline,
        log: (m) => opts.log(catalogMode ? `[${mission.role.id}] ${m}` : `[w${i}] ${m}`),
      };

      try {
        const result =
          mission.role.mode === "race"
            ? await runRaceMission(browser, agentOpts, mission, opts.forwardBus)
            : await runAgentMission(browser, agentOpts, mission, opts.forwardBus);
        results.set(i, result);
        opts.log(
          catalogMode
            ? `[${mission.role.id}] done — ${result.actions} action(s), ${result.findings.length} finding(s)`
            : `[w${i}] done — ${result.actions} action(s), ${result.findings.length} finding(s)`
        );
      } catch (e) {
        opts.log(`mission ${i} (${mission.role.id}) failed: ${(e as Error)?.message ?? String(e)}`);
      }
    });
  } finally {
    await browser.close();
  }

  const settled: MissionResult[] = [...results.values()];

  let replayStorageState: string | undefined;
  for (const r of settled) if (r.replayStorageState) replayStorageState = r.replayStorageState;

  // Merge identical fingerprints across missions, then collapse distinct
  // capture paths of the same fault (5xx + console + timeout + throw) into one.
  const findings = collapseSignals(mergeFindings(settled.map((r) => r.findings)));
  const totalActions = settled.reduce((sum, r) => sum + r.actions, 0);
  const totalCoverage = settled.reduce((sum, r) => sum + r.newCoverage, 0);

  // Per-role totals: group settled missions by role id, count their findings.
  const byRole = new Map<string, RoleStat>();
  for (const r of settled) {
    const stat = byRole.get(r.roleId) ?? { roleId: r.roleId, label: "", missions: 0, actions: 0, findings: 0 };
    stat.missions += 1;
    stat.actions += r.actions;
    stat.findings += r.findings.length;
    byRole.set(r.roleId, stat);
  }
  for (const m of missions) {
    const stat = byRole.get(m.role.id);
    if (stat && !stat.label) stat.label = `${m.role.emoji} ${m.role.name}`.trim();
  }
  const roleStats = [...byRole.values()];

  return {
    findings,
    replayStorageState,
    totalActions,
    totalCoverage,
    workerCount: settled.length,
    roles: missions.map((m) => m.role.name),
    roleStats,
    sawLoginForm: settled.some((r) => r.sawLoginForm),
  };
}
