/**
 * Terminal-friendly, word-level diff rendering for healed patches.
 *
 * The heal pipeline already computes Search & Replace hunks (`PatchHunk`). This
 * module turns those hunks into renderable lines — green for added, red for
 * removed, with the exact changed *words* highlighted — so the terminal can show
 * "what changed" the way a human reads a diff (Claude-Code-style) instead of a
 * wall of hunks. Zero dependencies: a small LCS over lines plus a
 * common-prefix/suffix word split.
 */

import pc from "picocolors";
import type { PatchHunk } from "./heal/types.js";

/** Render-oriented token kind. `ctx` = no highlight (line color only). */
export type DiffTokenKind = "ctx" | "del" | "add";

export interface DiffToken {
  text: string;
  kind: DiffTokenKind;
}

export interface DiffLine {
  type: "del" | "add";
  tokens: DiffToken[];
}

function splitLines(s: string): string[] {
  const r = s.split("\n");
  // `split` emits a trailing "" when the source ends in "\n"; drop one so a
  // trailing newline doesn't surface as a phantom blank line.
  if (r.length > 1 && r[r.length - 1] === "") r.pop();
  return r;
}

/** Common-prefix/suffix word split of two (similar) lines into diff tokens. */
function wordTokens(oldLine: string, newLine: string): { del: DiffToken[]; add: DiffToken[] } {
  let i = 0;
  const max = Math.min(oldLine.length, newLine.length);
  while (i < max && oldLine[i] === newLine[i]) i++;

  let j = 0;
  const maxJ = Math.min(oldLine.length, newLine.length) - i;
  while (j < maxJ && oldLine[oldLine.length - 1 - j] === newLine[newLine.length - 1 - j]) j++;

  const prefix = oldLine.slice(0, i);
  const removed = oldLine.slice(i, oldLine.length - j);
  const added = newLine.slice(i, newLine.length - j);
  const suffix = oldLine.slice(oldLine.length - j);

  const del: DiffToken[] = [];
  const add: DiffToken[] = [];
  const push = (list: DiffToken[], text: string, kind: DiffTokenKind) => {
    if (text) list.push({ text, kind });
  };
  push(del, prefix, "ctx");
  push(add, prefix, "ctx");
  push(del, removed, "del");
  push(add, added, "add");
  push(del, suffix, "ctx");
  push(add, suffix, "ctx");
  return { del, add };
}

/**
 * Line-level LCS diff between two texts, then word-level refinement inside each
 * replacement block. Context (unchanged) lines are omitted — the diff shows
 * only what changed, which is what matters for a fix review.
 */
export function diffText(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  const delBuf: string[] = [];
  const addBuf: string[] = [];

  const flush = () => {
    const k = Math.max(delBuf.length, addBuf.length);
    for (let x = 0; x < k; x++) {
      const delLine = delBuf[x];
      const addLine = addBuf[x];
      if (delLine !== undefined && addLine !== undefined) {
        const pair = wordTokens(delLine, addLine);
        lines.push({ type: "del", tokens: pair.del });
        lines.push({ type: "add", tokens: pair.add });
      } else if (delLine !== undefined) {
        // Whole line removed — line color, no background.
        lines.push({ type: "del", tokens: [{ text: delLine, kind: "ctx" }] });
      } else if (addLine !== undefined) {
        lines.push({ type: "add", tokens: [{ text: addLine, kind: "ctx" }] });
      }
    }
    delBuf.length = 0;
    addBuf.length = 0;
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      delBuf.push(a[i]);
      i++;
    } else {
      addBuf.push(b[j]);
      j++;
    }
  }
  while (i < n) delBuf.push(a[i++]);
  while (j < m) addBuf.push(b[j++]);
  flush();

  return lines;
}

/** One group of diff lines per hunk (renderers space the groups apart). */
export function diffHunks(hunks: PatchHunk[]): DiffLine[][] {
  return hunks.map((h) => diffText(h.search, h.replace));
}

/** ANSI-colorized diff for the plain (non-TUI) log path. */
export function formatDiff(hunks: PatchHunk[]): string {
  return diffHunks(hunks)
    .map((group) =>
      group
        .map((l) => {
          const add = l.type === "add";
          const lineColor = add ? pc.green : pc.red;
          const prefix = lineColor(add ? "+" : "-");
          const body = l.tokens
            .map((t) => {
              if (t.kind === "del") return pc.bgRed(pc.white(t.text));
              if (t.kind === "add") return pc.bgGreen(pc.black(t.text));
              return lineColor(t.text);
            })
            .join("");
          return "    " + prefix + " " + body;
        })
        .join("\n")
    )
    .join("\n");
}
