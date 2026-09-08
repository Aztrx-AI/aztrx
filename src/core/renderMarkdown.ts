/**
 * Minimal Markdown → ANSI renderer for the `--explain` / `--fix` human-language
 * summary. Handles the small dialect Aztrx emits: headings, bold/`code` inline,
 * bullet and numbered lists, and fenced code blocks with a light JS/TS syntax
 * highlight. Plain prose without markdown passes through unchanged.
 */

import pc from "picocolors";

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
  "new", "class", "extends", "super", "import", "export", "from", "async", "await",
  "try", "catch", "finally", "throw", "switch", "case", "break", "continue",
  "default", "typeof", "instanceof", "in", "of", "delete", "void", "this", "null",
  "undefined", "true", "false", "static", "get", "set", "interface", "type",
  "enum", "readonly", "as", "satisfies", "yield",
]);

/** Single-pass tokenizer. Classify by first char: `/` comment, quote/backtick
 * string, digit number, letter keyword, else plain identifier. */
const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;

function highlight(code: string): string {
  return code.replace(TOKEN, (raw) => {
    const c = raw[0];
    if (c === "/") return pc.dim(pc.gray(raw));
    if (c === "'" || c === '"' || c === "`") return pc.green(raw);
    if (c >= "0" && c <= "9") return pc.yellow(raw);
    if (KEYWORDS.has(raw)) return pc.magenta(raw);
    return raw;
  });
}

/** Inline formatting: `code`, **bold**. */
function renderInline(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, (_, s) => pc.cyan(s))
    .replace(/\*\*([^*]+)\*\*/g, (_, s) => pc.bold(s))
    .replace(/__([^_]+)__/g, (_, s) => pc.bold(s));
}

export function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let code: string[] = [];

  const flushCode = () => {
    if (!code.length) return;
    for (const l of code) out.push("  " + pc.dim("│") + " " + highlight(l));
    out.push("");
    code = [];
  };

  for (const raw of lines) {
    if (raw.trim().startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(raw);
      continue;
    }

    const heading = raw.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      out.push(pc.bold(pc.underline(renderInline(heading[2]))));
      out.push("");
      continue;
    }

    const bullet = raw.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      out.push("  " + pc.cyan("•") + " " + renderInline(bullet[1]));
      continue;
    }

    const numbered = raw.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      out.push("  " + pc.cyan(numbered[1] + ".") + " " + renderInline(numbered[2]));
      continue;
    }

    out.push(renderInline(raw));
  }
  flushCode();

  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();

  return out.join("\n");
}
