/**
 * Grounding: what is really on the page, and how much a hypothesis is entitled
 * to claim.
 *
 * Two jobs, both about not trusting the model's imagination:
 *
 *   observeState  walks the live application and records every control and every
 *                 readable thing (counts, headings, counters) it can actually
 *                 see, each with an id. Experiments can only be bound to these
 *                 ids, so a control that is not on the page cannot be named.
 *
 *   groundingOf   decides, from evidence and not from the model's say-so,
 *                 whether a hypothesis rests on a stated requirement
 *                 ("specified"), on a general property whose preconditions and
 *                 operands are all established ("general"), or on an unverified
 *                 assumption ("exploratory").
 */

import type { Page } from "playwright";
import { locate } from "./execute.js";
import type { Grounding, Hypothesis, HypothesisResult, Inventory, ResultStatus, Target } from "./types.js";

export interface ObservedControl {
  id: string;
  route: string;
  /** link | button | input | select | textarea | role */
  kind: string;
  /** Visible name (button text, aria-label, …). */
  name: string;
  type?: string;
  /** Same-origin path a link goes to. */
  href?: string;
  target: Target;
}

export interface ObservedReadable {
  id: string;
  route: string;
  /** `count`: how many elements match; `text`: the visible text of the first. */
  kind: "count" | "text";
  target: Target;
  /** What it showed when observed — the count, or the text. */
  sample: string;
}

export interface RouteObservation {
  path: string;
  title: string;
  /** Start of the visible text, for orientation. */
  text: string;
  controls: ObservedControl[];
  readables: ObservedReadable[];
}

export interface StateMap {
  routes: RouteObservation[];
  /** Route the observation started on; steps of a derived state begin there. */
  startRoute: string;
}

interface RawControl {
  kind: string;
  role?: string;
  type?: string;
  name: string;
  label: string;
  placeholder: string;
  href: string;
  path: string;
}
interface RawReadable {
  kind: "count" | "text";
  path: string;
  sample: string;
}

/** Runs in the page. Plain arrow functions only: it is serialised into the browser. */
const OBSERVE = () => {
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const cssPath = (el: Element) => {
    const parts: string[] = [];
    let e: Element | null = el;
    while (e && e.nodeType === 1 && parts.length < 7) {
      let seg = e.tagName.toLowerCase();
      const id = (e as HTMLElement).id;
      if (id && /^[A-Za-z][\w-]*$/.test(id)) {
        parts.unshift(`${seg}#${id}`);
        break;
      }
      const parent: Element | null = e.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === (e as Element).tagName);
        if (same.length > 1) seg += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(seg);
      e = parent;
    }
    return parts.join(" > ");
  };
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

  const controls: RawControl[] = [];
  const sel = "a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch]";
  for (const el of Array.from(document.querySelectorAll(sel))) {
    if (!visible(el) || controls.length >= 40) continue;
    const e = el as HTMLInputElement;
    const tag = el.tagName.toLowerCase();
    const labelEl = e.labels && e.labels[0] ? clean(e.labels[0].innerText) : "";
    controls.push({
      kind: tag === "a" ? "link" : tag === "input" || tag === "select" || tag === "textarea" || tag === "button" ? tag : "role",
      role: el.getAttribute("role") || undefined,
      type: tag === "input" ? e.type : undefined,
      name: clean(el.getAttribute("aria-label") || (tag === "input" ? "" : (el as HTMLElement).innerText) || el.getAttribute("title") || (tag === "input" && /^(submit|button)$/.test(e.type) ? e.value : "")).slice(0, 60),
      label: labelEl || clean(el.getAttribute("aria-label")),
      placeholder: clean(e.placeholder),
      href: tag === "a" ? (el as HTMLAnchorElement).href : "",
      path: cssPath(el),
    });
  }

  const readables: RawReadable[] = [];
  for (const h of Array.from(document.querySelectorAll("h1,h2,h3"))) {
    const t = clean((h as HTMLElement).innerText);
    if (t && visible(h) && readables.length < 12) readables.push({ kind: "text", path: cssPath(h), sample: t.slice(0, 60) });
  }
  for (const list of Array.from(document.querySelectorAll("ul,ol,tbody,[role=list]"))) {
    const kids = Array.from(list.children);
    // An empty list has no size, so judge visibility by its parent: "0 items" is a state worth reading.
    if (readables.length >= 20 || !visible(kids.length ? list : list.parentElement ?? list)) continue;
    if (!kids.length) {
      readables.push({ kind: "count", path: `${cssPath(list)} > *`, sample: "0" });
      continue;
    }
    const tag = kids[0].tagName.toLowerCase();
    if (kids.every((k) => k.tagName.toLowerCase() === tag)) {
      readables.push({ kind: "count", path: `${cssPath(list)} > ${tag}`, sample: String(kids.length) });
    }
  }
  // Short leaf elements that carry a number: counters, totals, badges.
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (readables.length >= 28) break;
    if (el.children.length || !visible(el) || el.closest("a,button,input,select,textarea,script,style")) continue;
    const t = clean((el as HTMLElement).innerText);
    if (t.length > 0 && t.length <= 40 && /\d/.test(t)) readables.push({ kind: "text", path: cssPath(el), sample: t });
  }

  return {
    title: document.title,
    text: clean(document.body.innerText).slice(0, 300),
    controls,
    readables,
  };
};

