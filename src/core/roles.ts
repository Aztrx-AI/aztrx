/**
 * Role catalog — the swarm's QA team.
 *
 * A role is a declarative spec: which behavior primitive(s) it runs, how it
 * runs them (solo mission, synchronized race pair, or a browser-less pass),
 * and what it exists to break. The scheduler (swarm.ts) turns a catalog
 * subset into agent missions; agent.ts executes one mission per role.
 *
 * Roles are deliberately data, not code: adding a role must not mean touching
 * the scheduler. New behavior primitives live next to domWalker/fuzzer.
 */

/** A behavior primitive — the one thing a mission actually does with a page. */
export type BehaviorKind =
  | "walk" // deterministic crawl — every button on every route
  | "fuzz" // chaos clicks + hostile payloads (seeded)
  | "keyboard" // keyboard-only: Tab/Enter/Escape, no pointer at all
  | "chaosReload" // walk interrupted by reloads mid-operation
  | "observe" // passive: sit on each route, watch console/network
  | "httpStorm" // hostile HTTP requests at the API (mutations included)
  | "slowWalk"; // walk under emulated slow network (3G-ish)

/** How a role's missions are scheduled. */
export type AgentMode =
  | "solo" // one browser context, one mission
  | "race" // two contexts, synchronized start on the same target
  | "light"; // minimal context, no guard/interceptor — API-only roles

export interface RoleBehavior {
  kind: BehaviorKind;
  /** Per-mission budget (actions or requests). */
  budget: number;
}

export interface Role {
  id: string;
  /** Human-readable name shown in the swarm summary. */
  name: string;
  emoji: string;
  /** What this agent exists to break — the mission, one line. */
  mission: string;
  mode: AgentMode;
  behaviors: RoleBehavior[];
}

export const ROLE_CATALOG: Role[] = [
  {
    id: "novice",
    name: "Novice",
    emoji: "🐣",
    mission: "clicks everything, submits half-filled forms, goes Back mid-flow",
    mode: "solo",
    behaviors: [{ kind: "walk", budget: 100 }],
  },
  {
    id: "power",
    name: "Power user",
    emoji: "⌨️",
    mission: "drives the app by keyboard alone: Tab, Enter, Escape, arrows",
    mode: "solo",
    behaviors: [{ kind: "keyboard", budget: 100 }],
  },
  {
    id: "hostile",
    name: "Hooligan",
    emoji: "💣",
    mission: "fills every field with garbage: 4KB strings, null bytes, SQL-ish payloads",
    mode: "solo",
    behaviors: [{ kind: "fuzz", budget: 100 }],
  },
  {
    id: "session-killer",
    name: "Session killer",
    emoji: "🪓",
    mission: "reloads mid-operation and forces modals shut — state-restore crashes",
    mode: "solo",
    behaviors: [{ kind: "chaosReload", budget: 100 }],
  },
  {
    id: "race-hunter",
    name: "Race hunter",
    emoji: "⚔️",
    mission: "two synchronized hands on the same button — races and lost updates",
    mode: "race",
    behaviors: [{ kind: "walk", budget: 100 }],
  },
  {
    id: "observer",
    name: "Observer",
    emoji: "🛰️",
    mission: "never clicks: sits on each route and watches console, 5xx, rejections",
    mode: "solo",
    behaviors: [{ kind: "observe", budget: 100 }],
  },
  {
    id: "a11y",
    name: "A11y tester",
    emoji: "🦮",
    mission: "keyboard-only navigation — focus traps and unreachable controls",
    mode: "solo",
    behaviors: [{ kind: "keyboard", budget: 100 }],
  },
  {
    id: "http-raider",
    name: "HTTP raider",
    emoji: "🏴‍☠️",
    mission: "storms the API with hostile headers, methods and body mutations",
    mode: "light",
    behaviors: [{ kind: "httpStorm", budget: 100 }],
  },
  {
    id: "regressor",
    name: "Regressor",
    emoji: "📜",
    mission: "re-walks the known routes — anything new vs. the baseline is a finding",
    mode: "solo",
    behaviors: [{ kind: "walk", budget: 100 }],
  },
  {
    id: "slow-net",
    name: "Slow internet",
    emoji: "🐌",
    mission: "walks under 3G throttle — skeletons, races, load-order timeouts",
    mode: "solo",
    behaviors: [{ kind: "slowWalk", budget: 100 }],
  },
];

/** Resolve a comma-separated `--roles` list against the catalog. Unknown ids
 * are skipped silently (the CLI reports them before this is called). */
export function resolveRoles(ids: string[] | undefined): Role[] {
  if (!ids || ids.length === 0) return ROLE_CATALOG;
  const byId = new Map(ROLE_CATALOG.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id.trim())).filter((r): r is Role => Boolean(r));
}

/** Swarm-summary label: emoji + name, e.g. "💣 Hooligan". */
export function roleLabel(role: Role): string {
  return `${role.emoji} ${role.name}`;
}
