/**
 * Stage 1: the inventory — everything the generator is allowed to know.
 *
 * Three sources, all of which exist for any project with no help from anyone:
 *
 *   docs     README and markdown under docs/
 *   tests    the *names* of the project's own tests (what its authors chose to
 *            promise), not their bodies
 *   ui       what the running product shows: headings, controls, labels
 *
 * Deliberately absent: git history, diffs, issue text, changelog entries about
 * the code under test. The reader never opens `.git`, and takes no revision
 * argument, so there is nothing to pass it by accident.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright";
import type { Inventory } from "./types.js";

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", ".venv", "venv", "__pycache__",
  "coverage", ".cache", "vendor", "target", ".aztrx",
]);
const MAX_DOC_CHARS = 12_000;
const MAX_TEST_NAMES = 150;
const MAX_UI_PAGES = 6;
const MAX_UI_CHARS = 8_000;

function walk(root: string, accept: (rel: string) => boolean, limit = 4000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name));
      } else {
        const rel = path.relative(root, path.join(dir, e.name)).replace(/\\/g, "/");
        if (accept(rel)) out.push(rel);
      }
    }
  }
  return out.sort();
}

function docsFrom(root: string): { source: string; text: string }[] {
  const files = walk(root, (r) => /(^|\/)readme[^/]*\.(md|rst|txt)$/i.test(r) || /^docs?\/.+\.(md|rst)$/i.test(r));
  // The root README first; deeper files only while there is room.
  files.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const out: { source: string; text: string }[] = [];
  let budget = MAX_DOC_CHARS;
  for (const f of files) {
    if (budget <= 0) break;
    try {
      const text = fs.readFileSync(path.join(root, f), "utf8").slice(0, budget);
      out.push({ source: `docs:${f}`, text });
      budget -= text.length;
    } catch {
      /* unreadable file: skip */
    }
  }
  return out;
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e|cypress|playwright)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rb)$/i;
const TEST_NAME = [
  /\b(?:it|test|describe)(?:\.\w+)?\(\s*(["'`])((?:\\.|(?!\1).){6,160})\1/g, // js/ts
  /^\s*(?:async\s+)?def\s+(test_\w+)/gm, //                                      python
  /^\s*func\s+(Test\w+)/gm, //                                                   go
  /^\s*(?:scenario|feature)\s*:?\s*(.{6,160})$/gim, //                           gherkin
];

function testNamesFrom(root: string): { source: string; text: string } | undefined {
  const files = walk(root, (r) => TEST_FILE.test(r) && /\.(?:[cm]?[jt]sx?|py|go|rb|feature)$/i.test(r));
  const names: string[] = [];
  for (const f of files) {
    if (names.length >= MAX_TEST_NAMES) break;
    let src: string;
    try {
      src = fs.readFileSync(path.join(root, f), "utf8").slice(0, 200_000);
    } catch {
      continue;
    }
    for (const re of TEST_NAME) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) && names.length < MAX_TEST_NAMES) {
        names.push(`${f}: ${(m[2] ?? m[1]).replace(/\s+/g, " ").trim()}`);
      }
    }
  }
  return names.length ? { source: "tests:names", text: names.join("\n") } : undefined;
}

/**
 * What one page shows a user, as text. The script is a string on purpose: a
 * function passed to `page.evaluate` is serialized after the transpiler has
 * run, and under tsx its named inner helpers gain a `__name` reference that does
 * not exist in the page. The call then fails and the inventory comes back empty.
 */
const DESCRIBE_PAGE = String.raw`(() => {
  const t = (e) => ((e && e.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 100);
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].slice(0, 40);
  const label = (el) =>
    el.getAttribute("aria-label") ||
    (el.id && t(document.querySelector('label[for="' + CSS.escape(el.id) + '"]'))) ||
    t(el.closest("label")) ||
    el.getAttribute("placeholder") ||
    el.getAttribute("name") ||
    "";
  const q = (sel) => [...document.querySelectorAll(sel)];
  const lines = ["title: " + document.title, "url: " + location.pathname + location.search];
  lines.push("headings: " + uniq(q("h1,h2,h3").map(t)).join(" | "));
  lines.push("buttons: " + uniq(q("button,[role=button],input[type=submit]").map((e) => t(e) || e.value || label(e))).join(" | "));
  lines.push("inputs: " + uniq(q("input:not([type=hidden]),textarea,select").map((e) => e.tagName.toLowerCase() + (e.type ? "[" + e.type + "]" : "") + ' "' + label(e) + '"')).join(" | "));
  lines.push("links: " + uniq(q("a[href]").map((e) => t(e) + " -> " + e.getAttribute("href"))).join(" | "));
  lines.push("text: " + t(document.body).slice(0, 700));
  return lines.join("\n");
})()`;

async function describePage(page: Page): Promise<string> {
  return page.evaluate<string>(DESCRIBE_PAGE).catch((e) => { return ""; });
}

/** Observe the running product: the landing page and the same-origin pages its
 * navigation links to, one hop deep. */
export async function uiFrom(page: Page, baseUrl: string): Promise<{ source: string; text: string }[]> {
  const origin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  const queue = [baseUrl];
  const out: { source: string; text: string }[] = [];
  let chars = 0;
  while (queue.length && out.length < MAX_UI_PAGES && chars < MAX_UI_CHARS) {
    const url = queue.shift() as string;
    const key = url.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await page.goto(url, { waitUntil: "load", timeout: 20_000 });
      await page.waitForTimeout(400);
    } catch {
      continue;
    }
    const text = (await describePage(page)).slice(0, MAX_UI_CHARS - chars);
    if (!text) continue;
    out.push({ source: `ui:${new URL(url).pathname}`, text });
    chars += text.length;
    const hrefs: string[] = await page
      .evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href))
      .catch(() => []);
    for (const h of hrefs) if (h.startsWith(origin) && !/\.(png|jpe?g|gif|svg|pdf|zip|css|js)(\?|$)/i.test(h)) queue.push(h);
  }
  return out;
}

export interface InventoryInput {
  repoDir?: string;
  page?: Page;
  baseUrl?: string;
}

export async function buildInventory(input: InventoryInput): Promise<Inventory> {
  const parts: { source: string; text: string }[] = [];
  if (input.repoDir) {
    parts.push(...docsFrom(input.repoDir));
    const t = testNamesFrom(input.repoDir);
    if (t) parts.push(t);
  }
  if (input.page && input.baseUrl) parts.push(...(await uiFrom(input.page, input.baseUrl)));
  return {
    text: parts.map((p) => `### ${p.source}\n${p.text}`).join("\n\n"),
    sections: parts.map((p) => ({ source: p.source, chars: p.text.length })),
  };
}
