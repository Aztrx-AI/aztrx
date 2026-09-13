import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configAllowHosts, configMaxActions } from "../src/core/devServer.js";
import { initProject } from "../src/core/init.js";

/** `aztrx init` scaffolds aztrx.config.ts and tells the user to edit keys in it.
 * A key the tool never reads is worse than no key: the user follows the
 * instructions, nothing changes, and there is no error to explain why. */

function repo(config?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-config-"));
  if (config !== undefined) fs.writeFileSync(path.join(dir, "aztrx.config.ts"), config, "utf-8");
  return dir;
}

test("init scaffolds only keys that are actually read", async () => {
  // The regression this guards: the template advertised `repo`, `maxActions` and
  // `allowHosts` while only `url` was ever parsed — so the scaffolded file
  // instructed the user to set an allow-list that had no effect.
  const dir = repo();
  await initProject({ repoRoot: dir, url: "http://localhost:3000" });

  const src = fs.readFileSync(path.join(dir, "aztrx.config.ts"), "utf-8");
  assert.ok(src.includes("url:"), "url must stay — it is read");
  assert.match(src, /maxActions:\s*\d+/);
  assert.match(src, /allowHosts:\s*\[/);
  // `repo` was dropped: it would be a second, implicit source of truth for a
  // value that governs worktrees, test commands and git operations, not just
  // sourcemap resolution — the one-line comment it shipped with understated it.
  assert.doesNotMatch(src, /\brepo\s*:/);
});

test("the scaffolded default file parses to usable values", async () => {
  const dir = repo();
  await initProject({ repoRoot: dir, url: "http://localhost:5173" });

  assert.equal(configMaxActions(dir), 100);
  assert.deepEqual(configAllowHosts(dir), []);
});

test("configAllowHosts reads a populated allow-list", () => {
  const dir = repo(`export default {
  url: "http://localhost:3000",
  allowHosts: ["api.example.com", "cdn.example.com"],
};`);
  assert.deepEqual(configAllowHosts(dir), ["api.example.com", "cdn.example.com"]);
});

test("configAllowHosts tolerates single quotes, backticks, and junk", () => {
  assert.deepEqual(configAllowHosts(repo(`allowHosts: ['a.test', \`b.test\`]`)), ["a.test", "b.test"]);
  // An unparseable value must widen the allow-list by nothing — this list is a
  // security control, so the failure mode has to be "no hosts", never "all".
  assert.deepEqual(configAllowHosts(repo(`allowHosts: "everything"`)), []);
  assert.deepEqual(configAllowHosts(repo(`allowHosts: []`)), []);
});

test("configAllowHosts is empty when there is no config at all", () => {
  assert.deepEqual(configAllowHosts(repo()), []);
  assert.equal(configMaxActions(repo()), undefined);
});

test("configMaxActions reads a number and rejects a non-number", () => {
  assert.equal(configMaxActions(repo(`maxActions: 250`)), 250);
  assert.equal(configMaxActions(repo(`maxActions = 7`)), 7);
  // Falls back to the built-in default rather than NaN reaching the walker.
  assert.equal(configMaxActions(repo(`maxActions: "lots"`)), undefined);
});
