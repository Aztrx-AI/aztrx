import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { chromium } from "playwright";
import { redirectStdoutToStderr, startServer, type ServerIO } from "../src/mcp/index.js";
import {
  LATEST_VERSION,
  METHOD_NOT_FOUND,
  META_SERVER_INFO,
  SUPPORTED_VERSIONS,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "../src/mcp/protocol.js";
import {
  installInto,
  installMcp,
  MCP_SERVER_NAME,
  serverEntry,
  TARGETS,
  uninstallFrom,
  uninstallMcp,
} from "../src/mcp/install.js";
import { McpRuntime, TOOLS } from "../src/mcp/tools.js";
import { isPortFree } from "../src/core/heal/boot.js";
import type { Finding } from "../src/core/types.js";
import type { HealOptions, HealResult } from "../src/core/heal/types.js";

const DIST_CLI = path.join(process.cwd(), "dist", "cli.js");

/** Every temp directory this file makes, removed once at the end. Registered
 * rather than cleaned inline, because a failing assertion skips whatever
 * cleanup sits after it — and a failing run is the one that runs most. */
const TEMP: string[] = [];
function track(dir: string): string {
  TEMP.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows holds handles on freshly-killed children; the OS reclaims it */
    }
  }
});

function tempDir(prefix: string): string {
  return track(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function repoWith(files: Record<string, string>): string {
  const dir = tempDir("aztrx-mcp-");
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }
  return dir;
}

function read(abs: string): string {
  return fs.readFileSync(abs, "utf-8");
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hasChromium = (): boolean => {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// A scripted client, in-process
// ---------------------------------------------------------------------------

type Message = Record<string, any>;

interface Harness {
  send(msg: unknown): void;
  /** Write to the protocol stream verbatim, for the lines a client should never
   * send but eventually will. */
  raw(line: string): void;
  /** Every stdout line, parsed. Throws on a line that is not JSON — so purity is
   * a property of every test that reads this, not of one test that remembers. */
  messages(): Message[];
  stderr(): string;
  stop(): Promise<void>;
}

async function harness(
  deps: ConstructorParameters<typeof McpRuntime>[0] = {}
): Promise<Harness> {
  const input = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  const io: ServerIO = {
    input,
    output: {
      write: (c: string) => {
        out.push(c);
        return true;
      },
    },
    error: {
      write: (c: string) => {
        err.push(c);
        return true;
      },
    },
  };
  const handle = await startServer({ io, runtime: new McpRuntime(deps) });
  return {
    send: (msg) => void input.write(JSON.stringify(msg) + "\n"),
    raw: (line) => void input.write(line),
    messages: () =>
      out
        .join("")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => {
          try {
            return JSON.parse(l) as Message;
          } catch {
            throw new Error(`stdout carried a line that is not JSON: ${JSON.stringify(l)}`);
          }
        }),
    stderr: () => err.join(""),
    stop: () => handle.stop(),
  };
}

/** Send a request and wait for the response with that id. Returns the whole
 * envelope so a test can assert on `error` as well as `result`. */
async function rpc(h: Harness, msg: Message, timeoutMs = 15_000): Promise<Message> {
  h.send(msg);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = h.messages().find(
      (m) => m.id === msg.id && (m.result !== undefined || m.error !== undefined)
    );
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no response to ${String(msg.method)}`);
    await sleep(10);
  }
}

// ---------------------------------------------------------------------------
// Protocol conformance
// ---------------------------------------------------------------------------

test("initialize: echoes the client's version, never our newest", async () => {
  const h = await harness();
  try {
    for (const version of ["2024-11-05", "2025-06-18", "2025-11-25"]) {
      const res = await rpc(h, {
        jsonrpc: "2.0",
        id: version,
        method: "initialize",
        params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "1" } },
      });
      assert.equal(
        res.result.protocolVersion,
        version,
        `answering ${version} with anything else is the mismatch that makes a client refuse the server`
      );
      assert.notEqual(res.result.protocolVersion, LATEST_VERSION);
      assert.deepEqual(res.result.capabilities, { tools: {} });
      assert.equal(res.result.serverInfo.name, "aztrx-cli");
    }
  } finally {
    await h.stop();
  }
});

test("initialize: an unservable version gets our newest, and says so on stderr", async () => {
  const h = await harness();
  try {
    const res = await rpc(h, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01", capabilities: {} },
    });
    assert.equal(res.result.protocolVersion, LATEST_VERSION);
    // A legacy client has no fall-forward, so the session may end right here.
    // That is correct behaviour, but it must not be silent — it is the only clue
    // in a bug report that says "the server won't connect".
    assert.match(h.stderr(), /1999-01-01/);
    assert.match(h.stderr(), new RegExp(LATEST_VERSION.replace(/\./g, "\\.")));
  } finally {
    await h.stop();
  }
});

test("server/discover: the spec's exact shape, and mandatory for every server", async () => {
  const h = await harness();
  try {
    const res = await rpc(h, { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    assert.equal(res.result.resultType, "complete");
    assert.deepEqual(res.result.supportedVersions, [...SUPPORTED_VERSIONS]);
    // `protocolVersions` is the plausible wrong name, and a client reading it
    // gets undefined rather than an error.
    assert.equal(res.result.protocolVersions, undefined, "the field is `supportedVersions`");
    assert.equal(res.result._meta[META_SERVER_INFO].name, "aztrx-cli");
    assert.deepEqual(res.result.capabilities, { tools: {} });
    assert.ok(res.result.ttlMs > 0);
    assert.equal(res.result.cacheScope, "public");
  } finally {
    await h.stop();
  }
});

test("tools/list: deterministic order, cacheable, no pagination", async () => {
  const h = await harness();
  try {
    const first = await rpc(h, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const second = await rpc(h, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    // The set and its order must not vary between calls *or* connections.
    assert.deepEqual(first.result.tools, second.result.tools);
    assert.deepEqual(
      first.result.tools.map((t: Message) => t.name),
      ["aztrx_scan", "aztrx_repro", "aztrx_fix"]
    );
    assert.equal(first.result.ttlMs, 300_000);
    assert.equal(first.result.cacheScope, "public");
    assert.equal(first.result.nextCursor, undefined);
    for (const tool of first.result.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(typeof tool.description, "string");
    }
  } finally {
    await h.stop();
  }
});

test("unknown method is -32601, and every result carries resultType", async () => {
  const h = await harness();
  try {
    const bad = await rpc(h, { jsonrpc: "2.0", id: 1, method: "resources/list", params: {} });
    assert.equal(bad.error.code, METHOD_NOT_FOUND);
    assert.equal(bad.result, undefined);

    for (const method of ["server/discover", "tools/list", "ping"]) {
      const res = await rpc(h, { jsonrpc: "2.0", id: method, method, params: {} });
      assert.equal(res.result.resultType, "complete", `${method} must set resultType`);
    }
  } finally {
    await h.stop();
  }
});

test("a modern request declaring a version we do not serve is rejected with -32022", async () => {
  const h = await harness();
  try {
    const rejected = await rpc(h, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" } },
    });
    assert.equal(rejected.error.code, UNSUPPORTED_PROTOCOL_VERSION);
    // The client picks a version off `supported` and retries, so both halves of
    // this data are load-bearing.
    assert.deepEqual(rejected.error.data.supported, [...SUPPORTED_VERSIONS]);
    assert.equal(rejected.error.data.requested, "1999-01-01");

    // A version we do serve is served — the same request, one field different.
    const served = await rpc(h, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    });
    assert.equal(served.result.tools.length, TOOLS.length);
  } finally {
    await h.stop();
  }
});

test("garbage on the wire is answered, and never breaks the channel", async () => {
  const h = await harness();
  try {
    // A notification has no id and expects no reply. Answering one desynchronises
    // a client that is counting responses.
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await sleep(150);
    assert.deepEqual(h.messages(), []);

    h.raw("not json at all\n");
    h.raw('"just a string"\n');
    h.raw("[1,2]\n");
    h.raw("\n");
    await sleep(200);

    const [parse, ...invalid] = h.messages();
    assert.equal(parse.error.code, -32700);
    assert.equal(parse.id, null, "a line that is not JSON has an unknowable id");
    assert.deepEqual(
      invalid.map((m) => m.error.code),
      [-32600, -32600]
    );
    assert.deepEqual(
      invalid.map((m) => m.id),
      [null, null]
    );

    // The channel survives all of it, which is the part that matters: a client
    // that gets a torn frame must still be able to talk to us afterwards.
    const ping = await rpc(h, { jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    assert.equal(ping.result.resultType, "complete");
  } finally {
    await h.stop();
  }
});

// ---------------------------------------------------------------------------
// stdout purity
// ---------------------------------------------------------------------------

test("redirectStdoutToStderr: moves the console's stdout writers, and undoes itself", () => {
  const sink: string[] = [];
  const before = { log: console.log, info: console.info, debug: console.debug, dir: console.dir };
  const restore = redirectStdoutToStderr({
    write: (c: string) => {
      sink.push(c);
      return true;
    },
  });
  try {
    console.log("stray %s", "line");
    console.info("also stray");
    console.dir({ a: 1 });
  } finally {
    restore();
  }
  assert.deepEqual(
    sink.map((s) => s.replace(/\n$/, "")),
    ["stray line", "also stray", "{ a: 1 }"]
  );
  // Restoring matters: a test process that keeps the redirect would silently
  // swallow every later test's output.
  assert.equal(console.log, before.log);
  assert.equal(console.info, before.info);
  assert.equal(console.debug, before.debug);
  assert.equal(console.dir, before.dir);
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const ACTION = { type: "click" as const, selectors: ["#go"], timestamp: 1 };

function crashFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f-1",
    fingerprint: "fp-1",
    occurrences: 1,
    severity: "crash",
    type: "uncaught_exception",
    rawMessage: "TypeError: Cannot read properties of undefined (reading 'rows')",
    rawStack: "TypeError: ...\n    at index.html:9:31",
    mappedLocation: {
      filePath: "index.html",
      line: 9,
      column: 31,
      codeContext: "document.title = report.rows.length;",
      isOwnCode: true,
    },
    actionHistory: [ACTION],
    repro: {
      actions: [ACTION],
      specPath: "",
      verdict: "deterministic",
      rate: 1,
      runs: 3,
      reproductions: 3,
    },
    ...over,
  };
}

/** A run function standing in for the orchestrator: no browser, no Playwright,
 * and it can print to prove the purity guard holds during a tool call. */
function fakeRun(findings: Finding[], onCall?: () => void) {
  return async () => {
    onCall?.();
    return findings;
  };
}

const FAKE_URL = "http://127.0.0.1:9/";

test("aztrx_scan: returns a compact projection and a handle, never the raw Finding", async () => {
  const h = await harness({ loadRun: async () => fakeRun([crashFinding()]) });
  try {
    const res = await rpc(h, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      // An explicit `url` keeps the fake run off the zero-config boot path: this
      // test is about the projection, and booting a real dev server for it would
      // be both slow and a second thing that can fail.
      params: { name: "aztrx_scan", arguments: { repoPath: process.cwd(), url: FAKE_URL } },
    });
    const s = res.result.structuredContent;
    assert.equal(res.result.isError, false);
    assert.deepEqual(s.counts, { crash: 1, error: 0, warning: 0 });
    assert.equal(typeof s.scanId, "string");
    assert.equal(s.findings.length, 1);

    const f = s.findings[0];
    assert.equal(f.id, "f-1");
    assert.equal(f.reproVerdict, "deterministic");
    assert.equal(f.hasRepro, true);
    assert.deepEqual(f.location, { file: "index.html", line: 9, column: 31, ownCode: true });
    // A finding carries a whole spec and a stack. Dumping them into the model's
    // context on every scan is how a useful tool becomes an expensive one.
    assert.equal(f.rawStack, undefined);
    assert.equal(f.actionHistory, undefined);

    // The spec asks that a tool returning structured content also serialize it
    // into a text block, for clients on revisions that lack the field. Compare
    // against the whole structuredContent: a block that carries only *some* of
    // it would pass a field-by-field check and still lose the client its data.
    const text = res.result.content[0].text as string;
    assert.match(text, /1 crash/);
    assert.ok(text.includes(JSON.stringify(s, null, 2)));
    assert.match(text, /aztrx_repro/);
  } finally {
    await h.stop();
  }
});

test("a clean scan says clean; a scan that could not run is an error, not zero findings", async () => {
  const clean = await harness({ loadRun: async () => fakeRun([]) });
  try {
    const res = await rpc(clean, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "aztrx_scan", arguments: { repoPath: process.cwd(), url: FAKE_URL } },
    });
    assert.equal(res.result.isError, false);
    assert.match(res.result.content[0].text, /Clean scan/);
    assert.deepEqual(res.result.structuredContent.counts, { crash: 0, error: 0, warning: 0 });
  } finally {
    await clean.stop();
  }

  const bad = await harness();
  try {
    const res = await rpc(bad, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "aztrx_scan", arguments: { repoPath: path.join(os.tmpdir(), "aztrx-does-not-exist") } },
    });
    assert.equal(res.result.isError, true);
    // The load-bearing part: no `counts` to misread. An agent that sees
    // `{crash: 0}` alongside an error message acts on the zero.
    assert.equal(res.result.structuredContent, undefined);
    assert.match(res.result.content[0].text, /does not exist/);
  } finally {
    await bad.stop();
  }
});

test("a stray console.log during a scan goes to stderr, not the protocol stream", async () => {
  const h = await harness({
    loadRun: async () => fakeRun([crashFinding()], () => console.log("STRAY FROM THE SCAN")),
  });
  try {
    const res = await rpc(h, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "aztrx_scan", arguments: { repoPath: process.cwd(), url: FAKE_URL } },
    });
    assert.equal(res.result.isError, false, "the scan must complete despite the stray write");
    // `messages()` throws on a non-JSON stdout line, so reaching here proves the
    // stray did not land in the protocol stream. Remove the redirect in
    // `startServer` and this assertion fails on both counts.
    assert.match(h.stderr(), /STRAY FROM THE SCAN/);
  } finally {
    await h.stop();
  }
});

test("argument validation is a tool error the model can read and retry on", async () => {
  const h = await harness({ loadRun: async () => fakeRun([]) });
  try {
    const cases: Array<[Message, RegExp]> = [
      [{ name: "aztrx_scan", arguments: { maxActions: 0 } }, /between 1 and 5000/],
      [{ name: "aztrx_scan", arguments: { runs: "three" } }, /must be an integer/],
      [{ name: "aztrx_scan", arguments: { url: "not a url" } }, /not a valid URL/],
      [{ name: "aztrx_scan", arguments: { repoPath: 7 } }, /must be a string/],
      [{ name: "aztrx_repro", arguments: {} }, /scanId.*is required/],
    ];
    let id = 1;
    for (const [params, pattern] of cases) {
      const res = await rpc(h, { jsonrpc: "2.0", id: id++, method: "tools/call", params });
      assert.equal(res.result.isError, true, `${JSON.stringify(params)} must fail`);
      assert.match(res.result.content[0].text, pattern);
      assert.equal(res.result.structuredContent, undefined);
    }

    // An unknown tool is a protocol error, not a tool result: there is no tool
    // to have run.
    const unknown = await rpc(h, {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "aztrx_nope", arguments: {} },
    });
    assert.equal(unknown.error.code, -32602);
    assert.match(unknown.error.message, /Unknown tool/);
  } finally {
    await h.stop();
  }
});

test("aztrx_repro: the steps and the spec for one finding", async () => {
  const specDir = tempDir("aztrx-spec-");
  const specPath = path.join(specDir, "f-1.spec.ts");
  fs.writeFileSync(specPath, "test('crash', async ({ page }) => {});\n", "utf-8");
  const finding = crashFinding({
    repro: {
      actions: [ACTION, { type: "input", selectors: ["input"], value: "ada", timestamp: 2 }],
      specPath,
      verdict: "deterministic",
      rate: 1,
      runs: 3,
      reproductions: 3,
    },
  });

  const h = await harness({ loadRun: async () => fakeRun([finding]) });
  try {
    const scan = await rpc(h, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "aztrx_scan", arguments: { repoPath: process.cwd(), url: FAKE_URL } },
    });
    const scanId = scan.result.structuredContent.scanId;

    const res = await rpc(h, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "aztrx_repro", arguments: { scanId, findingId: "f-1" } },
    });
    const s = res.result.structuredContent;
    assert.equal(s.verdict, "deterministic");
    assert.equal(s.reproductions, 3);
    assert.equal(s.actions.length, 2);
    assert.ok(s.spec.includes("test('crash'"));
    assert.match(res.result.content[0].text, /1\. click → #go/);
    assert.match(res.result.content[0].text, /2\. input "ada" → input/);
    // The spec path is reported repo-relative, because an absolute path in a
    // model's context is a path it cannot use in the project it is editing.
    assert.doesNotMatch(s.specPath, /^[A-Za-z]:/, "must not hand back an absolute path");

    const stale = await rpc(h, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "aztrx_repro", arguments: { scanId: "not-a-scan", findingId: "f-1" } },
    });
    assert.equal(stale.result.isError, true);
    assert.match(stale.result.content[0].text, /Unknown scanId/);
  } finally {
    await h.stop();
  }
});

test("handles are bounded, oldest first, and an evicted one says what to do", async () => {
  const h = await harness({ loadRun: async () => fakeRun([crashFinding()]) });
  try {
    const ids: string[] = [];
    for (let i = 1; i <= 9; i++) {
      const res = await rpc(h, {
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "aztrx_scan", arguments: { repoPath: process.cwd(), url: FAKE_URL, seed: i } },
      });
      ids.push(res.result.structuredContent.scanId);
    }
    const evicted = await rpc(h, {
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: { name: "aztrx_repro", arguments: { scanId: ids[0], findingId: "f-1" } },
    });
    assert.equal(evicted.result.isError, true);
    assert.match(evicted.result.content[0].text, /call aztrx_scan again/);

    const kept = await rpc(h, {
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: { name: "aztrx_repro", arguments: { scanId: ids[8], findingId: "f-1" } },
    });
    assert.equal(kept.result.isError ?? false, false);
  } finally {
    await h.stop();
  }
});

test("scans never overlap — run() rewrites .aztrx/ and boots a port", async () => {
  let live = 0;
  let peak = 0;
  const h = await harness({
    loadRun: async () =>
      async () => {
        live++;
        peak = Math.max(peak, live);
        await sleep(60);
        live--;
        return [crashFinding()];
      },
  });
  try {
    // Pipelined requests, which is what an editor's client actually does.
    for (let i = 1; i <= 4; i++) {
      h.send({
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "aztrx_scan", arguments: { repoPath: process.cwd(), url: FAKE_URL, seed: i } },
      });
    }
    await sleep(1_500);
    assert.equal(h.messages().length, 4);
    assert.equal(peak, 1, "two scans in one repo would clobber each other's artifacts and race for the port");
  } finally {
    await h.stop();
  }
});

test("aztrx_fix: passes heal what it needs, reports the status, applies only a verified patch", async () => {
  const repo = repoWith({ "index.html": "<script>const report; report.rows.length;</script>\n" });
  const finding = crashFinding();
  let seen: HealOptions | undefined;

  const healed: HealResult = {
    status: "healed",
    findingId: "f-1",
    filePath: "index.html",
    explanation: "guard the deref",
    hunks: [{ search: "const report; report.rows.length;", replace: "const report = {}; report.rows.length;" }],
    violations: [],
  };

  const h = await harness({
    loadRun: async () => fakeRun([finding]),
    loadHeal: async () => async (_f: Finding, opts: HealOptions): Promise<HealResult> => {
      seen = opts;
      return healed;
    },
  });
  try {
    const scan = await rpc(h, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "aztrx_scan", arguments: { repoPath: repo, url: FAKE_URL } },
    });
    const scanId = scan.result.structuredContent.scanId;

    const res = await rpc(h, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "aztrx_fix", arguments: { scanId, findingId: "f-1" } },
    });
    const s = res.result.structuredContent;
    assert.equal(s.status, "healed");
    assert.deepEqual(s.applied, null, "without `apply` nothing is written");
    assert.match(res.result.content[0].text, /apply: true/);
    // The gate is the whole reason `aztrx_fix` is not a `--heal` flag on the
    // scan: the repro the verdict was measured on must reach `heal` intact.
    assert.equal(seen?.repoRoot, repo);
    assert.equal(seen?.url, "http://127.0.0.1:9/");
    assert.deepEqual(seen?.actions, finding.repro?.actions);
    assert.equal(seen?.fingerprint, "fp-1");
    assert.equal(read(path.join(repo, "index.html")), "<script>const report; report.rows.length;</script>\n");

    const applied = await rpc(h, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "aztrx_fix", arguments: { scanId, findingId: "f-1", apply: true } },
    });
    assert.equal(
      read(path.join(repo, "index.html")),
      "<script>const report = {}; report.rows.length;</script>\n",
      "apply: true writes the verified hunks into the working tree"
    );
    assert.deepEqual(applied.result.structuredContent.applied, [
      { filePath: "index.html", hunkCount: 1 },
    ]);
    assert.match(applied.result.content[0].text, /never commits/);
  } finally {
    await h.stop();
  }
});

test("aztrx_fix: an unfixable finding is answered, not attempted", async () => {
  const noLocation = crashFinding({ mappedLocation: undefined });
  const flaky = crashFinding({
    repro: { actions: [ACTION], specPath: "", verdict: "unreliable", rate: 0.2, runs: 3, reproductions: 1 },
  });

  for (const [finding, pattern] of [
    [noLocation, /no own-code source location/],
    [flaky, /no deterministic repro/],
  ] as Array<[Finding, RegExp]>) {
    let healed = false;
    const h = await harness({
      loadRun: async () => fakeRun([finding]),
      loadHeal: async () => async (): Promise<HealResult> => {
        healed = true;
        return { status: "skipped", findingId: "", filePath: "", hunks: [], violations: [] };
      },
    });
    try {
      const scan = await rpc(h, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "aztrx_scan", arguments: { repoPath: process.cwd(), url: FAKE_URL } },
      });
      const res = await rpc(h, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "aztrx_fix",
          arguments: { scanId: scan.result.structuredContent.scanId, findingId: "f-1" },
        },
      });
      assert.equal(res.result.isError, true);
      assert.match(res.result.content[0].text, pattern);
      assert.equal(healed, false, "a fix that cannot be verified must not be paid for");
    } finally {
      await h.stop();
    }
  }
});

test("aztrx_fix: a patch that did not verify is never written", async () => {
  const repo = repoWith({ "index.html": "const report;\n" });
  const h = await harness({
    loadRun: async () => fakeRun([crashFinding()]),
    loadHeal: async () => async (): Promise<HealResult> => ({
      status: "unfixed",
      findingId: "f-1",
      filePath: "index.html",
      hunks: [{ search: "const report;", replace: "const report = {};" }],
      violations: [],
    }),
  });
  try {
    const scan = await rpc(h, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "aztrx_scan", arguments: { repoPath: repo, url: FAKE_URL } },
    });
    const res = await rpc(h, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "aztrx_fix",
        arguments: { scanId: scan.result.structuredContent.scanId, findingId: "f-1", apply: true },
      },
    });
    assert.equal(res.result.structuredContent.status, "unfixed");
    assert.equal(read(path.join(repo, "index.html")), "const report;\n");
    assert.match(res.result.content[0].text, /No patch/);
  } finally {
    await h.stop();
  }
});

test("aztrx_fix: no model configured is relayed as `no-llm`, with the way out", async () => {
  const h = await harness({
    loadRun: async () => fakeRun([crashFinding()]),
    loadHeal: async () => async (): Promise<HealResult> => ({
      status: "no-llm",
      findingId: "f-1",
      filePath: "index.html",
      hunks: [],
      violations: [],
      error: "this crash needs a model",
    }),
  });
  try {
    const scan = await rpc(h, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "aztrx_scan", arguments: { repoPath: process.cwd(), url: FAKE_URL } },
    });
    const res = await rpc(h, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "aztrx_fix",
        arguments: { scanId: scan.result.structuredContent.scanId, findingId: "f-1" },
      },
    });
    assert.equal(res.result.isError ?? false, false, "no key is an answer, not a tool failure");
    assert.equal(res.result.structuredContent.status, "no-llm");
    assert.match(res.result.content[0].text, /ANTHROPIC_API_KEY/);
  } finally {
    await h.stop();
  }
});

// ---------------------------------------------------------------------------
// The real thing: a spawned server on real stdio
// ---------------------------------------------------------------------------

interface Spawned {
  child: ChildProcess;
  out(): string;
  err(): string;
  send(msg: unknown): void;
  lines(): Message[];
  response(id: number | string, timeoutMs?: number): Promise<Message>;
  exited(timeoutMs: number): Promise<number | null>;
}

function spawnServer(cwd: string): Spawned {
  const child = spawn(process.execPath, [DIST_CLI, "mcp"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (err += d.toString()));

  const lines = (): Message[] =>
    out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Message;
        } catch {
          throw new Error(`the child wrote a non-JSON line to stdout: ${JSON.stringify(l)}`);
        }
      });

  return {
    child,
    out: () => out,
    err: () => err,
    send: (msg) => void child.stdin?.write(JSON.stringify(msg) + "\n"),
    lines,
    async response(id, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = lines().find((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no response to id ${String(id)}: ${err}`);
        await sleep(25);
      }
    },
    exited: (timeoutMs) =>
      new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        const timer = setTimeout(() => resolve(null), timeoutMs);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code ?? 0);
        });
      }),
  };
}

