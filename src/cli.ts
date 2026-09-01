#!/usr/bin/env node
import path from "path";
import * as fs from "fs";
import * as os from "os";
import pc from "picocolors";
import { program } from "commander";
import { opt, formatHelp } from "./cli/help.js";
import { run } from "./core/orchestrator.js";
import type { RunOptions } from "./core/orchestrator.js";
import { EventBus } from "./core/eventBus.js";
import { renderTui } from "./ui/app.js";
import type { Finding } from "./core/types.js";
import { initProject } from "./core/init.js";
import { startStudio } from "./core/studio.js";
import { writePrComment } from "./core/pr.js";
import { writeBadge } from "./core/badge.js";
import { writeRegressionSpecs } from "./core/specCompiler.js";
import { flushTelemetry } from "./core/telemetry/index.js";
import { flushCloud } from "./core/cloud/index.js";
import { summarizeFindings } from "./core/summarize.js";
import { applyVerifiedPatches } from "./core/heal/apply.js";
import { openFixPr } from "./core/fixPr.js";
import { promptYesNo, promptInput } from "./core/prompt.js";
import { modernizeFile } from "./core/modernize.js";

function collect(value: string, prev: string[]): string[] {
  prev.push(value);
  return prev;
}

/** Auto-size the swarm to the machine's CPU cores, capped so we never oversubscribe. */
function autoWorkers(): number {
  const n = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(n, 8));
}

/** Auto-detect the running dev server URL: `aztrx.config.ts`, the dev script's
 * `--port`, then a probe of common ports. Returns null when nothing responds. */
async function detectUrl(repoRoot: string): Promise<string | undefined> {
  const configPath = path.join(repoRoot, "aztrx.config.ts");
  if (fs.existsSync(configPath)) {
    const m = fs.readFileSync(configPath, "utf-8").match(/url\s*[=:]\s*["']([^"']+)["']/);
    if (m) return m[1];
  }

  const pkgPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const dev = pkg.scripts?.dev || pkg.scripts?.start || "";
    const pm = dev.match(/(?:--port|-p)\s*[= ]?\s*(\d+)/);
    if (pm) return `http://localhost:${pm[1]}`;
  }

  for (const port of [3000, 5173, 8080, 3001, 4000, 8000]) {
    try {
      const res = await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(300) });
      if (res.status < 500) return `http://localhost:${port}`;
    } catch {
      // not listening — try the next port
    }
  }
  return undefined;
}

/** Print one low-key "next flag" hint after a run, so users learn the advanced
 * flags on demand instead of memorizing the whole surface. Fires only in the
 * plain-log path when there's a finding worth acting on. */
function suggestNext(
  findings: Finding[],
  opts: {
    repro?: boolean;
    heal?: boolean;
    fix?: boolean;
    magicFix?: boolean;
    httpFuzz?: boolean;
    dryRun?: boolean;
    crashTest?: boolean;
  },
): void {
  if (opts.dryRun || opts.crashTest || findings.length === 0) return;

  const crashOrError = findings.some((f) => f.severity === "crash" || f.severity === "error");
  const alreadyFixing = opts.heal || opts.fix || opts.magicFix;
  if (crashOrError && !alreadyFixing) {
    if (opts.repro) {
      console.log(pc.dim("Tip: run with --fix to attempt a closed-loop fix"));
    } else {
      console.log(pc.dim("Tip: run with --repro to prove these with a runnable spec, or --fix to fix them end-to-end"));
    }
    return;
  }

  const serverError = findings.some((f) => f.type === "network_5xx");
  if (serverError && !opts.httpFuzz) {
    console.log(pc.dim("Tip: run with --http-fuzz to map the server-side attack surface"));
  }
}

