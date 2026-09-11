/**
 * Git hook integration — `aztrx-cli hook install | uninstall | run pre-push`.
 *
 * The file that lands in `.git/hooks/` is a short POSIX shim that calls back
 * into the CLI. That split is the design, not a shortcut: a hook carrying its
 * own implementation has to be *reinstalled* to be fixed, and by the time the
 * bug matters the user has already deleted the thing. Here, upgrading
 * `aztrx-cli` upgrades the hook.
 *
 * Everything below is **fail-open**. A missing tool, a shallow clone with no
 * base to diff against, a scan that could not run — none of those are reasons to
 * block someone's push. Only a crash we actually found is. A hook that blocks
 * pushes when it is merely broken gets turned off, and then it catches nothing.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { spawnScan, summarize } from "../plugins/scan.js";
import type { AztrxResult } from "../plugins/scan.js";

/** The line that marks a hook file as ours. Used to decide whether installing
 * is safe (never clobber a hook somebody else wrote) and whether uninstalling
 * would delete something we own. */
export const HOOK_MARKER = "aztrx-cli hook run pre-push";

/** The shim that lands in `.git/hooks/pre-push`.
 *
 * Built as an array of lines joined with `\n` rather than one multi-line
 * template literal, and that is load-bearing: a literal's line breaks are the
 * *source file's* line breaks, so on a checkout with `core.autocrlf=true` this
 * would come out CRLF — and `sh` reads `#!/bin/sh\r` as an interpreter named
 * `/bin/sh\r`, which is not a thing. The hook would fail with "bad
 * interpreter", on Windows only, for reasons invisible in the source. */
export function hookScript(): string {
  return [
    "#!/bin/sh",
    "# aztrx pre-push hook — installed by `aztrx-cli hook install`.",
    "# Remove with `aztrx-cli hook uninstall`; skip one push with `git push --no-verify`.",
    "#",
    "# This file is a shim. The logic lives in the CLI, so `npm i -g aztrx-cli@latest`",
    "# upgrades this hook too. Edits here will be overwritten by a reinstall.",
    "#",
    "# Fail-open on purpose: if aztrx-cli cannot be found the push proceeds. A missing",
    "# tool must never be able to block someone's push.",
    "if command -v aztrx-cli >/dev/null 2>&1; then",
    '  exec aztrx-cli hook run pre-push "$@"',
    "fi",
    "",
    "# Not on PATH — ask npx for the project's own copy. Probe first, then run:",
    "# `npx --no-install` reports 'no such package' and 'the command failed' with the",
    "# same non-zero exit, so `cmd || exit 0` would stay fail-open by also swallowing",
    "# a real crash, and `exit $?` would block a push because the tool is merely",
    "# missing. Neither is acceptable, so find out whether it is there — then run it",
    "# exactly once and let its exit code through untouched.",
    "if npx --no-install aztrx-cli --help >/dev/null 2>&1; then",
    '  exec npx --no-install aztrx-cli hook run pre-push "$@"',
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Reading what the push contains
// ---------------------------------------------------------------------------

export interface PushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

const ZERO = /^0+$/;

/** git hands a pre-push hook one line per ref on stdin:
 * `<local ref> <local sha> <remote ref> <remote sha>`. An all-zero sha means
 * "does not exist on that side". Malformed rows are dropped rather than
 * guessed at — a ref we cannot read is a ref we must not silently skip. */
export function parsePushLines(stdin: string): PushRef[] {
  return stdin
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/))
    .filter((p) => p.length >= 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({
      localRef,
      localSha,
      remoteRef,
      remoteSha,
    }));
}

/** Deleting a remote branch pushes no code. */
export function isBranchDelete(ref: PushRef): boolean {
  return ZERO.test(ref.localSha);
}

/** A branch the remote has never seen. There is no base to diff against, so
 * what is new cannot be known — the conservative answer is "all of it". */
export function isNewBranch(ref: PushRef): boolean {
  return ZERO.test(ref.remoteSha);
}

