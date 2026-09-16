import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_CATALOG, resolveRoles } from "../src/core/roles.js";
import { mergeFindings } from "../src/core/swarm.js";
import type { Finding } from "../src/core/types.js";

test("the catalog has the thirteen roles of the swarm", () => {
  assert.equal(ROLE_CATALOG.length, 13);
  const ids = ROLE_CATALOG.map((r) => r.id);
  assert.deepEqual(new Set(ids).size, ids.length, "role ids must be unique");
  for (const role of ROLE_CATALOG) {
    assert.ok(role.behaviors.length > 0, `${role.id} needs at least one behavior`);
    assert.ok(["solo", "race", "light"].includes(role.mode), `${role.id} has a valid mode`);
  }
});

test("every role id is a URL-safe slug — it appears in logs and fingerprints", () => {
  for (const role of ROLE_CATALOG) {
    assert.match(role.id, /^[a-z0-9-]+$/, `${role.id} must be a slug`);
  }
});

test("resolveRoles: a subset resolves in the order asked, unknown ids are skipped", () => {
  const roles = resolveRoles(["hostile", "nope", "novice"]);
  assert.deepEqual(
    roles.map((r) => r.id),
    ["hostile", "novice"]
  );
});

test("resolveRoles: empty input means the full catalog", () => {
  assert.equal(resolveRoles(undefined).length, ROLE_CATALOG.length);
  assert.equal(resolveRoles([]).length, ROLE_CATALOG.length);
});

function finding(fp: string, roles: string[], occurrences: number): Finding {
  return {
    id: fp,
    fingerprint: fp,
    occurrences,
    severity: "error",
    type: "uncaught_exception",
    rawMessage: fp,
    rawStack: "",
    actionHistory: [],
    roles,
  };
}

test("mergeFindings: dedup sums occurrences and unions role tags", () => {
  const merged = mergeFindings([
    [finding("fp1", ["novice"], 2)],
    [finding("fp1", ["hostile"], 3), finding("fp2", ["observer"], 1)],
  ]);
  assert.equal(merged.length, 2);
  const byFp = new Map(merged.map((f) => [f.fingerprint, f]));
  assert.equal(byFp.get("fp1")!.occurrences, 5);
  assert.deepEqual(byFp.get("fp1")!.roles, ["novice", "hostile"]);
  assert.deepEqual(byFp.get("fp2")!.roles, ["observer"]);
});

test("mergeFindings: a tag seen by two missions of one role stays a single entry", () => {
  const merged = mergeFindings([[finding("fp1", ["race-hunter"], 1)], [finding("fp1", ["race-hunter"], 1)]]);
  assert.deepEqual(merged[0].roles, ["race-hunter"]);
});

test("mergeFindings: findings without role tags (solo runs) stay untagged", () => {
  const merged = mergeFindings([[finding("fp1", undefined as never, 1)]]);
  assert.deepEqual(merged[0].roles, undefined);
});
