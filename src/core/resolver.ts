import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  FlattenMap,
  originalPositionFor,
  type DecodedSourceMap,
} from "@jridgewell/trace-mapping";
import type { ServerFrame } from "./types.js";

export type ResolvedFrom = "sourcemap" | "direct" | "unresolved";

export interface MappedError {
  message: string;
  /** Repo-relative path to the source file, e.g. `apps/web/src/App.tsx`. */
  sourceFile: string;
  line: number;
  column: number;
  codeSnippet: string;
  resolvedFrom: ResolvedFrom;
}

export interface RawFrame {
  url: string;
  line: number;
  column: number;
  message: string;
}

/** Framework-internal frames to skip when hunting the throw site. */
const FRAMEWORK_FRAME = /node_modules|webpack-runtime|\.next[\\/]|next[\\/]dist[\\/]/;

/**
 * Pulls the first *user-code* frame out of a stack string. Iterates every line,
 * skips framework internals (webpack runtime, node_modules, next/dist), and
 * returns the first frame in the user's own code — so a Next.js dev stack like
 * `webpack-internal:///(app-pages-browser)/./app/page.tsx:29:21` resolves to the
 * user's file, not `intercept-console-error.js`.
 */
export function extractFrame(text: string): RawFrame | null {
  const message = text.split("\n")[0].trim().slice(0, 200);
  for (const raw of text.split("\n")) {
    // V8 frame: "at fn (url:line:col)" or "at url:line:col".
    const m = raw.trim().match(/^(?:at\s+)?(?:\S+\s+\()?(.+?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    const url = m[1];
    if (!url || FRAMEWORK_FRAME.test(url)) continue;
    return { url, line: parseInt(m[2], 10), column: parseInt(m[3], 10), message };
  }
  return null;
}

/** True if `p` looks like an absolute source path — a `file://` URL, a POSIX
 * absolute path, or a Windows drive path. Rejects bare relative tokens like
 * `route.ts` so a stray `foo:12:34` in a stack body is never mistaken for a file. */
function isServerPath(p: string): boolean {
  return p.startsWith("file://") || p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * Pull the first server-side source frame out of a raw server stack (a 500 body,
 * a Next.js dev error page, etc.). V8 emits one frame per line as
 * `at <fn> (<path>:<line>:<col>)` or `at <path>:<line>:<col>`; we take the first
 * frame whose path is not inside node_modules. Best-effort — returns null when
 * the body carries no stack trace (e.g. an explicit
 * `NextResponse.json(..., { status: 500 })`).
 */
export function extractServerFrame(stack: string): ServerFrame | null {
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    const m = line.match(/\(?([^\s()"']+):(\d+):(\d+)\)?$/);
    if (!m) continue;
    const filePath = m[1];
    if (!isServerPath(filePath)) continue;
    if (filePath.includes("node_modules")) continue;
    return { filePath, line: parseInt(m[2], 10), column: parseInt(m[3], 10) };
  }
  return null;
}

function stripQuery(url: string): string {
  return url.split("?")[0];
}

/** Normalize a stack-frame URL to a path to probe: repo-relative for the
 * dev-server schemes (`webpack-internal:///(ns)/./src/…`, `webpack://ns/src/…`)
 * and plain `https://host/path` bundle URLs, **absolute** for `file://`.
 *
 * The asymmetry is deliberate. `file://` carries a real filesystem path, and on
 * POSIX the leading slash is the root; the `^\//` strip below exists for URL
 * paths (`/@fs/src/main.tsx`) and would eat it, turning `/tmp/p/app/actions.ts`
 * into the relative `tmp/p/app/actions.ts` — a path under the repo that never
 * exists. Every `file://` frame therefore fell through to "unresolved" on Linux
 * and macOS. `resolveWithin` accepts absolute segments, so callers are unchanged;
 * only display has to convert back (see `reportPath`). */
function normalizeFrameUrl(url: string): string {
  const raw = stripQuery(url);

  if (/^file:\/\//i.test(raw)) {
    try {
      return fileURLToPath(raw); // handles drive-letter and UNC forms on Windows too
    } catch {
      return raw; // malformed URL — let the containment check reject it
    }
  }

  return raw
    .replace(/^webpack-internal:\/\/\/[^/]+\/\.\//, "")
    .replace(/^webpack:\/\/[^/]+\//, "")
    .replace(/^webpack:\/\//, "")
    .replace(/^\/@fs\//, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^\//, "");
}

/** The repo-relative form of a normalized frame path, for anything user-facing.
 * An absolute `file://` path is reported the same way every other frame is. */
function reportPath(p: string, repoRoot: string): string {
  return path.isAbsolute(p) ? path.relative(repoRoot, p) : p;
}

/** True only for a real, readable regular file — directories and unreadable
 * paths return false so readers never hit `EISDIR` / permission errors. */
function isFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True only for a real directory. */
function isDirectory(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Secret-bearing filenames that must never be read, even inside the repo — a
 * hostile sourcemap could otherwise point `source` at `.env`, an npmrc, or a
 * private key and exfiltrate it into the report / PR comment. */
function isSensitive(p: string): boolean {
  const name = path.basename(p).toLowerCase();

  // Dotfiles that hold secrets.
  if (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".npmrc" ||
    name === ".yarnrc" ||
    name === ".netrc" ||
    name === ".htpasswd" ||
    name === ".git-credentials"
  ) {
    return true;
  }

  // SSH / private keys.
  if (/^id_(rsa|ed25519|ecdsa|dsa)(\..*)?$/.test(name)) return true;

  // Certificate and keystore material.
  if (/\.(pem|key|p12|pfx|jks|keystore|p8)$/.test(name)) return true;

  // Names that advertise secrets.
  if (/(credential|secret|service[-_]?account|private[-_]?key)/.test(name)) return true;

  return false;
}

/** Resolve `segments` under `root`, returning null if the result escapes the
 * root — via `..` traversal or a symlink pointing outside it. This is the
 * boundary that keeps sourcemap- and URL-derived paths from reading (or,
 * downstream, healing) arbitrary files outside the repo. */
function resolveWithin(root: string, ...segments: string[]): string | null {
  const candidate = path.resolve(root, ...segments);
  const rel = path.relative(root, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;

  // Symlink escape: when the file exists, its real path must also stay inside.
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(candidate);
    const realRel = path.relative(realRoot, realTarget);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
  } catch {
    // realpath fails for not-yet-existing candidates — the lexical check above
    // already ran and is sufficient for those.
  }
  return candidate;
}

/** Turns a sourcemap `source` value into candidate absolute paths to probe. */
function sourceCandidates(source: string, repoRoot: string): string[] {
  const raw = source.split("?")[0];

  // `file://` is an absolute *filesystem* path, not a URL path, and the two
  // differ in exactly one place: on POSIX the leading slash is the root. The
  // web-style stripping below exists for URL paths (`/@fs/src/main.tsx`) and
  // would eat that slash, turning `/tmp/p/app/actions.ts` into the relative
  // `tmp/p/app/actions.ts` — a path under the repo that never exists, so every
  // Turbopack `file:///` source silently resolved to nothing on Linux and macOS.
  // `fileURLToPath` also handles the drive-letter and UNC forms on Windows.
  if (/^file:\/\//i.test(raw)) {
    let abs: string;
    try {
      abs = fileURLToPath(raw);
    } catch {
      return []; // malformed URL — nothing to probe
    }
    const inside = resolveWithin(repoRoot, abs);
    return inside === null ? [] : [inside];
  }

  const cleaned = raw
    .replace(/^webpack:\/\/[^/]+\//, "") // webpack://namespace/src/...
    .replace(/^webpack:\/\//, "")
    .replace(/^\/@fs\//, "")
    .replace(/^\//, "");

  const prefixes = ["", "apps/web/", "src/", "app/"];
  return prefixes
    .map((p) => resolveWithin(repoRoot, p, cleaned))
    .filter((c): c is string => c !== null);
}

function locateFile(candidates: string[]): string | null {
  for (const c of candidates) {
    if (isFile(c) && !isSensitive(c)) return c;
  }
  return null;
}

export async function resolveFrame(frame: RawFrame, repoRoot: string): Promise<MappedError> {
  const viaServerAction = await tryServerActionSourceMap(frame, repoRoot);
  if (viaServerAction) return viaServerAction;

  const viaMap = await trySourceMap(frame, repoRoot);
  if (viaMap) return viaMap;

  // Fallback: dev servers (Vite, Next) serve real source files at their URL
  // path, so the bundle URL is already the source path — no sourcemap needed.
  const relative = normalizeFrameUrl(frame.url);
  let directPath = resolveWithin(repoRoot, relative);
  // A frame URL pointing at a directory — e.g. an inline `<script>` whose V8
  // frame carries the page URL (`http://localhost:3000/`, normalized to "") —
  // resolves to the repo root. Map it to `index.html`, mirroring the static
  // serve fallback, so the crash gets a real filename + snippet + own-code flag.
  if (directPath && isDirectory(directPath)) {
    const withIndex = resolveWithin(repoRoot, relative, "index.html");
    if (withIndex) directPath = withIndex;
  }
  if (!directPath) {
    const shown = reportPath(relative, repoRoot);
    return {
      message: frame.message,
      sourceFile: shown,
      line: frame.line,
      column: frame.column,
      codeSnippet: `<file not accessible locally: ${shown}>`,
      resolvedFrom: "unresolved",
    };
  }
  // The frame's line is only as good as the code it came from: for a
  // `webpack-internal://` frame it indexes webpack's *generated* module, not the
  // source on disk (see reanchorPosition), so re-anchor before showing it — and
  // before `generateRulePatch` reads it, which is the difference between a free
  // fix and a paid one.
  const readable = isFile(directPath) && !isSensitive(directPath);
  const at = readable
    ? reanchorPosition(fs.readFileSync(directPath, "utf-8"), frame.line, frame.column, frame.message)
    : { line: frame.line, column: frame.column };
  return {
    message: frame.message,
    sourceFile: path.relative(repoRoot, directPath),
    line: at.line,
    column: at.column,
    codeSnippet: extractSnippet(directPath, at.line),
    resolvedFrom: readable ? "direct" : "unresolved",
  };
}

/**
 * Resolve a server-side source frame (a filesystem path) to a repo-relative
 * source location + snippet. Mirrors `resolveFrame`'s containment rules: a path
 * outside the repo — via `..` traversal or a symlink pointing out — is never
 * read. Server frames carry no sourcemap; a directly-readable file maps
 * `resolvedFrom: "direct"`.
 */
export function resolveServerFrame(frame: ServerFrame, repoRoot: string): MappedError {
  let p = frame.filePath.replace(/^file:\/\//, "");
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1); // /C:/x → C:/x (Windows-on-POSIX)
  const abs = path.resolve(p);

  const rel = path.relative(repoRoot, abs);
  let contained = !(rel.startsWith("..") || path.isAbsolute(rel));
  if (contained) {
    try {
      const realRoot = fs.realpathSync(repoRoot);
      const realTarget = fs.realpathSync(abs);
      const realRel = path.relative(realRoot, realTarget);
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) contained = false;
    } catch {
      // realpath fails for a not-yet-existing candidate — the lexical check above suffices.
    }
  }

  if (!contained) {
    return {
      message: frame.filePath,
      sourceFile: abs,
      line: frame.line,
      column: frame.column,
      codeSnippet: `<file not accessible locally: ${abs}>`,
      resolvedFrom: "unresolved",
    };
  }

  const resolvedFrom = isFile(abs) && !isSensitive(abs) ? "direct" : "unresolved";
  return {
    message: frame.filePath,
    sourceFile: rel,
    line: frame.line,
    column: frame.column,
    codeSnippet: extractSnippet(abs, frame.line),
    resolvedFrom,
  };
}

/** True for a loopback hostname — the only place a sourcemap URL may point. */
function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}

/** Shared tail of sourcemap resolution: run `originalPositionFor` through a
 * (possibly sectioned) map, resolve the `source` it names to a repo file, and
 * build the `MappedError`. Returns null when the position maps to no known
 * source. */
function resolveFromMap(
  rawMap: DecodedSourceMap,
  line: number,
  column: number,
  message: string,
  repoRoot: string
): MappedError | null {
  const map = new FlattenMap(rawMap);
  const pos = originalPositionFor(map, { line, column });
  if (!pos.source || pos.line == null) return null;

  const absolute = locateFile(sourceCandidates(pos.source, repoRoot));
  if (!absolute) {
    return {
      message,
      sourceFile: pos.source,
      line: pos.line,
      column: pos.column ?? 0,
      codeSnippet: `<file not accessible locally: ${pos.source}>`,
      resolvedFrom: "unresolved",
    };
  }

  return {
    message,
    sourceFile: path.relative(repoRoot, absolute),
    line: pos.line,
    column: pos.column ?? 0,
    codeSnippet: extractSnippet(absolute, pos.line),
    resolvedFrom: "sourcemap",
  };
}

async function trySourceMap(frame: RawFrame, repoRoot: string): Promise<MappedError | null> {
  const mapUrl = stripQuery(frame.url) + ".map";
  // SSRF guard: the sourcemap URL is derived from an untrusted stack frame, so
  // refuse to fetch anything that isn't the local machine (this tool inspects
  // local dev servers) before a single byte leaves the process.
  let host: string;
  try {
    host = new URL(mapUrl).hostname;
  } catch {
    return null;
  }
  if (!isLoopback(host)) return null;

  let rawMap: DecodedSourceMap;
  try {
    const res = await fetch(mapUrl);
    if (!res.ok) return null;
    rawMap = (await res.json()) as DecodedSourceMap;
  } catch {
    return null;
  }

  try {
    return resolveFromMap(rawMap, frame.line, frame.column, frame.message, repoRoot);
  } catch {
    return null;
  }
}

/**
 * Map a Next.js Server Action throw site to its original source. The browser
 * sees the throw as `about://React/Server/<url-encoded chunk path>?<n>:<line>:<col>`,
 * where the encoded path is the compiled Turbopack chunk on disk. That chunk's
 * `.map` is a *sectioned* (indexed) sourcemap whose sections point at the real
 * source (e.g. `app/actions.ts`); `FlattenMap` walks the sections for us.
 */
async function tryServerActionSourceMap(
  frame: RawFrame,
  repoRoot: string
): Promise<MappedError | null> {
  const marker = "about://React/Server/";
  if (!frame.url.startsWith(marker)) return null;

  let chunkPath: string;
  try {
    chunkPath = stripQuery(decodeURIComponent(frame.url.slice(marker.length)));
  } catch {
    return null;
  }
  if (!isFile(chunkPath)) return null;

  const mapPath = chunkPath + ".map";
  if (!isFile(mapPath) || isSensitive(mapPath)) return null;

  try {
    const rawMap = JSON.parse(fs.readFileSync(mapPath, "utf-8")) as DecodedSourceMap;
    return resolveFromMap(rawMap, frame.line, frame.column, frame.message, repoRoot);
  } catch {
    return null;
  }
}

export function extractSnippet(filePath: string, targetLine: number, window = 4): string {
  if (!isFile(filePath) || isSensitive(filePath)) return `<file not accessible locally: ${filePath}>`;
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  const start = Math.max(0, targetLine - window - 1);
  const end = Math.min(lines.length, targetLine + window);
  return lines
    .slice(start, end)
    .map((line, idx) => {
      const n = start + idx + 1;
      const marker = n === targetLine ? "> " : "  ";
      return `${marker}${String(n).padStart(4, " ")} │ ${line}`;
    })
    .join("\n");
}

/** The property a null-deref message was reading:
 * `Cannot read properties of undefined (reading 'agents')` → `agents`.
 * Null for every other error, which is what keeps the correction below scoped
 * to the one message shape that proves where the throw happened. */
function readProperty(message: string): string | null {
  const m = message.match(/reading ['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Drop a trailing `//` comment. The `:` guard keeps `https://` intact. */
function stripComment(line: string): string {
  const i = line.indexOf("//");
  if (i <= 0 || line[i - 1] === ":") return line;
  return line.slice(0, i);
}

/** Does this line read `.prop`? */
function readsProperty(line: string, prop: string): boolean {
  return new RegExp(`\\.${escapeRe(prop)}\\b`).test(line);
}

/** True when every read of `.prop` on this line is optional-chained. A guarded
 * read cannot throw, so such a line is never the crash site — which is what
 * separates `d?.agents ?? []` from the `d.agents.map(…)` that actually threw. */
function allReadsGuarded(line: string, prop: string): boolean {
  const re = new RegExp(`(\\?)?\\.${escapeRe(prop)}\\b`, "g");
  let seen = false;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    seen = true;
    if (!m[1]) return false;
  }
  return seen;
}

/**
 * Re-anchor a position that a transpiled frame reported wrongly.
 *
 * `webpack-internal://` frames carry a position in the module webpack
 * *generated*, not in the `.tsx` on disk. Next dev reported
 * `app/page.tsx:29:21` for a crash that is on line 15 — and because the URL
 * path is the real source path, the file is found and a confidently wrong line
 * is shown. Worse, `generateRulePatch` looks for the property on the mapped
 * line, finds a `</div>` instead, and declines — so the free no-key fix never
 * fires on Next.js.
 *
 * The error message is the signal. `Cannot read properties of undefined
 * (reading 'agents')` can only be thrown by a line that reads `.agents`, so a
 * mapped line that does not read it is provably not the throw site, and the
 * real one is findable. Ambiguity is left alone rather than guessed at.
 */
export function reanchorPosition(
  content: string,
  line: number,
  column: number,
  message: string
): { line: number; column: number } {
  const prop = readProperty(message);
  if (!prop) return { line, column };

  const lines = content.split("\n");
  const mapped = lines[line - 1];
  if (mapped && readsProperty(stripComment(mapped), prop)) return { line, column };

  const candidates: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = stripComment(lines[i]);
    if (!readsProperty(text, prop) || allReadsGuarded(text, prop)) continue;
    candidates.push(i + 1);
  }
  if (candidates.length !== 1) return { line, column }; // ambiguous — don't guess

  const found = lines[candidates[0] - 1];
  // Point the column at the property too: the frame's column is as transpiled
  // as its line was.
  return { line: candidates[0], column: found.indexOf(`.${prop}`) + 1 };
}
