/**
 * The scan child that every dev-server plugin (`aztrx-cli/vite`,
 * `aztrx-cli/next`) runs.
 *
 * The scan is a **child process**, not an in-process call. That is the whole
 * point of the design: a scanner that crashes, hangs, or leaves a browser behind
 * must never be able to take the user's dev server down with it. The child speaks
 * `--json` (exactly one document on stdout), so the parent only parses a result.
 *
 * The plugins are deliberately quiet — one line when the scan finishes, nothing
 * while it runs. The dev server owns the terminal; Aztrx is a guest in it.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";
import { killTreeSync } from "../core/heal/boot.js";
import type { Finding } from "../core/types.js";

/** The JSON envelope `aztrx-cli --json` prints — see the `if (json)` block in
 * `src/cli.ts`, which serializes `findings` straight from the run.
 *
 * `findings` is the CLI's own `Finding`, not a restatement of it. An earlier
 * hand-written copy of the shape guessed `mappedLocation.file` where the real
 * field is `filePath`, and because the tests were written against the same
 * guess they passed while the plugin printed `first: undefined:18` for every
 * real crash. Borrowing the type makes that class of drift a compile error. */
export interface AztrxResult {
  version: number;
  url: string;
  repoRoot: string;
  counts: { crash: number; error: number; warning: number };
  findings: Finding[];
}

export interface ScanOptions {
  /** The dev server to attack. Omitted only with `boot: true`, where the child
   * works out (and starts) a server itself. */
  url?: string;
  /** Repo root for sourcemap resolution and `.aztrx/` artifacts. */
  repoRoot: string;
  /** Let the child find a dev server, or start the project's own and stop it
   * again. Default `false`: the dev-server plugins run *because* a server is
   * already up, and a second one would be a bug. The git hook passes `true`
   * because during a push there usually is not one — and the booted server is
   * then owned by the child, which already tears down correctly on every exit
   * path including a parent's death. */
  boot?: boolean;
  /** Max interactions per pass (the CLI's `--max-actions`). */
  maxActions?: number;
  /** Seeded chaos fuzzing instead of the deterministic walk. */
  fuzz?: boolean;
  /** Also fuzz the server's HTTP endpoints. Off by default: it mutates. */
  httpFuzz?: boolean;
  /** Extra CLI flags, for anything not surfaced above. */
  args?: string[];
  /** Replaces the default one-line report — e.g. to wire findings into your own
   * tooling. */
  onResult?: (result: AztrxResult) => void;
  /** Called when the scan itself fails. Never throws into the dev server. */
  onError?: (message: string) => void;
}

export interface ScanHandle {
  /** Kill the scan and everything below it. Idempotent, synchronous (it is also
   * called from `process.on("exit")`, where only sync work runs), and it
   * suppresses the "no result" error — an interrupted scan has nothing to say. */
  stop: () => void;
  /** Resolves once the child has exited. Never rejects. */
  done: Promise<void>;
}

/** Where the installed package's `cli.js` is, or undefined if we can't find one.
 * Split out so `resolveCliPath` can try several shapes. */
function tryResolveCli(): string | undefined {
  // Anchored on `process.cwd()` — the user's project — and not on
  // `import.meta.url`. Both halves matter:
  //
  //  * cwd, because a bundler will happily pre-evaluate `require.resolve` when
  //    its base is statically known. Turbopack did exactly that to the
  //    `import.meta.url` form and inlined a build-time virtual path
  //    (`…/[project]/node_modules/aztrx-cli/dist/cli.js`) that does not exist on
  //    disk. A base that is only known at runtime cannot be folded.
  //  * not `import.meta.url`, because when this module is bundled its URL is the
  //    *bundle's* — inside `.next/dev/server/` — and anything relative to it
  //    points at build output rather than the installed package.
  const fromCwd = createRequire(path.join(process.cwd(), "index.js"));
  try {
    // `./package.json` is the one subpath the exports map always exposes.
    return path.join(path.dirname(fromCwd.resolve("aztrx-cli/package.json")), "dist", "cli.js");
  } catch {
    // No `require.resolve` fallback: under a bundler it is the thing that lies.
    return undefined;
  }
}

/** Every layout the CLI plausibly lives in, most likely first. Exported for
 * tests — everything below is I/O. */
export function cliCandidates(repoRoot: string): string[] {
  const resolved = tryResolveCli();
  const candidates = [
    resolved,
    // npm's normal shape, read straight off the filesystem. Redundant when
    // `require.resolve` worked; the whole point when it did not.
    path.join(repoRoot, "node_modules", "aztrx-cli", "dist", "cli.js"),
    path.join(process.cwd(), "node_modules", "aztrx-cli", "dist", "cli.js"),
    // A checkout that was never installed into anyone's node_modules — which is
    // how this repo's own tests load the plugins.
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js"),
  ];
  return candidates.filter((c): c is string => Boolean(c));
}