test(
  "over real stdio: the CLI serves the protocol, and closing stdin ends it",
  { timeout: 90_000 },
  async () => {
    const cwd = tempDir("aztrx-stdio-");
    const s = spawnServer(cwd);
    try {
      s.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "claude-code", version: "1" },
        },
      });
      const init = await s.response(1);
      assert.equal(init.result.protocolVersion, "2025-11-25");
      assert.equal(init.result.resultType, "complete");

      s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      s.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      s.send({ jsonrpc: "2.0", id: 3, method: "server/discover", params: {} });
      const list = await s.response(2);
      const discover = await s.response(3);
      assert.equal(list.result.tools.length, TOOLS.length);
      assert.deepEqual(discover.result.supportedVersions, [...SUPPORTED_VERSIONS]);

      // Nothing but protocol on stdout — the whole transport is one JSON object
      // per line, and a stray byte is a parser error at the client.
      assert.equal(s.lines().length, 3, "one line per response, and no more");

      // The stdio shutdown sequence starts with the client closing our stdin.
      // A server that ignores that step leaves an orphan on every editor exit.
      s.child.stdin?.end();
      assert.equal(await s.exited(20_000), 0, `the server did not exit on stdin end: ${s.err()}`);
    } finally {
      if (s.child.exitCode === null) s.child.kill("SIGKILL");
    }
  }
);

