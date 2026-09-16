import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalogMissions, buildLegacyMissions } from "../src/core/swarm.js";
import type { Role } from "../src/core/roles.js";

function role(id: string, budget = 100, weight?: number): Role {
  return {
    id,
    name: id,
    emoji: "",
    mission: "",
    mode: "solo",
    weight,
    behaviors: [{ kind: "walk", budget }],
  };
}

test("catalog missions: explicit roles get one mission each by default", () => {
  const missions = buildCatalogMissions({ roles: [role("novice"), role("hostile")], total: 2, seed: 42 });
  assert.deepEqual(
    missions.map((m) => m.role.id),
    ["novice", "hostile"]
  );
});

test("catalog missions: round-robin scale keeps distinct seeds", () => {
  const missions = buildCatalogMissions({ roles: [role("novice"), role("hostile")], total: 5, seed: 42 });
  assert.equal(missions.length, 5);
  assert.deepEqual(
    missions.map((m) => m.role.id),
    ["novice", "hostile", "novice", "hostile", "novice"]
  );
  assert.equal(new Set(missions.map((m) => m.seed)).size, 5, "each mission gets its own seed");
});

test("catalog missions: weighted allocation mirrors the audience", () => {
  // 10 base roles at weight 1, one persona at weight 10 → the persona gets
  // half of a 1000-agent swarm, not 1/11th.
  const roster = Array.from({ length: 10 }, (_, i) => role(`base-${i}`, 100, 1));
  roster.push(role("rushed-buyer", 60, 10));
  const missions = buildCatalogMissions({ roles: roster, total: 1000, seed: 42, weighted: true });
  const buyer = missions.filter((m) => m.role.id === "rushed-buyer");
  assert.equal(buyer.length, 500);
  assert.equal(missions.length, 1000);
});

test("catalog missions: budgetCap shrinks per-mission budgets, never below 3", () => {
  const missions = buildCatalogMissions({
    roles: [role("novice", 100)],
    total: 1000,
    seed: 42,
    budgetCap: 100,
  });
  assert.equal(missions[0].budget, 3, "ceil(100/1000)=1 → the 3-action floor");
  assert.equal(missions[999].budget, 3);
});

test("catalog missions: without a cap the role budget stands", () => {
  const missions = buildCatalogMissions({ roles: [role("observer", 40)], total: 1, seed: 42 });
  assert.equal(missions[0].budget, 40);
});

test("legacy missions: one worker is the deterministic walk", () => {
  const missions = buildLegacyMissions({ workers: 1, seed: 42, maxActions: 100 });
  assert.equal(missions.length, 1);
  assert.equal(missions[0].role.id, "walk");
  assert.equal(missions[0].role.behaviors[0].kind, "walk");
});

test("legacy missions: --fuzz makes every worker a fuzzer with its own seed", () => {
  const missions = buildLegacyMissions({ workers: 3, fuzz: true, seed: 42, maxActions: 100 });
  assert.deepEqual(
    missions.map((m) => m.role.behaviors[0].kind),
    ["fuzz", "fuzz", "fuzz"]
  );
  assert.deepEqual(
    missions.map((m) => m.seed),
    [42, 43, 44]
  );
});

test("legacy missions: --workers fans out as walk + fuzz seeds", () => {
  const missions = buildLegacyMissions({ workers: 4, seed: 42, maxActions: 100 });
  assert.deepEqual(
    missions.map((m) => m.role.behaviors[0].kind),
    ["walk", "fuzz", "fuzz", "fuzz"]
  );
});