export interface PushAnalysis {
  /** Files the push touches, relative to the repo root. `null` when that cannot
   * be known — nothing on stdin, a new branch, a base missing from a shallow
   * clone — which means scan. */
  changed: string[] | null;
  /** Refs that actually carry code. Empty means deletions only. */
  liveRefs: PushRef[];
  /** Why `changed` is unknown, phrased for the user. Empty when it is known.
   * Three different situations land on `null`, and one message covering all of
   * them sent me hunting for a shallow clone that was not there — the actual
   * cause was a wrapper script that had drained stdin. */
  blind: string;
}

/** What is this push bringing? Pure but for the injected `diff`, so the branches
 * that are awkward to arrange in a real repo (shallow clone, new branch) are
 * cheap to test. */
export function analyzePush(
  refs: PushRef[],
  diff: (base: string, head: string) => string[] | null
): PushAnalysis {
  // Nothing on stdin: a manual `aztrx-cli hook run pre-push`, or something
  // upstream that swallowed it. Unknown, so scan — which is also the useful
  // thing for someone who typed the command.
  if (refs.length === 0) {
    return { changed: null, liveRefs: [], blind: "git sent no refs on stdin" };
  }

  const liveRefs = refs.filter((r) => !isBranchDelete(r));
  // Deleting branches is a push with no code in it.
  if (liveRefs.length === 0) return { changed: [], liveRefs, blind: "" };

  if (liveRefs.some(isNewBranch)) {
    return { changed: null, liveRefs, blind: "the remote has no such branch yet" };
  }

  const files = new Set<string>();
  for (const ref of liveRefs) {
    const names = diff(ref.remoteSha, ref.localSha);
    // A base git cannot resolve (shallow/partial clone, a ref from another
    // machine) is not a reason to skip — it is a reason to look at everything.
    if (names === null) {
      return {
        changed: null,
        liveRefs,
        blind: `git could not diff ${ref.remoteSha.slice(0, 7)}..${ref.localSha.slice(0, 7)}`,
      };
    }
    for (const n of names) files.add(n);
  }
  return { changed: [...files], liveRefs, blind: "" };
}

/** Paths that cannot change what the app does at runtime. Kept deliberately
 * short and boring: every entry is a file that, if it changed, no browser could
 * have behaved differently. Anything arguable (lockfiles, config, `.mdx`) is
 * absent on purpose — a wrong skip is a missed crash, and the whole point of the
 * hook is not missing crashes.
 *
 * Git always reports forward slashes, on every platform. */
const NON_RUNTIME = [
  /^\.github\//i,
  /^\.vscode\//i,
  /^\.idea\//i,
  /^\.aztrx\//i,
  /^aztrx-media\//i,
  /^LICENSE/i,
  /^\.git(ignore|attributes|modules)$/i,
  /^\.editorconfig$/i,
  /^\.npmrc$/i,
  /\.md$/i,
  /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?)$/i,
];

/** Could this file change the app's runtime behaviour? */
export function isAppCode(file: string): boolean {
  return !NON_RUNTIME.some((re) => re.test(file));
}

export interface PushDecision {
  scan: boolean;
  /** One line for the user explaining the call. */
  reason: string;
}

export function decidePush(analysis: PushAnalysis, always: boolean): PushDecision {
  const { changed, blind } = analysis;
  if (always) return { scan: true, reason: "scanning every push (--always)" };
  if (changed === null) {
    return { scan: true, reason: `${blind} — scanning the whole app` };
  }
  const code = changed.filter(isAppCode);
  if (code.length === 0) {
    const n = changed.length;
    return {
      scan: false,
      reason: n === 0 ? "nothing changed" : `only docs, metadata or assets changed (${n} file${n === 1 ? "" : "s"})`,
    };
  }
  const shown = code.slice(0, 3).join(", ") + (code.length > 3 ? `, +${code.length - 3} more` : "");
  return { scan: true, reason: `${code.length} changed file${code.length === 1 ? "" : "s"}: ${shown}` };
}

