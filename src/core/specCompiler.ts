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
  const out: string[] = [];

  out.push(`import { test, expect } from "@playwright/test";`);
  out.push(``);
  out.push(`// Aztrx repro — ${finding.id}`);
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

  out.push(`  await expect.poll(() => errors.join("\\n"), { timeout: 5000 }).toContain(${js(needle)});`);
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
