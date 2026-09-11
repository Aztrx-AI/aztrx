/**
 * Zero-config target resolution — what bare `aztrx` does when no URL is given.
 *
 * Every primitive already existed (framework detection in `init.ts`, start-command
 * detection and process-tree booting in `heal/boot.ts`); what was missing is the
 * orchestration that turns "I'm standing in a project directory" into a live URL.
 * The order below is the whole design:
 *
 *   1. a dev server already running — declared in `aztrx.config.ts`, named by the
 *      dev script's `--port`, or sitting on the port this project's framework
 *      uses — is *attached* to, never killed, because we did not start it
 *   2. otherwise the project's own dev script is booted and killed on exit
 *   3. otherwise the caller gets `ok: false` and prints the pass-a-URL error
 *
 * Only a project we could not identify at all (no dev script, unknown framework)
 * falls back to sweeping the usual ports for a stranger — attaching to the wrong
 * app would report someone else's crashes as yours.
 *
 * Booting the user's app is a bigger liberty than attaching to one, which is why
 * it is opt-out (`--no-boot`) and why the booted child inherits the real
 * environment: it is their machine and their app, and a stripped env would break
 * anything reading `DATABASE_URL`.
 */

import * as fs from "fs";
import * as path from "path";
import { defaultPort, detectFrameworkMeta } from "./init.js";
import { bootServer, detectStartCommand, isPortFree } from "./heal/boot.js";

/** Ports scanned for an already-running app, most common first. */
const PROBE_PORTS = [3000, 5173, 8080, 3001, 4000, 8000];

/** How long to wait for a detected server to answer HTTP. Generous on purpose:
 * a cold Next.js or Vite server binds its port long before it can serve, and
 * giving up early would boot a *second* server on top of the user's. */
const ATTACH_TIMEOUT_MS = 15_000;

/** Boot can legitimately take a while (dependency scan, cold compile). */
const BOOT_TIMEOUT_MS = 90_000;

function readDevScript(repoRoot: string): string {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8");
    const s = JSON.parse(raw).scripts;
    if (!s) return "";
    if (typeof s.dev === "string") return s.dev;
    if (typeof s.start === "string") return s.start;
  } catch {
    // no package.json, or unparseable — the caller falls through
  }
  return "";
}

/** A port hardcoded in the dev script (`vite --port 4000`). It beats the
 * framework default: the script wins over `PORT`, so booting on anything else
 * would leave us polling a port nothing ever binds. */
