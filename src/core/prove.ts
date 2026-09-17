/**
 * Prove-It-Fixed — the closing act of the closed loop.
 *
 * A patch that verifies still leaves one question open: what stops this bug
 * from coming back? proveItFixed answers it with a regression test: the
 * repro spec (which proves the bug exists) is handed to the configured LLM
 * together with the business risk and the applied diff, and rewritten into a
 * CI-ready Playwright test whose assertions verify the attack is now BLOCKED
 * — a 403, a redirect, or simply the absence of the crash.
 *
 * The artifact lands in a visible directory of the user's project
 * (`__aztrx_tests__/` by default), with a name that says what it guards:
 * prevent-actions-crash.spec.ts, prevent-paywall-bypass.spec.ts, …
 */

import * as fs from "fs";
import * as path from "path";
import { complete } from "./llm.js";
import { compileSpec } from "./specCompiler.js";
import type { Finding } from "./types.js";
import type { PatchHunk } from "./heal/types.js";

export interface ProveOptions {
  repoRoot: string;
  /** The finding the patch healed — business risk, message, repro actions. */
  finding: Finding;
  /** The URL the repro was recorded against. */
  url: string;
  /** The verified hunks the regression test must pin in place. */
  hunks: PatchHunk[];
  /** Output directory relative to repoRoot (default: __aztrx_tests__). */
  outDir?: string;
  log?: (msg: string) => void;
}

export interface ProveResult {
  ok: boolean;
  /** Repo-relative path of the written test. */
  testPath?: string;
  error?: string;
}

const SYSTEM = `You are a QA engineer who writes regression tests for security and crash fixes.
You are given a Playwright repro script (it proves a bug exists), the business risk, and the diff that fixed it.
Rewrite the script into a reliable regression test. The patch is ALREADY applied.

Rewrite the assertions so they verify the attack is now BLOCKED:
- expect an HTTP 403 / redirect when the attack is tried,
- expect the crash to NOT happen (no pageerror, no console error),
- expect the dangerous UI/content to be absent or harmless.
Keep the code clean and readable. Use ONLY \`import { test, expect } from "@playwright/test";\`.
Return ONLY the TypeScript source of the test file — no markdown fences, no prose before or after.

Hard rules:
- The base URL comes from process.env.TEST_BASE_URL, default "<origin>".
- If the repro needs auth state (localStorage token, cookies), seed it at the start of the test with page.evaluate / context.addCookies — the exact values are given below.
- One test() call. Title: "regression: <short message>".
- No custom helper imports, no relative imports, no process.exit.`;

/** A readable file name that says what the test guards. */
export function regressionFileName(f: Finding): string {
  const prop = /reading '([^']+)'/.exec(f.rawMessage)?.[1];
  if (prop) return `prevent-${prop.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "null-deref"}-crash.spec.ts`;
  if (/token tampering/i.test(f.rawMessage)) return "prevent-token-tampering.spec.ts";
  if (/paywall bypassed/i.test(f.rawMessage)) return "prevent-paywall-bypass.spec.ts";
  if (/secret exposed/i.test(f.rawMessage)) {
    const kind = /source: ([A-Za-z ]+?) on/.exec(f.rawMessage)?.[1]?.trim().toLowerCase().replace(/\s+/g, "-");
    return `prevent-${kind ?? "secret"}-leak.spec.ts`;
  }
  return `prevent-${f.fingerprint.slice(0, 8)}-regression.spec.ts`;
}

/** Generate the regression test and write it into the project. */
export async function proveItFixed(opts: ProveOptions): Promise<ProveResult> {
  const { finding } = opts;
  const outDir = opts.outDir ?? "__aztrx_tests__";
  const absDir = path.resolve(opts.repoRoot, outDir);

  const spec = compileSpec(finding, finding.repro?.actions ?? finding.actionHistory, opts.url);
  const diff = opts.hunks
    .map((h) => `-${h.search}\n+${h.replace}`)
    .join("\n");

  const prompt = [
    `Original repro (proves the bug):`,
    "```ts",
    spec,
    "```",
    "",
    `Business risk: ${finding.businessRisk ?? finding.rawMessage.split("\n")[0]}`,
    `The applied fix (already in the code under test):`,
    "```diff",
    diff,
    "```",
  ];
  if (finding.seedState) {
    prompt.push(
      `Auth state the test must restore before acting:`,
      `localStorage: ${JSON.stringify(finding.seedState.localStorage)}`,
      `cookies: ${JSON.stringify(finding.seedState.cookies.map((c) => ({ name: c.name, value: c.value })))}`
    );
  }

  let source: string;
  try {
    source = await complete({
      system: SYSTEM.replace("<origin>", new URL(opts.url).origin),
      prompt: prompt.join("\n"),
      maxTokens: 4096,
      temperature: 0,
    });
  } catch (e) {
    return { ok: false, error: `LLM call failed: ${(e as Error).message}` };
  }

  // Minimal sanity gate: it must be a Playwright test, not prose.
  const cleaned = source.trim().replace(/^```(?:ts|typescript)?\s*|```$/g, "").trim();
  if (!cleaned.includes("@playwright/test") || !cleaned.includes("test(")) {
    return { ok: false, error: "the model did not return a Playwright test" };
  }

  try {
    fs.mkdirSync(absDir, { recursive: true });
    const fileName = regressionFileName(finding);
    fs.writeFileSync(path.join(absDir, fileName), cleaned + "\n", "utf-8");
    opts.log?.(`🛡️  Generated a Playwright regression test for CI/CD: ${path.join(outDir, fileName)}`);
    return { ok: true, testPath: path.join(outDir, fileName) };
  } catch (e) {
    return { ok: false, error: `cannot write the test: ${(e as Error).message}` };
  }
}
