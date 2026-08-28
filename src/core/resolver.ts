import * as fs from "fs";
import * as path from "path";
import {
  TraceMap,
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

/**
 * Pulls the first `url:line:col` frame out of a stack string. Handles React
 * Error Boundary console text, which embeds the original stack in its body.
 */
export function extractFrame(text: string): RawFrame | null {
  const match = text.match(/(https?:\/\/[^\s)"']+?):(\d+):(\d+)/);
  if (!match) return null;
  return {
    url: match[1],
    line: parseInt(match[2], 10),
    column: parseInt(match[3], 10),
    message: text.split("\n")[0].trim().slice(0, 200),
  };
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

/** True only for a real, readable regular file — directories and unreadable
 * paths return false so readers never hit `EISDIR` / permission errors. */
function isFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
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
  const cleaned = source
    .replace(/^webpack:\/\/[^/]+\//, "") // webpack://namespace/src/...
    .replace(/^webpack:\/\//, "")
    .replace(/^\/@fs\//, "")
    .replace(/^\//, "")
    .split("?")[0];

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
  const viaMap = await trySourceMap(frame, repoRoot);
  if (viaMap) return viaMap;

  // Fallback: Vite dev serves real source files at their URL path, so the
  // bundle URL is already the source path — no sourcemap needed.
  const relative = stripQuery(frame.url)
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^\//, "");
  const directPath = resolveWithin(repoRoot, relative);
  if (!directPath) {
    return {
      message: frame.message,
      sourceFile: relative,
      line: frame.line,
      column: frame.column,
      codeSnippet: `<file not accessible locally: ${relative}>`,
      resolvedFrom: "unresolved",
    };
  }
  return {
    message: frame.message,
    sourceFile: path.relative(repoRoot, directPath),
    line: frame.line,
    column: frame.column,
    codeSnippet: extractSnippet(directPath, frame.line),
    resolvedFrom: isFile(directPath) && !isSensitive(directPath) ? "direct" : "unresolved",
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
    const map = new TraceMap(rawMap);
    const pos = originalPositionFor(map, { line: frame.line, column: frame.column });
    if (!pos.source || pos.line == null) return null;

    const absolute = locateFile(sourceCandidates(pos.source, repoRoot));
    if (!absolute) {
      return {
        message: frame.message,
        sourceFile: pos.source,
        line: pos.line,
        column: pos.column ?? 0,
        codeSnippet: `<file not accessible locally: ${pos.source}>`,
        resolvedFrom: "unresolved",
      };
    }

    return {
      message: frame.message,
      sourceFile: path.relative(repoRoot, absolute),
      line: pos.line,
      column: pos.column ?? 0,
      codeSnippet: extractSnippet(absolute, pos.line),
      resolvedFrom: "sourcemap",
    };
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
