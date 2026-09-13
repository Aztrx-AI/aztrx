import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The README's reference tables promise two things the code has to back: 52
 * flags and 10 environment variables. Nothing connected either list to the
 * parser or to `process.env`, so a rename on one side left the other advertising
 * something that no longer exists — and the reader pays for it. A documented
 * flag that was deleted gives `error: unknown option`, which blames their
 * command line rather than the documentation; an environment variable that was
 * renamed is worse, because nothing happens at all. It is read as undefined, the
 * feature quietly falls back to its default, and there is no error to search
 * for. Documentation that names something which is not there costs more than
 * documentation that is missing, because the reader has to debug before they can
 * even conclude they were misled.
 *
 * That is not hypothetical here: this repo just shipped one file over — CI
 * snippets pinning a tag that did not exist, failing with a message worded to
 * look like infrastructure. So both lists are checked against the code, not
 * trusted.
 *
 * The source is the source of truth, not `--help`: several options are marked
 * `.hideHelp()` (the deprecated `--magic-fix`, the `--auth` and `--login-*`
 * aliases) and are documented on purpose, so a help-text comparison would fail
 * on exactly the entries that are deliberate. Reading the declarations sees all
 * of them.
 *
 * Only the direction that can hurt is asserted — every name the README uses must
 * exist in the code. The reverse is deliberately not checked: most declared
 * options and env vars are internal, and forcing them all into the README would
 * make the table worse, not truer.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** README table rows that define a flag: `| \`--flag\` | description | ... |`. */
const FLAG_ROW = /^\|\s*`--/;

/** Where the code that reads env vars and parses flags lives. `web/` is excluded
 * on purpose — it is a separate Next.js app with its own dependencies, and its
 * mentions are marketing copy, not a promise about this CLI. */
const SCANNED_DIRS = ["src", "server", "bench"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const SOURCES = SCANNED_DIRS.flatMap(sourceFiles).map((rel) => ({
  rel,
  text: fs.readFileSync(path.join(ROOT, rel), "utf-8"),
}));

/** Every long flag the CLI can actually parse, from its own declarations. Covers
 * the three shapes in use: the grouped `opt(…)` helper, plain `.option(…)` /
 * `.requiredOption(…)`, and a raw `new Option(…)`. */
function declaredFlags(): Set<string> {
  const found = new Set<string>();
  const declaration = /(?:opt|\.option|\.requiredOption|new Option)\(\s*"([^"]+)"/g;
  for (const { text } of SOURCES) {
    for (const m of text.matchAll(declaration)) {
      for (const flag of m[1].matchAll(/--[A-Za-z0-9-]+/g)) found.add(flag[0]);
    }
  }
  return found;
}

/** Every long flag the README's reference tables promise, with the row it is on
 * so a failure can print the claim rather than just the name. */
function documentedFlags(): Map<string, string> {
  const found = new Map<string, string>();
  const rows = fs
    .readFileSync(path.join(ROOT, "README.md"), "utf-8")
    .split("\n")
    .filter((line) => FLAG_ROW.test(line));
  for (const row of rows) {
    for (const m of row.matchAll(/`(--[A-Za-z0-9-]+)/g)) {
      if (!found.has(m[1])) found.set(m[1], row.trim().slice(0, 90));
    }
  }
  return found;
}

/** Every `AZTRX_*` name the code reads, with the file that reads it. */
function readEnvVars(): Map<string, string> {
  const found = new Map<string, string>();
  for (const { rel, text } of SOURCES) {
    for (const m of text.matchAll(/AZTRX_[A-Z0-9_]+/g)) {
      if (!found.has(m[0])) found.set(m[0], rel);
    }
  }
  return found;
}

/** Every `AZTRX_*` name the README tells the user to set. */
function documentedEnvVars(): Map<string, string> {
  const found = new Map<string, string>();
  fs.readFileSync(path.join(ROOT, "README.md"), "utf-8")
    .split("\n")
    .forEach((line, i) => {
      for (const m of line.matchAll(/AZTRX_[A-Z0-9_]+/g)) {
        if (!found.has(m[0])) found.set(m[0], `README.md:${i + 1}`);
      }
    });
  return found;
}

const DECLARED_FLAGS = declaredFlags();
const DOCUMENTED_FLAGS = documentedFlags();
const READ_ENV = readEnvVars();
const DOCUMENTED_ENV = documentedEnvVars();

test("both README reference lists were found, and neither is suspiciously small", () => {
  // Guards the guard. If the flag table is reformatted so FLAG_ROW stops
  // matching, or the env mentions move out of README.md, the assertions below
  // would compare nothing against nothing and pass — the documentation could rot
  // entirely without this file ever failing. The code side is checked too,
  // because a pattern that stops matching makes the "missing" sets look empty.
  assert.ok(
    DOCUMENTED_FLAGS.size >= 40,
    `only ${DOCUMENTED_FLAGS.size} documented flags found — if the README's table shape changed, update FLAG_ROW`
  );
  assert.ok(
    DECLARED_FLAGS.size >= 40,
    `only ${DECLARED_FLAGS.size} declared flags found — the declaration patterns have stopped matching`
  );
  assert.ok(
    DOCUMENTED_ENV.size >= 8,
    `only ${DOCUMENTED_ENV.size} documented env vars found — the README's wording changed shape`
  );
  assert.ok(
    READ_ENV.size >= 8,
    `only ${READ_ENV.size} env vars read in the code — the scan is looking in the wrong place`
  );
});

test("every flag the README documents is one the CLI can parse", () => {
  const missing = [...DOCUMENTED_FLAGS].filter(([flag]) => !DECLARED_FLAGS.has(flag));
  assert.deepEqual(
    missing.map(([flag, row]) => `${flag} — documented as: ${row}`),
    [],
    "the README advertises flags that do not exist; typing one gives " +
      "`error: unknown option`, which blames the reader's command line"
  );
});

test("every environment variable the README names is one the code reads", () => {
  const missing = [...DOCUMENTED_ENV].filter(([name]) => !READ_ENV.has(name));
  assert.deepEqual(
    missing.map(([name, where]) => `${name} — named at ${where}`),
    [],
    "the README tells the user to set an env var nothing reads; it would be " +
      "read as undefined and the feature would fall back to its default in silence"
  );
});