export function scriptPort(repoRoot: string): number | undefined {
  const m = readDevScript(repoRoot).match(/(?:--port|-p)\s*[= ]?\s*(\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}

/** The URL from a generated `aztrx.config.ts`. Read as raw text rather than
 * imported — the config is an untrusted TypeScript file, not something to
 * execute just to read one string out of. */
function configUrl(repoRoot: string): string | undefined {
  const configPath = path.join(repoRoot, "aztrx.config.ts");
  if (!fs.existsSync(configPath)) return undefined;
  const m = fs.readFileSync(configPath, "utf-8").match(/url\s*[=:]\s*["']([^"']+)["']/);
  return m ? m[1] : undefined;
}

/** The port a declared URL points at, or null when the host isn't loopback —
 * a remote app's liveness can't be checked with a local connect. */
function loopbackPort(url: string): number | null {
  try {
    const u = new URL(url);
    if (!["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(u.hostname)) return null;
    if (u.port) return parseInt(u.port, 10);
    if (u.protocol === "https:") return 443;
    if (u.protocol === "http:") return 80;
  } catch {
    // not a URL at all — treat it as remote/unprobeable
  }
  return null;
}

/** Poll until the URL answers with any HTTP response (2xx/4xx/5xx all mean the
 * listener is up and serving). */
export async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await res.arrayBuffer().catch(() => {});
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

export interface BootPlan {
  framework: string;
  startCommand: string;
  /** Port to *ask* for. `bootServer` honours it only when it is genuinely free. */
  port: number;
}

/** The pure decision at the heart of zero-config: which framework, which command,
 * which port. Null when the project has no `dev`/`start` script — nothing to boot. */
export function planBoot(repoRoot: string): BootPlan | null {
  const startCommand = detectStartCommand(repoRoot);
  if (!startCommand) return null;
  const { framework } = detectFrameworkMeta(repoRoot);
  return {
    framework,
    startCommand,
    port: scriptPort(repoRoot) ?? defaultPort(framework),
  };
}

/** Find a dev server that is already running, so we can attach instead of booting.
 *
 * Declared URLs come first — they are the user's stated intent — then the port
 * this project's own framework listens on. The port check keys off *a listener
 * existing* rather than off an HTTP response, because a server that has bound
 * its port but is still compiling answers nothing yet.
 *
 * The generic sweep of common ports runs **only when we could not work out what
 * this project is** (`plan === null`). That restriction matters: sweeping always
 * would let a Vite project happily attach to whatever unrelated app happens to
 * be sitting on 3000 and report a stranger's crashes as its own. A known project
 * that is not running should be booted, not confused with its neighbour. */
export async function findRunning(repoRoot: string, plan: BootPlan | null): Promise<string | null> {
  const sp = scriptPort(repoRoot);
  const declared = [configUrl(repoRoot), sp ? `http://localhost:${sp}` : undefined].filter(
    (u): u is string => Boolean(u)
  );

  for (const url of declared) {
    const port = loopbackPort(url);
    // A declared URL whose port has no listener is simply stale. Don't make the
    // user sit out the readiness timeout to learn that — go straight to booting.
    if (port !== null && (await isPortFree(port))) continue;
    if (await waitForHttp(url, ATTACH_TIMEOUT_MS)) return url;
  }

  if (plan) {
    const url = `http://127.0.0.1:${plan.port}`;
    if (!(await isPortFree(plan.port)) && (await waitForHttp(url, ATTACH_TIMEOUT_MS))) return url;
    return null; // not up — the caller boots it
  }

  for (const port of PROBE_PORTS) {
    if (await isPortFree(port)) continue;
    const url = `http://localhost:${port}`;
    if (await waitForHttp(url, ATTACH_TIMEOUT_MS)) return url;
  }
  return null;
}

export type TargetSource = "attached" | "booted";

export interface ResolvedTarget {
  url: string;
  source: TargetSource;
  /** One line for the user explaining how we got here. */
  detail: string;
  /** Idempotent. A no-op when we attached — we never kill a server we didn't start. */
  close: () => Promise<void>;
}

export type TargetResolution = ({ ok: true } & ResolvedTarget) | { ok: false; error: string };

/** Booting means this process now owns a child dev server, so it also owns
 * killing it. `close` is idempotent, so a signal racing the normal exit path is
 * harmless. Only the booted path arms this — an attached server is not ours. */
function armSignalCleanup(close: () => Promise<void>): void {
  const shutdown = (code: number) => {
    void Promise.resolve(close()).finally(() => process.exit(code));
  };
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));
}

/**
 * Turn "no URL was given" into a live target: attach to a running server, or
 * boot one. Never throws — a boot failure comes back as `{ ok: false, error }`
 * carrying the server's own log tail, which is far more useful than a rejection.
 */
export async function resolveTarget(opts: {
  repoRoot: string;
  /** false = attach only, never spawn (`--no-boot`). */
  allowBoot: boolean;
  /** Called just before a server is spawned — booting can take up to a minute,
   * so the user should see why nothing is happening yet. */
  onBoot?: (plan: BootPlan) => void;
}): Promise<TargetResolution> {
  const { repoRoot, allowBoot } = opts;

  const plan = planBoot(repoRoot);

  const running = await findRunning(repoRoot, plan);
  if (running) {
    return {
      ok: true,
      url: running,
      source: "attached",
      detail: `Auto-detected ${running} — attaching (nothing started by Aztrx will be stopped).`,
      close: async () => {},
    };
  }

  if (!allowBoot) {
    const hint = plan
      ? `Start it yourself, or drop --no-boot to have Aztrx boot \`${plan.startCommand}\`.`
      : "Start it yourself, or pass the URL explicitly.";
    return { ok: false, error: `No dev server is running. ${hint}` };
  }

  if (!plan) {
    return {
      ok: false,
      error:
        "No dev server is running and package.json has no `dev` or `start` script to boot. Pass <url>, or run `aztrx-cli init` first.",
    };
  }

  opts.onBoot?.(plan);
  try {
    const server = await bootServer({
      worktreeDir: repoRoot,
      repoRoot,
      startCommand: plan.startCommand,
      timeoutMs: BOOT_TIMEOUT_MS,
      port: plan.port,
      // The user's own app, on the user's own machine — it gets the real env.
      env: "inherit",
    });
    armSignalCleanup(server.close);
    return {
      ok: true,
      url: server.url,
      source: "booted",
      detail: `Up at ${server.url} — it stops when Aztrx exits.`,
      close: server.close,
    };
  } catch (e) {
    return { ok: false, error: `Could not start \`${plan.startCommand}\`: ${(e as Error).message}` };
  }
}
