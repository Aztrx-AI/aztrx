/**
 * The comparison arm: a plain tool-using agent loop. Same model client, same
 * inventory text, same browser primitives and the same spend/time/step budget
 * as the hypothesis pipeline — and none of its structure: no stated hypotheses,
 * no prioritization, no replay-before-report, no outcome taxonomy. It decides
 * what to do next turn by turn and reports what it believes is a bug.
 *
 * The model is offered exactly the tools in `TOOLS`, as structured tool
 * definitions generated from that one registry — so a tool the model is told
 * about is, by construction, one the runtime can execute, and vice versa.
 *
 * Whether either arm's claims are real is decided afterwards by the same
 * independent evaluation, never by the arm itself.
 */

import { chromium, type Page } from "playwright";
import type { ToolDef, ToolReply } from "../llm.js";
import { Ledger, BudgetExceeded, redact } from "./ledger.js";
import { locate } from "./execute.js";
import { buildInventory } from "./inventory.js";
import type { Target } from "./types.js";

const SYSTEM = `You are testing a running web application for behavioral defects, acting like a real user. You are NOT told of any bug and must not assume one exists.

Each turn, call exactly one of the provided tools. Look at the page, then act on it, then look at what changed.
Stay inside the product: same-origin only, synthetic data, no attacks, no deleting data you did not create.
Report (with the report tool) only what you actually observed in this session, with the exact steps. Call done when you have nothing more to try.`;

// ---- tool registry --------------------------------------------------------

const TARGET_SCHEMA = {
  type: "object",
  description: "Where on the page. Give at least one of the fields; prefer text, label or role over selector.",
  properties: {
    text: { type: "string", description: "visible text of the element" },
    label: { type: "string", description: "its form label" },
    placeholder: { type: "string", description: "an input's placeholder" },
    role: { type: "string", description: "ARIA role, e.g. button, link, textbox (use with text as its accessible name)" },
    selector: { type: "string", description: "CSS selector, last resort" },
  },
};

interface ToolContext {
  page: Page;
  baseUrl: string;
  look(): Promise<string>;
  claims: BaselineReport["claims"];
  turn: number;
}

interface Tool extends ToolDef {
  /** Does a successful call return what the page now looks like? */
  observes: boolean;
  /** Extra argument checks the schema cannot express; return a message when invalid. */
  check?(args: Record<string, unknown>): string | undefined;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<string>;
  /** Marks the end of the session. */
  terminal?: boolean;
}

const hasTarget = (v: unknown): string | undefined => {
  const t = v as Record<string, unknown> | undefined;
  return t && typeof t === "object" && ["text", "label", "placeholder", "role", "selector"].some((k) => typeof t[k] === "string" && (t[k] as string).trim())
    ? undefined
    : "target needs at least one of text, label, placeholder, role, selector";
};

export const TOOLS: Tool[] = [
  {
    name: "look",
    description: "See the current page: URL, title, visible text and the interactive controls (buttons, links, inputs) on it.",
    parameters: { type: "object", properties: {} },
    observes: true,
    run: (ctx) => ctx.look(),
  },
  {
    name: "goto",
    description: "Open a page of the app by its path.",
    parameters: { type: "object", properties: { path: { type: "string", description: "same-origin path starting with /, e.g. /settings" } }, required: ["path"] },
    observes: true,
    check: (a) => (typeof a.path === "string" && a.path.startsWith("/") && !a.path.startsWith("//") ? undefined : "path must be a same-origin path starting with a single /"),
    run: async (ctx, a) => {
      await ctx.page.goto(new URL(String(a.path), ctx.baseUrl).toString(), { waitUntil: "load", timeout: 20_000 });
      return ctx.look();
    },
  },
  {
    name: "click",
    description: "Click an element, then see the page.",
    parameters: { type: "object", properties: { target: TARGET_SCHEMA }, required: ["target"] },
    observes: true,
    check: (a) => hasTarget(a.target),
    run: async (ctx, a) => {
      await locate(ctx.page, a.target as Target).click({ timeout: 8_000 });
      await ctx.page.waitForTimeout(300);
      return ctx.look();
    },
  },
  {
    name: "fill",
    description: "Type a value into an input, replacing what is there. Does not submit; press Enter or click the submit control afterwards.",
    parameters: { type: "object", properties: { target: TARGET_SCHEMA, value: { type: "string" } }, required: ["target", "value"] },
    observes: false,
    check: (a) => hasTarget(a.target),
    run: async (ctx, a) => {
      await locate(ctx.page, a.target as Target).fill(String(a.value), { timeout: 8_000 });
      return "filled";
    },
  },
  {
    name: "press",
    description: "Press a keyboard key (e.g. Enter, Tab, Escape), then see the page.",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    observes: true,
    check: (a) => (typeof a.key === "string" && a.key.length > 0 && a.key.length <= 20 ? undefined : "key must be a short key name"),
    run: async (ctx, a) => {
      await ctx.page.keyboard.press(String(a.key));
      await ctx.page.waitForTimeout(300);
      return ctx.look();
    },
  },
  {
    name: "reload",
    description: "Reload the current page, then see it.",
    parameters: { type: "object", properties: {} },
    observes: true,
    run: async (ctx) => {
      await ctx.page.reload({ waitUntil: "load" });
      return ctx.look();
    },
  },
  {
    name: "report",
    description: "Record a defect you found: what you did, what you saw, and why it is wrong.",
    parameters: {
      type: "object",
      properties: { claim: { type: "string", description: "the exact steps and what was observed" }, why_it_is_wrong: { type: "string" } },
      required: ["claim", "why_it_is_wrong"],
    },
    observes: false,
    check: (a) => (String(a.claim ?? "").trim() && String(a.why_it_is_wrong ?? "").trim() ? undefined : "claim and why_it_is_wrong must be non-empty"),
    run: async (ctx, a) => {
      ctx.claims.push({ claim: String(a.claim), why_it_is_wrong: String(a.why_it_is_wrong), atTurn: ctx.turn });
      return "recorded";
    },
  },
  {
    name: "done",
    description: "Finish the session.",
    parameters: { type: "object", properties: {} },
    observes: false,
    terminal: true,
    run: async () => "session ended",
  },
];