test("over real stdio: SIGTERM does not leave a server running", { timeout: 60_000 }, async () => {
  const cwd = tempDir("aztrx-stdio-");
  const s = spawnServer(cwd);
  try {
    const deadline = Date.now() + 20_000;
    while (!s.err().includes("serving") && Date.now() < deadline) await sleep(25);
    assert.match(s.err(), /serving 3 tools on stdio/, "the banner belongs on stderr, not stdout");
    assert.equal(s.out(), "", "nothing at all may reach stdout before a client asks for it");

    s.child.kill("SIGTERM");
    // On POSIX this runs the handler, which tears down booted dev servers first.
    // On Windows Node emulates SIGTERM with a forced termination, so what this
    // asserts there is the weaker but still necessary half: it dies.
    assert.notEqual(await s.exited(15_000), null, "the process survived a SIGTERM");
  } finally {
    if (s.child.exitCode === null) s.child.kill("SIGKILL");
  }
});

function helpFor(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [DIST_CLI, ...args], { encoding: "utf-8" }, (e, stdout) =>
      e ? reject(e) : resolve(stdout)
    );
  });
}

test("the CLI exposes `mcp`, and its help names both forms", async () => {
  // `mcp` with no action starts a server, so `--help` is the only way to see the
  // install form without an editor config to run it. If it is not documented
  // here, it is not discoverable.
  const top = await helpFor("--help");
  assert.match(top, /^\s*mcp\b/m, "`mcp` must appear in the command list");

  const help = await helpFor("mcp", "--help");
  assert.match(help, /\[action\]/, "the action is optional — bare `mcp` serves");
  assert.match(help, /install/);
  assert.match(help, /uninstall/);
  assert.match(help, /--force/);
});