const origin = (baseUrl: string) => new URL(baseUrl).origin;

/** Observe the page the browser is on right now. Targets are verified to resolve before they are offered. */
export async function observePage(page: Page, baseUrl: string, nextId: { c: number; r: number }): Promise<RouteObservation> {
  // tsx/esbuild wrap named arrows in a `__name` helper that does not exist in the page.
  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
  const raw = await page.evaluate(OBSERVE);
  const path = new URL(page.url()).pathname;
  const controls: ObservedControl[] = [];
  const seen = new Set<string>();
  for (const c of raw.controls) {
    let target: Target;
    if (c.kind === "input" || c.kind === "textarea" || c.kind === "select") {
      target = c.label ? { label: c.label } : c.placeholder ? { placeholder: c.placeholder } : { selector: c.path };
    } else {
      const role = c.role ?? (c.kind === "link" ? "link" : "button");
      target = c.name ? { role, text: c.name } : { selector: c.path };
    }
    // A semantic target that does not resolve (or a hidden duplicate) falls back to the DOM path it came from.
    const resolves = await locate(page, target).count().catch(() => 0);
    if (!resolves && target.selector === undefined) target = { selector: c.path };
    const key = JSON.stringify(target);
    if (seen.has(key)) continue;
    seen.add(key);
    let href: string | undefined;
    if (c.href) {
      try {
        const u = new URL(c.href);
        if (u.origin === origin(baseUrl)) href = u.pathname;
      } catch { /* not a URL */ }
    }
    controls.push({ id: `c${++nextId.c}`, route: path, kind: c.kind, name: c.name || c.label || c.placeholder, type: c.type, href, target });
  }
  const readables: ObservedReadable[] = [];
  for (const r of raw.readables) {
    const target: Target = { selector: r.path };
    readables.push({ id: `r${++nextId.r}`, route: path, kind: r.kind, target, sample: r.sample });
  }
  return { path, title: raw.title, text: raw.text, controls, readables };
}

const ASSET = /\.(png|jpe?g|gif|svg|ico|pdf|zip|css|js|map|json|xml|txt)(\?|$)/i;

/**
 * Observe the application: the current page, and (with `crawl`) the same-origin
 * pages it links to. Without `crawl` only the current page is observed — used
 * for a state reached by earlier steps, where navigating away would lose it.
 */
export async function observeState(page: Page, baseUrl: string, opts: { crawl: boolean; maxRoutes?: number }): Promise<StateMap> {
  const nextId = { c: 0, r: 0 };
  const startRoute = new URL(page.url()).pathname;
  const first = await observePage(page, baseUrl, nextId);
  const routes = [first];
  if (opts.crawl) {
    const seen = new Set([first.path]);
    const queue = first.controls.flatMap((c) => (c.href ? [c.href] : []));
    while (queue.length && routes.length < (opts.maxRoutes ?? 6)) {
      const href = queue.shift() as string;
      const p = href.split("#")[0];
      if (seen.has(p) || ASSET.test(p)) continue;
      seen.add(p);
      try {
        await page.goto(new URL(p, baseUrl).toString(), { waitUntil: "load", timeout: 20_000 });
        await page.waitForTimeout(400);
      } catch {
        continue;
      }
      const obs = await observePage(page, baseUrl, nextId);
      seen.add(obs.path);
      routes.push(obs);
      for (const c of obs.controls) if (c.href) queue.push(c.href);
    }
    await page.goto(new URL(startRoute, baseUrl).toString(), { waitUntil: "load", timeout: 20_000 }).catch(() => undefined);
  }
  return { routes, startRoute };
}

export const allControls = (m: StateMap): ObservedControl[] => m.routes.flatMap((r) => r.controls);
export const allReadables = (m: StateMap): ObservedReadable[] => m.routes.flatMap((r) => r.readables);

// ---- prerequisites ---------------------------------------------------------

