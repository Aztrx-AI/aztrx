import { test } from "node:test";
import assert from "node:assert/strict";
import { minimize } from "../src/core/minimizer.js";
import type { RecordedAction } from "../src/core/types.js";

function act(value: string): RecordedAction {
  return { type: "click", selectors: [`#${value}`], value, timestamp: Date.now() };
}

// A minimal ReplayEngine stub: the "bug" reproduces iff the sequence contains the
// crash-triggering action tagged `value === "b"`.
function engine(predicate: (subset: RecordedAction[]) => boolean) {
  return {
    run: async (_url: string, subset: RecordedAction[], _fp: string) => ({
      reproduced: predicate(subset),
    }),
  };
}

test("minimize shrinks [a,b,c,d] to the single triggering action b", async () => {
  const actions = [act("a"), act("b"), act("c"), act("d")];
  const out = await minimize(
    engine((s) => s.some((a) => a.value === "b")) as never,
    actions,
    { url: "http://x", fingerprint: "fp", maxReplays: 30 }
  );
  assert.deepEqual(
    out.map((a) => a.value),
    ["b"]
  );
});

test("minimize returns the original when nothing reproduces", async () => {
  const actions = [act("a"), act("b"), act("c")];
  const out = await minimize(
    engine(() => false) as never,
    actions,
    { url: "http://x", fingerprint: "fp" }
  );
  assert.deepEqual(
    out.map((a) => a.value),
    ["a", "b", "c"]
  );
});

test("minimize returns a single action unchanged", async () => {
  const actions = [act("only")];
  const out = await minimize(
    engine((s) => s.some((a) => a.value === "only")) as never,
    actions,
    { url: "http://x", fingerprint: "fp" }
  );
  assert.deepEqual(
    out.map((a) => a.value),
    ["only"]
  );
});
