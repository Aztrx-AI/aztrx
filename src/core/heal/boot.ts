/**
 * F10 gate #4 — boot the *patched* app for server-side verification. A server
 * finding (e.g. `HTTP 500 /api/cart`) can't be verified by statically serving
 * the worktree — the 500 only reappears when the route actually runs. So before
 * the replay, this boots the patched server inside the worktree on a free port,
 * waits for an HTTP readiness signal, and returns a `close` hook that tree-kills
 * the process (and its children) so nothing is left holding the port.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { buildChildEnv } from "./childEnv.js";

/** Auto-detect how the app starts, mirroring `runTests`'s `npm test` convention:
 * prefer `scripts.dev` (no build step), then `scripts.start`. Null when neither
 * exists — the caller then requires an explicit `--start-command`. */
export function detectStartCommand(repoRoot: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
    const s = pkg.scripts;
    if (s && typeof s.dev === "string") return "npm run dev";
    if (s && typeof s.start === "string") return "npm run start";
  } catch {
    // no package.json, or unparseable — fall through to null
  }
  return null;
}

/** Allocate a free loopback port. Best-effort: there is a small window between
 * closing the probe and the app binding, so a collision is surfaced as a boot
 * timeout rather than silently mis-directed. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
  });
}

export interface BootedServer {
  url: string;
  close: () => Promise<void>;
  /** Tail of the server's stdout/stderr, for timeout/error reporting. */
  logs: () => string;
}

export async function bootServer(opts: {
  worktreeDir: string;
  repoRoot: string;
  startCommand: string;
  timeoutMs?: number;
}): Promise<BootedServer> {
  const { worktreeDir, repoRoot, startCommand } = opts;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // A fresh worktree has no node_modules — symlink the root's so the booted
  // server resolves its dependencies (the same junction trick sandbox.ts uses).
  const rootNodeModules = path.join(repoRoot, "node_modules");
  const wtNodeModules = path.join(worktreeDir, "node_modules");
  if (!fs.existsSync(wtNodeModules) && fs.existsSync(rootNodeModules)) {
    try {
      fs.symlinkSync(rootNodeModules, wtNodeModules, process.platform === "win32" ? "junction" : "dir");
    } catch {
      /* resolution errors surface in the readiness timeout below */
    }
  }

  const port = await freePort();
  // Support scripts that hardcode a port via `-p {port}`; `PORT` is also set in
  // the environment for the (more common) scripts that read `process.env.PORT`.
  const command = startCommand.replace(/\{port\}/g, String(port));

  // Ring buffer of the last ~40 log lines, so a boot timeout can tell the user
  // *why* the server didn't come up rather than just "timeout".
  const lines: string[] = [];
  const push = (chunk: string | Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line) {
        lines.push(line);
        if (lines.length > 40) lines.shift();
      }
    }
  };

  const child = spawn(command, {
    shell: true,
    cwd: worktreeDir,
    // Minimal allow-list — the booted app is patched PR code; it must not see
    // the caller's ANTHROPIC_API_KEY or other CI secrets.
    env: buildChildEnv({ PORT: String(port), CI: "true" }),
    // On POSIX, detach so the server + its children form their own process
    // group — close() can then signal the whole group. Windows can't do group
    // signaling; it relies on `taskkill /T` below instead.
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed || !child.pid) return;
    closed = true;
    if (process.platform === "win32") {
      // `shell: true` spawns cmd.exe which spawns the real server as a child —
      // a plain child.kill() would orphan that child and leave the port taken.
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
      });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already exited
      }
    }
  };

  // Readiness: poll until the server answers with *any* HTTP response (2xx/4xx/
  // 5xx all mean "the listener is up"). A still-compiling dev server (Next) may
  // take a while on its first request — the loop keeps retrying until it's hot.
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await res.arrayBuffer().catch(() => {});
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (!ready) {
    await close();
    throw new Error(
      `server did not become ready in ${timeoutMs}ms: ${startCommand}\n${lines.join("\n").slice(-2000)}`
    );
  }

  return { url, close, logs: () => lines.join("\n") };
}