const TOOL_NAMES = TOOLS.map((t) => t.name);

/** Model-facing definitions, straight from the registry. */
export const toolDefs = (): ToolDef[] => TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));

/** Validate arguments against the tool's schema (required keys, primitive types) and its own check. */
export function checkArguments(tool: Tool, args: Record<string, unknown>): string | undefined {
  const schema = tool.parameters as { properties?: Record<string, { type?: string }>; required?: string[] };
  for (const k of schema.required ?? []) if (args[k] === undefined) return `missing required argument "${k}"`;
  for (const [k, v] of Object.entries(args)) {
    const want = schema.properties?.[k]?.type;
    if (!schema.properties?.[k]) return `unknown argument "${k}"`;
    if (want === "string" && typeof v !== "string") return `argument "${k}" must be a string`;
    if (want === "object" && (typeof v !== "object" || v === null || Array.isArray(v))) return `argument "${k}" must be an object`;
  }
  return tool.check?.(args);
}

// ---- loop -----------------------------------------------------------------

export type TurnStatus =
  /** Valid call, ran, returned its result. */
  | "ok"
  /** Valid call that the runtime could not carry out (element not found, timeout…). */
  | "tool_error"
  /** Named a tool that does not exist, or its arguments failed the schema. */
  | "invalid_tool_call"
  /** The model replied with no tool call at all. */
  | "no_tool_call";

export interface BaselineMetrics {
  turns: number;
  /** Calls to a real tool with schema-valid arguments. */
  validToolCalls: number;
  invalidToolCalls: number;
  noToolCalls: number;
  /** Valid calls the runtime could not carry out. */
  toolErrors: number;
  /** Successful calls that returned what the page looks like. */
  observations: number;
  /** Successful state-changing actions (goto/click/fill/press/reload). */
  actionsExecuted: number;
  validCallRate: number;
}

export interface BaselineReport {
  turns: Array<{ act: unknown; status: TurnStatus; observation: string }>;
  claims: Array<{ claim: string; why_it_is_wrong: string; atTurn: number }>;
  stoppedBecause: string;
  metrics: BaselineMetrics;
  ledger: ReturnType<Ledger["summary"]>;
}

export type ToolCaller = (req: { system: string; prompt: string; maxTokens: number; tools: ToolDef[] }) => Promise<ToolReply>;

/** Consecutive unusable replies after which the session ends instead of retrying forever. */
export const MAX_CONSECUTIVE_INVALID = 3;

const LOOK_SCRIPT = () => {
  const controls = Array.from(document.querySelectorAll("a[href],button,input,select,textarea,[role=button]"))
    .slice(0, 40)
    .map((el) => {
      const e = el as HTMLInputElement;
      const name = (e.getAttribute("aria-label") || e.innerText || e.placeholder || e.name || e.value || "").replace(/\s+/g, " ").trim().slice(0, 40);
      const kind = el.tagName.toLowerCase() + (e.type && el.tagName === "INPUT" ? `[${e.type}]` : "");
      return `${kind}${name ? ` "${name}"` : ""}`;
    });
  return `url: ${location.pathname}${location.search}\ntitle: ${document.title}\ntext: ${document.body.innerText.replace(/\s+/g, " ").slice(0, 1500)}\ncontrols: ${controls.join("; ")}`;
};

