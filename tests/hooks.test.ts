import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  analyzePush,
  decidePush,
  diffNames,
  hookScript,
  hooksDir,
  installHook,
  isAppCode,
  isBranchDelete,
  isNewBranch,
  parsePushLines,
  uninstallHook,
} from "../src/hooks/index.js";

const ZERO = "0".repeat(40);
const SHA = (c: string) => c.repeat(40);

/** Every temp directory this file makes, removed once at the end.
 *
 * Registered rather than deleted at the end of each test, because a failing
 * assertion skips whatever cleanup sits after it — and a failing run is the one
 * that runs most. Note this is the whole OS temp dir, not just this repo's: it
 * had drifted to a few hundred directories before anyone looked. */
const TEMP: string[] = [];
function track(dir: string): string {
  TEMP.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP) {
    // Best-effort. Windows holds handles on freshly-killed git repos and git
    // marks object files read-only, so a delete here can legitimately fail —
    // and a temp directory that will not go away is not a test failure.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS reclaims it eventually */
    }
  }
});

/** A throwaway git repo. Real `git init` rather than a mock directory, because
 * the two things most likely to be wrong here — where the hooks directory
 * actually is, and whether the shim is executable — are exactly the things a
 * mock would get wrong in the same way the code does. */
function gitRepo(): string {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-hook-")));
  const res = spawnSync("git", ["init", "-q", "."], { cwd: dir, encoding: "utf-8" });
  assert.equal(res.status, 0, `git init failed: ${res.stderr}`);
  return dir;
}

// ---------------------------------------------------------------------------
// Reading the push
// ---------------------------------------------------------------------------

test("parsePushLines: reads git's four-column format and drops what it cannot", () => {
  const refs = parsePushLines(
    [
      `refs/heads/main ${SHA("a")} refs/heads/main ${SHA("b")}`,
      "",
      "   ",
      "garbage",
      `refs/heads/x ${SHA("c")} refs/heads/x ${SHA("d")} extra-columns-are-fine`,
      "",
    ].join("\n")
  );
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], {
    localRef: "refs/heads/main",
    localSha: SHA("a"),
    remoteRef: "refs/heads/main",
    remoteSha: SHA("b"),
  });
  assert.equal(refs[1].localSha, SHA("c"));
});

test("zero-sha means absent on that side, and the two sides mean opposite things", () => {
  const del = parsePushLines(`(delete) ${ZERO} refs/heads/gone ${SHA("b")}`)[0];
  const fresh = parsePushLines(`refs/heads/new ${SHA("a")} refs/heads/new ${ZERO}`)[0];
  // A deletion carries no code; a new branch carries unknown code.
  assert.equal(isBranchDelete(del), true);
  assert.equal(isBranchDelete(fresh), false);
  assert.equal(isNewBranch(del), false);
  assert.equal(isNewBranch(fresh), true);
});

test("isAppCode: skips only what provably cannot change runtime behaviour", () => {
  for (const file of [
    "src/App.tsx",
    "app/page.tsx",
    "public/index.html",
    "package-lock.json", // a dependency bump absolutely changes runtime
    "docs/guide.mdx", // not `.md` — mdx compiles into the app
    "vite.config.ts",
    "next.config.js",
  ]) {
    assert.equal(isAppCode(file), true, `${file} must count as app code`);
  }
  for (const file of [
    "README.md",
    "docs/notes.md",
    "LICENSE",
    ".gitignore",
    ".editorconfig",
    ".github/workflows/ci.yml",
    ".vscode/settings.json",
    ".aztrx/report.html",
    "aztrx-media/abc.gif",
    "media/logo.svg",
    "public/hero.png",
  ]) {
    assert.equal(isAppCode(file), false, `${file} must be skipped`);
  }
});

test("analyzePush: deletions skip, anything unknowable scans and says why", () => {
  const ref = (local: string, remote: string) =>
    parsePushLines(`refs/heads/m ${local} refs/heads/m ${remote}`)[0];
  const never = () => {
    throw new Error("diff must not be called");
  };
  const scan = (a: { changed: string[] | null }) => a.changed === null;

  // Nothing on stdin = a manual run, or something upstream swallowed it. Scan —
  // that is what the person who typed the command wants, and the conservative
  // answer besides.
  const empty = analyzePush([], never);
  assert.equal(scan(empty), true);
  assert.match(empty.blind, /no refs on stdin/);

  // Deleting a remote branch pushes no code.
  assert.deepEqual(analyzePush([ref(ZERO, SHA("b"))], never).changed, []);

  // A branch the remote has never seen has no base; assume everything is new.
  const fresh = analyzePush([ref(SHA("a"), ZERO)], never);
  assert.equal(scan(fresh), true);
  assert.match(fresh.blind, /no such branch yet/);

  // A base git cannot resolve (shallow clone) is a reason to look at
  // everything, never a reason to skip — and it must not be reported as
  // something else, which is how a drained stdin got blamed on a shallow clone.
  const shallow = analyzePush([ref(SHA("a"), SHA("b"))], () => null);
  assert.equal(scan(shallow), true);
  assert.match(shallow.blind, /could not diff/);

  // Several refs pushed at once: the union of their diffs.
  const changed = analyzePush(
    [ref(SHA("a"), SHA("b")), ref(SHA("c"), SHA("d"))],
    (base) => (base === SHA("b") ? ["src/a.ts"] : ["src/b.ts", "src/a.ts"])
  ).changed;
  assert.deepEqual(changed, ["src/a.ts", "src/b.ts"]);
});