interface CliOptions {
  maxActions: string;
  dryRun?: boolean;
  crashTest?: boolean;
  failOn?: boolean;
  fuzz?: boolean;
  httpFuzz?: boolean;
  httpFuzzMutations?: boolean;
  seed: string;
  workers?: string;
  swarm?: boolean;
  repro?: boolean;
  reproRuns: string;
  allowHost?: string[];
  plain?: boolean;
  ui?: boolean;
  repo?: string;
  heal?: boolean;
  healModel?: string;
  healFastModel?: string;
  testCommand?: string;
  test?: boolean;
  testTimeoutMs?: string;
  startCommand?: string;
  prComment?: string | boolean;
  badge?: string | boolean;
  regressionTest?: string | boolean;
  telemetry?: boolean;
  shareData?: boolean;
  upload?: boolean;
  apiKey?: string;
  cloudUrl?: string;
  storageState?: string;
  auth?: string;
  login?: boolean;
  loginEmail?: string;
  loginPassword?: string;
  loginUrl?: string;
  fix?: boolean;
  magicFix?: boolean;
  explain?: boolean;
  pr?: boolean;
  yes?: boolean;
  lang?: string;
}

program
  .name("aztrx-cli")
  .description("Runtime stress-testing for web apps — detect bugs, prove them with a repro")
  .option("--repo <path>", "project root to inspect/watch (default: cwd)", process.cwd());

program
  .command("init")
  .description("scaffold aztrx.config.ts and seed .aztrx/ into .gitignore")
  .option("--url <url>", "dev server URL (default: auto-detect port)")
  .option("--framework <name>", "framework override (auto-detected if omitted)")
  .action(async (opts: { url?: string; framework?: string }) => {
    const res = await initProject({
      repoRoot: path.resolve(program.opts().repo as string),
      url: opts.url,
      framework: opts.framework,
    });
    console.log(pc.green("✓") + ` aztrx.config.ts written (${pc.bold(res.framework)}, ${res.url})`);
    if (res.gitignoreUpdated) console.log(pc.green("✓") + " .aztrx/ added to .gitignore");
    console.log("");
    console.log(pc.dim(`Next:  npx aztrx-cli run ${res.url} --repo .`));
  });

program
  .command("studio")
  .description("start the live studio dashboard on localhost:7331")
  .option("--port <n>", "port to listen on", "7331")
  .action((opts: { port: string }) => {
    startStudio({ repoRoot: path.resolve(program.opts().repo as string), port: parseInt(opts.port, 10) });
  });

program
  .command("modernize")
  .description("rewrite a legacy JS/TS file into modern idiomatic syntax (LLM)")
  .argument("<file>", "path to the file to modernize")
  .option("-y, --yes", "apply without prompting")
  .action(async (file: string, opts: { yes?: boolean }) => {
    const repoRoot = path.resolve(program.opts().repo as string);
    const rel = path.relative(repoRoot, path.resolve(file));
    const res = await modernizeFile(repoRoot, file);
    if (!res.ok) {
      console.error(pc.red("modernize failed:") + ` ${res.error}`);
      process.exit(1);
    }
    for (const c of res.changes) console.log(pc.green("  ✓") + ` ${c}`);
    const doApply = await promptYesNo(`Apply modernized version to ${rel}? (y/N)`, { yes: opts.yes });
    if (doApply) {
      fs.writeFileSync(path.resolve(file), res.modernized as string, "utf-8");
      console.log(pc.dim(`  Applied → review with: git diff ${rel}`));
    } else {
      console.log(pc.dim("  Not applied."));
    }
  });