// ---------------------------------------------------------------------------
// Talking to git and to the filesystem
// ---------------------------------------------------------------------------

function git(repoRoot: string, args: string[]): { ok: boolean; out: string } {
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf-8" });
  if (res.error || res.status !== 0) return { ok: false, out: "" };
  return { ok: true, out: res.stdout };
}

/** `git rev-parse --git-path hooks` resolves the hooks directory the way git
 * itself will — through `.git` being a file in a worktree, and through
 * `core.hooksPath` (husky sets it). Installing into `.git/hooks` while
 * `core.hooksPath` points somewhere else produces a hook git never runs, which
 * is the worst possible outcome: the user believes they are covered. */
export function hooksDir(repoRoot: string): string | null {
  const res = git(repoRoot, ["rev-parse", "--git-path", "hooks"]);
  if (!res.ok) return null;
  const raw = res.out.trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
}

/** Which files a range touches, or null when git cannot answer. */
export function diffNames(repoRoot: string, base: string, head: string): string[] | null {
  const res = git(repoRoot, ["diff", "--name-only", base, head]);
  if (!res.ok) return null;
  return res.out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    // No stdin to read — a manual run from a terminal. Treated as "unknown",
    // which scans; see `analyzePush`.
    return "";
  }
}

export type HookAction = "installed" | "updated" | "unchanged" | "refused" | "removed" | "absent";

export interface HookResult {
  ok: boolean;
  action: HookAction;
  hookPath?: string;
  message: string;
}