test("decidePush: skips a docs-only push, blocks everything else into a scan", () => {
  const know = (changed: string[] | null) => ({ changed, liveRefs: [], blind: "because" });
  assert.equal(decidePush(know(["README.md", "LICENSE"]), false).scan, false);
  assert.equal(decidePush(know(["README.md", "src/a.ts"]), false).scan, true);
  assert.equal(decidePush(know(["src/a.ts"]), false).scan, true);
  // An empty diff is an empty push.
  assert.equal(decidePush(know([]), false).scan, false);
  // Unknowable → scan, and the reason reaches the user rather than a guess.
  const unknown = decidePush(know(null), false);
  assert.equal(unknown.scan, true);
  assert.match(unknown.reason, /because/);
  // `--always` overrides the filter entirely.
  assert.equal(decidePush(know(["README.md"]), true).scan, true);
});

// ---------------------------------------------------------------------------
// The shim
// ---------------------------------------------------------------------------

test("hookScript: LF only, delegate to the CLI, carried by both shells", () => {
  const script = hookScript();
  assert.match(script, /^#!\/bin\/sh\n/, "a CRLF shebang is `/bin/sh\\r`, which is not an interpreter");
  assert.doesNotMatch(script, /\r/, "a hook written with CRLF fails on Windows with 'bad interpreter'");
  assert.ok(script.includes("aztrx-cli hook run pre-push"), "must be recognisable as ours");
  assert.match(script, /npx --no-install/, "falls back to the project's local copy");
  assert.match(script, /^exit 0$/m, "fail-open: a missing tool must not block a push");
  // The first version ended with `npx --no-install …; exit $?` — and `npx
  // --no-install` exits 1 both when the CLI reports a crash and when the package
  // is simply not installed, so an uninstalled tool blocked every push. The
  // guard is that the run is *conditional*, never that its status is passed on.
  // Comments are stripped first: the explanation above quotes the bad line
  // verbatim, and an assertion that matches its own comment tests nothing.
  const code = script
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(code, /exit \$\?/, "never propagate a bare exit status — npx's 1 is not ours");
  assert.ok(script.endsWith("\n"));
});

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

test("install: writes an executable shim where git will actually look", () => {
  const root = gitRepo();
  const res = installHook(root);
  assert.equal(res.ok, true, res.message);
  assert.equal(res.action, "installed");

  const dir = hooksDir(root);
  assert.ok(dir, "git must be able to name its own hooks directory");
  const hookPath = path.join(dir, "pre-push");
  assert.equal(res.hookPath, hookPath);
  assert.ok(fs.existsSync(hookPath));
  assert.equal(fs.readFileSync(hookPath, "utf-8"), hookScript());

  // Idempotent — running it again is not an error, and says so.
  const again = installHook(root);
  assert.equal(again.action, "unchanged");
});

test("install: refuses to clobber a hook it did not write, unless forced", () => {
  const root = gitRepo();
  const hookPath = path.join(hooksDir(root) as string, "pre-push");
  const foreign = "#!/bin/sh\necho 'the project's own hook'\n";
  fs.writeFileSync(hookPath, foreign, "utf-8");

  const refused = installHook(root);
  assert.equal(refused.ok, false);
  assert.equal(refused.action, "refused");
  // The point is not the refusal, it is that the file is untouched: losing
  // someone's lint hook is discovered weeks later, if at all.
  assert.equal(fs.readFileSync(hookPath, "utf-8"), foreign);

  const forced = installHook(root, true);
  assert.equal(forced.ok, true);
  assert.equal(fs.readFileSync(hookPath, "utf-8"), hookScript());
});

test("uninstall: removes only its own hook", () => {
  const root = gitRepo();
  assert.equal(uninstallHook(root).action, "absent");

  installHook(root);
  const removed = uninstallHook(root);
  assert.equal(removed.ok, true);
  assert.equal(removed.action, "removed");
  assert.equal(fs.existsSync(path.join(hooksDir(root) as string, "pre-push")), false);

  // A foreign hook survives an uninstall the same way it survives an install.
  const hookPath = path.join(hooksDir(root) as string, "pre-push");
  fs.writeFileSync(hookPath, "#!/bin/sh\ntrue\n", "utf-8");
  assert.equal(uninstallHook(root).action, "refused");
  assert.ok(fs.existsSync(hookPath));
});

test("install: follows core.hooksPath, because git ignores .git/hooks once it is set", () => {
  const root = gitRepo();
  spawnSync("git", ["config", "core.hooksPath", ".husky"], { cwd: root });

  const dir = hooksDir(root);
  assert.equal(dir, path.join(root, ".husky"), "installing into .git/hooks would produce a hook git never runs");

  const res = installHook(root);
  assert.equal(res.ok, true, res.message);
  assert.ok(fs.existsSync(path.join(root, ".husky", "pre-push")));
  assert.equal(fs.existsSync(path.join(root, ".git", "hooks", "pre-push")), false);
});

test("install: says so plainly outside a repository", () => {
  const notARepo = track(fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-norepo-")));
  const res = installHook(notARepo);
  assert.equal(res.ok, false);
  assert.match(res.message, /not a git repository/);
});

test("diffNames: a range git can answer, and null when it cannot", () => {
  const root = gitRepo();
  const commit = (file: string) => {
    fs.writeFileSync(path.join(root, file), "x", "utf-8");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", file], {
      cwd: root,
    });
    return spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).stdout.trim();
  };
  const first = commit("a.ts");
  const second = commit("b.ts");

  assert.deepEqual(diffNames(root, first, second), ["b.ts"]);
  // An unresolvable base is null, never an empty list — "nothing changed" and
  // "could not tell" must not look the same to the caller.
  assert.equal(diffNames(root, ZERO, second), null);
});

