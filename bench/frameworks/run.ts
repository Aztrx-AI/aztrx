// Framework benchmark runner: for each real Next.js App Router target, boot a
// `next dev` server, run the Aztrx detector against it, tear the server down, and
// score detection + repro against the app's manifest.json.
//
// Usage (from this dir):
//   npx tsx run.ts            # detect only
//   npx tsx run.ts --repro    # detect + repro
import { spawn, execSync, type ChildProcess } from "child_process";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { run } from "../../dist/core/orchestrator.js";
import type { Finding } from "../../dist/core/types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = join(HERE, ".out");
const NEXT_BIN = join(HERE, "node_modules", "next", "dist", "bin", "next");

const BASE_PORT = 8940;

interface SeededBug {
  id: string;
  severity: "crash" | "error" | "warning";
  type: string;
  /** Substring matched against `Finding.rawMessage`. */
  message: string;
  trigger: string;
}
/** A boundary signal Aztrx must TRIAGE (suppress as noise), not surface. The
 * scorer asserts it does NOT appear in `findings` — if one leaks through, the
 * triage is broken. */
interface SuppressedBug {
  id: string;
  message: string;
  reason: string;
}
interface Manifest {
  id: string;
  name: string;
  archetype: string;
  framework: string;
  seeded: SeededBug[];
  suppressed?: SuppressedBug[];
}

// Findings produced by Next's dev error overlay (not by the app under test) —
// e.g. the "__nextjs_launch-editor" request fired when the overlay tries to
// resolve a source location. These are expected framework dev-tooling noise,
// reported separately rather than as real false positives.
const DEV_NOISE = ["__nextjs_launch-editor"];

const args = process.argv.slice(2);
const arg = (name: string, fallback: number): number => {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) {
    const n = Number(args[i + 1]);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
};
const OPT = {
  repro: args.includes("--repro"),
  seed: arg("--seed", 42),
  maxActions: arg("--max-actions", 80),
  only: args.includes("--only") ? args[args.indexOf("--only") + 1] : null,
};

const isNoise = (msg: string) => DEV_NOISE.some((n) => msg.toLowerCase().includes(n));
const match = (msg: string, needle: string) => msg.toLowerCase().includes(needle.toLowerCase());

function bootDevServer(appDir: string, port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NEXT_BIN, "dev", "-p", String(port)], {
      cwd: appDir,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let out = "";
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) {
        stop(child);
        reject(new Error(`next dev did not become ready within 90s:\n${out.slice(-2000)}`));
      }
    }, 90_000);

    const onData = (buf: Buffer) => {
      out += buf.toString();
      if (!ready && /Ready/.test(out)) {
        ready = true;
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`next dev exited early (code ${code}):\n${out.slice(-2000)}`));
      }
    });
  });
}

