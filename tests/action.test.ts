import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards for the GitHub Action.
 *
 * The action is the one artifact every CI user touches and the only part of the
 * repo the test suite cannot execute — nothing here runs on a GitHub runner. What
 * it *can* check is the class of defect that actually shipped: references that
 * must agree with each other drifting apart silently, and shell logic that
 * mistakes one outcome for another.
 *
 * There is no YAML parser in the dependency tree and adding one to read five
 * scalar values is not worth it, so these read the raw text with anchored
 * patterns. They are deliberately narrow: each one asserts a specific value it
 * knows how to find, and fails with both sides printed so the fix is obvious.
 * If the shape of the file changes enough to break a pattern, the assertion
 * fails loudly rather than passing vacuously — which is what a guard is for.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf-8");

const pkg = JSON.parse(read("package.json")) as {
  version: string;
  dependencies: Record<string, string>;
};
const actionYml = read("action.yml");
const workflow = read(".github/workflows/aztrx-pr.yml");

/** The version this release claims to be. */
const VERSION = pkg.version;

// ---------------------------------------------------------------------------
// Version references
// ---------------------------------------------------------------------------

test("action.yml: the fallback engine version matches package.json", () => {
  // The literal used when `github.action_path` is empty (a local `uses: ./`).
  // Every other path reads the version off the action's own manifest, so this is
  // the one place a stale number can hide.
  const m = actionYml.match(/\[ -z "\$ver" \] && ver="([^"]+)"/);
  assert.ok(m, "the fallback version assignment is gone — did the Run step change shape?");
  assert.equal(
    m[1],
    VERSION,
    `action.yml falls back to aztrx-cli ${m[1]} but package.json is ${VERSION}. ` +
      "`uses: Aztrx-AI/aztrx@vX` runs aztrx-cli at this version for local checkouts."
  );
});

test("action.yml: the Chromium pin matches the Playwright aztrx depends on", () => {
  // Driver and browser must be the same build or launch() fails, and the failure
  // lands on a user's CI rather than here.
  const m = actionYml.match(/playwright@([0-9]+\.[0-9]+\.[0-9]+) install/);
  assert.ok(m, "the Chromium install step no longer names a Playwright version");
  assert.equal(
    m[1],
    pkg.dependencies.playwright,
    `action.yml installs Chromium for Playwright ${m[1]}, but aztrx depends on ` +
      `${pkg.dependencies.playwright}. A mismatch makes launch() fail in CI.`
  );
});

test("aztrx-pr.yml: our own action is pinned to this release's tag", () => {
  const m = workflow.match(/uses:\s*Aztrx-AI\/aztrx@(\S+)/);
  assert.ok(m, "the reusable workflow no longer calls our own action");
  assert.equal(
    m[1],
    `v${VERSION}`,
    `the reusable workflow calls Aztrx-AI/aztrx@${m[1]} but this release is v${VERSION}. ` +
      "Consumers copying this snippet would get an older engine."
  );
  // The copy-paste example at the top of the file is what people actually paste —
  // it has been stale before, independently of the real reference.
  const example = workflow.match(/aztrx-pr\.yml@(\S+)/);
  assert.equal(example?.[1], `v${VERSION}`, "the usage example at the top of the workflow is stale");
});

test("action.yml: the engine is not pinned to a literal version", () => {
  // The defect this whole file exists for: a hardcoded `npx aztrx-cli@0.4.3`
  // meant `uses: Aztrx-AI/aztrx@v0.4.5` executed 0.4.3, because the tag selects
  // the wrapper and the wrapper named the engine.
  const m = actionYml.match(/default:\s*"(npx[^"]*aztrx-cli@[^"]*)"/);
  assert.equal(
    m,
    null,
    `the aztrx input defaults to a hardcoded version (${m?.[1]}), which overrides the ` +
      "tag the consumer pinned. Leave it empty and let the action read its own version."
  );
  assert.match(actionYml, /ACTION_PATH.*package\.json|package\.json.*ACTION_PATH/s, "the action must read its own version from github.action_path");
});

// ---------------------------------------------------------------------------
// Supply chain
// ---------------------------------------------------------------------------

