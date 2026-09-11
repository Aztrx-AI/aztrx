import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cliCandidates,
  pickCliPath,
  resolveCliPath,
  scanDisabled,
  summarize,
} from "../src/plugins/scan.js";
import type { Finding } from "../src/core/types.js";

/** A finding in the shape `--json` really emits. Copied field-for-field from a
 * live run rather than idealized — the previous hand-written shape guessed
 * `mappedLocation.file`, so these tests passed while every real summary line
 * read `first: undefined:18`. */
function realFinding(over: Partial<Finding>): Finding {
  return {
    id: "abc123",
    fingerprint: "abc123",
    rootKey: "throw:X",
    occurrences: 1,
    severity: "crash",
    type: "uncaught_exception",
    rawMessage: "Cannot read properties of null (reading 'items')",
    rawStack: "TypeError: ...",
    actionHistory: [],
    ...over,
  };
}

test("summarize: clean run says so plainly", () => {
  const line = summarize({
    version: 1,
    url: "http://localhost:5173/",
    repoRoot: "/tmp/x",
    counts: { crash: 0, error: 0, warning: 0 },
    findings: [],
  });
  assert.match(line, /clean/);
});

test("summarize: names the worst finding's location, and how to get the repro", () => {
  const line = summarize({
    version: 1,
    url: "http://localhost:5173/",
    repoRoot: "/tmp/x",
    counts: { crash: 1, error: 0, warning: 2 },
    findings: [
      realFinding({ id: "a", severity: "warning", type: "console_error", rawMessage: "404" }),
      realFinding({
        id: "b",
        mappedLocation: {
          filePath: "src\\Report.tsx",
          line: 42,
          column: 11,
          codeContext: "> 42 | rows.map(...)",
          isOwnCode: true,
        },
      }),
    ],
  });
  assert.match(line, /1 crash · 2 warnings/);
  // Forward slashes, and the file name actually present.
  assert.match(line, /src\/Report\.tsx:42/);
  assert.doesNotMatch(line, /undefined/);
  assert.match(line, /npx aztrx-cli/);
});

test("scanDisabled: opt-in by presence, escapable by env for one run", () => {
  const before = process.env.AZTRX_DEV_SCAN;
  try {
    delete process.env.AZTRX_DEV_SCAN;
    // Adding the plugin to your config is already the opt-in, so `undefined` runs.
    assert.equal(scanDisabled(undefined), false);
    assert.equal(scanDisabled(true), false);
    assert.equal(scanDisabled(false), true);

    process.env.AZTRX_DEV_SCAN = "0";
    assert.equal(scanDisabled(undefined), true);
    process.env.AZTRX_DEV_SCAN = "1";
    assert.equal(scanDisabled(undefined), false);
  } finally {
    if (before === undefined) delete process.env.AZTRX_DEV_SCAN;
    else process.env.AZTRX_DEV_SCAN = before;
  }
});

test("cliCandidates: includes the layout a real project installs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-cli-lookup-"));
  const installed = path.join(root, "node_modules", "aztrx-cli", "dist", "cli.js");
  assert.ok(
    cliCandidates(root).includes(installed),
    "npm's node_modules/aztrx-cli/dist/cli.js must be one of the candidates"
  );
});

test("pickCliPath: takes the first candidate that exists, in order", () => {
  // The ordering, tested without a filesystem to arrange. Turbopack pre-evaluated
  // a `require.resolve` whose base was statically known and handed us a
  // build-time path that did not exist — picking by existence is what makes that
  // failure recoverable instead of fatal.
  const candidates = ["/a/cli.js", "/b/cli.js", "/c/cli.js"];
  assert.equal(pickCliPath(candidates, (p) => p === "/b/cli.js"), "/b/cli.js");
  assert.equal(pickCliPath(candidates, (p) => p === "/c/cli.js"), "/c/cli.js");
  assert.equal(pickCliPath(candidates, () => false), undefined);
});

test("resolveCliPath: returns a path rather than throwing when nothing is installed", () => {
  // Never throw: a caller with no installed copy should get a name to print in
  // the error, not an exception from the error path itself.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-cli-missing-"));
  const found = resolveCliPath(empty);
  assert.equal(typeof found, "string");
  assert.match(found, /cli\.js$/);
});