function stop(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

async function main() {
  const ids = readdirSync(HERE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name))
    .map((d) => d.name)
    .sort()
    .filter((id) => (OPT.only ? id === OPT.only : true));
  mkdirSync(OUT_DIR, { recursive: true });

  if (!existsSync(NEXT_BIN)) {
    console.error(pc.red("✗ next not found — run `npm install` in bench/frameworks first."));
    process.exit(1);
  }

  const rows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const appDir = join(HERE, id);
    const manifest: Manifest = JSON.parse(readFileSync(join(appDir, "manifest.json"), "utf8"));
    const port = BASE_PORT + i;
    const url = `http://localhost:${port}`;
    console.log(`\n${pc.cyan("▶")} ${manifest.name} ${pc.dim(`(${id})`)}`);

    let child: ChildProcess | null = null;
    try {
      child = await bootDevServer(appDir, port);
    } catch (e) {
      console.log(pc.red(`   ✗ boot failed: ${(e as Error).message.split("\n")[0]}`));
      rows.push({ id, name: manifest.name, archetype: manifest.archetype, bootError: (e as Error).message });
      continue;
    }

    const findings: Finding[] = await run({
      url,
      repoRoot: appDir,
      fuzz: true,
      seed: OPT.seed,
      maxActions: OPT.maxActions,
      repro: OPT.repro,
      ui: true,
    });
    stop(child);

    const found: Array<{ bug: SeededBug; finding: Finding }> = [];
    const missed: SeededBug[] = [];
    const severityMismatches: Array<{ id: string; expected: string; actual: string }> = [];
    for (const bug of manifest.seeded) {
      const f = findings.find((x) => match(x.rawMessage, bug.message));
      if (f) {
        found.push({ bug, finding: f });
        if (f.severity !== bug.severity) {
          severityMismatches.push({ id: bug.id, expected: bug.severity, actual: f.severity });
        }
      } else {
        missed.push(bug);
      }
    }
    const falsePos = findings.filter(
      (f) => !manifest.seeded.some((b) => match(f.rawMessage, b.message)) && !isNoise(f.rawMessage)
    );
    const noise = findings.filter((f) => isNoise(f.rawMessage));
    // Triage assertion: a suppressed signal must NOT surface as a finding.
    const suppressedLeaks = (manifest.suppressed ?? []).filter((s) =>
      findings.some((f) => match(f.rawMessage, s.message))
    );

    const reproVerdicts = found.map(({ finding }) => finding.repro?.verdict).filter((v): v is string => v != null);
    const repro = {
      attempted: reproVerdicts.length,
      deterministic: reproVerdicts.filter((v) => v === "deterministic").length,
      flaky: reproVerdicts.filter((v) => v === "flaky").length,
      unreliable: reproVerdicts.filter((v) => v === "unreliable").length,
    };

    rows.push({
      id,
      name: manifest.name,
      archetype: manifest.archetype,
      seeded: manifest.seeded.length,
      found: found.length,
      missed: missed.map((b) => b.id),
      severityMismatches,
      falsePositives: falsePos.length,
      falsePosMessages: falsePos.map((f) => f.rawMessage.split("\n")[0].slice(0, 100)),
      devNoise: noise.length,
      devNoiseMessages: noise.map((f) => f.rawMessage.split("\n")[0].slice(0, 100)),
      suppressed: (manifest.suppressed ?? []).map((s) => s.id),
      suppressedLeaks: suppressedLeaks.map((s) => s.id),
      repro,
    });

    const ok = missed.length === 0 && suppressedLeaks.length === 0;
    const reproSeg = OPT.repro
      ? `  · repro ${repro.deterministic}/${repro.attempted} deterministic` +
        (repro.flaky ? `, ${repro.flaky} flaky` : "") +
        (repro.unreliable ? `, ${repro.unreliable} unreliable` : "")
      : "";
    console.log(
      `   ${ok ? pc.green("✓") : pc.red("✗")} detected ${found.length}/${manifest.seeded.length}` +
        (suppressedLeaks.length ? pc.red(`  · ${suppressedLeaks.length} triage-leak`) : "") +
        (severityMismatches.length ? pc.yellow(`  · ${severityMismatches.length} severity-mismatch`) : "") +
        (falsePos.length ? pc.yellow(`  · ${falsePos.length} extra`) : "") +
        (noise.length ? pc.dim(`  · ${noise.length} dev-noise`) : "") +
        (OPT.repro ? pc.cyan(reproSeg) : "")
    );
  }

  const seeded = rows.reduce((s, r) => s + (r.seeded as number), 0);
  const found = rows.reduce((s, r) => s + (r.found as number), 0);
  const fp = rows.reduce((s, r) => s + (r.falsePositives as number), 0);
  const noise = rows.reduce((s, r) => s + (r.devNoise as number), 0);
  const rate = seeded ? (found / seeded) * 100 : 0;
  const suppressed = rows.reduce((s, r) => s + ((r.suppressed as string[])?.length ?? 0), 0);
  const leaked = rows.reduce((s, r) => s + ((r.suppressedLeaks as string[])?.length ?? 0), 0);
  const severityBad = rows.reduce((s, r) => s + ((r.severityMismatches as unknown[])?.length ?? 0), 0);
  const reproAttempted = rows.reduce((s, r) => s + ((r.repro as { attempted: number })?.attempted ?? 0), 0);
  const reproDeterministic = rows.reduce((s, r) => s + ((r.repro as { deterministic: number })?.deterministic ?? 0), 0);
  const reproFlaky = rows.reduce((s, r) => s + ((r.repro as { flaky: number })?.flaky ?? 0), 0);
  const reproRate = reproAttempted ? (reproDeterministic / reproAttempted) * 100 : 0;

  writeFileSync(
    join(OUT_DIR, "results.json"),
    JSON.stringify(
      {
        totals: {
          seeded,
          found,
          rate: +rate.toFixed(1),
          falsePositives: fp,
          devNoise: noise,
          triage: { suppressed, leaked, severityMismatches: severityBad },
          repro: { attempted: reproAttempted, deterministic: reproDeterministic, flaky: reproFlaky, rate: +reproRate.toFixed(1) },
        },
        cases: rows,
      },
      null,
      2
    )
  );

  console.log("\n" + "═".repeat(64));
  console.log(pc.bold(`Detection  ${found}/${seeded}  (${rate.toFixed(1)}%)`) + pc.dim(`   ·   ${fp} false positive(s) · ${noise} dev-noise · ${leaked} triage-leak`));
  if (OPT.repro && reproAttempted > 0) {
    console.log(
      pc.bold(`Repro      ${reproDeterministic}/${reproAttempted} deterministic  (${reproRate.toFixed(1)}%)`) +
        pc.dim(`   ·   ${reproFlaky} flaky`)
    );
  }
  console.log("═".repeat(64));
  for (const r of rows) {
    const bad = (r.missed as string[]).length || (r.suppressedLeaks as string[]).length;
    console.log(
      `  ${bad ? pc.red("✗") : pc.green("✓")} ${(r.id as string).padEnd(24)} ${r.found}/${r.seeded}` +
        (r.falsePositives ? pc.yellow(`   +${r.falsePositives} fp`) : "")
    );
    for (const m of r.missed as string[]) console.log(pc.red(`      missed  ${m}`));
    for (const m of r.suppressedLeaks as string[]) console.log(pc.red(`      triage-leak  ${m}`));
    for (const m of r.severityMismatches as Array<{ id: string; expected: string; actual: string }>)
      console.log(pc.yellow(`      severity  ${m.id}: ${m.expected}≠${m.actual}`));
    for (const m of r.falsePosMessages as string[]) console.log(pc.dim(`      extra   ${m}`));
  }
  console.log("");
}

// Exit deterministically: `next dev`'s stdio pipes keep a data listener alive
// even after `taskkill` tears the process tree down, so without an explicit
// exit the runner hangs between apps (the next app's `▶` header never prints).
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(pc.red("benchmark failed:"), e);
    process.exit(1);
  });
