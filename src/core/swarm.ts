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

import * as path from "path";
import type { Browser } from "playwright";
import pc from "picocolors";
import { launchChromium } from "./browser.js";
import { EventBus } from "./eventBus.js";
import { collapseSignals } from "./classifier.js";
import type { Role } from "./roles.js";
import { ROLE_CATALOG, resolveRoles } from "./roles.js";
import type { AgentOptions, Mission, MissionResult } from "./agent.js";
import { runAgentMission, runRaceMission } from "./agent.js";
import { analyzeTarget } from "./profile.js";
import type { ProjectProfile } from "./profile.js";
import { profileSummary, synthesizeRoles } from "./synthesize.js";
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
  /** Analyze the target first and synthesize audience roles for it (--swarm).
   * Default agents = 1000; per-mission budgets shrink to keep the run bounded. */
  synthesize?: boolean;
  /** `--agents N` — total missions across the selected roles (default: 1 per
   * role in `--roles` mode, 1000 in synthesized `--swarm` mode). */
  agents?: number;
  /** Delta-scan scope (aztrx watch): only findings that point at this file —
   * by mapped source location, or by mentioning it in message/stack — survive
   * the merge. The whole swarm still runs; the report shrinks to the delta. */
  scopePath?: string;
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
  /** The scout pass's read of the target (synthesized swarm mode only). */
  profile?: ProjectProfile;
  /** How many persona roles the synthesizer added on top of the catalog. */
  personaCount?: number;
}

/** A synthetic role for the legacy (non-catalog) modes. */
function syntheticRole(id: string, label: string, kind: "walk" | "fuzz", budget: number): Role {
  return { id, name: label, emoji: "", mission: "", mode: "solo", behaviors: [{ kind, budget }] };
}

/** Per-mission budget under a swarm-wide cap: shrink so `total` missions stay
 * around `cap` actions altogether, but never below 3 (an agent that pokes
 * less than three times isn't an agent). */
function effectiveBudget(role: Role, total: number, cap: number | undefined): number {
  const roleBudget = role.behaviors[0]?.budget ?? 100;
  if (!cap) return roleBudget;
  return Math.max(3, Math.min(roleBudget, Math.ceil(cap / total)));
}

export interface CatalogMissionsInput {
  roles: Role[];
  /** Total missions to allocate across the roles. */
  total: number;
  seed: number;
  /** Allocate by role weight (the synthesized audience mix). Default: round-robin. */
  weighted?: boolean;
  /** Swarm-wide action cap — per-mission budgets shrink to honor it. */
  budgetCap?: number;
}

/**
 * Allocate `total` missions across the role roster. Weighted allocation
 * mirrors the audience: each role gets floor(total × weight / totalWeight)
 * missions, the remainder is distributed round-robin in roster order. Every
 * mission gets its own seed.
 */
export function buildCatalogMissions(input: CatalogMissionsInput): Mission[] {
  const { roles, total, seed } = input;
  const counts = new Map<string, number>();
  let assigned = 0;

  if (input.weighted) {
    const totalWeight = roles.reduce((s, r) => s + (r.weight ?? 1), 0);
    for (const r of roles) {
      const n = Math.floor((total * (r.weight ?? 1)) / totalWeight);
      counts.set(r.id, n);
      assigned += n;
    }
  }
  let i = 0;
  while (assigned < total) {
    const r = roles[i % roles.length];
    counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
    assigned++;
    i++;
  }

  // Emit interleaved — role A, B, C, A, B, C — so the first queued missions
  // span the whole roster and an interrupted run still sampled everyone.
  const remaining = new Map(counts);
  const missions: Mission[] = [];
  let s = seed;
  let pushed = true;
  while (pushed) {
    pushed = false;
    for (const r of roles) {
      const left = remaining.get(r.id) ?? 0;
      if (left > 0) {
        remaining.set(r.id, left - 1);
        missions.push({ role: r, seed: s++, budget: effectiveBudget(r, total, input.budgetCap) });
        pushed = true;
      }
    }
  }
  return missions;
}

/**
 * The legacy roster: `workers = 1` is the single walk; `workers > 1` fans out
 * as walk + fuzz seeds (`--fuzz` makes every worker fuzz). `--http-fuzz` is
 * not a mission — it folds into the walk/fuzz mission as before.
 */
