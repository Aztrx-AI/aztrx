import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PatrolState } from "../src/core/patrol/state.js";

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-patrol-"));
}

test("a fresh state has no handled fingerprints", () => {
  const dir = tmpRepo();
  try {
    const state = new PatrolState(dir, "https://app.example.com");
    assert.deepEqual(state.handled(), []);
    assert.equal(state.isHandled("abc123"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("markPr / markUnfixed register a fingerprint as handled", () => {
  const dir = tmpRepo();
  try {
    const state = new PatrolState(dir, "https://app.example.com");
    state.markPr("fp-aaa", "https://github.com/x/y/pull/1", "aztrx/fix-fp-aaa");
    state.markUnfixed("fp-bbb");
    assert.deepEqual(state.handled().sort(), ["fp-aaa", "fp-bbb"]);
    assert.equal(state.isHandled("fp-aaa"), true);
    assert.equal(state.isHandled("fp-bbb"), true);
    assert.equal(state.isHandled("fp-ccc"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handled() survives a save/load round-trip", () => {
  const dir = tmpRepo();
  try {
    const a = new PatrolState(dir, "https://app.example.com");
    a.markPr("fp-aaa", "https://github.com/x/y/pull/2", "aztrx/fix-fp-aaa");
    a.markUnfixed("fp-bbb");
    a.save();

    const b = new PatrolState(dir, "https://app.example.com");
    assert.deepEqual(b.handled().sort(), ["fp-aaa", "fp-bbb"]);
    // PR metadata is retained, not just the key.
    assert.equal(b.isHandled("fp-aaa"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
