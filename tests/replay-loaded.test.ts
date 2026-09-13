import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";
import { ReplayEngine } from "../src/core/replay.js";

/** The browser-backed half of the verification fix: `reproduced === false` is
 * only meaningful when the page actually loaded. This exercises the primitive
 * itself, since every higher-level guard is built on it. */

function hasChromium(): boolean {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/** A port nothing is listening on: bound to learn a free one, then released. */
function deadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

function liveServer(status = 200): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv: Server = createServer((_req, res) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><html><body><h1>ok</h1></body></html>");
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

test("replay reports loaded:false for a URL that never answers", { skip: hasChromium() ? false : "playwright chromium not installed" }, async () => {
  const port = await deadPort();
  const engine = new ReplayEngine();
  try {
    const r = await engine.run(`http://127.0.0.1:${port}/`, [], "fp");
    // The whole point: "the bug did not reproduce" here means only that nothing
    // ran. A caller that cannot tell this from a real fix declares victory.
    assert.equal(r.loaded, false);
    assert.equal(r.reproduced, false);
  } finally {
    await engine.close();
  }
});

test("replay reports loaded:true for a page that answers", { skip: hasChromium() ? false : "playwright chromium not installed" }, async () => {
  const srv = await liveServer();
  const engine = new ReplayEngine();
  try {
    const r = await engine.run(srv.url, [], "fp");
    assert.equal(r.loaded, true);
    assert.equal(r.reproduced, false);
  } finally {
    await engine.close();
    await srv.close();
  }
});

test("replay reports loaded:false for an error response", { skip: hasChromium() ? false : "playwright chromium not installed" }, async () => {
  const srv = await liveServer(500);
  const engine = new ReplayEngine();
  try {
    // A 5xx is not a page the app served — treating it as a load would let a
    // broken boot pass verification as a non-reproduction.
    const r = await engine.run(srv.url, [], "fp");
    assert.equal(r.loaded, false);
  } finally {
    await engine.close();
    await srv.close();
  }
});
