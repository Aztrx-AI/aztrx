/**
 * Next.js dev-server plugin — `aztrx-cli/next`.
 *
 * Next has no `vite.config.ts` to hang a plugin off. What it does have is
 * `instrumentation.ts`, the hook Next added for exactly this kind of
 * instrumentation (Sentry, OpenTelemetry) — it runs once in the server process
 * at startup, in dev and in production alike. So the adapter is a `register()`
 * call, not a config object:
 *
 *     // instrumentation.ts, next to app/ or src/
 *     export async function register() {
 *       if (process.env.NEXT_RUNTIME === "nodejs") {
 *         const { registerAztrx } = await import("aztrx-cli/next");
 *         registerAztrx();
 *       }
 *     }
 *
 * Next 15 `register()` may return a promise that Next awaits *before it starts
 * serving*. That makes the obvious implementation — wait for the server, then
 * scan — a deadlock: the server cannot serve until `register()` returns, and
 * `register()` would be waiting on the server. So `registerAztrx` returns
 * immediately and does its waiting detached. It is deliberately not `async`.
 *
 * The scan itself lives in `src/plugins/scan.ts`, shared with the Vite plugin.
 */

import { planBoot, waitForHttp } from "../core/devServer.js";
import type { ScanHandle } from "../plugins/scan.js";
import { resolveRepoRoot, scanDisabled, spawnScan } from "../plugins/scan.js";
import type { AztrxResult } from "../plugins/scan.js";

export type { AztrxResult } from "../plugins/scan.js";
export { summarize } from "../plugins/scan.js";
// Exposed so a "scan did not produce a result" report can name the path that was
// actually tried — the one fact needed to tell a resolution bug from a scan bug.
export { resolveCliPath } from "../plugins/scan.js";

/** How long to wait for the dev server to answer before giving up. Generous for
 * the same reason as the CLI's attach timeout: Next binds its port well before
 * it can serve, and a cold Turbopack compile is not fast. */
const READY_TIMEOUT_MS = 60_000;

export interface NextPluginOptions {
  /** Run a scan once the dev server is up. Default `true` — creating
   * `instrumentation.ts` is already the opt-in. `AZTRX_DEV_SCAN=0` disables it
   * for a single run without touching the file. */
  enabled?: boolean;
  /** The dev server to attack. Almost never needed: the port is derived from
   * your `next dev` script, falling back to Next's default 3000. Set it (or
   * `AZTRX_URL`) when Next picked a different port because 3000 was taken. */
  url?: string;
  /** Max interactions per pass (the CLI's `--max-actions`). */
  maxActions?: number;
  /** Seeded chaos fuzzing instead of the deterministic walk. */
  fuzz?: boolean;
  /** Also fuzz the server's HTTP endpoints. Off by default: it mutates. */
  httpFuzz?: boolean;
  /** Repo root for sourcemap resolution and `.aztrx/` artifacts. Defaults to
   * the Next project's working directory. */
  repoRoot?: string;
  /** Extra CLI flags, for anything not surfaced above. */
  args?: string[];
  /** How long to wait for the dev server to answer before reporting that it
   * never came up. Raise it for a monorepo whose cold compile outlasts the
   * default. */
  readyTimeoutMs?: number;
  /** Replace the default one-line report — e.g. to wire findings into your own
   * tooling. */
  onResult?: (result: AztrxResult) => void;
  /** Called when the scan itself fails (never throws into the dev server). */
  onError?: (message: string) => void;
}

/** Next may call `register()` more than once (restarts, worker processes); a
 * second scan of the same server is pure waste. Module-scoped because the
 * duplicate arrives in the same process. */
let started = false;

/** The URL to attack: explicit option → `AZTRX_URL` → the port Next itself is
 * listening on → the port this project's `next dev` script asks for.
 *
 * `process.env.PORT` is the good one: Next sets it in the instrumentation
 * process to the port it actually bound, *after* resolving collisions. That is
 * the only source that stays correct when Next auto-increments away from 3000
 * because something else already holds it. Exported for tests — the rest is I/O. */
export function resolveNextUrl(repoRoot: string, explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.AZTRX_URL) return process.env.AZTRX_URL;
  if (process.env.PORT) return `http://localhost:${process.env.PORT}`;
  // planBoot reads the dev script's `--port`/`-p` and otherwise returns Next's
  // default. It returns null only when there is no dev/start script at all —
  // not our problem to guess at that point, so fall back to the default.
  return `http://localhost:${planBoot(repoRoot)?.port ?? 3000}`;
}

/** Wire Aztrx into a Next.js dev server. Call from `instrumentation.ts`.
 * Returns immediately — see the deadlock note at the top of this file. */
export function registerAztrx(options: NextPluginOptions = {}): void {
  // `next build` and `next start` are production; a scan there would drive a
  // browser at a real deployment. Dev only, unconditionally.
  if (process.env.NODE_ENV !== "development") return;
  // `instrumentation.ts` is also bundled for the edge runtime, which has no
  // child_process. The caller's `NEXT_RUNTIME` guard is the documented form;
  // this is the one that holds even when they forget it.
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;
  if (scanDisabled(options.enabled)) return;
  if (started) return;
  started = true;

  const repoRoot = resolveRepoRoot(options.repoRoot, process.cwd());
  const url = resolveNextUrl(repoRoot, options.url);

  /** Killed on the way out, or the browser outlives the server it was driving.
   * `exit` rather than SIGINT/SIGTERM on purpose: this handler lives inside the
   * *user's* server process, and installing signal handlers there would fight
   * whatever Next (and Sentry, and nodemon) already installed. Next's own
   * Ctrl-C path calls `process.exit()`, which fires this. */
  let scan: ScanHandle | undefined;
  process.once("exit", () => scan?.stop());

  const timeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;

  void (async () => {
    if (!(await waitForHttp(url, timeoutMs))) {
      options.onError?.(
        `no dev server answered at ${url} within ${timeoutMs / 1000}s — ` +
          "if Next picked a different port, set AZTRX_URL or the `url` option."
      );
      return;
    }
    scan = spawnScan({
      url,
      repoRoot,
      maxActions: options.maxActions,
      fuzz: options.fuzz,
      httpFuzz: options.httpFuzz,
      args: options.args,
      onResult: options.onResult,
      onError: options.onError,
    });
  })();
}
