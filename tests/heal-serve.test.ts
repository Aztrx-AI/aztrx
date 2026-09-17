import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { heal } from "../src/core/heal/index.js";
import type { Finding } from "../src/core/types.js";

/** A repo with the given package.json scripts (or no package.json at all). */
function repoWith(scripts: Record<string, string> | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-serve-"));
  if (scripts) {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts }), "utf-8");
  }
  return dir;
}

/** The keyless paths are part of the contract — run them hermetic, so an
 * ambient key in the developer's shell (or the CI runner's) can't flip the
 * flow these tests pin down. */
const LLM_KEY_ENV = ["AZTRX_API_BASE", "AZTRX_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"] as const;

async function withoutLlmKeys<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const k of LLM_KEY_ENV) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of LLM_KEY_ENV) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function findingFor(filePath: string, type: Finding["type"] = "runtime_error"): Finding {
  return {
    id: "f1",
    fingerprint: "fp",
    occurrences: 1,
    severity: "high",
    type,
    rawMessage: "Cannot read properties of undefined",
    rawStack: "at App (App.tsx:1:1)",
    mappedLocation: { filePath, line: 1, column: 1, codeContext: "", isOwnCode: true },
    actionHistory: [],
    repro: { actions: [], specPath: "x.spec.ts", verdict: "deterministic", rate: 1, runs: 3, reproductions: 3 },
  };
}

test("heal refuses to verify a source file it cannot run (no start command)", async () => {
  // The regression this guards: with no way to boot the app, heal static-served
  // the .tsx, the browser got it as text, nothing executed, the crash "stopped
  // reproducing", and the patch was reported healed and written out.
  const repoRoot = repoWith(null);
  fs.writeFileSync(path.join(repoRoot, "App.tsx"), "export const App = () => null;\n", "utf-8");

  const r = await heal(findingFor("App.tsx"), { repoRoot, url: "http://localhost:3000", actions: [], fingerprint: "fp", allowHosts: [] });
  assert.equal(r.status, "skipped");
  assert.match(r.error ?? "", /without running it/);
  // Refused before spending anything: no patch, no artifact, no tier attempted.
  assert.equal(r.hunks.length, 0);
  assert.equal(r.patchPath, undefined);
  assert.equal(r.tiers, undefined);
});

test("heal still serves a self-contained HTML fixture statically", async () => {
  await withoutLlmKeys(async () => {
    // The fixture/benchmark path must keep working without a start command — an
    // HTML entry really does execute when served, so the verification is honest.
    const repoRoot = repoWith(null);
    fs.writeFileSync(path.join(repoRoot, "crash.html"), "<html><body>hi</body></html>", "utf-8");

    const r = await heal(findingFor("crash.html"), { repoRoot, url: "http://localhost:3000", actions: [], fingerprint: "fp", allowHosts: [] });
    // No LLM key and no rule fix applies here, so it stops at that gate — which
    // proves it got *past* the serve guard rather than being refused by it.
    assert.equal(r.status, "no-llm");
    assert.doesNotMatch(r.error ?? "", /without running it/);
  });
});

test("heal accepts a source file when a start command exists", async () => {
  await withoutLlmKeys(async () => {
    const repoRoot = repoWith({ dev: "vite" });
    fs.writeFileSync(path.join(repoRoot, "App.tsx"), "export const App = () => null;\n", "utf-8");

    const r = await heal(findingFor("App.tsx"), { repoRoot, url: "http://localhost:3000", actions: [], fingerprint: "fp", allowHosts: [] });
    assert.equal(r.status, "no-llm");
    assert.doesNotMatch(r.error ?? "", /without running it/);
  });
});

test("heal accepts a source file when an explicit serve hook is injected", async () => {
  await withoutLlmKeys(async () => {
    const repoRoot = repoWith(null);
    fs.writeFileSync(path.join(repoRoot, "App.tsx"), "export const App = () => null;\n", "utf-8");

    const r = await heal(findingFor("App.tsx"), {
      repoRoot,
      url: "http://localhost:3000",
      actions: [],
      fingerprint: "fp",
      allowHosts: [],
      serve: async () => ({ url: "http://127.0.0.1:1", close: async () => {} }),
    });
    assert.equal(r.status, "no-llm");
  });
});

test("heal still requires a start command for a server finding, HTML or not", async () => {
  // Static serving cannot produce a 500 from a route that never runs, so the
  // HTML exemption must not leak into the network path.
  const repoRoot = repoWith(null);
  fs.writeFileSync(path.join(repoRoot, "page.html"), "<html></html>", "utf-8");

  const r = await heal(findingFor("page.html", "network_5xx"), { repoRoot, url: "http://localhost:3000", actions: [], fingerprint: "fp", allowHosts: [] });
  assert.equal(r.status, "skipped");
  assert.match(r.error ?? "", /no start command for server heal/);
});

test("heal skips a finding with no deterministic repro before anything else", async () => {
  const repoRoot = repoWith({ dev: "vite" });
  fs.writeFileSync(path.join(repoRoot, "App.tsx"), "export const App = () => null;\n", "utf-8");

  const f = findingFor("App.tsx");
  f.repro = { ...f.repro!, verdict: "unreliable" };
  const r = await heal(f, { repoRoot, url: "http://localhost:3000", actions: [], fingerprint: "fp", allowHosts: [] });
  assert.equal(r.status, "skipped");
  assert.match(r.error ?? "", /no deterministic repro/);
});

test("heal skips a finding whose source location is not own code", async () => {
  const repoRoot = repoWith({ dev: "vite" });
  const f = findingFor("node_modules/dep/index.js");
  f.mappedLocation = { ...f.mappedLocation!, isOwnCode: false };

  const r = await heal(f, { repoRoot, url: "http://localhost:3000", actions: [], fingerprint: "fp", allowHosts: [] });
  assert.equal(r.status, "skipped");
  assert.match(r.error ?? "", /no own-code source location/);
});
