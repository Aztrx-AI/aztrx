import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The version a stranger is told to install appears in four files, and GitHub
 * Actions resolves each of them independently: the README's two examples, the
 * composite action's `description`, and the reusable workflow's own `uses:` line.
 *
 * Nothing keeps them together, and the failure is quiet in the worst direction.
 * A `uses: owner/repo@vX` whose tag does not exist does not report a broken pin —
 * it reports `aztrx did not run (exit code: N)`, which is deliberately worded so
 * it cannot be mistaken for a verdict about the app… and which therefore reads
 * like an infrastructure hiccup rather than "the README is wrong". This repo has
 * already shipped that bug once (the `v0.5.0` tag, which was never published) and
 * once more in the mirror image of it — the README pinned `@v0.5.2` for four
 * commits while npm's `latest` was still 0.5.1, so every reader who copied the
 * snippet out got a failing job.
 *
 * So the invariant is checked rather than remembered. Two rules, both offline:
 * the pins must agree with each other, and they may never name a version *ahead*
 * of `package.json` — lagging is the normal pre-release state, leading is a
 * version that exists nowhere.
 */

const PIN_SOURCES = [
  "README.md",
  "action.yml",
  path.join(".github", "workflows", "aztrx-pr.yml"),
] as const;

/** Every place one of those files tells a reader which version to install. */
const PIN_PATTERNS: RegExp[] = [
  /Aztrx-AI\/aztrx@v(\d+\.\d+\.\d+)/g, // `uses: Aztrx-AI/aztrx@v1.2.3`
  /aztrx-cli@(\d+\.\d+\.\d+)/g, // `npx --yes aztrx-cli@1.2.3`
  /aztrx-cli (\d+\.\d+\.\d+)/g, // prose: "runs **aztrx-cli 1.2.3**"
];

interface Pin {
  file: string;
  version: string;
}

function pinsIn(file: string): Pin[] {
  const text = fs.readFileSync(path.join(process.cwd(), file), "utf-8");
  const found: Pin[] = [];
  for (const re of PIN_PATTERNS) {
    for (const m of text.matchAll(re)) found.push({ file, version: m[1] });
  }
  return found;
}

function packageVersion(): string {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8")).version;
}

/** Numeric, not lexicographic: 0.10.0 is newer than 0.9.0 and a string compare
 * says otherwise, which would let exactly the release this guard exists for pass. */
function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

const ALL_PINS = PIN_SOURCES.flatMap(pinsIn);

test("every file that names a version still names one", () => {
  // Guards the guard. If a file is rewritten so the patterns miss, an empty
  // result would sail through the tests below and the check would be gone
  // without ever having failed — which is the whole shape of bug this file is
  // about, one level up.
  const byFile = new Map<string, number>();
  for (const p of ALL_PINS) byFile.set(p.file, (byFile.get(p.file) ?? 0) + 1);
  for (const file of PIN_SOURCES) {
    assert.ok(
      (byFile.get(file) ?? 0) > 0,
      `${file} no longer names an installable version — if the wording changed, update PIN_PATTERNS`
    );
  }
});

test("the README, the action, and the reusable workflow pin the same version", () => {
  const versions = [...new Set(ALL_PINS.map((p) => p.version))];
  assert.equal(
    versions.length,
    1,
    `pins disagree — ${ALL_PINS.map((p) => `${p.file}: ${p.version}`).join(", ")}`
  );
});

test("no pin is ahead of what package.json says we are building", () => {
  // The published direction is the dangerous one: a pin for a version that was
  // never tagged resolves to nothing, and the reader has no way to tell that
  // from a flaky CI run. Lagging is fine and expected — `main` is normally
  // ahead of npm between releases, which is why this asserts one-way.
  const pinned = ALL_PINS[0].version;
  const pkg = packageVersion();
  assert.ok(
    compare(pinned, pkg) <= 0,
    `pins say ${pinned} but package.json is only ${pkg} — a pin may lag the tree, never lead it`
  );
});
