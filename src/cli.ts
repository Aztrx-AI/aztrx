#!/usr/bin/env node
import path from "path";
import * as fs from "fs";
import * as os from "os";
import pc from "picocolors";
import { program } from "commander";
import { opt, formatHelp } from "./cli/help.js";
import { resolveRepoRoot } from "./cli/repo.js";
import type { RunOptions } from "./core/orchestrator.js";
import type { Finding } from "./core/types.js";
import { ROLE_CATALOG } from "./core/roles.js";
import { initProject } from "./core/init.js";
import { VERSION } from "./core/version.js";
import { installHook, runPrePush, uninstallHook } from "./hooks/index.js";

/**
 * Everything else is loaded on demand, and that is not tidiness — it is 3.3
 * seconds off *every* invocation.
 *
 * Measured cold, on this repo: `ui/app.js` (ink) costs 1645ms and
 * `core/orchestrator.js` (Playwright and the whole heal stack) costs 1710ms. As
 * static imports they are paid before the CLI knows what it was asked to do —
 * so `--help`, `init`, and a pre-push hook whose scan is *skipped* all pay for a
 * browser engine they will never use. On the hook that tax was most of the
 * runtime, which is how a hook gets uninstalled.
 *
 * `await import()` caches after the first call, so the commands that do need
 * these pay exactly what they paid before.
 */
async function loadOrchestrator() {
  const m = await import("./core/orchestrator.js");
  return m.run;
}

function collect(value: string, prev: string[]): string[] {
  prev.push(value);
  return prev;
}

/** Auto-size the swarm to the machine's CPU cores, capped so we never oversubscribe. */
function autoWorkers(): number {
  const n = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(n, 8));
}

/** Resolve the target for a run with no explicit URL: attach to a dev server
 * that is already up, or boot the project's own one. Prints progress as it goes
 * (this all happens before the TUI mounts, so plain writes are safe) and exits
 * with a specific reason when neither is possible. */
