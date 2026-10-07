/**
 * Entity scoping: which part of a page is *one thing*.
 *
 * A page that lists many things — rows, cards, list items — each with its own
 * state and its own controls cannot be bound as a whole: a state read from one
 * row and a control from another would be a lie. This module finds the
 * repeated structure, picks something inside each repetition that tells them
 * apart, and gives the runtime a way to re-find the same repetition after the
 * page has changed (a row re-sorted, a list re-rendered).
 *
 * It is structural. It knows nothing about what a repetition *is* — no tag
 * names beyond the DOM's own, no class names, no words. What it uses:
 *
 *   state-bearing elements   an element whose text is (or a <select> whose
 *                            selected option is) one of the machine's states
 *   a repeated structure     the children of the lowest element that contains
 *                            every state-bearing element, when those children
 *                            have the same shape
 *   an identity              a value at the same place in every repetition,
 *                            unique across them: an id/data-* attribute, a
 *                            link target, or a short leaf text
 *
 * Anything less definite is reported, not guessed: regions that are not alike,
 * or repetitions nothing tells apart, are `ambiguous`.
 */

import type { Page } from "playwright";

/** How to find one entity again: where its identity lives, and its value. */
export interface ScopeSpec {
  slot: string;
  value: string;
  /** Other identifying values the entity had when it was chosen (slot -> value).
   * A re-found entity must still agree with at least one of them, so a primary
   * identity that has come to mean a different row is caught, not trusted. */
  witnesses?: Record<string, string>;
}

export interface EntitySurvey {
  /** `none`: nothing on the page shows a state. `single`: one thing (or one
   * thing shown in several places) — bind the page. `entities`: a repeated
   * structure with a usable identity. `ambiguous`: several things, and no
   * confident way to tell them apart. */
  mode: "none" | "single" | "entities" | "ambiguous";
  reason?: string;
  /** Where the identity lives, relative to a repetition (`text:0/1`, `attr:id:`). */
  slot?: string;
  /** What was found repeating, e.g. `tr ×4`. */
  shape?: string;
  /** One per repetition, in document order. `state` is null when the
   * repetition shows no state, or shows two that disagree. */
  entities?: Array<{ value: string; state: string | null; witnesses?: Record<string, string> }>;
}

/** Installs the page-side helpers once per document. A reload drops them, so
 * every scoped operation calls this first. */
