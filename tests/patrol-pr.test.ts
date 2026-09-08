import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalUrl, branchForSet } from "../src/core/patrol/pr.js";

test("isLocalUrl treats loopback as local and everything else as deployed", () => {
  assert.equal(isLocalUrl("http://localhost:3000"), true);
  assert.equal(isLocalUrl("http://127.0.0.1:8080"), true);
  assert.equal(isLocalUrl("http://127.5.4.3"), true);
  assert.equal(isLocalUrl("http://0.0.0.0:3000"), true);
  assert.equal(isLocalUrl("https://app.example.com"), false);
  assert.equal(isLocalUrl("https://192.168.1.10"), false);
  // Unparseable → assume local rather than scare-mongering.
  assert.equal(isLocalUrl("not a url"), true);
});

test("branchForSet is stable across order and varies with the set", () => {
  const a = branchForSet(["fp-1", "fp-2", "fp-3"]);
  const b = branchForSet(["fp-3", "fp-1", "fp-2"]);
  assert.equal(a, b);
  assert.match(a, /^aztrx\/fix-batch-[0-9a-f]{8}$/);
  assert.notEqual(a, branchForSet(["fp-1", "fp-2"]));
});