/** Is this file a shim we wrote (as opposed to a hook the project already had)? */
export function isOurs(hookPath: string): boolean {
  try {
    return fs.readFileSync(hookPath, "utf-8").includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

export function installHook(repoRoot: string, force = false): HookResult {
  const dir = hooksDir(repoRoot);
  if (!dir) {
    return { ok: false, action: "refused", message: "not a git repository — nothing to install into." };
  }
  const hookPath = path.join(dir, "pre-push");

  if (fs.existsSync(hookPath) && !isOurs(hookPath) && !force) {
    return {
      ok: false,
      action: "refused",
      hookPath,
      // Overwriting is one thing; overwriting *silently* is how a project loses
      // a hook that ran its linter, and the loss is discovered weeks later.
      message:
        `${path.relative(repoRoot, hookPath).replace(/\\/g, "/")} already exists and was not written by Aztrx.\n` +
        "  Move it aside and re-run, or pass --force to overwrite it.",
    };
  }

  const existed = fs.existsSync(hookPath);
  const previous = existed ? fs.readFileSync(hookPath, "utf-8") : "";
  const script = hookScript();
  if (existed && previous === script) {
    return { ok: true, action: "unchanged", hookPath, message: "already installed and up to date." };
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(hookPath, script, "utf-8");
  try {
    // Windows has no execute bit and git-for-windows runs hooks through its own
    // sh regardless; on POSIX this is what makes the file runnable at all.
    fs.chmodSync(hookPath, 0o755);
  } catch {
    /* a filesystem that cannot do this does not need it */
  }

  return {
    ok: true,
    action: isOurs(hookPath) && existed ? "updated" : "installed",
    hookPath,
    message: existed ? "updated." : "installed.",
  };
}

export function uninstallHook(repoRoot: string): HookResult {
  const dir = hooksDir(repoRoot);
  if (!dir) {
    return { ok: false, action: "refused", message: "not a git repository." };
  }
  const hookPath = path.join(dir, "pre-push");
  if (!fs.existsSync(hookPath)) {
    return { ok: true, action: "absent", hookPath, message: "no pre-push hook to remove." };
  }
  if (!isOurs(hookPath)) {
    return {
      ok: false,
      action: "refused",
      hookPath,
      message: `${path.relative(repoRoot, hookPath).replace(/\\/g, "/")} was not written by Aztrx — leaving it alone.`,
    };
  }
  fs.unlinkSync(hookPath);
  return { ok: true, action: "removed", hookPath, message: "removed." };
}

// ---------------------------------------------------------------------------
// The hook body
// ---------------------------------------------------------------------------

/** Hard ceiling on a single hooked scan. It is a safety net for a dev server
 * that never comes up, not a budget — the CLI has its own timeouts. Past this,
 * the push goes through: an infrastructure hang is not a found crash. */
const DEFAULT_TIMEOUT_MS = 300_000;

export interface PrePushOptions {
  repoRoot: string;
  /** Raw hook stdin. Read from fd 0 when omitted. */
  stdin?: string;
  /** Scan even when nothing app-shaped changed (`--always`). */
  always?: boolean;
  /** Called once, just before the scan starts. The scan itself is silent until
   * it has a result (that is what `--json` means), so without this the push
   * would look hung for the better part of a minute. */
  onProgress?: (message: string) => void;
}

export interface PrePushOutcome {
  /** Exit code for the hook process. Non-zero blocks the push. */
  code: number;
  /** Everything to show the user, in order. */
  lines: string[];
}

const PREFIX = "[aztrx] ";

function raceTimeout(done: Promise<void>, ms: number, onTimeout: () => void): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      onTimeout();
      resolve(false);
    }, ms);
    timer.unref?.();
    void done.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** `aztrx-cli hook run pre-push` — the body of the shim. */
export async function runPrePush(opts: PrePushOptions): Promise<PrePushOutcome> {
  if (process.env.AZTRX_HOOK_SKIP === "1") return { code: 0, lines: [] };

  const refs = parsePushLines(opts.stdin ?? readStdinSync());
  const analysis = analyzePush(refs, (base, head) => diffNames(opts.repoRoot, base, head));
  const decision = decidePush(analysis, Boolean(opts.always));

  if (!decision.scan) {
    return { code: 0, lines: [`${PREFIX}skipped — ${decision.reason}.`] };
  }

  opts.onProgress?.(`${PREFIX}${decision.reason}. Scanning the app…`);

  let result: AztrxResult | undefined;
  let error: string | undefined;
  const handle = spawnScan({
    // No URL and `boot: true`: the child finds the dev server, or starts the
    // project's own and stops it again. It also owns the cleanup, which is why
    // this process can simply exit — see the note on the outcome below.
    repoRoot: opts.repoRoot,
    boot: true,
    onResult: (r) => (result = r),
    onError: (m) => (error = m),
  });

  const timeoutMs = Number(process.env.AZTRX_HOOK_TIMEOUT ?? DEFAULT_TIMEOUT_MS);
  const finished = await raceTimeout(handle.done, Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS, () =>
    handle.stop()
  );

  if (!finished) {
    return {
      code: 0,
      lines: [
        `${PREFIX}the scan did not finish in ${Math.round(timeoutMs / 1000)}s — pushing anyway.`,
        `${PREFIX}raise AZTRX_HOOK_TIMEOUT, or run \`npx aztrx-cli\` yourself to see what it is stuck on.`,
      ],
    };
  }

  if (!result) {
    // Not a clean scan — a scan that never happened. Saying "clean" here would
    // be the one failure mode this tool exists to prevent.
    return {
      code: 0,
      lines: [
        `${PREFIX}could not scan${error ? `: ${error}` : "."}`,
        `${PREFIX}pushing anyway. Run \`npx aztrx-cli\` in this directory to see why.`,
      ],
    };
  }

  const summary = summarize(result);
  const blocking = result.counts.crash + result.counts.error;
  if (blocking === 0) return { code: 0, lines: [summary] };

  return {
    code: 1,
    lines: [
      summary,
      `${PREFIX}push blocked — ${blocking} crash/error finding${blocking === 1 ? "" : "s"} in your app.`,
      `${PREFIX}fix them and push again; to push anyway, \`git push --no-verify\`.`,
    ],
  };
}
