/**
 * `aztrx watch` — Security Hot-Reload.
 *
 * While the developer writes code and hits Ctrl+S, a micro-swarm wakes up:
 * the saved file's own content is fed to the intent parser (what does this
 * code fear?), a focused swarm runs with the file as the delta-scan scope,
 * and any NEW vulnerability goes straight through heal — the alert prints
 * the business risk and the verified ```diff right in the terminal.
 *
 * One watcher, one debounce (saves burst, the swarm runs once), serialized
 * cycles (a slow audit never overlaps the next one), and a session memory
 * of reported fingerprints so the same bug is not re-shouted on every save.
 */

import * as fs from "fs";
import * as path from "path";
import pc from "picocolors";
import { resolveTarget } from "./devServer.js";
import { parseIntent } from "./intent.js";
import { run } from "./orchestrator.js";
import { heal } from "./heal/index.js";
import type { SpendBudget } from "./heal/types.js";

export interface WatchOptions {
  /** Dev server URL. When omitted, watch finds a running one or boots the
   * project's own — once, and keeps it for the session. */
  url?: string;
  /** The directory to watch (default: cwd). */
  repoRoot: string;
  /** Silence window after the last save before a cycle starts (default 500). */
  debounceMs?: number;
  /** Per-cycle action budget for the micro-swarm (default 30). */
  maxActions?: number;
  /** LLM model override for auto-patching (default: the core's env logic). */
  healModel?: string;
  /** Never boot a dev server — attach only; cycles wait until one runs. */
  noBoot?: boolean;
  /** Shared spend budget for paid LLM generations. */
  budget?: SpendBudget;
  /** Where the human lines go (default: stdout). Injectable for tests. */
  write?: (s: string) => void;
}

const WATCH_EXTENSIONS = /\.(ts|js|tsx|html)$/i;
/** Never watch these — noise, build output, our own artifacts. */
const IGNORED = /(^|[\\/])(node_modules|\.git|dist|\.aztrx)([\\/]|$)/;

/** A quiet cycle skips work instead of burning a crawl. */
const SKIP_MARKERS = /(^|[\\/])(package-lock\.json|yarn\.lock)$/;