/** Runs the installed hook exactly as git would — through `sh`, with a PATH
 * holding a stub `aztrx-cli`. This is the one test that proves the shim is
 * valid shell that hands off; every other test here would still pass if the
 * script were nonsense. */
test(
  "the installed hook is runnable shell that delegates to the CLI",
  { skip: spawnSync("sh", ["-c", "true"]).status === 0 ? false : "no `sh` on PATH" },
  () => {
    const root = gitRepo();
    installHook(root);
    const hookPath = path.join(hooksDir(root) as string, "pre-push");

    // A stub standing in for a global install. MSYS resolves an extensionless
    // file as executable when it opens with a shebang, which is why this works
    // on Windows as well as POSIX.
    const bin = track(fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-bin-")));
    const record = path.join(bin, "called.txt");
    const stub = path.join(bin, "aztrx-cli");
    fs.writeFileSync(stub, `#!/bin/sh\necho "$@" > ${JSON.stringify(record)}\nexit 0\n`, "utf-8");
    fs.chmodSync(stub, 0o755);

    const res = spawnSync("sh", [hookPath], {
      cwd: root,
      input: "",
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    });

    assert.equal(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
    assert.equal(
      fs.readFileSync(record, "utf-8").trim(),
      "hook run pre-push",
      "the shim must hand off to the CLI with the hook name"
    );
  }
);

/** The other half of the same story, and the one that decides whether people
 * keep the hook installed: when the tool is *not* there, the push must go
 * through. `npx --no-install` exits 1 for a missing package — the very code the
 * CLI uses to mean "crash found" — so this is not a hypothetical. */
test(
  "the hook fails open when aztrx-cli is not installed anywhere",
  { skip: spawnSync("sh", ["-c", "true"]).status === 0 ? false : "no `sh` on PATH" },
  () => {
    const root = gitRepo();
    installHook(root);
    const hookPath = path.join(hooksDir(root) as string, "pre-push");

    // An npx that behaves like the real one on a missing package: exit 1.
    const bin = track(fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-noinstall-")));
    const npx = path.join(bin, "npx");
    fs.writeFileSync(npx, '#!/bin/sh\necho "npm ERR! could not determine executable to run" >&2\nexit 1\n', "utf-8");
    fs.chmodSync(npx, 0o755);

    // PATH is narrowed *inside* sh rather than through spawn's `env`, because
    // on Windows `sh` lives at an MSYS path (`/usr/bin/sh`) that Node can only
    // resolve through the real PATH — narrow it from out here and the spawn
    // itself fails with ENOENT and proves nothing.
    const res = spawnSync("sh", ["-c", `PATH='${bin.replace(/\\/g, "/")}' exec "$0"`, hookPath], {
      cwd: root,
      input: "",
      encoding: "utf-8",
    });

    assert.equal(res.status, 0, `a missing tool blocked the push (exit ${res.status}: ${res.stderr})`);
  }
);
