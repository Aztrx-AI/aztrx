/**
 * F10 gate #2 — AST safety gates. A model-generated patch is never applied
 * blindly: the patched file is re-parsed and rejected if it smuggles in a new
 * import, dynamic code execution, child-process access, or an empty catch that
 * would swallow the very error we're trying to surface. JavaScript/TypeScript
 * use the TypeScript compiler's AST; HTML/Vue/Svelte are audited by extracting
 * inline <script> blocks and running the same checks on each.
 */

import ts from "typescript";
import type { GateResult, GateViolation } from "./types.js";

const JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const MARKUP_EXT = new Set([".html", ".htm", ".vue", ".svelte", ".astro"]);

function scriptKindFor(ext: string): ts.ScriptKind {
  switch (ext) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".ts": case ".mts": case ".cts": return ts.ScriptKind.TS;
    default: return ts.ScriptKind.JS;
  }
}

const FORBIDDEN_CALLS = new Set([
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
  "fork",
]);

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function collectImports(source: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      out.add(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        out.add(node.moduleReference.expression.text);
      }
    } else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const isRequire = ts.isIdentifier(expr) && expr.text === "require";
      const isDynamicImport = expr.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        out.add(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return out;
}

function scanForbidden(source: ts.SourceFile, violations: GateViolation[]): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const name = ts.isIdentifier(expr) ? expr.text : null;
      const line = lineOf(source, node);

      if (name === "eval") {
        violations.push({ rule: "no-eval", detail: `eval() at line ${line}` });
      } else if (name === "require" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const spec = node.arguments[0].text;
        if (spec === "child_process" || spec.startsWith("node:")) {
          violations.push({ rule: "no-child-process", detail: `require(${JSON.stringify(spec)}) at line ${line}` });
        }
      } else if (name === "setTimeout" || name === "setInterval") {
        if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          violations.push({ rule: "no-eval", detail: `${name}(string) at line ${line}` });
        }
      } else if (name && FORBIDDEN_CALLS.has(name)) {
        violations.push({ rule: "no-child-process", detail: `${name}() at line ${line}` });
      }
    }

    if (ts.isNewExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && expr.text === "Function") {
        violations.push({ rule: "no-eval", detail: `new Function() at line ${lineOf(source, node)}` });
      }
    }

    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      violations.push({ rule: "no-empty-catch", detail: `empty catch at line ${lineOf(source, node)}` });
    }

    if (ts.isExpressionStatement(node)) {
      const text = node.getText(source).trim();
      if (/\bprocess\.(exit|kill)\s*\(/.test(text)) {
        violations.push({ rule: "no-child-process", detail: `${text.slice(0, 60)}` });
      }
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

function auditScript(original: string, patched: string, label: string, kind: ts.ScriptKind): GateResult {
  const violations: GateViolation[] = [];
  const fileName = `${label}.js`;

  const origSrc = ts.createSourceFile(fileName, original, ts.ScriptTarget.Latest, true, kind);
  const patchSrc = ts.createSourceFile(fileName, patched, ts.ScriptTarget.Latest, true, kind);

  // Gate 0: the patched file must still parse — the compile fast-fail that runs
  // before any Playwright verification (cheap, dependency-free).
  const parseDiags = (patchSrc as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const d of parseDiags) {
    violations.push({ rule: "syntax-error", detail: ts.flattenDiagnosticMessageText(d.messageText, " ") });
  }

  // Gate 1: no new imports / dependencies.
  const before = collectImports(origSrc);
  const after = collectImports(patchSrc);
  for (const spec of after) {
    if (!before.has(spec)) {
      violations.push({ rule: "no-new-imports", detail: `new import ${JSON.stringify(spec)}` });
    }
  }

  // Gates 2–4: no eval, no child_process, no empty catch.
  scanForbidden(patchSrc, violations);

  return { ok: violations.length === 0, violations };
}

function scriptBlocks(markup: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup)) !== null) out.push(m[1]);
  return out;
}

/** Audit a patch by parsing the resulting file. `filePath` selects the parser. */
export function auditPatch(original: string, patched: string, filePath: string): GateResult {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();

  if (JS_EXT.has(ext)) {
    return auditScript(original, patched, "file", scriptKindFor(ext));
  }

  if (MARKUP_EXT.has(ext)) {
    const origBlocks = scriptBlocks(original);
    const patchBlocks = scriptBlocks(patched);
    const violations: GateViolation[] = [];
    const n = Math.max(origBlocks.length, patchBlocks.length);
    for (let i = 0; i < n; i++) {
      const r = auditScript(origBlocks[i] ?? "", patchBlocks[i] ?? "", `script${i + 1}`, ts.ScriptKind.JS);
      violations.push(...r.violations);
    }
    // If the patch introduced a <script> that wasn't there, patchBlocks grew;
    // the per-block audit already covers the new content. Report combined.
    return { ok: violations.length === 0, violations };
  }

  // Unknown extension: conservative lexical scan, clearly not an AST audit.
  const violations: GateViolation[] = [];
  if (/\beval\s*\(/.test(patched) || /\bnew\s+Function\b/.test(patched)) {
    violations.push({ rule: "no-eval", detail: "lexical eval/Function in non-JS file" });
  }
  if (/child_process|\bexec(Sync|File|FileSync)?\s*\(|\bspawn(Sync)?\s*\(|\bfork\s*\(/.test(patched)) {
    violations.push({ rule: "no-child-process", detail: "lexical child_process/exec in non-JS file" });
  }
  if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(patched)) {
    violations.push({ rule: "no-empty-catch", detail: "lexical empty catch in non-JS file" });
  }
  return { ok: violations.length === 0, violations };
}
