/**
 * Stage 1: evidence. Three places program text can come from, one shape out.
 *
 *   served_js    what the browser was handed by the running app
 *   repo_source  code files under the project root
 *   git_diff     the same files, narrowed to the lines a change touched
 *
 * Inference (`infer.ts`) reads `EvidenceChunk`s and has no idea which of the
 * three produced one. A git_diff chunk carries the *whole current file* plus
 * the line numbers the diff touched, so a rule that references a constant
 * declared elsewhere in the file still resolves, while "this rule comes from
 * the change" stays answerable by line number.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright";
import type { EvidenceSource } from "./types.js";

export interface EvidenceChunk {
  source: EvidenceSource;
  /** File path (repo-relative) or URL path the text came from. */
  location: string;
  content: string;
  /** 1-based line number of `content`'s first line within `location`. Default 1. */
  firstLine?: number;
  /** 1-based line numbers (in `location`) a diff touched. Present on git_diff
   * chunks only; its presence is what makes a chunk "changed code". */
  changedLines?: number[];
}

/** When one rule is stated in several places, the closest to the change wins. */
export const SOURCE_PRIORITY: Record<EvidenceSource, number> = { git_diff: 3, repo_source: 2, served_js: 1 };

const MAX_FILE_BYTES = 200_000;
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/i;
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".aztrx", "dist", "build", "out", ".out", ".next", ".nuxt", ".svelte-kit",
  "coverage", ".turbo", ".cache", "vendor",
]);
const SKIP_FILE = /\.min\.[cm]?js$|\.d\.ts$/i;

// ---- served_js -------------------------------------------------------------

const MAX_SCRIPTS = 8;

/** Library and framework code looks like it: the bundler names it after the
 * package, or after what it is. Nothing here knows a particular bundler. */
const VENDOR_LOOKING = /node_modules|vendor|framework|polyfill|webpack|runtime|react-dom|next[-_]dist|devtools|chunk-vendors|.min.|jquery|lodash/i;

/** 0 for a script likely to be the app's own, 1 for one that is obviously a
 * library. Used only to decide what to read first when there are more scripts
 * than the cap allows — a vendor chunk is never excluded while there is room. */
export function scriptPriority(src: string): 0 | 1 {
  let path = src;
  try {
    path = decodeURIComponent(new URL(src, "http://x").pathname);
  } catch {
    /* keep the raw string */
  }
  return VENDOR_LOOKING.test(path) ? 1 : 0;
}

/** Served program text for the page: inline scripts plus same-origin
 * external ones. Code the browser was handed — real evidence of what the app
 * is written to do, not an assumption about it. */
