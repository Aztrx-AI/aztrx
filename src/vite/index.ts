/**
 * Vite dev-server plugin — `aztrx-cli/vite`.
 *
 * Drop it into `vite.config.ts` and the dev server reports its own runtime
 * crashes while you work, without a second terminal:
 *
 *     import { aztrx } from "aztrx-cli/vite";
 *     export default defineConfig({ plugins: [aztrx()] });
 *
 * The scan itself lives in `src/plugins/scan.ts` — a child process every
 * dev-server plugin shares. This file is only the Vite-shaped adapter: when to
 * start, and what to do when the server goes away.
 */

import type { AztrxResult, ScanHandle } from "../plugins/scan.js";
import { resolveRepoRoot, scanDisabled, spawnScan } from "../plugins/scan.js";

export type { AztrxResult } from "../plugins/scan.js";
export { summarize } from "../plugins/scan.js";
// Exposed so a "scan did not produce a result" report can name the path that was
// actually tried — the one fact needed to tell a resolution bug from a scan bug.
export { resolveCliPath } from "../plugins/scan.js";

/** The slice of Vite's `DevServer` this plugin actually touches, declared
 * structurally so the plugin stays usable across Vite majors (4 → 8) without
 * pinning a peer dependency's types. */
export interface ViteDevServerLike {
  config: { root: string };
  httpServer: {
    once(event: string, cb: () => void): unknown;
    on(event: string, cb: () => void): unknown;
  } | null;
  resolvedUrls?: { local?: string[] } | null;
}

export interface AztrxPluginOptions {
  /** Run a scan when the dev server starts. Default `true` — adding the plugin
   * to your config is already the opt-in. `AZTRX_DEV_SCAN=0` disables it for a
   * single run without touching the config. */
  enabled?: boolean;
  /** Max interactions per pass (the CLI's `--max-actions`). */
  maxActions?: number;
  /** Seeded chaos fuzzing instead of the deterministic walk. */
  fuzz?: boolean;
  /** Also fuzz the server's HTTP endpoints. Off by default: it mutates. */
  httpFuzz?: boolean;
  /** Repo root for sourcemap resolution and `.aztrx/` artifacts. Defaults to
   * Vite's resolved root. */
  repoRoot?: string;
  /** Extra CLI flags, for anything not surfaced above. */
  args?: string[];
  /** Replace the default one-line report — e.g. to wire findings into your own
   * tooling. */
  onResult?: (result: AztrxResult) => void;
  /** Called when the scan itself fails (never throws into Vite). */
  onError?: (message: string) => void;
}

export function aztrx(options: AztrxPluginOptions = {}) {
  return {
    name: "aztrx",
    // A dev-server sentinel — nothing to scan during a production build.
    apply: "serve" as const,

    configureServer(server: ViteDevServerLike): void {
      if (scanDisabled(options.enabled)) return;
      if (!server.httpServer) return;

      let scan: ScanHandle | undefined;

      // Vite calls configureServer before listen(), so this fires once the port
      // is actually bound and `resolvedUrls` is populated — no readiness poll
      // needed here, unlike the Next.js plugin.
      server.httpServer.once("listening", () => {
        const url = server.resolvedUrls?.local?.[0];
        if (!url) {
          options.onError?.("dev server started but Vite reported no local URL");
          return;
        }
        scan = spawnScan({
          url,
          repoRoot: resolveRepoRoot(options.repoRoot, server.config.root),
          maxActions: options.maxActions,
          fuzz: options.fuzz,
          httpFuzz: options.httpFuzz,
          args: options.args,
          onResult: options.onResult,
          onError: options.onError,
        });
      });

      // Ctrl-C on the dev server must take the scan down with it, or a browser
      // is left driving an app that no longer exists.
      server.httpServer.on("close", () => scan?.stop());
    },
  };
}

export default aztrx;