// ---------------------------------------------------------------------------
// `mcp install` — merging into a file we do not own
// ---------------------------------------------------------------------------

const vscodeTarget = TARGETS.find((t) => t.id === "vscode") as (typeof TARGETS)[number];
const cursorTarget = TARGETS.find((t) => t.id === "cursor") as (typeof TARGETS)[number];
const claudeTarget = TARGETS.find((t) => t.id === "claude-code") as (typeof TARGETS)[number];

test("install: adds one key and leaves the other servers in the file alone", () => {
  const other = { command: "npx", args: ["-y", "some-other-server"] };
  const repo = repoWith({
    ".mcp.json": JSON.stringify({ mcpServers: { other }, _comment: "keep me" }, null, 2) + "\n",
  });

  const out = installInto(repo, claudeTarget, "9.9.9");
  assert.equal(out.status, "written");
  assert.match(out.message, /1 other server/);

  const doc = JSON.parse(read(path.join(repo, ".mcp.json")));
  assert.deepEqual(doc.mcpServers.other, other, "another server's config is not ours to touch");
  assert.equal(doc._comment, "keep me", "an unknown top-level key survives too");
  assert.deepEqual(doc.mcpServers[MCP_SERVER_NAME], serverEntry("9.9.9"));

  // Idempotent: a second run is not an error and does not rewrite the file.
  assert.equal(installInto(repo, claudeTarget, "9.9.9").status, "unchanged");
  // A version change *is* a change — the point of pinning.
  assert.equal(installInto(repo, claudeTarget, "9.9.10").status, "written");
});