export async function watchLoop(opts: WatchOptions): Promise<void> {
  const write = opts.write ?? ((s: string) => console.log(s));
  const repoRoot = path.resolve(opts.repoRoot);
  const debounceMs = opts.debounceMs ?? 500;

  write(pc.cyan("👁️  Aztrx Watcher active. Listening for changes... (Press Ctrl+C to exit)"));
  write(pc.dim(`   watching: ${repoRoot} (${WATCH_EXTENSIONS.source} files)`));

  // Resolve the target once: attach to a running server, or boot the
  // project's own and hold it for the whole session.
  let targetUrl = opts.url;
  let bootedClose: (() => Promise<void>) | undefined;
  if (!targetUrl) {
    const resolved = await resolveTarget({ repoRoot, allowBoot: !opts.noBoot, onBoot: () => {} });
    if (!resolved.ok) {
      write(pc.yellow(`⚠  No dev server reachable (${resolved.error}) — starting the watcher anyway; it will pick up once one runs.`));
    } else {
      targetUrl = resolved.url;
      bootedClose = resolved.close;
      write(pc.dim(`   target: ${targetUrl}`));
    }
  }

  // Session memory: a fingerprint already shouted stays quiet on later saves.
  const reported = new Set<string>();

  // Serialized cycles: one audit at a time; saves during a cycle mark the
  // queue dirty so a single follow-up runs afterwards.
  let dirty = false;
  let running = false;
  let pendingFiles = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  const runCycle = async (files: Set<string>): Promise<void> => {
    if (files.size === 0) return;
    const file = [...files][0]; // the first changed file sets the intent
    const changed = [...files];

    if (!targetUrl) {
      // Retry attaching — the dev server may have come up meanwhile.
      const resolved = await resolveTarget({ repoRoot, allowBoot: false, onBoot: () => {} });
      if (!resolved.ok) {
        write(pc.dim(`[watch] waiting for a dev server (${resolved.error}) — skipping this save`));
        return;
      }
      targetUrl = resolved.url;
      bootedClose = resolved.close;
      write(pc.dim(`[watch] attached to ${targetUrl}`));
    }

    // The saved file's own words become the intent: the parser picks the
    // agents that understand what this code is afraid of.
    let intent: string | undefined;
    try {
      intent = fs.readFileSync(file, "utf-8").slice(0, 8192);
    } catch {
      intent = undefined;
    }
    const plan = parseIntent(intent);
    write(pc.dim(`[watch] ${changed.map((f) => path.relative(repoRoot, f)).join(", ")} saved → ${plan.theme} team (${plan.roles.length} role(s))`));

    try {
      // The orchestrator's own pipeline: swarm (scoped to the saved file) →
      // repro (minimized, validated) → business-risk language. ui:true keeps
      // it silent — the watcher renders its own compact alerts.
      const findings = await run({
        url: targetUrl,
        repoRoot,
        ui: true,
        intent,
        repro: true,
        scopePath: file,
        maxActions: opts.maxActions ?? 30,
      });

      const fresh = findings.filter((f) => !reported.has(f.fingerprint));
      for (const f of fresh) {
        reported.add(f.fingerprint);
        const loc = f.mappedLocation ? ` ${f.mappedLocation.filePath}:${f.mappedLocation.line}` : "";

        write(pc.bold(pc.red("\n⚠️  ОБНАРУЖЕНА УЯЗВИМОСТЬ!")) + pc.dim(loc));
        write(pc.yellow(`   ${f.businessRisk ?? f.rawMessage.split("\n")[0]}`));

        // Auto-patch in real time — the same closed loop as --fix: generate,
        // sandbox, verify. The diff prints here; nothing is applied to the tree.
        const patch = await heal(f, {
          repoRoot,
          url: targetUrl,
          actions: f.repro?.actions ?? f.actionHistory,
          fingerprint: f.fingerprint,
          allowHosts: [new URL(targetUrl).hostname],
          model: opts.healModel,
          budget: opts.budget,
          skipTest: true, // the watcher's proof is the repro replay; the test gate belongs to the reviewed flow
        });

        if (patch.status === "healed" && patch.hunks.length > 0) {
          write(pc.bold(pc.green("   ✅ Авто-патч готов (проверен):")));
          write("```diff");
          write(`--- ${patch.filePath}`);
          for (const h of patch.hunks) {
            for (const l of h.search.split("\n")) write(`-${l}`);
            for (const l of h.replace.split("\n")) write(`+${l}`);
          }
          write("```");
          if (patch.patchPath) write(pc.dim(`   patch: ${path.relative(repoRoot, patch.patchPath)}`));
        } else {
          write(pc.dim(`   patch: ${patch.status}${patch.error ? ` — ${patch.error}` : ""}`));
        }
      }
      if (fresh.length === 0) {
        write(pc.dim(`[watch] clean — nothing new in this save`));
      }
    } catch (e) {
      // One failed cycle must not kill the watcher — the next save retries.
      write(pc.yellow(`[watch] cycle failed: ${(e as Error).message}`));
    }
  };

  const queue = (files: Set<string>): void => {
    for (const f of files) pendingFiles.add(f);
    dirty = true;
    if (running) return; // the running cycle will pick the queue up
    void pump();
  };

  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (dirty) {
        dirty = false;
        const files = pendingFiles;
        pendingFiles = new Set<string>();
        await runCycle(files);
      }
    } finally {
      running = false;
    }
  };

  // The debounce: saves burst on Ctrl+S; the swarm wakes once, 500ms after
  // the last one.
  const schedule = (file: string): void => {
    const next = new Set(pendingFiles);
    next.add(file);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => queue(next), debounceMs);
  };

  const watcher = fs.watch(repoRoot, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const abs = path.join(repoRoot, filename);
    if (IGNORED.test(abs)) return;
    if (SKIP_MARKERS.test(abs)) return;
    if (!WATCH_EXTENSIONS.test(filename)) return;
    if (!fs.existsSync(abs)) return; // deleted file — nothing to audit
    schedule(abs);
  });
  watcher.on("error", (e) => {
    write(pc.yellow(`[watch] fs watcher error: ${e.message}`));
  });

  // Ctrl+C: close the watcher and release a booted dev server.
  const stop = async (): Promise<void> => {
    watcher.close();
    if (timer) clearTimeout(timer);
    if (bootedClose) await bootedClose().catch(() => {});
  };
  process.once("SIGINT", () => {
    void stop().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void stop().then(() => process.exit(0));
  });

  // Keep the process alive — the watcher owns the session.
  await new Promise<void>(() => {});
}