export interface Prerequisite {
  kind: "authentication";
  /** Where it was seen: the UI and/or the documentation. */
  evidence: string[];
  /** Was an authenticated state supplied? */
  satisfied: boolean;
}

const AUTH_DOC = /\b(password|log ?in|sign ?in|credentials?|authenticat\w+|token)\b/i;
const AUTH_NAME = /\b(log ?in|sign ?in|authenticate)\b/i;

/**
 * Prerequisites are *read*, never guessed: a password field or a login control on
 * the live pages, and what the documentation says about credentials. No value is
 * ever taken from the docs; a credential reaches the run only if the operator
 * supplies it.
 */
export function detectPrerequisites(inv: Inventory, map: StateMap, authSupplied: boolean): Prerequisite[] {
  const evidence: string[] = [];
  for (const r of map.routes) {
    for (const c of r.controls) {
      if (c.type === "password") evidence.push(`ui:${r.path} has a password field`);
      else if (AUTH_NAME.test(c.name)) evidence.push(`ui:${r.path} has a "${c.name}" control`);
    }
    if (AUTH_DOC.test(r.text) && /log ?in|sign ?in|authenticat/i.test(r.text)) evidence.push(`ui:${r.path} text mentions logging in`);
  }
  const docLines = inv.text
    .split("\n")
    .filter((l) => /^(?:[#*\-\s]*)/.test(l) && AUTH_DOC.test(l) && /password|credential|authenticat|log ?in/i.test(l))
    .slice(0, 3)
    .map((l) => `docs: ${l.trim().slice(0, 100)}`);
  evidence.push(...docLines);
  return evidence.length ? [{ kind: "authentication", evidence: [...new Set(evidence)].slice(0, 6), satisfied: authSupplied }] : [];
}

// ---- grounding -------------------------------------------------------------

/**
 * Literals the hypothesis compares a reading against that nothing established:
 * not typed by the script itself, not in the verified quote, and not what the
 * reading showed when it was observed. `10` expected of a page that showed `0`
 * is a number somebody made up.
 */
export function ungroundedLiterals(h: Hypothesis, observed?: Map<string, string>): string[] {
  const typed = new Set(h.steps.flatMap((s) => (s.op === "fill" ? [s.value.trim().toLowerCase()] : [])));
  const quote = (h.expectation.quote ?? "").toLowerCase();
  const out: string[] = [];
  for (const r of h.expect) {
    if (r.kind === "increased_by") continue;
    const right = r.right;
    const isRef = typeof right === "string" && /^[\w-]+\.[\w-]+$/.test(right) && h.steps.some((s) => s.op === "snapshot" && s.label === right.split(".")[0]);
    if (isRef) continue;
    const lit = String(right).trim().toLowerCase();
    const baseline = observed?.get(r.left.split(".")[1]);
    const word = new RegExp(`(^|[^\\w])${lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w])`);
    const partial = r.kind === "contains" || r.kind === "not_contains";
    const grounded =
      typed.has(lit) ||
      (quote.length > 0 && word.test(quote)) ||
      (baseline !== undefined && baseline.trim().toLowerCase() === lit) ||
      // Only a "contains" check may match part of what the script typed, and not by a stray character.
      (partial && [...typed].some((t) => t.length >= 3 && (lit.includes(t) || t.includes(lit))));
    if (!grounded) out.push(String(right));
  }
  return out;
}

/**
 * - specified:   a requirement the project itself states (doc/test/ui, verbatim quote verified), with no invented constants
 * - general:     a universal property whose preconditions are established (`bound`: every control it uses was observed on
 *                the page, or the script is known to have run in full) and whose operands are all readings taken in the
 *                run or things the script typed — never a guessed constant
 * - exploratory: everything else
 */
export function groundingOf(h: Hypothesis, opts: { bound?: boolean; observed?: Map<string, string> } = {}): Grounding {
  if (ungroundedLiterals(h, opts.observed).length) return "exploratory";
  if (h.expectation.kind !== "universal") return "specified";
  return opts.bound ? "general" : "exploratory";
}

/**
 * What a result may be called. A replayed violation of a *specified* expectation
 * is a finding; a violation of a general or exploratory one is a lead — evidence
 * that something is worth a person's attention, not a statement that it is wrong.
 */
export function statusOf(r: HypothesisResult): ResultStatus {
  switch (r.outcome) {
    case "supported_violation": {
      const bound = r.runs.length > 0 && r.runs.every((run) => run.steps.every((s) => s.ok));
      return (r.hypothesis.grounding ?? groundingOf(r.hypothesis, { bound })) === "specified" ? "finding" : "lead";
    }
    case "disproven":
      return "held";
    case "unknown":
      return "unknown";
    default:
      return "environment";
  }
}