test("install: VS Code's key is `servers`, and it is not the same key", () => {
  const repo = repoWith({ ".vscode/mcp.json": JSON.stringify({ servers: {}, inputs: [] }) });
  assert.equal(installInto(repo, vscodeTarget, "1.0.0").status, "written");

  const doc = JSON.parse(read(path.join(repo, ".vscode", "mcp.json")));
  assert.ok(doc.servers[MCP_SERVER_NAME], "VS Code reads `servers`");
  assert.equal(doc.mcpServers, undefined, "writing `mcpServers` here produces a file VS Code reads as empty");
  assert.deepEqual(doc.inputs, [], "the editor's own keys are kept");
});

test("install: an editor the project does not use is skipped, not written to", () => {
  const bare = repoWith({ ".mcp.json": "{}\n" });
  const res = installMcp(bare, "1.0.0");
  const byId = Object.fromEntries(res.outcomes.map((o) => [o.target.id, o]));

  assert.equal(byId["claude-code"].status, "written");
  assert.equal(byId.cursor.status, "skipped");
  assert.equal(byId.vscode.status, "skipped");
  assert.match(byId.cursor.message, /no \.cursor\//);
  assert.equal(fs.existsSync(path.join(bare, ".cursor")), false, "skipped means no directory created");

  const withDirs = repoWith({ ".mcp.json": "{}\n", ".cursor/mcp.json": "{}\n", ".vscode/mcp.json": "{}\n" });
  const all = installMcp(withDirs, "1.0.0");
  assert.deepEqual(
    all.outcomes.map((o) => o.status),
    ["written", "written", "written"]
  );
  assert.equal(all.changed, true);
  assert.deepEqual(JSON.parse(read(path.join(withDirs, ".cursor", "mcp.json"))).mcpServers.aztrx, serverEntry("1.0.0"));
});

test("install: a file that will not parse is refused, not clobbered", () => {
  const broken = '{ "mcpServers": { "other": {} }, }';
  const repo = repoWith({ ".mcp.json": broken });

  const refused = installInto(repo, claudeTarget, "1.0.0");
  assert.equal(refused.status, "refused");
  assert.equal(read(path.join(repo, ".mcp.json")), broken, "a JSON typo must not cost a user their config");

  const forced = installInto(repo, claudeTarget, "1.0.0", true);
  assert.equal(forced.status, "written");
  assert.match(forced.message, /\.bak/);
  assert.equal(read(path.join(repo, ".mcp.json.bak")), broken, "the escape hatch keeps the original");
  assert.deepEqual(JSON.parse(read(path.join(repo, ".mcp.json"))).mcpServers.aztrx, serverEntry("1.0.0"));
});

test("install: a `mcpServers` key that is not an object is refused, and forcing spares the rest", () => {
  const repo = repoWith({ ".mcp.json": JSON.stringify({ mcpServers: ["nope"], $schema: "x" }, null, 2) });
  assert.equal(installInto(repo, claudeTarget, "1.0.0").status, "refused");

  assert.equal(installInto(repo, claudeTarget, "1.0.0", true).status, "written");
  const doc = JSON.parse(read(path.join(repo, ".mcp.json")));
  assert.equal(doc.$schema, "x", "only the key we cannot merge into is dropped");
  assert.ok(doc.mcpServers.aztrx);
});

test("uninstall: removes only our key and keeps the file", () => {
  const other = { command: "npx", args: ["-y", "some-other-server"] };
  const repo = repoWith({
    ".mcp.json": JSON.stringify({ mcpServers: { other } }, null, 2),
    ".cursor/mcp.json": "{}\n",
  });
  installMcp(repo, "1.0.0");

  const out = uninstallFrom(repo, claudeTarget);
  assert.equal(out.status, "written");
  const doc = JSON.parse(read(path.join(repo, ".mcp.json")));
  assert.deepEqual(doc.mcpServers.other, other);
  assert.equal(doc.mcpServers.aztrx, undefined);

  // Emptying the map does not delete the file: a config we did not create is not
  // ours to remove on the strength of it looking empty afterwards.
  const cursor = uninstallFrom(repo, cursorTarget);
  assert.equal(cursor.status, "written");
  assert.ok(fs.existsSync(path.join(repo, ".cursor", "mcp.json")));
  assert.deepEqual(JSON.parse(read(path.join(repo, ".cursor", "mcp.json"))).mcpServers, {});

  assert.equal(uninstallMcp(repo).changed, false, "nothing left to remove");
  assert.equal(uninstallFrom(repo, vscodeTarget).status, "skipped");
});

test("install: writing into a directory that does not exist creates it", () => {
  const bare = repoWith({ "package.json": "{}\n" });
  fs.mkdirSync(path.join(bare, ".cursor"), { recursive: true });
  fs.rmSync(path.join(bare, ".cursor", "mcp.json"), { force: true });

  assert.equal(installInto(bare, cursorTarget, "1.0.0").status, "written");
  assert.ok(fs.existsSync(path.join(bare, ".cursor", "mcp.json")));
});

// ---------------------------------------------------------------------------
// End to end: a real app, a real browser, the whole loop
// ---------------------------------------------------------------------------

/** A project whose one button throws. `--port N` in the dev script is what
 * `planBoot` reads, so the boot lands on a port this test picked — the same
 * `scriptPort` path a real `vite --port 4000` takes. */
function bootableProject(port: number): string {
  const dir = tempDir("aztrx-mcpapp-");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "mcp-app", private: true, scripts: { dev: `node server.mjs --port ${port}` } })
  );
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>Reports</title></head>
<body><h1>Reports</h1><button id="go">Open report</button>
<script>
  document.getElementById("go").addEventListener("click", () => {
    const report = window.report;          // never assigned
    document.title = report.rows.length;   // 💥 reading 'rows'
  });