export async function runBaseline(opts: {
  baseUrl: string;
  repoDir?: string;
  callTools: ToolCaller;
  ledger: Ledger;
  /** Same budgets the pipeline ran under. */
  maxTurns: number;
  maxMs: number;
  maxTokensPerTurn?: number;
}): Promise<BaselineReport> {
  const browser = await chromium.launch({ headless: true });
  const turns: BaselineReport["turns"] = [];
  const claims: BaselineReport["claims"] = [];
  let stoppedBecause = "turn cap reached";
  const t0 = Date.now();
  const m: BaselineMetrics = { turns: 0, validToolCalls: 0, invalidToolCalls: 0, noToolCalls: 0, toolErrors: 0, observations: 0, actionsExecuted: 0, validCallRate: 0 };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const inv = await buildInventory({ repoDir: opts.repoDir, page, baseUrl: opts.baseUrl });
    await page.goto(opts.baseUrl, { waitUntil: "load" });
    const transcript: string[] = [];
    const look = async () => page.evaluate(LOOK_SCRIPT).catch(() => "(no page)");
    const defs = toolDefs();
    let consecutiveInvalid = 0;

    for (let i = 0; i < opts.maxTurns; i++) {
      if (Date.now() - t0 > opts.maxMs) { stoppedBecause = "wall-clock cap reached"; break; }
      const prompt = `=== INVENTORY ===\n${inv.text}\n=== END INVENTORY ===\n\nHistory (latest last):\n${transcript.slice(-24).join("\n") || "(none yet)"}\n\nTurn ${i + 1} of ${opts.maxTurns}. Call one tool.`;
      const maxTokens = opts.maxTokensPerTurn ?? 700;
      let reply: ToolReply;
      try {
        opts.ledger.guard(SYSTEM.length + prompt.length, maxTokens);
        reply = await opts.callTools({ system: SYSTEM, prompt, maxTokens, tools: defs });
      } catch (e) {
        stoppedBecause = e instanceof BudgetExceeded ? `budget: ${e.message}` : `model call failed: ${redact(String((e as Error).message))}`;
        break;
      }
      m.turns++;

      let status: TurnStatus;
      let obs: string;
      let act: unknown;
      const call = reply.calls[0];
      const tool = call ? TOOLS.find((t) => t.name === call.name) : undefined;
      if (!call) {
        status = "no_tool_call";
        act = reply.text.slice(0, 200);
        obs = `no tool was called. Available actions: ${TOOL_NAMES.join(", ")}. Call exactly one.`;
        m.noToolCalls++;
      } else if (!tool) {
        status = "invalid_tool_call";
        act = { name: call.name, arguments: call.arguments };
        obs = `unknown action "${call.name}". Available actions: ${TOOL_NAMES.join(", ")}.`;
        m.invalidToolCalls++;
      } else {
        act = { name: call.name, arguments: call.arguments };
        const bad = checkArguments(tool, call.arguments);
        if (bad) {
          status = "invalid_tool_call";
          obs = `invalid arguments for "${call.name}": ${bad}.`;
          m.invalidToolCalls++;
        } else {
          m.validToolCalls++;
          try {
            obs = await tool.run({ page, baseUrl: opts.baseUrl, look, claims, turn: i + 1 }, call.arguments);
            status = "ok";
            if (tool.observes) m.observations++;
            if (["goto", "click", "fill", "press", "reload"].includes(tool.name)) m.actionsExecuted++;
            if (tool.terminal) stoppedBecause = "agent said done";
          } catch (e) {
            status = "tool_error";
            obs = `failed: ${String((e as Error).message).split("\n")[0]}`;
            m.toolErrors++;
          }
        }
      }

      consecutiveInvalid = status === "invalid_tool_call" || status === "no_tool_call" ? consecutiveInvalid + 1 : 0;
      turns.push({ act, status, observation: obs.slice(0, 600) });
      transcript.push(`#${i + 1} ${JSON.stringify(act)} [${status}] -> ${obs.slice(0, 500)}`);
      if (tool?.terminal && status === "ok") break;
      if (consecutiveInvalid >= MAX_CONSECUTIVE_INVALID) {
        stoppedBecause = `${consecutiveInvalid} consecutive invalid tool calls`;
        break;
      }
    }
    await ctx.close();
  } finally {
    await browser.close().catch(() => undefined);
  }
  m.validCallRate = m.turns ? Number((m.validToolCalls / m.turns).toFixed(3)) : 0;
  return { turns, claims, stoppedBecause, metrics: m, ledger: opts.ledger.summary() };
}
