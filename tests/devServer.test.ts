import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { planBoot, scriptPort } from "../src/core/devServer.js";
import { bootServer, isPortFree } from "../src/core/heal/boot.js";

/** Write a throwaway project directory containing only a package.json. */
function project(pkg: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-plan-"));
  if (pkg !== undefined) {
    fs.writeFileSync(path.join(dir, "package.json"), typeof pkg === "string" ? pkg : JSON.stringify(pkg));
  }
  return dir;
}

/** A port nothing is listening on (bind to 0, learn the number, release it). */
function sparePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

test("planBoot: Next.js project boots on 3000 with npm run dev", () => {
  const dir = project({ dependencies: { next: "16.0.0" }, scripts: { dev: "next dev" } });
  assert.deepEqual(planBoot(dir), { framework: "Next.js", startCommand: "npm run dev", port: 3000 });
});

test("planBoot: Vite project boots on 5173", () => {
  const dir = project({ devDependencies: { vite: "^5" }, scripts: { dev: "vite" } });
  assert.deepEqual(planBoot(dir), { framework: "Vite", startCommand: "npm run dev", port: 5173 });
});

test("planBoot: a port hardcoded in the dev script beats the framework default", () => {
  // `vite --port 4000` ignores PORT, so asking for 5173 would leave the
  // readiness poll watching a port nothing ever binds.
  const dir = project({ devDependencies: { vite: "^5" }, scripts: { dev: "vite --port 4000" } });
  assert.equal(planBoot(dir)?.port, 4000);
});

test("planBoot: falls back to scripts.start when there is no dev script", () => {
  const dir = project({ dependencies: { next: "16.0.0" }, scripts: { start: "next start" } });
  assert.equal(planBoot(dir)?.startCommand, "npm run start");
});

test("planBoot: an unknown framework still boots, on the 3000 default", () => {
  const dir = project({ dependencies: { "@angular/core": "^17" }, scripts: { dev: "ng serve" } });
  assert.deepEqual(planBoot(dir), { framework: "unknown", startCommand: "npm run dev", port: 3000 });
});

test("planBoot: null when there is no dev/start script — nothing to boot", () => {
  assert.equal(planBoot(project({ scripts: { test: "node --test" } })), null);
});

test("planBoot: null without a package.json, and doesn't throw on a malformed one", () => {
  assert.equal(planBoot(project(undefined)), null);
  assert.equal(planBoot(project("{ not json")), null);
});

test("scriptPort: undefined when the dev script names no port", () => {
  assert.equal(scriptPort(project({ scripts: { dev: "next dev" } })), undefined);
  assert.equal(scriptPort(project({ scripts: { dev: "vite -p 5199" } })), 5199);
});

test("isPortFree: true for a spare port, false once something is listening", async () => {
  const port = await sparePort();
  assert.equal(await isPortFree(port), true);

  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", r));
  try {
    assert.equal(await isPortFree(port), false);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

/** A real child process that serves HTTP — stands in for a project's `npm run dev`. */
const SERVER_JS = `import http from "node:http";
const port = Number(process.env.PORT);
http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ marker: process.env.AZTRX_TEST_MARKER ?? null }));
}).listen(port, "127.0.0.1");
`;

test("bootServer: honours a free preferred port and close() releases it", async () => {
  const dir = project({ scripts: { dev: "node server.mjs" } });
  fs.writeFileSync(path.join(dir, "server.mjs"), SERVER_JS);
  const port = await sparePort();

  const server = await bootServer({
    worktreeDir: dir,
    repoRoot: dir,
    startCommand: "node server.mjs",
    port,
    env: "inherit",
    timeoutMs: 30_000,
  });

  try {
    assert.equal(server.url, `http://127.0.0.1:${port}`);
    assert.equal((await fetch(server.url)).status, 200);
  } finally {
    await server.close();
  }

  assert.equal(await isPortFree(port), true, "close() must leave the port free");
});

test("bootServer: env 'inherit' passes the caller's environment, 'isolated' strips it", async () => {
  const dir = project({ scripts: { dev: "node server.mjs" } });
  fs.writeFileSync(path.join(dir, "server.mjs"), SERVER_JS);
  const port = await sparePort();

  // Not on the allow-list, so the isolated child must not see it. This is the
  // difference between booting the user's own app (inherit — it needs
  // DATABASE_URL) and booting untrusted PR code (isolated — it must not see
  // the caller's ANTHROPIC_API_KEY).
  process.env.AZTRX_TEST_MARKER = "sentinel";
  try {
    const isolated = await bootServer({
      worktreeDir: dir,
      repoRoot: dir,
      startCommand: "node server.mjs",
      port,
      timeoutMs: 30_000,
    });
    try {
      assert.equal((await (await fetch(isolated.url)).json()).marker, null);
    } finally {
      await isolated.close();
    }

    const inherited = await bootServer({
      worktreeDir: dir,
      repoRoot: dir,
      startCommand: "node server.mjs",
      port,
      env: "inherit",
      timeoutMs: 30_000,
    });
    try {
      assert.equal((await (await fetch(inherited.url)).json()).marker, "sentinel");
    } finally {
      await inherited.close();
    }
  } finally {
    delete process.env.AZTRX_TEST_MARKER;
  }
});

test("bootServer: a port that is already taken falls back to a free one", async () => {
  const dir = project({ scripts: { dev: "node server.mjs" } });
  fs.writeFileSync(path.join(dir, "server.mjs"), SERVER_JS);

  const held = net.createServer();
  const port = await sparePort();
  await new Promise<void>((r) => held.listen(port, "127.0.0.1", r));
  try {
    const server = await bootServer({
      worktreeDir: dir,
      repoRoot: dir,
      startCommand: "node server.mjs",
      port,
      env: "inherit",
      timeoutMs: 30_000,
    });
    try {
      assert.notEqual(server.url, `http://127.0.0.1:${port}`, "must not collide with the listener");
    } finally {
      await server.close();
    }
  } finally {
    await new Promise<void>((r) => held.close(() => r()));
  }
});