</script></body></html>`
  );
  fs.writeFileSync(
    path.join(dir, "server.mjs"),
    `import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const i = process.argv.indexOf("--port");
const port = Number(i >= 0 ? process.argv[i + 1] : process.env.PORT);
const file = fileURLToPath(new URL("./index.html", import.meta.url));
http.createServer((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => console.log("up on " + port));
`
  );
  return dir;
}

test(
  "end to end: aztrx_scan boots the app itself, and aztrx_repro returns the steps",
  { skip: hasChromium() ? false : "playwright chromium not installed", timeout: 300_000 },
  async () => {
    const port = await sparePort();
    const repo = bootableProject(port);
    const h = await harness({ defaultRepoRoot: repo });
    try {
      // No `url` — the zero-config path, which is the one an agent will use.
      const scan = await rpc(
        h,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "aztrx_scan", arguments: { repoPath: repo, maxActions: 40 } },
        },
        280_000
      );
      const s = scan.result.structuredContent;
      assert.equal(scan.result.isError ?? false, false, scan.result.content?.[0]?.text);
      assert.ok(s.counts.crash >= 1, `expected the click crash: ${scan.result.content[0].text}`);
      const f = s.findings[0];
      assert.equal(f.hasRepro, true);
      assert.equal(f.reproVerdict, "deterministic");

      const repro = await rpc(h, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "aztrx_repro", arguments: { scanId: s.scanId, findingId: f.id } },
      });
      const r = repro.result.structuredContent;
      assert.equal(r.verdict, "deterministic");
      assert.ok(r.actions.length > 0, "a click must be in the minimized sequence");
      assert.ok(r.spec, "the compiled spec is what makes the finding reproducible outside aztrx");

      // The app was booted for the scan and released after it. A dev server left
      // holding its port is the failure that only shows up as an orphan on
      // someone's laptop, days later.
      assert.equal(await isPortFree(port), true, "the booted dev server must be stopped again");
    } finally {
      await h.stop();
    }
    assert.equal(await isPortFree(port), true, "stopping the server must not leave the app running either");
  }
);

/** The honesty rule, against the real orchestrator rather than a fake — the fake
 * tests above can only prove what the *tool* does with findings, and the question
 * here is what `run()` hands it when the app was never reachable.
 *
 * What it hands back is a **finding**, not a rejection: `run()` reports the failed
 * navigation as `network_timeout`, so the tool returns `isError: false` with
 * `counts.error: 1` and a message naming `ERR_CONNECTION_REFUSED`. That is not the
 * failure this test guards against — "nothing is broken" and "nothing was looked
 * at" still read differently to a model, and the second one names the reason — so
 * the assertion is on the property that has to hold either way: a dead URL must
 * never come back *clean*.
 *
 * It does not, and cannot, separate "the app never answered" from "the app
 * answered 500". Both arrive as an error-severity network finding, because
 * `classifier.ts:133-135` maps `network_5xx`/`network_timeout` to `error` — which
 * is the same classification the git hook and the GitHub Action gate on. Worth a
 * decision; not one this test should make. */
test(
  "a scan against a port with nothing on it never reads as clean",
  { skip: hasChromium() ? false : "playwright chromium not installed", timeout: 180_000 },
  async () => {
    const repo = tempDir("aztrx-dead-");
    const port = await sparePort();
    const h = await harness({ defaultRepoRoot: repo });
    try {
      const res = await rpc(
        h,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "aztrx_scan",
            arguments: { repoPath: repo, url: `http://127.0.0.1:${port}/`, maxActions: 5 },
          },
        },
        170_000
      );
      const text = res.result.content[0].text as string;
      assert.doesNotMatch(text, /Clean scan/, `a dead URL read as clean: ${text}`);

      if (res.result.isError) {
        assert.equal(res.result.structuredContent, undefined, "no counts for an app never reached");
      } else {
        const s = res.result.structuredContent;
        assert.ok(s.counts.crash + s.counts.error > 0, `a dead URL read as clean: ${text}`);
        assert.match(text, /ERR_CONNECTION_REFUSED/, "the model must be able to see why");
        assert.equal(s.findings[0].location, null, "there is no source location for an unreachable app");
      }
    } finally {
      await h.stop();
    }
  }
);