export async function ensureEntityHelpers(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const w = window as unknown as { __aztrx?: unknown };
      if (w.__aztrx) return;

      const norm = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const INTERACTIVE = "button, a, input, select, option, textarea, label, script, style, [role=button]";

      interface Bearer {
        el: Element;
        state: string;
      }

      /** Elements that show a state, innermost only. */
      const bearers = (states: string[]): Bearer[] => {
        const byNorm = new Map(states.map((s) => [norm(s), s]));
        const out: Bearer[] = [];
        for (const el of Array.from(document.body?.querySelectorAll("*") ?? [])) {
          if (el.tagName === "SELECT") {
            if (el.getClientRects().length === 0) continue;
            const o = (el as HTMLSelectElement).selectedOptions[0];
            if (!o) continue;
            const a = byNorm.get(norm(o.value));
            const b = byNorm.get(norm(o.textContent ?? ""));
            if ((a && b && a !== b) || !(a ?? b)) continue;
            out.push({ el, state: (a ?? b) as string });
            continue;
          }
          if (el.matches(INTERACTIVE) || el.closest("button, a, [role=button]")) continue;
          if (el.getClientRects().length === 0) continue;
          const text = ((el as HTMLElement).innerText ?? "").trim();
          if (!text || text.length > 80) continue;
          const tail = text.includes(":") ? text.slice(text.lastIndexOf(":") + 1) : text;
          const hit = byNorm.get(norm(tail));
          if (hit !== undefined) out.push({ el, state: hit });
        }
        return out.filter((b) => b.el.tagName === "SELECT" || !out.some((o) => o !== b && o.el !== b.el && b.el.contains(o.el)));
      };

      /** The tags an element holds. Counts and text are ignored. */
      const tagsOf = (el: Element): Set<string> => {
        const tags = new Set<string>();
        for (const d of Array.from(el.querySelectorAll("*"))) tags.add(d.tagName);
        return tags;
      };

      /** Two repetitions are alike when they are the same tag and hold mostly the
       * same kinds of things. "Mostly": a card with a product image and a card
       * without one are the same kind of card, while a filter bar next to a list
       * of cards is not. */
      const alikeEnough = (a: Element, b: Element): boolean => {
        if (a.tagName !== b.tagName) return false;
        const ta = tagsOf(a);
        const tb = tagsOf(b);
        let both = 0;
        for (const t of ta) if (tb.has(t)) both++;
        const either = ta.size + tb.size - both;
        return either === 0 || both / either >= 0.75;
      };

      const relPath = (root: Element, el: Element): string => {
        const p: number[] = [];
        let c: Element | null = el;
        while (c && c !== root) {
          const par: Element | null = c.parentElement;
          if (!par) break;
          p.unshift(Array.prototype.indexOf.call(par.children, c));
          c = par;
        }
        return p.join("/");
      };

      /** Everything inside a repetition that could identify it, keyed by where it is. */
      const slotsOf = (g: Element, states: string[]): Map<string, string> => {
        const m = new Map<string, string>();
        const stateNorms = new Set(states.map(norm));
        const visit = (el: Element) => {
          const p = relPath(g, el);
          for (const a of Array.from(el.attributes)) {
            const n = a.name;
            if ((n === "id" || n.startsWith("data-")) && !n.startsWith("data-aztrx") && a.value && a.value.length <= 64) {
              m.set("attr:" + n + ":" + p, a.value);
            }
            if (n === "href" && a.value) m.set("href:" + p, a.value.split("?")[0].split("#")[0]);
          }
          if (el.children.length === 0 && !el.matches("option, script, style, button, select, textarea, input")) {
            const t = (el.textContent ?? "").trim();
            if (t && t.length <= 40 && !stateNorms.has(norm(t))) m.set("text:" + p, t);
          }
          for (const c of Array.from(el.children)) visit(c);
        };
        visit(g);
        return m;
      };

      const slotRank = (k: string) => (k.startsWith("attr:id:") ? 0 : k.startsWith("attr:") ? 1 : k.startsWith("href:") ? 2 : 3);

      /** Values that just number the repetitions (0,1,2… or 1,2,3…, in order, or
       * the reverse). They are unique, but they name a *position*, which does not
       * survive a re-sort — a row that moves takes its number's meaning with it. */
      const numbersThePosition = (vals: string[]): boolean => {
        if (!vals.every((v) => /^\d+$/.test(v))) return false;
        const n = vals.map(Number);
        const up = n.every((x, i) => x === n[0] + i) && (n[0] === 0 || n[0] === 1);
        const down = n.every((x, i) => x === n[0] - i) && (n[0] === vals.length - 1 || n[0] === vals.length);
        return up || down;
      };

      /** The first slot present in every repetition whose values are all
       * different and do not merely count the repetitions. Every other such slot
       * is kept as a witness, to check an entity against after it is re-found. */
      const pickSlot = (groups: Element[], states: string[]) => {
        const maps = groups.map((g) => slotsOf(g, states));
        const keys = [...maps[0].keys()].filter((k) => maps.every((m) => m.has(k)));
        keys.sort((a, b) => slotRank(a) - slotRank(b)); // stable: document order within a kind
        const usable: Array<{ slot: string; values: string[] }> = [];
        let positional = 0;
        for (const k of keys) {
          const vals = maps.map((m) => m.get(k) as string);
          if (new Set(vals).size !== vals.length) continue;
          if (numbersThePosition(vals)) positional++;
          else usable.push({ slot: k, values: vals });
        }
        if (usable.length === 0) return { picked: null, positional };
        const [primary, ...rest] = usable;
        const witnesses = groups.map((_, i) => Object.fromEntries(rest.slice(0, 3).map((r) => [r.slot, r.values[i]])));
        return { picked: { slot: primary.slot, values: primary.values, witnesses }, positional };
      };

      /** The repetitions: children of the lowest element holding every bearer. */
      const regions = (states: string[]) => {
        const bs = bearers(states);
        if (bs.length < 2) return { bs, groups: [] as Element[] };
        let lca: Element | null = bs[0].el;
        while (lca && !bs.every((b) => (lca as Element).contains(b.el))) lca = lca.parentElement;
        const groups = lca ? Array.from(lca.children).filter((c) => bs.some((b) => c.contains(b.el))) : [];
        return { bs, groups };
      };

      const discover = (states: string[]) => {
        const { bs, groups } = regions(states);
        if (bs.length === 0) return { mode: "none" as const };
        if (bs.length === 1) return { mode: "single" as const };

        const alike = groups.length >= 2 && groups.every((g) => alikeEnough(g, groups[0]));
        if (!alike) {
          // One thing shown in two places (a badge and a select) is not a list.
          const distinct = new Set(bs.map((b) => b.state));
          const selects = bs.filter((b) => b.el.tagName === "SELECT").length;
          if (distinct.size === 1 && selects <= 1) return { mode: "single" as const };
          return {
            mode: "ambiguous" as const,
            reason:
              "the page shows several of the machine's states at once in " + groups.length +
              " regions that are not alike, so it cannot tell which one is a single entity",
          };
        }

        const { picked, positional } = pickSlot(groups, states);
        if (!picked) {
          return {
            mode: "ambiguous" as const,
            reason:
              "the page shows several of the machine's states at once in " + groups.length + " repetitions of " +
              groups[0].tagName.toLowerCase() + ", but nothing inside them tells one from another (no unique id/data attribute, link or text)" +
              (positional > 0 ? "; the only unique values just number the repetitions, which does not survive a re-sort" : ""),
          };
        }
        const stateOf = groups.map((g) => {
          const s = new Set(bs.filter((b) => g.contains(b.el)).map((b) => b.state));
          return s.size === 1 ? [...s][0] : null;
        });
        return {
          mode: "entities" as const,
          slot: picked.slot,
          shape: groups[0].tagName.toLowerCase() + " ×" + groups.length,
          entities: picked.values.map((value, i) => ({ value, state: stateOf[i], witnesses: picked.witnesses[i] })),
        };
      };

      /** Re-find one repetition by its identity. The structure is re-read from
       * the page as it is now; nothing from before is trusted except the
       * identity. Zero or several matches are reported as such. */
      const resolve = (spec: { slot: string; value: string; witnesses?: Record<string, string> }, states: string[]) => {
        const { bs, groups } = regions(states);
        const none = (reason: string) => ({ el: null as Element | null, reason });
        if (bs.length < 2 || groups.length < 2) return none("the page no longer shows a repeated structure of entities");

        const maps = groups.map((g) => slotsOf(g, states));
        const wit = Object.entries(spec.witnesses ?? {});
        const agree = (i: number) => wit.filter(([k, v]) => maps[i].get(k) === v).length;

        const byPrimary = groups.map((_, i) => i).filter((i) => maps[i].get(spec.slot) === spec.value);
        if (byPrimary.length === 1) {
          // The identity matches one repetition. If it came with other
          // identifying values, that repetition must still agree with one: a
          // primary that now names a different row is not the entity we chose.
          if (wit.length > 0 && agree(byPrimary[0]) === 0) {
            return none('the row now at "' + spec.value + '" no longer matches the entity\'s other identifying values (it moved or was replaced)');
          }
          return { el: groups[byPrimary[0]] as Element | null, reason: "" };
        }
        if (byPrimary.length > 1) return none('the identity "' + spec.value + '" is no longer unique (' + byPrimary.length + " matches)");

        // The primary is gone. The entity may still be there under its other values.
        if (wit.length > 0) {
          const byAll = groups.map((_, i) => i).filter((i) => agree(i) === wit.length);
          if (byAll.length === 1) return { el: groups[byAll[0]] as Element | null, reason: "" };
        }
        return none('the entity "' + spec.value + '" is gone or its identity changed');
      };

      (w as { __aztrx?: unknown }).__aztrx = { discover, resolve };
    })
    .catch(() => {});
}

/** Look at the page as a set of entities (or not). Serializable. */
export async function surveyEntities(page: Page, states: string[]): Promise<EntitySurvey> {
  await ensureEntityHelpers(page);
  return page
    .evaluate((states) => {
      const h = (window as unknown as { __aztrx?: { discover(s: string[]): EntitySurvey } }).__aztrx;
      return h ? h.discover(states) : ({ mode: "none", reason: "page helpers unavailable" } as EntitySurvey);
    }, states)
    .catch(() => ({ mode: "none", reason: "page evaluation failed" }) as EntitySurvey);
}