async function resolveTargetOrExit(
  repoRoot: string,
  noBoot: boolean,
  out: (msg: string) => void = (m) => console.log(m)
): Promise<{ url: string; close: () => Promise<void> }> {
  const { resolveTarget } = await import("./core/devServer.js");
  const res = await resolveTarget({
    repoRoot,
    allowBoot: !noBoot,
    onBoot: (plan) =>
      out(pc.dim(`No dev server running — starting \`${plan.startCommand}\` (${plan.framework})…`)),
  });
  if (!res.ok) {
    console.error(pc.red(res.error));
    process.exit(1);
  }
  out(pc.dim(res.detail));
  return { url: res.url, close: res.close };
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

  const alreadyFixing = opts.heal || opts.fix || opts.magicFix;

  // Server-side 5xx → point at the server fuzzer. `--fix` patches frontend code,
  // so it can't help with a 502/500 from the server.
  const serverError = findings.some((f) => f.type === "network_5xx");
  if (serverError && !opts.httpFuzz) {
    console.log(pc.dim("Tip: these are server-side 5xx — run with --http-fuzz to map the server attack surface"));
    return;
  }

  const crashOrError = findings.some((f) => f.severity === "crash" || f.severity === "error");
  if (crashOrError && !alreadyFixing) {
    if (opts.repro) {
      console.log(pc.dim("Tip: run with --fix to attempt a closed-loop fix"));
    } else {
      console.log(pc.dim("Tip: run with --repro to prove these with a runnable spec, or --fix to fix them end-to-end"));
    }
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
  allowDestructive?: boolean;
  seed: string;
  workers?: string;
  swarm?: boolean;
  roles?: string;
  intent?: string;
  agents?: string;
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
  boot?: boolean;
  json?: boolean;
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
  // Read from the installed package.json, so it can never drift from the
  // published version (see core/version.ts).
  .version(VERSION, "-V, --version", "print the CLI version")
  .option("--repo <path>", "project root to inspect/watch (default: cwd)", process.cwd());

program
  .command("init")
  .description("scaffold aztrx.config.ts and seed .aztrx/ into .gitignore")
  .option("--url <url>", "dev server URL (default: auto-detect port)")
  .option("--framework <name>", "framework override (auto-detected if omitted)")
  .action(async (opts: { url?: string; framework?: string }) => {
    const res = await initProject({
      repoRoot: resolveRepoRoot(program.opts().repo as string),
      url: opts.url,
      framework: opts.framework,
    });
    console.log(pc.green("✓") + ` aztrx.config.ts written (${pc.bold(res.framework)}, ${res.url})`);
    if (res.gitignoreUpdated) console.log(pc.green("✓") + " .aztrx/ added to .gitignore");
    console.log("");
    console.log(pc.dim(`Next:  npx aztrx-cli run ${res.url} --repo .`));
  });

program
  .command("hook")
  .description("install a git hook that scans your app before you push")
  .argument("<action>", "install | uninstall | run")
  .argument("[name]", "hook name (default: pre-push)")
  .option("--force", "overwrite a pre-push hook that Aztrx did not write")
  .option("--always", "with `run`: scan even when no app code changed")
  .action(async (action: string, name: string | undefined, opts: { force?: boolean; always?: boolean }) => {
    const repoRoot = resolveRepoRoot(program.opts().repo as string);
    const hookName = name ?? "pre-push";
    if (hookName !== "pre-push") {
      console.error(pc.red(`unsupported hook: ${hookName}`) + " (only `pre-push` is wired up)");
      process.exit(1);
    }

    if (action === "install" || action === "uninstall") {
      const res = action === "install" ? installHook(repoRoot, opts.force) : uninstallHook(repoRoot);
      if (!res.ok) {
        console.error(pc.red(`✗ ${res.message}`));
        process.exit(1);
      }
      if (res.action === "absent") {
        console.log(pc.dim(res.message));
        return;
      }
      console.log(pc.green("✓") + ` pre-push hook ${res.message}`);
      if (res.hookPath) console.log(pc.dim(`  ${path.relative(repoRoot, res.hookPath).replace(/\\/g, "/")}`));
      if (action === "install") {
        console.log(pc.dim("  Every `git push` now scans the app and blocks on a crash."));
        console.log(pc.dim("  Skip one push with `git push --no-verify`, or a run with AZTRX_HOOK_SKIP=1."));
      }
      return;
    }

    if (action !== "run") {
      console.error(pc.red(`unknown action: ${action}`) + " — expected install, uninstall or run");
      process.exit(1);
    }

    // The hook body. Everything is printed at the end rather than streamed: the
    // scan runs with `--json`, which is silent by contract, so there is nothing
    // to stream until it has an answer.
    const res = await runPrePush({
      repoRoot,
      always: opts.always,
      onProgress: (m) => console.log(pc.dim(m)),
    });
    for (const line of res.lines) console.log(res.code === 0 ? line : pc.red(line));
    process.exit(res.code);
  });

program
  .command("mcp")
  .description("serve aztrx to your editor's agent over MCP (stdio), or wire an editor up to it")
  .argument("[action]", "install | uninstall — omit to serve on stdio")
  .option("--force", "with `install`: replace a config file that will not parse (a .bak is saved first)")
  .action(async (action: string | undefined, opts: { force?: boolean }) => {
    const repoRoot = resolveRepoRoot(program.opts().repo as string);

    // No action means serve, because that is what an editor's config runs and it
    // must be the shortest thing to type. From here stdout is the protocol
    // channel: the server reroutes `console.log` to stderr itself, but anything
    // printed *in this branch* would land before that guard exists.
    if (action === undefined) {
      const { startServer } = await import("./mcp/index.js");
      await startServer({ repoRoot });
      return;
    }

    if (action !== "install" && action !== "uninstall") {
      console.error(
        pc.red(`unknown action: ${action}`) + " — expected install, uninstall, or no action to serve"
      );
      process.exit(1);
    }

    const { installMcp, uninstallMcp } = await import("./mcp/install.js");
    const { VERSION } = await import("./core/version.js");
    const res = action === "install" ? installMcp(repoRoot, VERSION, opts.force) : uninstallMcp(repoRoot);

    let refused = false;
    for (const o of res.outcomes) {
      const line = `${pc.bold(o.target.label)} — ${o.message}`;
      if (o.status === "refused") {
        refused = true;
        console.error(pc.red("✗") + ` ${line}`);
      } else if (o.status === "written") {
        console.log(pc.green("✓") + ` ${line}`);
      } else {
        // skipped and unchanged are both "nothing to do", not failures.
        console.log(pc.dim(`• ${line}`));
      }
    }

    // A refused config is the one outcome the user must act on — it is the only
    // reason to fail the command. A project with no editor we recognise is not an
    // error, it is a project that does not use one.
    if (refused) process.exit(1);

    if (action === "install" && !res.nothingDone) {
      console.log("");
      console.log(pc.dim("  Restart your editor — or reload its window — to pick the server up."));
      console.log(pc.dim("  Scanning and proving a crash need no key. Fixing one does:"));
      console.log(pc.dim("  set ANTHROPIC_API_KEY, or AZTRX_API_BASE + AZTRX_API_KEY + AZTRX_MODEL."));
    }
  });

program
  .command("studio")
  .description("start the live studio dashboard on localhost:7331")
  .option("--port <n>", "port to listen on", "7331")
  .action(async (opts: { port: string }) => {
    const { startStudio } = await import("./core/studio.js");
    startStudio({ repoRoot: resolveRepoRoot(program.opts().repo as string), port: parseInt(opts.port, 10) });
  });

program
  .command("modernize")
  .description("rewrite a legacy JS/TS file into modern idiomatic syntax (LLM)")
  .argument("<file>", "path to the file to modernize")
  .option("-y, --yes", "apply without prompting")
  .action(async (file: string, opts: { yes?: boolean }) => {
    const repoRoot = resolveRepoRoot(program.opts().repo as string);
    const rel = path.relative(repoRoot, path.resolve(file));
    const [{ modernizeFile }, { promptYesNo }] = await Promise.all([
      import("./core/modernize.js"),
      import("./core/prompt.js"),
    ]);
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
  .addOption(opt("--max-actions <n>", "max actions per pass (default: aztrx.config.ts, else 100)", "advanced"))
  .addOption(opt("--dry-run", "report what would be clicked without clicking", "detect"))
  .addOption(opt("--crash-test", "throw a deliberate error to verify capture", "advanced"))
  .addOption(opt("--no-boot", "never start a dev server — only attach to one already running", "detect"))
  .addOption(opt("--fail-on", "exit 1 if any crash/error finding is present", "ship"))
  .addOption(opt("--fuzz", "chaos fuzzing instead of the deterministic walk (F5)", "detect"))
  .addOption(opt("--http-fuzz", "HTTP-layer mutation fuzzing — hostile requests against the target origin (F5-http)", "detect"))
  .addOption(opt("--http-fuzz-mutations", "with --http-fuzz: also send POST/PUT body mutations (default: GET-only)", "advanced"))
  .addOption(opt("--allow-destructive", "opt-in: test destructive controls/endpoints (delete/pay/logout/checkout) — can mutate real data", "advanced"))
  .addOption(opt("--seed <n>", "RNG seed for fuzz", "advanced").default("42"))
  .addOption(opt("--workers <n>", "max concurrent browser contexts (default: min(missions, 8))", "detect"))
  .addOption(opt("--swarm", "analyze the app, synthesize its audience, swarm it with 1000 agents", "detect"))
  .addOption(opt("--roles <ids>", "comma-separated catalog roles to run (e.g. novice,hostile,race-hunter) — skips the analysis", "detect"))
  .addOption(opt("--intent <text>", "what you fear, in your words (\"проверь безопасность оплаты\") — the swarm picks the agents", "detect"))
  .addOption(opt("--agents <n>", "total agent missions (default: 1000 with --swarm, 1 per role with --roles) — missions are tasks, not browsers", "detect"))
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
  .addOption(opt("--regression-test [dir]", "copy validated repro specs into the project test dir (default: first of e2e/, tests/, test/, __tests__/; else .aztrx/regression/)", "ship"))
  .addOption(opt("--telemetry", "opt-in: collect anonymized crash→repro→patch tuples locally (.aztrx/telemetry)", "advanced"))
  .addOption(opt("--share-data", "opt-in: also upload the sanitized tuples to the telemetry endpoint", "advanced"))
  .addOption(opt("--upload", "opt-in: stream run results to the Aztrx AI cloud dashboard (needs --api-key)", "advanced"))
  .addOption(opt("--api-key <key>", "API key for --upload / --share-data (defaults to $AZTRX_CLOUD_API_KEY — a separate key from the model provider's $AZTRX_API_KEY)", "advanced"))
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
  .addOption(opt("--json", "machine-readable result on stdout: one JSON document, nothing else", "advanced"))
  .action(
    async (
      url: string | undefined,
      opts: CliOptions
    ) => {
      // `--fix` is the memorable verb; `--magic-fix` is a hidden alias.
      const magicFix = opts.magicFix || opts.fix;
      const repoRoot = resolveRepoRoot(opts.repo ?? (program.opts().repo as string));
      // Defaults the scaffolded aztrx.config.ts supplies, read here (lazily, like
      // the target resolver) because only this command knows the repo root.
      const { configAllowHosts, configMaxActions } = await import("./core/devServer.js");
      // `--json` is a machine contract: one JSON document on stdout, nothing
      // else. Every human-facing write below is suppressed, and the run itself
      // gets `ui: true` (which already means "emit nothing, the caller renders").
      const json = Boolean(opts.json);
      const out = json ? () => {} : (msg: string) => console.log(msg);
      // No URL given: find the app, or start it. `--no-boot` keeps the old
      // attach-only behaviour for scripts where a surprise child process is
      // unacceptable.
      let booted: (() => Promise<void>) | undefined;
      let targetUrl = url;
      if (!targetUrl) {
        const target = await resolveTargetOrExit(repoRoot, opts.boot === false, out);
        targetUrl = target.url;
        booted = target.close;
      }
      // A booted dev server is a child of this process — releasing it is part of
      // finishing, so every exit path goes through here. The `process.exit`
      // calls below would otherwise skip a `finally` block entirely.
      const finish = async (code: number): Promise<never> => {
        await booted?.().catch(() => {});
        process.exit(code);
      };
      // Spawned by a dev-server plugin (`aztrx-cli/vite`, `aztrx-cli/next`)? The
      // plugins open an IPC channel for exactly this: when the dev server dies,
      // so must the scan — a browser driving an app nobody owns is worse than no
      // scan. `disconnect` is the only reliable signal here, because it also
      // fires when the parent was SIGKILLed, which no signal handler can catch.
      if (process.connected) {
        process.once("disconnect", () => {
          void finish(0);
        });
      }
      const workers = opts.workers ? parseInt(opts.workers, 10) : opts.swarm ? autoWorkers() : undefined;

      // Resolve the swarm roster: `--swarm` analyzes the app and synthesizes
      // its audience (roles are born, not chosen); `--roles a,b` runs exactly
      // those catalog roles and skips the analysis. Explicit roles beat the
      // synthesizer. Unknown ids are a hard error — a typo silently dropping
      // half the swarm would corrupt the run.
      const synthesize = Boolean(opts.swarm && !opts.roles);
      let roleIds: string[] | undefined;
      if (opts.roles) {
        roleIds = opts.roles.split(",").map((s) => s.trim()).filter(Boolean);
        const known = new Set(ROLE_CATALOG.map((r) => r.id));
        const unknown = roleIds.filter((id) => !known.has(id));
        if (unknown.length > 0) {
          console.error(
            pc.red(
              `Unknown role(s): ${unknown.join(", ")}. Known roles: ${ROLE_CATALOG.map((r) => `${r.id} (${r.name})`).join(", ")}`
            )
          );
          process.exit(1);
        }
      }
      const agents = opts.agents ? parseInt(opts.agents, 10) : undefined;

      const mode = opts.intent && !roleIds
        ? `intent audit (${opts.intent.slice(0, 40)})`
        : synthesize
          ? `swarm (synthesized, ${agents ?? 1000} agents)`
        : roleIds
          ? `swarm (${roleIds.length} role${roleIds.length === 1 ? "" : "s"}${agents ? `, ${agents} missions` : ""})`
          : (workers ?? 1) > 1 || opts.httpFuzz
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
        const { promptInput } = await import("./core/prompt.js");
        loginEmail = await promptInput("Email:");
        loginPassword = await promptInput("Password:");
      }

      const runOpts: RunOptions = {
        url: targetUrl,
        repoRoot,
        // Config-file defaults, with the flag winning: `--max-actions` now has no
        // commander default, so an unset flag is distinguishable from a set one.
        maxActions: opts.maxActions
          ? parseInt(opts.maxActions, 10)
          : (configMaxActions(repoRoot) ?? 100),
        dryRun: opts.dryRun,
        crashTest: opts.crashTest,
        fuzz: opts.fuzz,
        httpFuzz: opts.httpFuzz,
        httpFuzzMutations: opts.httpFuzzMutations,
        allowDestructive: opts.allowDestructive,
        lang: opts.lang,
        repro: opts.repro || opts.heal || magicFix,
        seed: parseInt(opts.seed, 10),
        workers,
        roles: roleIds,
        synthesize,
        intent: opts.intent,
        agents,
        allowHosts: [...(opts.allowHost ?? []), ...configAllowHosts(repoRoot)],
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
      const useUi = !json && !opts.plain && (process.stdout.isTTY === true || opts.ui === true);

      let findings: Finding[] = [];
      if (useUi) {
        // ink (1645ms) and Playwright (1710ms) — together, and only here.
        const [{ run }, { EventBus }, { renderTui }] = await Promise.all([
          import("./core/orchestrator.js"),
          import("./core/eventBus.js"),
          import("./ui/app.js"),
        ]);
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
          await finish(1);
        }
      } else {
        // `ui: true` also means "print nothing" — reuse it to silence the
        // orchestrator's own banner and progress lines under --json.
        const run = await loadOrchestrator();
        findings = await run(json ? { ...runOpts, ui: true } : runOpts);
      }

      if (opts.prComment) {
        const prPath =
          typeof opts.prComment === "string"
            ? opts.prComment
            : path.join(repoRoot, ".aztrx", "pr-comment.md");
        const { writePrComment } = await import("./core/pr.js");
        writePrComment(repoRoot, targetUrl, findings, prPath);
        out(pc.dim(`PR comment: ${path.relative(repoRoot, prPath)}`));
      }

      if (opts.badge) {
        const badgePath =
          typeof opts.badge === "string"
            ? opts.badge
            : path.join(repoRoot, ".aztrx", "badge.svg");
        const { writeBadge } = await import("./core/badge.js");
        writeBadge(repoRoot, findings, badgePath);
        out(pc.dim(`Badge: ${path.relative(repoRoot, badgePath)}`));
      }

      if (opts.regressionTest) {
        const regDir = typeof opts.regressionTest === "string" ? opts.regressionTest : undefined;
        const { writeRegressionSpecs } = await import("./core/specCompiler.js");
        const written = writeRegressionSpecs(repoRoot, findings, regDir);
        for (const w of written) {
          out(pc.green("  ✓ regression test") + ` ${path.relative(repoRoot, w)}`);
        }
      }

      // F13 — human-language summary + opt-in apply (the "Senior Rescuer" flow).
      // The run already printed its structured output; this layer explains it and,
      // under `--fix`, offers to apply the verified patches so `git diff`
      // shows the result. Never commits.
      if (magicFix || opts.explain) {
        const [{ summarizeFindings }, { renderMarkdown }] = await Promise.all([
          import("./core/summarize.js"),
          import("./core/renderMarkdown.js"),
        ]);
        const summary = await summarizeFindings(findings, { lang: opts.lang });
        out("\n" + renderMarkdown(summary));
      }

      if (magicFix) {
        const healed = findings.filter((f) => f.heal?.status === "healed");
        if (healed.length > 0) {
          const { promptYesNo } = await import("./core/prompt.js");
          const doApply = await promptYesNo(
            `Apply ${healed.length} verified fix${healed.length === 1 ? "" : "es"} to the working tree? (y/N)`,
            { yes: opts.yes }
          );
          if (doApply) {
            const { applyVerifiedPatches } = await import("./core/heal/apply.js");
            const result = applyVerifiedPatches(repoRoot, findings);
            for (const a of result.applied) {
              out(pc.green("  ✓ applied") + ` ${a.filePath} (${a.hunkCount} edit${a.hunkCount === 1 ? "" : "s"})`);
            }
            for (const c of result.conflicts) {
              out(pc.yellow("  ◐ skipped") + ` ${c.filePath}: ${c.error}`);
            }
            out(pc.dim("  Review with: git diff"));
          } else {
            out(pc.dim("  Not applied — review the .patch files under .aztrx/heal/."));
          }
        }
      }

      if (opts.pr) {
        const { openFixPr } = await import("./core/fixPr.js");
        const prRes = await openFixPr(repoRoot, findings, targetUrl);
        if (prRes.ok) {
          out(pc.green("  ✓ PR opened") + ` ${prRes.url}`);
        } else {
          out(pc.yellow("  ◐ PR skipped") + `: ${prRes.error}`);
        }
      }

      // Suggest the next flag (e.g. --fix) after the run, in both the live TUI
      // and plain paths. In the TUI this prints after the panel has finished.
      if (!json) suggestNext(findings, opts);

      // Drain any in-flight telemetry uploads (each bounded) before exit, so a
      // pending `--share-data` dispatch isn't killed mid-flight. Never affects
      // the exit code.
      const [{ flushTelemetry }, { flushCloud }] = await Promise.all([
        import("./core/telemetry/index.js"),
        import("./core/cloud/index.js"),
      ]);
      await flushTelemetry();
      await flushCloud();

      if (json) {
        process.stdout.write(
          JSON.stringify(
            {
              version: 1,
              url: targetUrl,
              repoRoot,
              counts: {
                crash: findings.filter((f) => f.severity === "crash").length,
                error: findings.filter((f) => f.severity === "error").length,
                warning: findings.filter((f) => f.severity === "warning").length,
              },
              findings,
            },
            null,
            2
          ) + "\n"
        );
      }

      if (failOn && findings.some((f) => f.severity === "crash" || f.severity === "error")) {
        await finish(1);
      }
      await finish(0);
    }
  );

program
  .command("watch")
  .description("security hot-reload: watch the project, micro-swarm every save, alert + auto-patch in real time")
  .argument("[url]", "app to watch (auto-detected if omitted), e.g. http://localhost:3000")
  .configureHelp({ formatHelp })
  .addOption(opt("--repo <path>", "project root to watch (default: cwd)", "advanced"))
  .addOption(opt("--debounce <ms>", "silence window after a save before the swarm wakes", "advanced").default("500"))
  .addOption(opt("--max-actions <n>", "per-cycle action budget of the micro-swarm", "advanced").default("30"))
  .addOption(opt("--heal-model <model>", "LLM model for healing (default: claude-sonnet-5 / AZTRX_MODEL)", "advanced"))
  .addOption(opt("--no-boot", "never start a dev server — only attach to one already running", "detect"))
  .action(
    async (
      url: string | undefined,
      opts: { repo?: string; debounce: string; maxActions: string; healModel?: string; boot?: boolean }
    ) => {
      const repoRoot = resolveRepoRoot(opts.repo ?? (program.opts().repo as string));
      const { watchLoop } = await import("./core/watch.js");
      await watchLoop({
        url,
        repoRoot,
        debounceMs: parseInt(opts.debounce, 10),
        maxActions: parseInt(opts.maxActions, 10),
        healModel: opts.healModel,
        noBoot: opts.boot === false,
      });
    }
  );

program
  .command("audit")
  .description("state-graph audit: the Mapper builds the app's state graph, the swarm attacks from the richest authed state, and the kill chain prints per finding")
  .argument("[url]", "app to audit (auto-detected if omitted), e.g. http://localhost:3000")
  .configureHelp({ formatHelp })
  .addOption(opt("--repo <path>", "project root to inspect (default: cwd)", "advanced"))
  .addOption(opt("--intent <text>", "what you fear, in your words — the swarm picks the agents", "detect"))
  .addOption(opt("--max-actions <n>", "max actions per pass (default: aztrx.config.ts, else 100)", "advanced"))
  .addOption(opt("--fix", "auto-patch reliable findings (heal) and print the verified diffs", "fix"))
  .addOption(opt("--no-test", "skip the test gate during healing (the repro replay still verifies)", "advanced"))
  .addOption(opt("--plain", "disable the live terminal UI, print plain logs", "advanced"))
  .action(
    async (
      url: string | undefined,
      opts: { repo?: string; intent?: string; maxActions?: string; plain?: boolean; fix?: boolean; test?: boolean }
    ) => {
      const repoRoot = resolveRepoRoot(opts.repo ?? (program.opts().repo as string));
      const run = await loadOrchestrator();
      let targetUrl = url;
      let booted: (() => Promise<void>) | undefined;
      if (!targetUrl) {
        const target = await resolveTargetOrExit(repoRoot, false);
        targetUrl = target.url;
        booted = target.close;
      }
      try {
        await run({
          url: targetUrl,
          repoRoot,
          graph: true,
          intent: opts.intent,
          repro: true,
          heal: opts.fix === true,
          skipTest: opts.test === false,
          maxActions: opts.maxActions ? parseInt(opts.maxActions, 10) : undefined,
          ui: opts.plain !== true,
        });
      } finally {
        await booted?.().catch(() => {});
      }
    }
  );

program
  .command("patrol")
  .description("autonomously re-scan the app, fix new bugs, and open a PR per bug")
  .argument("[url]", "app to patrol (auto-detected if omitted), e.g. http://localhost:3000")
  .configureHelp({ formatHelp })
  .addOption(opt("--repo <path>", "project root to inspect/watch (default: cwd)", "advanced"))
  .addOption(opt("--interval <s>", "seconds between scans", "advanced").default("600"))
  .addOption(opt("--max-fixes <n>", "max PRs to open per session", "advanced").default("5"))
  .addOption(opt("--max-spend <n>", "hard cap on paid LLM generations per session", "advanced"))
  .addOption(opt("--retry-after <s>", "cooldown before an unfixed bug is retried", "advanced").default("1800"))
  .addOption(opt("--batch", "group all fixes of a cycle into one PR", "advanced"))
  .addOption(opt("--once", "run a single scan then exit (no loop)", "advanced"))
  .addOption(opt("--max-actions <n>", "max actions per pass (default: aztrx.config.ts, else 100)", "advanced"))
  .addOption(opt("--fuzz", "chaos fuzzing instead of the deterministic walk", "detect"))
  .addOption(opt("--workers <n>", "number of parallel detection workers", "detect"))
  .addOption(opt("--lang <en|ru>", "language for the diagnosis", "advanced").default("en"))
  .addOption(opt("--login", "auto-login before each pass (needs AZTRX_AUTH_EMAIL/AZTRX_AUTH_PASSWORD env)", "auth"))
  .addOption(opt("--login-email <email>", "email for --login (default: $AZTRX_AUTH_EMAIL)").hideHelp())
  .addOption(opt("--login-password <pass>", "password for --login (default: $AZTRX_AUTH_PASSWORD)").hideHelp())
  .addOption(opt("--login-url <url>", "explicit login page URL for --login (default: current page)").hideHelp())
  .addOption(opt("--storage-state <path>", "Playwright storage-state JSON for authenticated pages", "auth"))
  .addOption(opt("--heal-model <model>", "LLM model for healing (default: claude-sonnet-5)", "advanced"))
  .addOption(opt("--test-command <cmd>", "test command run against a healed patch", "advanced"))
  .addOption(opt("--no-test", "skip the test gate during healing", "advanced"))
  .addOption(opt("--start-command <cmd>", "command to boot the app for server healing", "advanced"))
  .addOption(opt("--no-boot", "never start a dev server — only attach to one already running", "detect"))
  .action(
    async (
      url: string | undefined,
      opts: {
        repo?: string;
        interval: string;
        maxFixes: string;
        maxSpend?: string;
        retryAfter: string;
        batch?: boolean;
        once?: boolean;
        maxActions: string;
        fuzz?: boolean;
        workers?: string;
        lang: string;
        login?: boolean;
        loginEmail?: string;
        loginPassword?: string;
        loginUrl?: string;
        storageState?: string;
        healModel?: string;
        testCommand?: string;
        test?: boolean;
        startCommand?: string;
        boot?: boolean;
      }
    ) => {
      const repoRoot = resolveRepoRoot(opts.repo ?? (program.opts().repo as string));
      const { configAllowHosts, configMaxActions } = await import("./core/devServer.js");
      let booted: (() => Promise<void>) | undefined;
      let targetUrl = url;
      if (!targetUrl) {
        const target = await resolveTargetOrExit(repoRoot, opts.boot === false);
        targetUrl = target.url;
        booted = target.close;
      }

      // Resolve credentials the same way `run` does — then refuse if they are
      // incomplete. Patrol is unattended, so it cannot prompt the way `run`
      // does, and `swarm`'s login block needs all three fields and has no else
      // branch: without this, `patrol --login` was accepted and silently did
      // nothing, scanning the logged-out app and opening PRs from those results.
      const loginEmail = opts.loginEmail ?? process.env.AZTRX_AUTH_EMAIL;
      const loginPassword = opts.loginPassword ?? process.env.AZTRX_AUTH_PASSWORD;
      if (opts.login && (!loginEmail || !loginPassword)) {
        console.error(
          "aztrx: --login needs credentials, but none were found.\n" +
            "  Set AZTRX_AUTH_EMAIL and AZTRX_AUTH_PASSWORD, or pass --login-email / --login-password.\n" +
            "  Refusing to run: an unattended patrol that silently scans the logged-out app " +
            "would open pull requests from the wrong pages."
        );
        process.exit(2);
      }

      const { patrol } = await import("./core/patrol/loop.js");
      await patrol({
        url: targetUrl,
        repoRoot,
        intervalMs: parseInt(opts.interval, 10) * 1000,
        maxFixes: parseInt(opts.maxFixes, 10),
        maxSpend: opts.maxSpend ? parseInt(opts.maxSpend, 10) : undefined,
        retryAfterMs: parseInt(opts.retryAfter, 10) * 1000,
        batch: Boolean(opts.batch),
        once: Boolean(opts.once),
        maxActions: opts.maxActions
          ? parseInt(opts.maxActions, 10)
          : (configMaxActions(repoRoot) ?? 100),
        // Patrol exposes no --allow-host, so the config file is the only way to
        // allow a cross-origin API here. Absent either, the allow-list stays
        // deny-by-default at the target's own origin.
        allowHosts: configAllowHosts(repoRoot),
        fuzz: opts.fuzz,
        workers: opts.workers ? parseInt(opts.workers, 10) : undefined,
        lang: opts.lang,
        login: opts.login,
        loginEmail,
        loginPassword,
        loginUrl: opts.loginUrl,
        storageState: opts.storageState,
        healModel: opts.healModel,
        testCommand: opts.testCommand,
        skipTest: opts.test === false,
        startCommand: opts.startCommand,
      });
      await booted?.().catch(() => {});
      process.exit(0);
    }
  );

program.parseAsync();
