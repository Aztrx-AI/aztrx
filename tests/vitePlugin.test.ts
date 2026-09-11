import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { aztrx, summarize } from "../src/vite/index.js";
import type { AztrxResult } from "../src/plugins/scan.js";

/** The plugin spawns the *built* CLI (`dist/cli.js`) — it has no source-mode
 * fallback, because in a published package there is no `src/`. The integration
 * test therefore loads the built plugin too, which `npm test` guarantees via its
 * `pretest` build step. */
const DIST_PLUGIN = path.join(process.cwd(), "dist", "vite", "index.js");

function hasChromium(): boolean {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

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

/** A Vite project whose one button throws — the same shape as the benchmark's
 * null-deref archetype. */
function viteProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-vite-"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>Reports</title></head>
<body><h1>Reports</h1><button id="go">Open report</button>
<script type="module">
  document.getElementById("go").addEventListener("click", () => {
    const report = window.report;          // never assigned
    document.title = report.rows.length;   // 💥 reading 'rows'
  });
</script></body></html>`
  );
  return dir;
}

test("aztrx(): is a serve-only plugin with a configureServer hook", () => {
  const p = aztrx();
  assert.equal(p.name, "aztrx");
  assert.equal(p.apply, "serve");
  assert.equal(typeof p.configureServer, "function");
});

test(
  "aztrx(): a real Vite dev server scans itself and reports the crash",
  { skip: hasChromium() ? false : "playwright chromium not installed" },
  async () => {
    const { aztrx: plugin } = (await import(pathToFileURL(DIST_PLUGIN).href)) as {
      aztrx: typeof aztrx;
    };

    const root = viteProject();
    const port = await sparePort();
    const results: AztrxResult[] = [];
    const errors: string[] = [];

    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: { port, strictPort: true },
      plugins: [
        plugin({
          onResult: (r) => results.push(r),
          onError: (m) => errors.push(m),
        }),
      ],
    });

    try {
      await server.listen();
      assert.ok(server.resolvedUrls?.local?.[0], "vite should report a local URL");

      const deadline = Date.now() + 120_000;
      while (results.length === 0 && errors.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }

      assert.deepEqual(errors, [], `scan reported errors instead of a result: ${errors.join("; ")}`);
      assert.equal(results.length, 1, "expected exactly one scan result");
      assert.equal(results[0].counts.crash, 1);
      assert.match(results[0].findings[0].rawMessage, /reading 'rows'/);

      // The whole point of a dev-server plugin is naming the file, so assert on
      // the real mapped location. A hand-written copy of the JSON shape once got
      // this field wrong (`file` vs `filePath`) and every unit test still passed,
      // because the fixtures carried the same guess. This runs a real scan.
      const loc = results[0].findings[0].mappedLocation;
      assert.ok(loc, "a mapped location is what makes the finding actionable");
      assert.equal(loc.filePath, "index.html");
      assert.equal(typeof loc.line, "number");
      assert.match(summarize(results[0]), /index\.html:\d+/);
      assert.doesNotMatch(summarize(results[0]), /undefined/);
    } finally {
      await server.close();
    }
  }
);
