/**
 * Recorded repro (Phase 3) — turns a reproducible bug into a shareable
 * "before/after" proof: an animated GIF and a static crash screenshot, both
 * destined for the patrol PR body.
 *
 * The capture is deliberately OFF the hot path. Verification replays a bug many
 * times (ddmin + validator), but the recording runs once, only when a PR is about
 * to open — so it launches its own browser instead of reusing ReplayEngine's.
 *
 * GIF encoding is pure-JS (`gifenc` + `pngjs`), no ffmpeg, so it works for every
 * `npm install aztrx-cli` user rather than only machines with ffmpeg on PATH.
 */

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { replayActions } from "../replay.js";
import type { Finding, RecordedAction } from "../types.js";

// `gifenc` ships a CJS bundle whose named exports Node can't statically detect
// (esbuild `__export` getters), so a bare `import { quantize } from "gifenc"`
// typechecks but throws at runtime under NodeNext. `createRequire` sidesteps the
// interop and hands back the full named object reliably.
type PaletteColor = [number, number, number];
type Palette = PaletteColor[];
interface GifEncoderInstance {
  writeFrame(
    index: Uint8Array,
    width: number,
    height: number,
    opts?: {
      palette?: Palette;
      delay?: number;
      repeat?: number;
      transparent?: boolean;
      transparentIndex?: number;
      dispose?: number;
    }
  ): void;
  finish(): void;
  bytes(): Uint8Array;
}
const require = createRequire(import.meta.url);
const { GIFEncoder, quantize, applyPalette } = require("gifenc") as {
  GIFEncoder: (opts?: { auto?: boolean }) => GifEncoderInstance;
  quantize: (
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: Record<string, unknown>
  ) => Palette;
  applyPalette: (
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: string
  ) => Uint8Array;
};

export interface CaptureOptions {
  viewport?: { width: number; height: number };
  /** Settle time after page load, before the first frame. */
  settleMs?: number;
  /** Settle time after each replayed action, before its screenshot. */
  stepMs?: number;
}

/**
 * Captures one PNG screenshot before the replay and one after each action, so
 * the crash (or its absence) is visible in the sequence. Replays `replayActions`
 * one action at a time — reusing the exact detection semantics, not a parallel
 * reimplementation that could drift.
 */
export async function captureReproFrames(
  url: string,
  actions: RecordedAction[],
  opts: CaptureOptions = {}
): Promise<Buffer[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: opts.viewport ?? { width: 720, height: 430 },
    });
    await page.goto(url, { waitUntil: "load", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(opts.settleMs ?? 1200);

    const frames: Buffer[] = [await page.screenshot()];
    for (const action of actions) {
      await replayActions(page, [action]);
      await page.waitForTimeout(opts.stepMs ?? 300);
      frames.push(await page.screenshot());
    }
    return frames;
  } finally {
    await browser.close().catch(() => {});
  }
}

export interface GifOptions {
  /** Frame delay in ms (default 400). */
  delay?: number;
  /** Quantized palette size, ≤ 256 (default 256). */
  maxColors?: number;
}

/** Encodes a sequence of PNG frames into an animated GIF (pure JS, no ffmpeg). */
export function encodeGif(frames: Buffer[], opts: GifOptions = {}): Buffer {
  if (frames.length === 0) return Buffer.alloc(0);
  const delay = opts.delay ?? 400;
  const maxColors = opts.maxColors ?? 256;

  const decoded = frames.map((f) => PNG.sync.read(f));
  const { width, height } = decoded[0];

  // One global palette across every frame → compact file, no per-frame flicker.
  const combined = new Uint8Array(decoded.reduce((n, d) => n + d.data.length, 0));
  let off = 0;
  for (const d of decoded) {
    combined.set(d.data, off);
    off += d.data.length;
  }
  const palette = quantize(combined, maxColors);
  const indexes = decoded.map((d) => applyPalette(d.data, palette));

  const gif = GIFEncoder();
  indexes.forEach((index, i) => {
    gif.writeFrame(index, width, height, {
      palette: i === 0 ? palette : undefined,
      delay,
    });
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

/** The static "crash shot": the final frame, when the crash has fully rendered. */
export function crashFrame(frames: Buffer[]): Buffer {
  return frames[frames.length - 1];
}

/**
 * Produces the recorded-repro GIF for a finding and writes it to
 * `aztrx-media/<fp8>.gif`. That dir is deliberate: `media/` is in the npm
 * `files` allowlist (so demo.gif/logo ship), but patrol GIFs must not publish —
 * they're per-run artifacts. The path is committed to the PR branch so the PR
 * body can inline it via a raw URL.
 *
 * Returns the repo-relative path, or null when there is nothing to record (no
 * repro, or capture/encode failed) — the caller opens the PR regardless.
 */
export async function recordFindingGif(
  repoRoot: string,
  url: string,
  finding: Finding
): Promise<string | null> {
  // Skip `navigate` actions — captureReproFrames navigates itself, so replaying a
  // leading navigate would just add a duplicate frame of the same page.
  const actions = (finding.repro?.actions ?? []).filter((a) => a.type !== "navigate");
  if (actions.length === 0) return null;

  const frames = await captureReproFrames(url, actions);
  if (frames.length < 2) return null; // a single frame isn't an animation

  const gif = encodeGif(frames, { delay: 700 });
  const rel = path.join("aztrx-media", `${finding.fingerprint.slice(0, 8)}.gif`);
  const abs = path.resolve(repoRoot, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, gif);
  return rel;
}