program
  .command("run", { isDefault: true })
  .description("inspect a running app and prove its bugs with an executable repro")
  .argument("[url]", "dev server to inspect (auto-detected if omitted), e.g. http://localhost:3000")
  .configureHelp({ formatHelp })
  .addOption(opt("--repo <path>", "project root to inspect/watch (default: cwd)", "advanced"))
  .addOption(opt("--max-actions <n>", "max actions per pass", "advanced").default("100"))
  .addOption(opt("--dry-run", "report what would be clicked without clicking", "detect"))
  .addOption(opt("--crash-test", "throw a deliberate error to verify capture", "advanced"))
  .addOption(opt("--fail-on", "exit 1 if any crash/error finding is present", "ship"))
  .addOption(opt("--fuzz", "chaos fuzzing instead of the deterministic walk (F5)", "detect"))
  .addOption(opt("--http-fuzz", "HTTP-layer mutation fuzzing — hostile requests against the target origin (F5-http)", "detect"))
  .addOption(opt("--http-fuzz-mutations", "with --http-fuzz: also send POST/PUT body mutations (default: GET-only)", "advanced"))
  .addOption(opt("--seed <n>", "RNG seed for fuzz", "advanced").default("42"))
  .addOption(opt("--workers <n>", "number of parallel detection workers (default 1)", "detect"))
  .addOption(opt("--swarm", "auto-size the swarm to the machine's CPU cores (alias: --workers auto)").hideHelp())
  .addOption(opt("--repro", "minimize + compile + validate each finding (F7-F9)", "prove"))
  .addOption(opt("--repro-runs <n>", "replay iterations for the flake-rate gate", "advanced").default("3"))
  .addOption(opt("--fix", "find → explain → heal → apply: one-command fix", "fix"))
  .addOption(opt("--heal", "closed-loop healing for crash/error findings (implies --repro)", "fix"))
  .addOption(opt("--magic-fix", "alias for --fix (deprecated)").hideHelp())
  .addOption(opt("--heal-model <model>", "LLM model for healing (default: claude-sonnet-5 or $AZTRX_MODEL)", "advanced"))
  .addOption(opt("--heal-fast-model <model>", "fast/cheap first tier (default: claude-haiku-4-5 or $AZTRX_FAST_MODEL)", "advanced"))
  .addOption(opt("--test-command <cmd>", "test command run against a healed patch (default: npm test, auto-detected)", "advanced"))
  .addOption(opt("--test-timeout <ms>", "timeout for the heal test gate, ms", "advanced").default("300000"))
  .addOption(opt("--no-test", "skip the test gate during healing", "advanced"))
  .addOption(opt("--start-command <cmd>", "command to boot the app for server healing (default: auto-detect scripts.dev/scripts.start)", "advanced"))
  .addOption(opt("--explain", "print a human-language summary of the findings (no healing)", "fix"))
  .addOption(opt("-y, --yes", "auto-apply verified fixes without prompting (with --fix)", "fix"))
  .addOption(opt("--pr", "open a PR with the verified fixes (with --fix)", "fix"))
  .addOption(opt("--lang <en|ru>", "language for the human-language summary", "advanced").default("en"))
  .addOption(opt("--pr-comment [path]", "write a GitHub PR markdown comment (default .aztrx/pr-comment.md)", "ship"))
  .addOption(opt("--badge [path]", "write a self-contained SVG badge (default .aztrx/badge.svg)", "ship"))
  .addOption(opt("--regression-test [dir]", "copy validated repro specs into the project test dir (default: e2e/ or tests/)", "ship"))
  .addOption(opt("--telemetry", "opt-in: collect anonymized crash→repro→patch tuples locally (.aztrx/telemetry)", "advanced"))
  .addOption(opt("--share-data", "opt-in: also upload the sanitized tuples to the telemetry endpoint", "advanced"))
  .addOption(opt("--upload", "opt-in: stream run results to the Aztrx AI cloud dashboard (needs --api-key)", "advanced"))
  .addOption(opt("--api-key <key>", "API key for --upload / --share-data (defaults to $AZTRX_API_KEY)", "advanced"))
  .addOption(opt("--cloud-url <url>", "override the cloud ingest base URL (default https://api.aztrx.app)", "advanced"))
  .addOption(opt("--allow-host <host>", "add a host to the network allow-list (repeatable)", "advanced").argParser(collect).default([]))
  .addOption(opt("--storage-state <path>", "path to a Playwright storage-state JSON (cookies/localStorage) for authenticated pages", "auth"))
  .addOption(opt("--auth <path>", "alias for --storage-state").hideHelp())
  .addOption(opt("--login", "auto-login before the pass (needs AZTRX_AUTH_EMAIL/AZTRX_AUTH_PASSWORD env)", "auth"))
  .addOption(opt("--login-email <email>", "email for --login (default: $AZTRX_AUTH_EMAIL)").hideHelp())
  .addOption(opt("--login-password <pass>", "password for --login (default: $AZTRX_AUTH_PASSWORD)").hideHelp())
  .addOption(opt("--login-url <url>", "explicit login page URL for --login (default: current page)").hideHelp())
  .addOption(opt("--plain", "disable the live terminal UI, print plain logs (default when piped)", "advanced"))
  .addOption(opt("--ui", "force the live terminal UI even when stdout is not a TTY", "advanced"))
  .action(
    async (
      url: string | undefined,
      opts: CliOptions
    ) => {
      // `--fix` is the memorable verb; `--magic-fix` is a hidden alias.
      const magicFix = opts.magicFix || opts.fix;
      const repoRoot = path.resolve(opts.repo ?? (program.opts().repo as string));
      // Auto-detect the target when no URL is given — one less thing to type.
      let targetUrl = url;
      if (!targetUrl) {
        targetUrl = await detectUrl(repoRoot);
        if (!targetUrl) {
          console.error(pc.red("No URL given and none auto-detected. Pass <url>, or run `aztrx-cli init` first."));
          process.exit(1);
        }
        console.log(pc.dim(`Auto-detected ${targetUrl}`));
      }
      const workers = opts.workers ? parseInt(opts.workers, 10) : opts.swarm ? autoWorkers() : undefined;
      const mode =
        (workers ?? 1) > 1 || opts.httpFuzz
          ? `swarm (${workers ?? 1} worker${(workers ?? 1) === 1 ? "" : "s"})`
          : opts.fuzz
            ? `fuzz (seed ${opts.seed})`
            : opts.heal
              ? "repro → heal"
              : opts.repro
                ? "repro"
                : "deterministic walk";

      // Interactive login: if --login was passed without credentials, ask for them
      // so the user never has to remember the AZTRX_AUTH_* env vars.
      let loginEmail = opts.loginEmail ?? process.env.AZTRX_AUTH_EMAIL;
      let loginPassword = opts.loginPassword ?? process.env.AZTRX_AUTH_PASSWORD;
      if (opts.login && !loginEmail && !loginPassword) {
        loginEmail = await promptInput("Email:");
        loginPassword = await promptInput("Password:");
      }

      const runOpts: RunOptions = {
        url: targetUrl,
        repoRoot,
        maxActions: parseInt(opts.maxActions, 10),
        dryRun: opts.dryRun,
        crashTest: opts.crashTest,
        fuzz: opts.fuzz,
        httpFuzz: opts.httpFuzz,
        httpFuzzMutations: opts.httpFuzzMutations,
        repro: opts.repro || opts.heal || magicFix,
        seed: parseInt(opts.seed, 10),
        workers,
        allowHosts: opts.allowHost ?? [],
        reproRuns: parseInt(opts.reproRuns, 10),
        heal: opts.heal || magicFix,
        healModel: opts.healModel,
        healFastModel: opts.healFastModel,
        testCommand: opts.testCommand,
        testTimeoutMs: opts.testTimeoutMs ? parseInt(opts.testTimeoutMs, 10) : undefined,
        skipTest: opts.test === false,
        startCommand: opts.startCommand,
        telemetry: opts.telemetry,
        shareData: opts.shareData,
        upload: opts.upload,
        apiKey: opts.apiKey,
        cloudUrl: opts.cloudUrl,
        storageState: opts.storageState ?? opts.auth,
        login: opts.login,
        loginEmail,
        loginPassword,
        loginUrl: opts.loginUrl,
      };
      const failOn = Boolean(opts.failOn);
      const useUi = !opts.plain && (process.stdout.isTTY === true || opts.ui === true);

      let findings: Finding[] = [];
      if (useUi) {
        const bus = new EventBus();
        const runPromise = run({ ...runOpts, bus, ui: true });
        await renderTui({
          bus,
          done: runPromise,
          targetUrl,
          repoRoot,
          mode,
        });
        try {
          findings = await runPromise;
        } catch (e) {
          console.error(pc.red("Aztrx AI run failed:"), (e as Error).message);
          process.exit(1);
        }
      } else {
        findings = await run(runOpts);
      }

      if (opts.prComment) {
        const prPath =
          typeof opts.prComment === "string"
            ? opts.prComment
            : path.join(repoRoot, ".aztrx", "pr-comment.md");
        writePrComment(repoRoot, targetUrl, findings, prPath);
        console.log(pc.dim(`PR comment: ${path.relative(repoRoot, prPath)}`));
      }

      if (opts.badge) {
        const badgePath =
          typeof opts.badge === "string"
            ? opts.badge
            : path.join(repoRoot, ".aztrx", "badge.svg");
        writeBadge(repoRoot, findings, badgePath);
        console.log(pc.dim(`Badge: ${path.relative(repoRoot, badgePath)}`));
      }

      if (opts.regressionTest) {
        const regDir = typeof opts.regressionTest === "string" ? opts.regressionTest : undefined;
        const written = writeRegressionSpecs(repoRoot, findings, regDir);
        for (const w of written) {
          console.log(pc.green("  ✓ regression test") + ` ${path.relative(repoRoot, w)}`);
        }
      }

      // F13 — human-language summary + opt-in apply (the "Senior Rescuer" flow).
      // The run already printed its structured output; this layer explains it and,
      // under `--fix`, offers to apply the verified patches so `git diff`
      // shows the result. Never commits.
      if (magicFix || opts.explain) {
        const summary = await summarizeFindings(findings, { lang: opts.lang });
        console.log("\n" + summary);
      }

      if (magicFix) {
        const healed = findings.filter((f) => f.heal?.status === "healed");
        if (healed.length > 0) {
          const doApply = await promptYesNo(
            `Apply ${healed.length} verified fix${healed.length === 1 ? "" : "es"} to the working tree? (y/N)`,
            { yes: opts.yes }
          );
          if (doApply) {
            const result = applyVerifiedPatches(repoRoot, findings);
            for (const a of result.applied) {
              console.log(pc.green("  ✓ applied") + ` ${a.filePath} (${a.hunkCount} edit${a.hunkCount === 1 ? "" : "s"})`);
            }
            for (const c of result.conflicts) {
              console.log(pc.yellow("  ◐ skipped") + ` ${c.filePath}: ${c.error}`);
            }
            console.log(pc.dim("  Review with: git diff"));
          } else {
            console.log(pc.dim("  Not applied — review the .patch files under .aztrx/heal/."));
          }
        }
      }

      if (opts.pr) {
        const prRes = await openFixPr(repoRoot, findings, targetUrl);
        if (prRes.ok) {
          console.log(pc.green("  ✓ PR opened") + ` ${prRes.url}`);
        } else {
          console.log(pc.yellow("  ◐ PR skipped") + `: ${prRes.error}`);
        }
      }

      // Suggest the next flag (e.g. --fix) after the run, in both the live TUI
      // and plain paths. In the TUI this prints after the panel has finished.
      suggestNext(findings, opts);

      // Drain any in-flight telemetry uploads (each bounded) before exit, so a
      // pending `--share-data` dispatch isn't killed mid-flight. Never affects
      // the exit code.
      await flushTelemetry();
      await flushCloud();

      if (failOn && findings.some((f) => f.severity === "crash" || f.severity === "error")) {
        process.exit(1);
      }
      process.exit(0);
    }
  );

program.parseAsync();