test("every third-party action is pinned to a full commit SHA", () => {
  // A tag can be repointed at new code; a SHA cannot. This is the check that
  // would have caught a compromised upstream release.
  //
  // Matched as a YAML key at the start of a line, not by searching for the
  // substring: `uses:` also appears in prose (input descriptions and comments),
  // and a first version of this guard happily "validated" a backticked mention
  // in a description instead of the real reference.
  const refs = `${actionYml}\n${workflow}`
    .split("\n")
    .map((l) => l.match(/^\s*uses:\s*([^\s#]+)/)?.[1])
    .filter((r): r is string => Boolean(r) && !r.startsWith("./"));

  assert.ok(refs.length > 0, "no `uses:` references found — the pattern has stopped matching");
  for (const ref of refs) {
    const [owner, rest] = ref.split("/");
    if (!rest) continue;
    if (owner.toLowerCase() === "aztrx-ai") {
      // Our own action: a version tag is the point — it is how the tag the
      // consumer chose reaches the engine.
      assert.match(
        ref,
        /^Aztrx-AI\/aztrx@v\d+\.\d+\.\d+$/,
        `our own action should be pinned to a version tag, found: ${ref}`
      );
    } else {
      assert.match(
        ref,
        /@[0-9a-f]{40}$/,
        `${ref} is not pinned to a full commit SHA — a moved tag would run different code`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The step body
// ---------------------------------------------------------------------------

/** Every line that is part of a `run:` value — block form (`run: |`) or the
 * single-line form — that also interpolates an input. Scanned by indentation
 * rather than by regex over the whole file, because a step's `run:` body ends at
 * the next line that is not more indented than the key itself. */
function interpolatedRunLines(text: string): string[] {
  const bad: string[] = [];
  let inBlock = false;
  let blockIndent = 0;

  for (const line of text.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (inBlock && line.trim() && indent <= blockIndent) inBlock = false;

    if (inBlock) {
      if (/\$\{\{\s*inputs\./.test(line)) bad.push(line.trim());
      continue;
    }

    const block = line.match(/^(\s*)run:\s*\|/);
    if (block) {
      inBlock = true;
      blockIndent = block[1].length;
      continue;
    }
    if (/^\s*run:\s*\S/.test(line) && /\$\{\{\s*inputs\./.test(line)) bad.push(line.trim());
  }
  return bad;
}

test("no action input is interpolated into a run: block", () => {
  // `${{ inputs.x }}` is substituted into the script *text* before bash parses it,
  // so a value containing a quote closes the string and runs its own commands —
  // on the step that holds ANTHROPIC_API_KEY. Inputs must arrive through `env`
  // and be read as quoted variables.
  const bad = interpolatedRunLines(actionYml);
  assert.deepEqual(
    bad,
    [],
    "these interpolate an input into shell text (move them to the step's env: and read " +
      "them as quoted variables):\n  " + bad.join("\n  ")
  );
  // The scanner has to be able to see a run body at all, or it would pass by
  // finding nothing — the same reason the old `exit $?` guard strips comments.
  assert.ok(
    /Run aztrx[\s\S]*?read -r -a AZTRX_ARGS/.test(actionYml),
    "the scanner found no run bodies; the file's shape changed and this guard is now vacuous"
  );
});

test("the gate distinguishes 'found a crash' from 'never ran'", () => {
  // npx exits 1 both when aztrx reports a crash and when the package does not
  // exist (verified: ETARGET on a bad version, and on an unreachable registry).
  // Collapsing those two into "crash/error findings" accuses a PR of a bug that
  // nothing ever looked for.
  const runStep = actionYml.slice(actionYml.indexOf("- name: Run aztrx"));
  assert.match(runStep, /1\)\s*verdict="findings"/, "exit 1 must be identified as findings");
  assert.match(runStep, /\*\)\s*verdict="did-not-run"/, "any other exit code must be identified as `did not run`");
  assert.match(actionYml, /VERDICT/, "the gate must branch on the verdict, not just the code");

  const gate = actionYml.slice(actionYml.indexOf("- name: Surface gate"));
  // An empty output (the step died before writing one) is not a pass and not a
  // crash — it still has to fail, with its own wording.
  assert.match(gate, /if: always\(\)/, "the gate must run even when the run step died");
  assert.match(gate, /did not run/, "the gate must say so in its own words when the scan never happened");
  assert.doesNotMatch(
    gate.slice(gate.indexOf("*)")),
    /findings/,
    "the did-not-run branch must not reuse the findings wording"
  );
});

test("the comment step cannot take the job down ahead of the gate", () => {
  // Forks get a read-only token, so `gh pr comment` 403s. Without this the step
  // aborts the action before the gate runs and the check is red whatever the scan
  // found — with the comment step named as the failure.
  const comment = actionYml.slice(actionYml.indexOf("- name: Post PR comment"), actionYml.indexOf("- name: Surface gate"));
  assert.match(comment, /continue-on-error:\s*true/, "a failed comment must not fail the job");
  assert.match(comment, /if ! gh pr comment/, "gh must be allowed to fail without aborting the step");
});

test("the readiness poll is bounded and cannot mistake an error page for a live app", () => {
  const wait = actionYml.slice(actionYml.indexOf("- name: Wait for app"), actionYml.indexOf("- name: Run aztrx"));
  assert.match(wait, /--max-time/, "a socket that accepts but never answers would hang the step");
  assert.match(wait, /--connect-timeout/, "connect attempts need their own bound");
  assert.match(wait, /-f\b/, "without -f a 404/500 counts as the app being ready");
  assert.match(wait, /aztrx-dev\.log/, "the dev server's own output is the only clue when boot fails");
});

test("the dev server is actually stopped", () => {
  // The PID was captured and never read, so a self-hosted runner kept the server
  // (and its port) past the job.
  assert.match(actionYml, /AZTRX_DEV_PID=\$!/, "the dev server PID must be captured");
  const stop = actionYml.slice(actionYml.indexOf("- name: Stop dev server"));
  assert.match(stop, /if: always\(\)/, "teardown must run even when the scan fails");
  assert.match(stop, /kill "\$AZTRX_DEV_PID"/, "the captured PID is never used to stop anything");
});

// ---------------------------------------------------------------------------
// Shell behaviour — the two pieces worth actually executing
// ---------------------------------------------------------------------------

/** Run a fragment under sh, with the fallbacks a real runner would provide. */
function sh(script: string, env: Record<string, string> = {}) {
  return spawnSync("sh", ["-c", script], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

/** The version-resolution block, lifted out of action.yml rather than retyped —
 * so this test executes the code that ships, and cannot drift into validating a
 * paraphrase of it. Bounded by the fallback line that ends the block. */
function versionSnippet(): string {
  const start = actionYml.indexOf('ver=""');
  assert.ok(start > -1, "the version-resolution block is gone from the Run step");
  const fallback = actionYml.indexOf('[ -z "$ver" ] && ver="', start);
  assert.ok(fallback > start, "the fallback assignment is gone — the block changed shape");
  const end = actionYml.indexOf("\n", actionYml.indexOf('"', fallback + 20));
  return actionYml.slice(start, end);
}

test(
  "version resolution reads the action's own manifest at whatever ref it was fetched",
  { skip: spawnSync("sh", ["-c", "true"]).status === 0 ? false : "no `sh` on PATH" },
  () => {
    // Stands in for $GITHUB_ACTION_PATH. Being correct for a *tag* is not enough:
    // a consumer may pin a branch or a full SHA, and `github.action_ref` would
    // hand back "main" or a 40-char SHA in those cases, neither of which is a
    // version. Reading the manifest works for all three.
    const snippet = `${versionSnippet()}; echo "$ver"`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-actionpath-"));
    try {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "aztrx-cli", version: "9.9.9" }),
        "utf-8"
      );

      const found = sh(snippet, { ACTION_PATH: dir });
      assert.equal(found.status, 0, found.stderr);
      assert.equal(found.stdout.trim(), "9.9.9", "must take the version from the action's own tree");

      // A local `uses: ./` has no action path, and the fallback has to hold.
      assert.equal(sh(snippet, { ACTION_PATH: "" }).stdout.trim(), "0.4.5", "must fall back when ACTION_PATH is empty");

      // A path that exists but has no manifest must fall back too, not emit
      // "undefined" — which would become an npx request for aztrx-cli@undefined.
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-actionpath-"));
      try {
        assert.equal(sh(snippet, { ACTION_PATH: bare }).stdout.trim(), "0.4.5");
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  "the exit code becomes a verdict that does not blame the PR for a missing tool",
  { skip: spawnSync("sh", ["-c", "true"]).status === 0 ? false : "no `sh` on PATH" },
  () => {
    // The table, executed rather than read: 0 is clean, 1 is a crash (npx exits 1
    // for its own failures too), and everything else means the scan never ran.
    const classify = 'case "$1" in 0) v=clean ;; 1) v=findings ;; *) v=did-not-run ;; esac; echo "$v"';

    for (const [code, expected] of [
      ["0", "clean"],
      ["1", "findings"],
      ["2", "did-not-run"], // commander: unknown option
      ["127", "did-not-run"], // command not found
      ["130", "did-not-run"], // interrupted
    ] as const) {
      const res = sh(`set -- ${code}; ${classify}`);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout.trim(), expected, `exit ${code} should classify as ${expected}`);
    }
  }
);
