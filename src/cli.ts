#!/usr/bin/env node
import path from "path";
import pc from "picocolors";
import { program } from "commander";
import { run } from "./core/orchestrator.js";
import type { RunOptions } from "./core/orchestrator.js";
import { EventBus } from "./core/eventBus.js";
import { renderTui } from "./ui/app.js";
import type { Finding } from "./core/types.js";
import { initProject } from "./core/init.js";
import { startStudio } from "./core/studio.js";
import { writePrComment } from "./core/pr.js";
import { writeBadge } from "./core/badge.js";
import { flushTelemetry } from "./core/telemetry/index.js";
import { flushCloud } from "./core/cloud/index.js";
import { summarizeFindings } from "./core/summarize.js";
import { applyVerifiedPatches } from "./core/heal/apply.js";
import { promptYesNo } from "./core/prompt.js";

function collect(value: string, prev: string[]): string[] {
  prev.push(value);
  return prev;
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
  magicFix?: boolean;
  explain?: boolean;
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
  .command("run", { isDefault: true })
  .description("inspect a running app and prove its bugs with an executable repro")
  .argument("<url>", "dev server to inspect, e.g. http://localhost:3000")
  .option("--repo <path>", "project root to inspect/watch (default: cwd)")
  .option("--max-actions <n>", "max actions per pass", "100")
  .option("--dry-run", "report what would be clicked without clicking")
  .option("--crash-test", "throw a deliberate error to verify capture")
  .option("--fail-on", "exit 1 if any crash/error finding is present")
  .option("--fuzz", "chaos fuzzing instead of the deterministic walk (F5)")
  .option("--http-fuzz", "HTTP-layer mutation fuzzing — hostile requests against the target origin (F5-http)")
  .option("--http-fuzz-mutations", "with --http-fuzz: also send POST/PUT body mutations (default: GET-only)")
  .option("--seed <n>", "RNG seed for fuzz", "42")
  .option("--repro", "minimize + compile + validate each finding (F7-F9)")
  .option("--repro-runs <n>", "replay iterations for the flake-rate gate", "3")
  .option("--heal", "closed-loop healing for crash/error findings (implies --repro)")
  .option("--heal-model <model>", "LLM model for healing — the fallback tier (default claude-sonnet-5)")
  .option("--heal-fast-model <model>", "fast/cheap first tier for the smart router (default claude-haiku-4-5)")
  .option("--test-command <cmd>", "test command run against a healed patch (default: npm test, auto-detected)")
  .option("--test-timeout <ms>", "timeout for the heal test gate, ms", "300000")
  .option("--no-test", "skip the test gate during healing")
  .option("--start-command <cmd>", "command to boot the app for server healing (default: auto-detect scripts.dev/scripts.start)")
  .option("--magic-fix", "find → explain → heal → apply: closed-loop fix with a human-language report and an apply prompt")
  .option("--explain", "print a human-language summary of the findings (no healing)")
  .option("-y, --yes", "auto-apply verified fixes without prompting (with --magic-fix)")
  .option("--lang <en|ru>", "language for the human-language summary", "en")
  .option("--pr-comment [path]", "write a GitHub PR markdown comment (default .aztrx/pr-comment.md)")
  .option("--badge [path]", "write a self-contained SVG badge (default .aztrx/badge.svg)")
  .option("--telemetry", "opt-in: collect anonymized crash→repro→patch tuples locally (.aztrx/telemetry)")
  .option("--share-data", "opt-in: also upload the sanitized tuples to the telemetry endpoint")
  .option("--upload", "opt-in: stream run results to the Aztrx AI cloud dashboard (needs --api-key)")
  .option("--api-key <key>", "API key for --upload / --share-data (defaults to $AZTRX_API_KEY)")
  .option("--cloud-url <url>", "override the cloud ingest base URL (default https://api.aztrx.app)")
  .option("--allow-host <host>", "add a host to the network allow-list (repeatable)", collect, [])
  .option("--storage-state <path>", "path to a Playwright storage-state JSON (cookies/localStorage) for authenticated pages")
  .option("--auth <path>", "alias for --storage-state")
  .option("--login", "auto-login before the pass (needs --login-email/--login-password or AZTRX_AUTH_* env)")
  .option("--login-email <email>", "email for --login (default: $AZTRX_AUTH_EMAIL)")
  .option("--login-password <pass>", "password for --login (default: $AZTRX_AUTH_PASSWORD)")
  .option("--login-url <url>", "explicit login page URL for --login (default: current page)")
  .option("--plain", "disable the live terminal UI, print plain logs (default when piped)")
  .option("--ui", "force the live terminal UI even when stdout is not a TTY")
  .action(
    async (
      url: string,
      opts: CliOptions
    ) => {
      const repoRoot = path.resolve(opts.repo ?? (program.opts().repo as string));
      const runOpts: RunOptions = {
        url,
        repoRoot,
        maxActions: parseInt(opts.maxActions, 10),
        dryRun: opts.dryRun,
        crashTest: opts.crashTest,
        fuzz: opts.fuzz,
        httpFuzz: opts.httpFuzz,
        httpFuzzMutations: opts.httpFuzzMutations,
        repro: opts.repro || opts.heal || opts.magicFix,
        seed: parseInt(opts.seed, 10),
        allowHosts: opts.allowHost ?? [],
        reproRuns: parseInt(opts.reproRuns, 10),
        heal: opts.heal || opts.magicFix,
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
        loginEmail: opts.loginEmail ?? process.env.AZTRX_AUTH_EMAIL,
        loginPassword: opts.loginPassword ?? process.env.AZTRX_AUTH_PASSWORD,
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
          targetUrl: url,
          repoRoot,
          mode: opts.fuzz ? `fuzz (seed ${opts.seed})` : opts.httpFuzz ? "http fuzz" : opts.heal ? "repro → heal" : opts.repro ? "repro" : "deterministic walk",
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
        writePrComment(repoRoot, url, findings, prPath);
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

      // F13 — human-language summary + opt-in apply (the "Senior Rescuer" flow).
      // The run already printed its structured output; this layer explains it and,
      // under `--magic-fix`, offers to apply the verified patches so `git diff`
      // shows the result. Never commits.
      if (opts.magicFix || opts.explain) {
        const summary = await summarizeFindings(findings, { lang: opts.lang });
        console.log("\n" + summary);
      }

      if (opts.magicFix) {
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