export function buildLegacyMissions(opts: { workers: number; fuzz?: boolean; seed: number; maxActions: number }): Mission[] {
  const missions: Mission[] = [];
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
  const browser = await launchChromium();

  // Roster: the synthesized swarm (--swarm) scouts the target first and builds
  // its audience; --roles picks catalog roles outright; otherwise the legacy
  // walk/fuzz roster runs untouched.
  let profile: ProjectProfile | undefined;
  let personaCount = 0;
  let missions: Mission[];
  let catalogMode = Boolean(opts.roles?.length);

  if (opts.synthesize) {
    try {
      // The scout: one quiet page load to read what this app is. The interceptor
      // and guard are irrelevant here — nothing is clicked, nothing is sent.
      const scout = await browser.newContext();
      try {
        const scoutPage = await scout.newPage();
        await scoutPage.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await scoutPage.waitForTimeout(1500);
        profile = await analyzeTarget(scoutPage, opts.repoRoot);
      } finally {
        await scout.close();
      }
      const roster = synthesizeRoles(profile);
      personaCount = roster.length - ROLE_CATALOG.length;
      // The scout's verdict, printed the moment it lands — the orchestrator
      // announced "Analyzing your app…" before this.
      opts.log(pc.dim(`audience: ${profileSummary(profile, personaCount)}`));
      // The audience mix, weighted, scaled to a thousand missions by default.
      // Budgets shrink so the whole swarm stays within `maxActions` of work.
      missions = buildCatalogMissions({
        roles: roster,
        total: opts.agents ?? 1000,
        seed: opts.seed,
        weighted: true,
        budgetCap: opts.maxActions,
      });
      opts.log(pc.dim(`swarming: ${missions.length} mission(s) across ${roster.length} role(s)`));
      catalogMode = true;
    } catch (e) {
      // A failed scout must not kill the run — fall back to the standing catalog.
      opts.log(`scout failed (${(e as Error)?.message ?? String(e)}) — falling back to the base catalog`);
      const roster = resolveRoles(undefined);
      missions = buildCatalogMissions({ roles: roster, total: opts.agents ?? roster.length, seed: opts.seed });
      catalogMode = true;
    }
  } else if (opts.roles?.length) {
    const roster = resolveRoles(opts.roles);
    missions = buildCatalogMissions({ roles: roster, total: opts.agents ?? roster.length, seed: opts.seed });
  } else {
    missions = buildLegacyMissions({ workers: opts.workers, fuzz: opts.fuzz, seed: opts.seed, maxActions: opts.maxActions });
  }

  // `--workers` overrides the pool size; otherwise catalog mode caps at 8
  // contexts (a desktop-size default), legacy mode runs exactly its roster.
  const concurrency =
    opts.concurrency ?? (opts.workers > 1 ? opts.workers : Math.min(missions.length, catalogMode ? 8 : missions.length));

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
        // A thousand-mission swarm logs per-mission lines only when there is
        // something to say — the per-role summary carries the totals.
        if (result.findings.length > 0 || missions.length <= 20) {
          opts.log(
            catalogMode
              ? `[${mission.role.id}] done — ${result.actions} action(s), ${result.findings.length} finding(s)`
              : `[w${i}] done — ${result.actions} action(s), ${result.findings.length} finding(s)`
          );
        }
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
  let findings = collapseSignals(mergeFindings(settled.map((r) => r.findings)));

  // Delta-scan scope (aztrx watch): keep only what points at the saved file.
  // The mapped source path must match (extension-swapped .js/.ts/.tsx/.html
  // count as the same file), or the message/stack must name it.
  if (opts.scopePath) {
    const scopeBase = path.basename(opts.scopePath).replace(/\.(js|ts|tsx|html)$/i, "");
    const scopeRel = path.resolve(opts.scopePath);
    findings = findings.filter((f) => {
      if (f.mappedLocation) {
        const fp = path.resolve(opts.repoRoot, f.mappedLocation.filePath);
        const base = path.basename(f.mappedLocation.filePath).replace(/\.(js|ts|tsx|html)$/i, "");
        if (fp === scopeRel || base === scopeBase) return true;
      }
      const needle = path.basename(opts.scopePath!).split(path.sep).join("\\\\");
      return f.rawMessage.includes(path.basename(opts.scopePath!)) || f.rawStack.includes(needle) || f.rawStack.includes(path.basename(opts.scopePath!));
    });
  }
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
    roles: [...new Set(missions.map((m) => m.role.name))],
    roleStats,
    sawLoginForm: settled.some((r) => r.sawLoginForm),
    profile,
    personaCount,
  };
}