export async function collectServedJs(page: Page): Promise<EvidenceChunk[]> {
  const origin = new URL(page.url()).origin;
  const scripts = await page
    .evaluate(() => Array.from(document.scripts).map((s) => ({ src: s.src, text: s.src ? "" : s.textContent ?? "" })))
    .catch(() => [] as Array<{ src: string; text: string }>);

  // The page lists scripts in document order, which on a real bundled app puts
  // the framework first. Read inline code and application-looking chunks before
  // library-looking ones so the cap can't crowd the app's own code out.
  const ordered = scripts
    .map((s, i) => ({ s, i, rank: s.src ? scriptPriority(s.src) : -1 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.s);

  const out: EvidenceChunk[] = [];
  let n = 0;
  for (const s of ordered) {
    if (n >= MAX_SCRIPTS) break;
    if (!s.src) {
      if (s.text.trim()) {
        out.push({
          source: "served_js",
          location: `${new URL(page.url()).pathname} <inline script>`,
          content: s.text.slice(0, MAX_FILE_BYTES),
        });
      }
      n++;
      continue;
    }
    let u: URL;
    try {
      u = new URL(s.src);
    } catch {
      continue;
    }
    if (u.origin !== origin) continue;
    n++;
    const text = await page
      .evaluate(async (src) => {
        try {
          const r = await fetch(src);
          return r.ok ? await r.text() : "";
        } catch {
          return "";
        }
      }, s.src)
      .catch(() => "");
    if (text) out.push({ source: "served_js", location: u.pathname, content: text.slice(0, MAX_FILE_BYTES) });
  }
  return out;
}

// ---- repo_source -----------------------------------------------------------

const MAX_REPO_FILES = 300;

/** Code files under `repoRoot`, skipping dependencies and build output. */
export function collectRepoSource(repoRoot: string, maxFiles = MAX_REPO_FILES): EvidenceChunk[] {
  const out: EvidenceChunk[] = [];
  const walk = (dir: string) => {
    if (out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile() && CODE_FILE.test(e.name) && !SKIP_FILE.test(e.name)) {
        const content = readCode(full);
        if (content !== null) out.push({ source: "repo_source", location: rel(repoRoot, full), content });
      }
    }
  };
  walk(repoRoot);
  return out;
}

function readCode(file: string): string | null {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

const rel = (root: string, file: string) => path.relative(root, file).replace(/\\/g, "/");

// ---- git_diff --------------------------------------------------------------

export interface DiffFile {
  /** New-side path, relative to where git was run. */
  file: string;
  /** New-side line numbers the diff added or changed. */
  added: number[];
}

/** Parse a unified diff into the new-side line numbers each file gained. Pure.
 * Removed lines are not evidence of what the program does *now*, so only
 * additions are recorded. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let line = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      cur = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      cur = p === "/dev/null" ? null : { file: p.replace(/^b\//, ""), added: [] };
      if (cur) files.push(cur);
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      line = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !cur) continue;
    if (raw.startsWith("+")) cur.added.push(line++);
    else if (raw.startsWith("-") || raw.startsWith("\\")) continue;
    else line++;
  }
  return files;
}

export interface DiffEvidence {
  /** `ok`: changed code found. `empty`: git answered and nothing code-shaped
   * changed. `unavailable`: git could not answer (not a repo, bad ref). */
  status: "ok" | "empty" | "unavailable";
  base: string;
  chunks: EvidenceChunk[];
  detail: string;
}

const MAX_DIFF_FILES = 40;

function git(repoRoot: string, args: string[]): { ok: boolean; out: string; err: string } {
  const res = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd: repoRoot, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
  if (res.error || res.status !== 0) return { ok: false, out: "", err: String(res.error?.message ?? res.stderr ?? "").trim() };
  return { ok: true, out: res.stdout, err: "" };
}

/** What changed relative to `base` (default HEAD: staged + unstaged edits, plus
 * new untracked files). An empty diff is a first-class answer — it yields no
 * chunks, and nothing downstream is allowed to invent evidence for it. */
export function collectGitDiff(repoRoot: string, base = "HEAD"): DiffEvidence {
  const inside = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { status: "unavailable", base, chunks: [], detail: "not a git repository" };

  const diff = git(repoRoot, ["diff", "--no-color", "--no-ext-diff", "--relative", "-U0", base, "--"]);
  if (!diff.ok) return { status: "unavailable", base, chunks: [], detail: `git diff ${base} failed: ${diff.err.split("\n")[0]}` };

  const changed = new Map<string, number[]>();
  for (const f of parseUnifiedDiff(diff.out)) if (f.added.length > 0) changed.set(f.file, f.added);

  // New files git doesn't track yet are changes too: every line is new.
  const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked.ok) {
    for (const f of untracked.out.split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (changed.has(f) || f.startsWith(".aztrx/")) continue;
      const text = CODE_FILE.test(f) ? readCode(path.join(repoRoot, f)) : null;
      if (text !== null) changed.set(f, Array.from({ length: text.split("\n").length }, (_, i) => i + 1));
    }
  }

  const chunks: EvidenceChunk[] = [];
  for (const [file, lines] of changed) {
    if (chunks.length >= MAX_DIFF_FILES) break;
    if (!CODE_FILE.test(file) || SKIP_FILE.test(file)) continue;
    const content = readCode(path.join(repoRoot, file));
    if (content === null) continue;
    chunks.push({ source: "git_diff", location: file, content, changedLines: lines });
  }

  if (chunks.length === 0) {
    return { status: "empty", base, chunks, detail: `no changed code against ${base}` };
  }
  const n = chunks.reduce((s, c) => s + (c.changedLines?.length ?? 0), 0);
  return { status: "ok", base, chunks, detail: `${n} changed line(s) across ${chunks.length} file(s) against ${base}` };
}

// ---- request ---------------------------------------------------------------

/** What a caller asks `collectLocalEvidence` for. Served JS is always read
 * from the live page; these are the opt-in local sources. */
export interface LocalEvidenceRequest {
  /** Read code files under the project root. */
  repo?: boolean;
  /** Read the live git diff against this base (`true` = HEAD). */
  diff?: string | boolean;
}

export interface LocalEvidence {
  chunks: EvidenceChunk[];
  /** One human line per requested source, for the run log. */
  notes: string[];
}

export function collectLocalEvidence(repoRoot: string, req: LocalEvidenceRequest | undefined): LocalEvidence {
  const out: LocalEvidence = { chunks: [], notes: [] };
  if (!req) return out;
  if (req.diff) {
    const d = collectGitDiff(repoRoot, typeof req.diff === "string" ? req.diff : "HEAD");
    out.chunks.push(...d.chunks);
    out.notes.push(`git diff: ${d.detail}`);
  }
  if (req.repo) {
    const r = collectRepoSource(repoRoot);
    out.chunks.push(...r);
    out.notes.push(`repo source: ${r.length} file(s)`);
  }
  return out;
}
