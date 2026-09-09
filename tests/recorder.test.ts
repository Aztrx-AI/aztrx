import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionRecorder } from "../src/core/recorder.js";
import type { RecordedAction } from "../src/core/types.js";

const act = (v: string): RecordedAction => ({
  type: "click",
  selectors: ["#x"],
  value: v,
  timestamp: Date.now(),
});

test("ActionRecorder caps at 25, evicting the oldest", () => {
  const r = new ActionRecorder();
  for (let i = 0; i < 30; i++) r.record(act(`step-${i}`));

  const snap = r.snapshot();
  assert.equal(snap.length, 25);
  // The first 5 are gone; the last 25 survive in order.
  assert.equal(snap[0].value, "step-5");
  assert.equal(snap[24].value, "step-29");
  // `step-0` was evicted.
  assert.ok(!snap.some((a) => a.value === "step-0"));
});

test("snapshot returns a copy, so mutation doesn't corrupt the buffer", () => {
  const r = new ActionRecorder();
  r.record(act("one"));
  const snap = r.snapshot();
  snap.push(act("injected"));
  assert.equal(r.snapshot().length, 1);
});
