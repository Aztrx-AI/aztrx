import * as fs from "fs";
import * as path from "path";
import type { Finding, RecordedAction } from "./types.js";

const js = (s: string): string => JSON.stringify(s);

/**
 * F8 — spec compiler. Turns a minimal action sequence into an executable
 * Playwright test that asserts the failure actually happens, so a human can
 * run `npx playwright test` and see the bug with their own eyes — proof, not
 * a log line.
 */
export function compileSpec(finding: Finding, actions: RecordedAction[], url: string): string {
  const title = finding.rawMessage.split("\n")[0].slice(0, 80) || "unknown error";
  const needle = finding.rawMessage.split("\n")[0].slice(0, 120);
  const hasRequest = actions.some((a) => a.type === "request");
  const out: string[] = [];

  out.push(`import { test, expect } from "@playwright/test";`);
  out.push(``);
  out.push(`// Aztrx AI repro — ${finding.id}`);
  out.push(`// severity: ${finding.severity}   type: ${finding.type}`);
  if (finding.mappedLocation) {
    out.push(`// source: ${finding.mappedLocation.filePath}:${finding.mappedLocation.line}:${finding.mappedLocation.column}`);
  }
  out.push(`test(${js(`repro: ${title}`)}, async ({ page }) => {`);
  out.push(`  const errors: string[] = [];`);
  out.push(`  page.on("pageerror", (e) => errors.push(e.message));`);
  out.push(`  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });`);
  out.push(`  await page.goto(${js(url)});`);

  for (const a of actions) {
    if (a.type === "navigate") {
      out.push(`  await page.goto(${js(a.value ?? url)});`);
      continue;
    }
    if (a.type === "scroll") {
      out.push(`  await page.mouse.wheel(0, ${a.value === "up" ? -600 : 600});`);
      continue;
    }
    if (a.type === "request" && a.request) {
      out.push(`  {`);
      out.push(`    const status = await page.evaluate(async (r) => {`);
      out.push(`      try { const resp = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body }); return resp.status; }`);
      out.push(`      catch { return 0; }`);
      out.push(`    }, ${JSON.stringify(a.request)});`);
      out.push(`    expect(status).toBeGreaterThanOrEqual(500);`);
      out.push(`  }`);
      continue;
    }
    const sel = a.selectors[0];
    if (!sel) {
      out.push(`  // (skipped — no reliable selector for this step)`);
      continue;
    }
    switch (a.type) {
      case "input":
        out.push(`  await page.locator(${js(sel)}).first().fill(${js(a.value ?? "")});`);
        break;
      case "hover":
        out.push(`  await page.locator(${js(sel)}).first().hover();`);
        break;
      case "select":
        out.push(`  await page.locator(${js(sel)}).first().selectOption(${js(a.value ?? "")});`);
        break;
      case "keypress":
        out.push(`  await page.locator(${js(sel)}).first().focus();`);
        out.push(`  await page.keyboard.press(${js(a.value ?? "Enter")});`);
        break;
      default:
        out.push(`  await page.locator(${js(sel)}).first().click();`);
        break;
    }
  }

  if (!hasRequest) {
    // A server-side 5xx produces no `pageerror`/`console.error` — the per-request
    // status assertion above is the proof instead, so skip the error poll.
    out.push(`  await expect.poll(() => errors.join("\\n"), { timeout: 5000 }).toContain(${js(needle)});`);
  }
  out.push(`});`);
  return out.join("\n") + "\n";
}

export function writeSpec(
  repoRoot: string,
  finding: Finding,
  actions: RecordedAction[],
  url: string
): string {
  const dir = path.join(repoRoot, ".aztrx", "repro");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${finding.id}.spec.ts`);
  fs.writeFileSync(file, compileSpec(finding, actions, url), "utf-8");
  return file;
}

/**
 * Install validated repro specs into the project's test directory so a fixed
 * bug can't silently regress — the "immunity" step after find → prove → fix.
 * Copies each deterministic/flaky repro into `<dir>/aztrx-<fingerprint>.spec.ts`
 * and returns the written paths. `dir` defaults to an existing test dir, else a
 * gitignored fallback.
 */
export function writeRegressionSpecs(
  repoRoot: string,
  findings: Finding[],
  dir?: string
): string[] {
  const target = path.resolve(repoRoot, dir || detectTestDir(repoRoot));
  fs.mkdirSync(target, { recursive: true });

  const written: string[] = [];
  for (const f of findings) {
    if (!f.repro?.specPath || f.repro.verdict === "unreliable") continue;
    const src = path.resolve(repoRoot, f.repro.specPath);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(target, `aztrx-${f.fingerprint.slice(0, 8)}.spec.ts`);
    fs.copyFileSync(src, dest);
    written.push(dest);
  }
  return written;
}

/** Prefer an existing test dir, else a gitignored fallback. */
function detectTestDir(repoRoot: string): string {
  for (const d of ["e2e", "tests", "test", "__tests__"]) {
    if (fs.existsSync(path.join(repoRoot, d))) return d;
  }
  return ".aztrx/regression";
}
