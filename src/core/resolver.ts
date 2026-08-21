import * as fs from "fs";
import * as path from "path";
import {
  TraceMap,
  originalPositionFor,
  type DecodedSourceMap,
} from "@jridgewell/trace-mapping";

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

function stripQuery(url: string): string {
  return url.split("?")[0];
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
  return prefixes.map((p) => path.resolve(repoRoot, p, cleaned));
}

function locateFile(candidates: string[]): string | null {
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
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
  const directPath = path.resolve(repoRoot, relative);
  return {
    message: frame.message,
    sourceFile: path.relative(repoRoot, directPath),
    line: frame.line,
    column: frame.column,
    codeSnippet: extractSnippet(directPath, frame.line),
    resolvedFrom: fs.existsSync(directPath) ? "direct" : "unresolved",
  };
}

async function trySourceMap(frame: RawFrame, repoRoot: string): Promise<MappedError | null> {
  const mapUrl = stripQuery(frame.url) + ".map";
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
  if (!fs.existsSync(filePath)) return `<file not accessible locally: ${filePath}>`;
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
