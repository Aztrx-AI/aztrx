import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { encodeGif } from "../src/core/patrol/record.js";

/** A tiny solid-color PNG, built in-memory so the test needs no fixture file. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

test("encodeGif emits a GIF89a stream from two PNG frames", () => {
  const frames = [
    solidPng(4, 4, [220, 38, 38]),
    solidPng(4, 4, [37, 99, 235]),
  ];
  const gif = encodeGif(frames, { delay: 700 });
  assert.ok(gif.length > 0);
  assert.equal(gif.subarray(0, 6).toString("ascii"), "GIF89a");
});

test("encodeGif returns an empty buffer for no frames", () => {
  assert.equal(encodeGif([]).length, 0);
});
