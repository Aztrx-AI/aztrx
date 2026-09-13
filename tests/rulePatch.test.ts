import { test } from "node:test";
import assert from "node:assert/strict";
import { generateRulePatch, RULE_TIER } from "../src/core/heal/llm.js";
import type { HealContext } from "../src/core/heal/types.js";
import type { Finding } from "../src/core/types.js";

/** A finding whose only relevant parts are the message and the mapped line. */
function ctxAt(line: number, content: string, message: string): HealContext {
  return {
    finding: {
      id: "f",
      fingerprint: "f",
      rootKey: "k",
      occurrences: 1,
      severity: "error",
      type: "uncaught_exception",
      rawMessage: message,
      rawStack: message,
      actionHistory: [],
      mappedLocation: { filePath: "app/page.tsx", line, column: 1, codeContext: "", isOwnCode: true },
    } as Finding,
    filePath: "app/page.tsx",
    fileContent: content,
    redactedContent: content,
  };
}

const DEREF = "Cannot read properties of undefined (reading 'agents')";

test("the sentinel tier name is the one heal routes on", () => {
  assert.equal(RULE_TIER, "__rule__");
});

test("a plain chain is optional-chained end to end", () => {
  const src = `  setAgents(d.agents.map((a) => a));`;
  const patch = generateRulePatch(ctxAt(1, src, DEREF));
  assert.ok(patch, "a null-deref on the mapped line is fixable for free");
  assert.equal(patch.hunks[0].replace, `  setAgents(d?.agents?.map((a) => a));`);
});

test("a spread survives — this is what made the rule engine give up on React", () => {
  // The regression: `\.(?=[a-zA-Z_$])` matches the third dot of `...s`, so the
  // patch came out as `{ ..?.s, … }`, the AST gate refused it as a syntax
  // error, and the finding was reported `rejected` — hiding that the free fixer
  // had produced garbage rather than that no fix was possible.
  const src = `    setStatus((s) => ({ ...s, [id]: result.ok ? "connected" : "failed" }));`;
  const patch = generateRulePatch(
    ctxAt(1, src, "TypeError: Cannot read properties of undefined (reading 'ok')")
  );
  assert.ok(patch);
  assert.equal(
    patch.hunks[0].replace,
    `    setStatus((s) => ({ ...s, [id]: result?.ok ? "connected" : "failed" }));`
  );
  assert.ok(!patch.hunks[0].replace.includes("..?."), "spread dots are not property access");
});

test("an access that is already optional is not chained twice", () => {
  const src = `  setAgents(d?.agents?.map((a) => a));`;
  // Already guarded: there is nothing to fix, so the free tier must decline
  // rather than emit `d??.agents`.
  assert.equal(generateRulePatch(ctxAt(1, src, DEREF)), null);
});

test("numbers are left alone", () => {
  const patch = generateRulePatch(
    ctxAt(1, `  return 1.5 + qty.toFixed(2);`, "Cannot read properties of null (reading 'toFixed')")
  );
  assert.ok(patch);
  assert.equal(patch.hunks[0].replace, `  return 1.5 + qty?.toFixed(2);`);
});

test("the line must actually read the property the message names", () => {
  // The message is the only proof of where the throw happened, so a mapped line
  // that does not read `.agents` is not the crash site and must be declined.
  assert.equal(generateRulePatch(ctxAt(1, `  return <div>ok</div>;`, DEREF)), null);
});

test("a message that is not a null/undefined deref is not ours", () => {
  assert.equal(
    generateRulePatch(ctxAt(1, `  return qty.toFixed(2);`, "qty.toFixed is not a function")),
    null
  );
});
