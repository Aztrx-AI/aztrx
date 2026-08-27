/**
 * Self-contained SVG status badge generated from a real run's findings. Unlike a
 * static "Protected by …" sticker, this badge is *earned*: it reflects the
 * crash/error count of the run that produced it, so a stale badge is a
 * regeneration problem — not a lie baked into the image.
 */

import * as fs from "fs";
import * as path from "path";
import type { Finding } from "./types.js";

const CHAR_W = 7.1; // Verdana 11px approximate advance width
const PAD_X = 11; // horizontal padding per text block

const LABEL = "#27272a"; // zinc-800 — brand monochrome
const GREEN = "#16a34a";
const RED = "#dc2626";

function criticalCount(findings: Finding[]): number {
  return findings.filter((f) => f.severity === "crash" || f.severity === "error").length;
}

function blockWidth(text: string): number {
  return Math.round(text.length * CHAR_W + 2 * PAD_X);
}

export function renderBadge(findings: Finding[], label = "aztrx"): string {
  const n = criticalCount(findings);
  const message = n === 0 ? "crash-free" : `${n} finding${n === 1 ? "" : "s"}`;
  const color = n === 0 ? GREEN : RED;

  const labelW = blockWidth(label);
  const msgW = blockWidth(message);
  const totalW = labelW + msgW;
  const labelX = labelW / 2;
  const msgX = labelW + msgW / 2;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${label}: ${message}">`,
    `  <linearGradient id="g" x2="0" y2="100%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.14"/><stop offset="1" stop-opacity="0"/></linearGradient>`,
    `  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `  <g clip-path="url(#r)">`,
    `    <rect width="${labelW}" height="20" fill="${LABEL}"/>`,
    `    <rect x="${labelW}" width="${msgW}" height="20" fill="${color}"/>`,
    `    <rect width="${totalW}" height="20" fill="url(#g)"/>`,
    `  </g>`,
    `  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" font-weight="600">`,
    `    <text x="${labelX}" y="14">${label}</text>`,
    `    <text x="${msgX}" y="14">${message}</text>`,
    `  </g>`,
    `</svg>`,
  ].join("\n") + "\n";
}

export function writeBadge(repoRoot: string, findings: Finding[], filePath?: string): string {
  const file = filePath ?? path.join(repoRoot, ".aztrx", "badge.svg");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderBadge(findings), "utf-8");
  return file;
}
