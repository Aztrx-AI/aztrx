/**
 * Chromium launcher with a first-run safety net. Playwright no longer downloads
 * its browser builds on `npm install`, so a fresh `npx aztrx-cli run` would
 * otherwise die on a bare "Executable doesn't exist". This detects that specific
 * failure, installs the Chromium build that matches the bundled Playwright
 * version, and retries once — keeping the zero-setup promise.
 */
import { spawn } from "child_process";
import { createRequire } from "module";
import path from "path";
import pc from "picocolors";
import { chromium, type Browser, type LaunchOptions } from "playwright";

const require = createRequire(import.meta.url);

/** True when the driver can't find its browser build (the "run playwright install" case). */
function isMissingBrowser(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Executable doesn't exist|playwright install/i.test(msg);
}

/** Install the Chromium build that matches the bundled Playwright version. */
function installChromium(): Promise<void> {
  const pkgPath = require.resolve("playwright/package.json");
  const cli = path.join(path.dirname(pkgPath), "cli.js");
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Route progress to stderr so it never corrupts the Ink TUI on stdout.
    child.stdout?.on("data", (d) => process.stderr.write(d));
    child.stderr?.on("data", (d) => process.stderr.write(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`playwright install exited ${code}`)),
    );
  });
}

/** Launch Chromium headlessly, installing its browser build first when absent. */
export async function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
  const launch = () => chromium.launch({ headless: true, ...options });
  try {
    return await launch();
  } catch (err) {
    if (!isMissingBrowser(err)) throw err;
    process.stderr.write(pc.dim("First run: downloading the Chromium browser (~150 MB)…\n"));
    await installChromium();
    return await launch();
  }
}