/** The first candidate that exists, or undefined. Split from the filesystem so
 * the ordering is testable without a real install to point at. */
export function pickCliPath(
  candidates: string[],
  exists: (p: string) => boolean = fs.existsSync
): string | undefined {
  return candidates.find(exists);
}

/** The first candidate that actually exists on disk. */
export function resolveCliPath(repoRoot: string): string {
  const candidates = cliCandidates(repoRoot);
  // Nothing found: hand back the first guess so the spawn error names a real
  // path the user can look at, rather than a placeholder.
  return pickCliPath(candidates) ?? candidates[0];
}

/** One line, no colour games — it has to read well in the middle of the dev
 * server's own startup output. */
export function summarize(result: AztrxResult): string {
  const { crash, error, warning } = result.counts;
  const total = crash + error + warning;
  if (total === 0) return "[aztrx] clean — no runtime crashes found.";
  const bits = [
    crash && `${crash} crash${crash === 1 ? "" : "es"}`,
    error && `${error} error${error === 1 ? "" : "s"}`,
    warning && `${warning} warning${warning === 1 ? "" : "s"}`,
  ].filter(Boolean);
  const first = result.findings.find((f) => f.severity === "crash" || f.severity === "error");
  // Forward slashes so the line reads the same on Windows as everywhere else.
  const where = first?.mappedLocation
    ? ` — first: ${first.mappedLocation.filePath.replace(/\\/g, "/")}:${first.mappedLocation.line}`
    : "";
  return `[aztrx] ${bits.join(" · ")}${where}\n[aztrx] run \`npx aztrx-cli\` for the repro and the fix.`;
}

/** What went wrong, in one line, so a failed scan says *why*.
 *
 * Not a fixed slice of either end. A Node crash dump opens with
 * `node:internal/modules/cjs/loader:1451 / throw err; / ^` boilerplate and only
 * *then* names the failure; the tail is `at node:internal/main/...` noise. Both
 * a head-slice and a tail-slice report everything except the cause — so find the
 * line that names it. */
function stderrTail(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  const at = lines.findIndex((l) => /(^|\s)\w*Error\b/.test(l));
  return `: ${(at === -1 ? lines.slice(0, 3) : lines.slice(at, at + 2)).join(" ")}`;
}

export function spawnScan(opts: ScanOptions): ScanHandle {
  const args = [
    resolveCliPath(opts.repoRoot),
    ...(opts.url ? [opts.url] : []),
    "--json",
    // Attach to the running server, never boot another — unless the caller said
    // there isn't one (`boot`), which is the git hook during a push.
    ...(opts.boot ? [] : ["--no-boot"]),
    "--repo",
    opts.repoRoot,
    ...(opts.maxActions !== undefined ? ["--max-actions", String(opts.maxActions)] : []),
    ...(opts.fuzz ? ["--fuzz"] : []),
    ...(opts.httpFuzz ? ["--http-fuzz"] : []),
    ...(opts.args ?? []),
  ];

  let stopping = false;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, args, {
      cwd: opts.repoRoot,
      // Same process-group trick as the boot path: POSIX signals the group
      // (node + its Playwright browser), Windows uses taskkill /T.
      detached: process.platform !== "win32",
      // The IPC slot is not for messages — it is a death signal. The OS closes
      // the channel when the parent goes away, *including* when it is SIGKILLed,
      // which no signal handler can catch. See the watcher in `src/cli.ts`.
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
  } catch (e) {
    opts.onError?.((e as Error).message);
    return { stop: () => {}, done: Promise.resolve() };
  }

  const pid = child.pid;
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

  child.on("error", (e: Error) => {
    if (!stopping) opts.onError?.(e.message);
  });

  const done = new Promise<void>((resolve) => {
    child.on("close", () => {
      if (stopping) return resolve();
      let result: AztrxResult;
      try {
        result = JSON.parse(stdout);
      } catch {
        // A failed scan must not look like a clean one — say so instead of
        // staying silent, which is exactly how a real crash gets missed.
        opts.onError?.(`scan did not produce a result${stderrTail(stderr)}`);
        return resolve();
      }
      if (opts.onResult) opts.onResult(result);
      else console.log(summarize(result));
      resolve();
    });
  });

  return {
    stop: () => {
      stopping = true;
      if (pid) killTreeSync(pid);
    },
    done,
  };
}

/** Shared by both plugins: adding the plugin to your config is already the
 * opt-in, and `AZTRX_DEV_SCAN=0` skips a scan for one run without touching it. */
export function scanDisabled(optionsEnabled: boolean | undefined): boolean {
  return optionsEnabled === false || process.env.AZTRX_DEV_SCAN === "0";
}

/** Repo root for sourcemap resolution. The dev server's root is the right
 * default, but a monorepo package root is often deeper than the repo. */
export function resolveRepoRoot(explicit: string | undefined, fallback: string): string {
  return path.resolve(explicit ?? fallback);
}
