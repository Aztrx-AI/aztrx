import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMissions } from "../src/core/swarm.js";
import type { SwarmOptions } from "../src/core/swarm.js";

function base(opts: Partial<SwarmOptions> = {}): SwarmOptions {
  return {
    url: "http://localhost:3000",
    repoRoot: ".",
    maxActions: 100,
    seed: 42,
    workers: 1,
    allowHosts: new Set(["localhost"]),
    baseline: [],
    guardOn: false,
    log: () => {},
    ...opts,
  };
}

test("catalog mode: --roles runs exactly those roles, one mission each", () => {
  const missions = buildMissions(base({ roles: ["novice", "hostile"] }));
  assert.equal(missions.length, 2);
  assert.deepEqual(
    missions.map((m) => m.role.id),
    ["novice", "hostile"]
  );
});

test("catalog mode: --agents scales missions round-robin with distinct seeds", () => {
  const missions = buildMissions(base({ roles: ["novice", "hostile"], agents: 5 }));
  assert.equal(missions.length, 5);
  assert.deepEqual(
    missions.map((m) => m.role.id),
    ["novice", "hostile", "novice", "hostile", "novice"]
  );
  assert.equal(new Set(missions.map((m) => m.seed)).size, 5, "each mission gets its own seed");
});

test("catalog mode: unknown role ids are dropped by resolveRoles", () => {
  const missions = buildMissions(base({ roles: ["hostile", "does-not-exist"] }));
  assert.deepEqual(
    missions.map((m) => m.role.id),
    ["hostile"]
  );
});

test("legacy mode: one worker is the deterministic walk", () => {
  const missions = buildMissions(base({ workers: 1 }));
  assert.equal(missions.length, 1);
  assert.equal(missions[0].role.id, "walk");
  assert.equal(missions[0].role.behaviors[0].kind, "walk");
});

test("legacy mode: --fuzz makes every worker a fuzzer with its own seed", () => {
  const missions = buildMissions(base({ workers: 3, fuzz: true }));
  assert.deepEqual(
    missions.map((m) => m.role.behaviors[0].kind),
    ["fuzz", "fuzz", "fuzz"]
  );
  assert.deepEqual(
    missions.map((m) => m.seed),
    [42, 43, 44]
  );
});

test("legacy mode: --workers fans out as walk + fuzz seeds", () => {
  const missions = buildMissions(base({ workers: 4 }));
  assert.deepEqual(
    missions.map((m) => m.role.behaviors[0].kind),
    ["walk", "fuzz", "fuzz", "fuzz"]
  );
});

test("missions carry the role budget as the per-mission action cap", () => {
  const missions = buildMissions(base({ roles: ["observer"] }));
  assert.equal(missions[0].role.behaviors[0].budget, 100);
});
