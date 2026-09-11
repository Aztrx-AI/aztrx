import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerAztrx, resolveNextUrl } from "../src/next/index.js";

/** A Next project, in the shape `planBoot` reads. */
function nextProject(devScript: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-next-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { next: "16.3.2" }, scripts: { dev: devScript } })
  );
  return dir;
}

/** Run `fn` with the given environment, restoring it afterwards — `PORT` and
 * `AZTRX_URL` are process-wide and these tests must not leak into each other. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("resolveNextUrl: a stated URL always wins", () => {
  const root = nextProject("next dev");
  withEnv({ PORT: "3001", AZTRX_URL: "http://localhost:9999" }, () => {
    assert.equal(resolveNextUrl(root, "http://example.test:8080"), "http://example.test:8080");
  });
});

test("resolveNextUrl: AZTRX_URL is the environment's stated intent", () => {
  const root = nextProject("next dev");
  withEnv({ PORT: "3001", AZTRX_URL: "http://localhost:9999" }, () => {
    assert.equal(resolveNextUrl(root), "http://localhost:9999");
  });
});

test("resolveNextUrl: prefers the port Next actually bound", () => {
  // The case that matters: 3000 was taken, Next moved to 3001, and `PORT` is the
  // only source that knows. Guessing the framework default would scan a stranger.
  const root = nextProject("next dev");
  withEnv({ PORT: "3001", AZTRX_URL: undefined }, () => {
    assert.equal(resolveNextUrl(root), "http://localhost:3001");
  });
});

test("resolveNextUrl: falls back to the dev script's own --port", () => {
  const root = nextProject("next dev -p 4321");
  withEnv({ PORT: undefined, AZTRX_URL: undefined }, () => {
    assert.equal(resolveNextUrl(root), "http://localhost:4321");
  });
});

test("resolveNextUrl: and to Next's default when the script names no port", () => {
  const root = nextProject("next dev");
  withEnv({ PORT: undefined, AZTRX_URL: undefined }, () => {
    assert.equal(resolveNextUrl(root), "http://localhost:3000");
  });
});

// The dev-mode test below installs the `exit` listener, so the guard tests must
// come first: registration is deliberately once-per-process. node:test runs
// top-level tests in declaration order.
test("registerAztrx: is a no-op when disabled", () => {
  withEnv({ NODE_ENV: "development" }, () => {
    const before = process.listenerCount("exit");
    assert.equal(registerAztrx({ enabled: false, url: "http://127.0.0.1:1" }), undefined);
    assert.equal(process.listenerCount("exit"), before, "a disabled plugin must not hook the process");
  });
});

test("registerAztrx: never runs outside development", () => {
  // `instrumentation.ts` also loads under `next build` and `next start`, where a
  // scan would drive a browser at a real deployment.
  withEnv({ NODE_ENV: "production" }, () => {
    const before = process.listenerCount("exit");
    assert.equal(registerAztrx({ url: "http://127.0.0.1:1" }), undefined);
    assert.equal(process.listenerCount("exit"), before, "production must not hook the process");
  });
});

test("registerAztrx: never runs in the edge runtime", () => {
  withEnv({ NODE_ENV: "development", NEXT_RUNTIME: "edge" }, () => {
    const before = process.listenerCount("exit");
    assert.equal(registerAztrx({ url: "http://127.0.0.1:1" }), undefined);
    assert.equal(process.listenerCount("exit"), before, "edge has no child_process");
  });
});

test("registerAztrx: returns synchronously and hooks process exit", async () => {
  await withEnvAsync({ NODE_ENV: "development", NEXT_RUNTIME: "nodejs" }, async () => {
    const before = process.listenerCount("exit");
    let error: string | undefined;
    const returned = registerAztrx({
      // Nothing is listening here, so readiness fails fast and loudly.
      url: "http://127.0.0.1:1",
      readyTimeoutMs: 200,
      onError: (m) => (error = m),
    });

    // The deadlock trap, as a test. Next *awaits* `register()` before it starts
    // serving, so a `registerAztrx` that awaited readiness would wait on a server
    // that is waiting on it. A promise here would be a hang in the real thing.
    assert.equal(returned, undefined, "registerAztrx must not return a promise");
    assert.equal(process.listenerCount("exit"), before + 1, "the scan is killed on the way out");

    const deadline = Date.now() + 5000;
    while (error === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.match(String(error), /no dev server answered at http:\/\/127\.0\.0\.1:1/);
    assert.match(String(error), /AZTRX_URL/, "the failure must say how to point it elsewhere");
  });
});

/** `withEnv` for a body that awaits. */
async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
