import path from "path";
import pc from "picocolors";
import { program } from "commander";
import { run } from "./core/orchestrator.js";
import { initProject } from "./core/init.js";
import { startStudio } from "./core/studio.js";

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
  seed: string;
  repro?: boolean;
  reproRuns: string;
  allowHost?: string[];
}

program
  .name("aztrx")
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
    console.log(pc.dim(`Next:  npx aztrx run ${res.url} --repo .`));
  });

program
  .command("studio")
  .description("start the live studio dashboard on localhost:7331")
  .option("--port <n>", "port to listen on", "7331")
  .action((opts: { port: string }) => {
    startStudio({ repoRoot: path.resolve(program.opts().repo as string), port: parseInt(opts.port, 10) });
  });

program
  .argument("<url>", "dev server to inspect, e.g. http://localhost:3000")
  .option("--max-actions <n>", "max actions per pass", "100")
  .option("--dry-run", "report what would be clicked without clicking")
  .option("--crash-test", "throw a deliberate error to verify capture")
  .option("--fail-on", "exit 1 if any crash/error finding is present")
  .option("--fuzz", "chaos fuzzing instead of the deterministic walk (F5)")
  .option("--seed <n>", "RNG seed for fuzz", "42")
  .option("--repro", "minimize + compile + validate each finding (F7-F9)")
  .option("--repro-runs <n>", "replay iterations for the flake-rate gate", "3")
  .option("--allow-host <host>", "add a host to the network allow-list (repeatable)", collect, [])
  .action(
    async (
      url: string,
      opts: CliOptions
    ) => {
      const repoRoot = path.resolve(program.opts().repo as string);
      const findings = await run({
        url,
        repoRoot,
        maxActions: parseInt(opts.maxActions, 10),
        dryRun: opts.dryRun,
        crashTest: opts.crashTest,
        fuzz: opts.fuzz,
        repro: opts.repro,
        seed: parseInt(opts.seed, 10),
        allowHosts: opts.allowHost ?? [],
        reproRuns: parseInt(opts.reproRuns, 10),
      });

      if (opts.failOn && findings.some((f) => f.severity === "crash" || f.severity === "error")) {
        process.exit(1);
      }
      process.exit(0);
    }
  );

program.parseAsync();
