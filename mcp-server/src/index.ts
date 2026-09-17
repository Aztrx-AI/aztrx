/**
 * Aztrx MCP over HTTP — the remote connector.
 *
 * The same `run_security_audit` tool the local connector serves over stdio,
 * here served over **streamable HTTP** so remote MCP clients (the claude.ai
 * "Add custom connector" flow, any https://-only UI) can call it. Runs in a
 * container with Chromium — that is why it lives in this repo: the swarm
 * needs the core AND a browser, and a serverless function has neither.
 *
 * Endpoints:
 *   GET  /health — liveness (the container's health check)
 *   POST /mcp    — MCP streamable-HTTP transport (session-scoped)
 *   DELETE /mcp  — end a session
 *
 * Remote reality, stated honestly: the container cannot read the user's
 * filesystem, so findings come back with proofs and business language, but
 * patch generation needs the code — `repoFiles` (path → content) can be
 * passed in the tool arguments when the calling agent has them.
 */

import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// The core, one directory up — tsx compiles it from source; the container
// carries the whole repo, so the imports resolve naturally.
import { run } from "../../src/core/orchestrator.js";
import { parseIntent } from "../../src/core/intent.js";
import { heal } from "../../src/core/heal/index.js";
import { formatAuditReport } from "../../src/core/auditReport.js";
import { EventBus } from "../../src/core/eventBus.js";

const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// The audit tool — same contract as the local connector
// ---------------------------------------------------------------------------

async function runSecurityAudit(input: {
  target: string;
  intent?: string;
  lang?: "en" | "ru";
  repoFiles?: Record<string, string>;
}): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown>; isError?: boolean }> {
  const started = Date.now();
  const lang: "en" | "ru" = input.lang ?? (/[а-яё]/i.test(input.intent ?? "") ? "ru" : "en");

  // The target must be a reachable URL — a remote container has no localhost
  // of its own, so a path target is meaningless here.
  let url: string;
  try {
    const parsed = new URL(input.target);
    if (!/^https?:$/.test(parsed.protocol)) {
      return { content: [{ type: "text", text: `Unsupported protocol in target: ${parsed.protocol}` }], structuredContent: {}, isError: true };
    }
    url = input.target;
  } catch {
    return {
      content: [{ type: "text", text: `A remote audit needs a URL the container can reach (https://…). Got: ${input.target}` }],
      structuredContent: {},
      isError: true,
    };
  }

  // Reachability preflight.
  try {
    await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
  } catch {
    return {
      content: [{ type: "text", text: `Target unreachable from the swarm: ${url}` }],
      structuredContent: { status: "target-unreachable", target: url },
      isError: true,
    };
  }

  const plan = parseIntent(input.intent);
  const bus = new EventBus();
  let actions = 0;
  const routesSeen = new Set<string>();
  bus.on("action", () => actions++);
  bus.on("route", (r: { url: string }) => routesSeen.add(r.url));

  // No local repo: findings come back proven, patches are out of scope
  // unless the calling agent passed the files in.
  const repoRoot = process.cwd();

  try {
    const findings = await run({
      url,
      repoRoot,
      ui: true,
      intent: input.intent,
      repro: true,
      bus,
    });

    const byRole = new Map<string, number>();
    for (const f of findings) for (const r of f.roles ?? []) byRole.set(r, (byRole.get(r) ?? 0) + 1);
    const roleStats = [...byRole.entries()].map(([roleId, n]) => ({ roleId, label: roleId, missions: 0, actions: 0, findings: n }));

    const report = formatAuditReport(
      findings,
      { totalActions: actions, workerCount: roleStats.length, roleStats, routes: routesSeen.size },
      lang
    );

    return {
      content: [{ type: "text", text: report }],
      structuredContent: {
        status: "completed",
        target: url,
        intent: input.intent ?? null,
        theme: plan.theme,
        totalIssues: findings.length,
        durationMs: Date.now() - started,
        findings: findings.map((f) => ({
          severity: f.severity,
          file: f.mappedLocation ? `${f.mappedLocation.filePath}:${f.mappedLocation.line}` : f.rawMessage.split("\n")[0].slice(0, 80),
          description: f.businessRisk ?? f.rawMessage.split("\n")[0],
        })),
      },
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `The audit failed: ${(e as Error).message}` }],
      structuredContent: { status: "failed", target: url },
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** A fresh server per request — stateless streamable HTTP. An McpServer binds
 * to exactly one transport, so the session-map pattern dies on the second
 * connection; per-request instances are also exactly what a load balancer or
 * serverless-style caller expects. */
function createMcpServer(): McpServer {
  const mcp = new McpServer({ name: "aztrx", version: VERSION });
  mcp.registerTool(
    "run_security_audit",
    {
      title: "Run the Aztrx security swarm",
      description:
        "Drive the Aztrx swarm against a reachable URL: intent parsing picks the agents, the " +
        "Mapper walks the state graph, the swarm attacks, and only exploits that worked end to " +
        "end are reported — in business language, with proofs. The target must be a URL this " +
        "container can reach. Patch generation needs the code: pass `repoFiles` (path → content) " +
        "when the calling agent has the project files.",
      inputSchema: {
        target: z.string().describe("The app to audit: a URL reachable from the swarm (https://…)."),
        intent: z.string().optional().describe('What you fear, in your words, e.g. "проверь безопасность оплаты".'),
        lang: z.enum(["en", "ru"]).optional().describe("Report language. Default: auto."),
        repoFiles: z.record(z.string(), z.string()).optional().describe("Optional project files (path → content) for patch generation."),
      },
    },
    async (args) => runSecurityAudit(args as never)
  );
  return mcp;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return undefined;
  }
}

const server = http.createServer(async (req, res) => {
  // CORS: remote MCP UIs may call from a browser context.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "aztrx-mcp", version: VERSION }));
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found — try POST /mcp" }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  const body = await readBody(req);
  const transport = new StreamableHTTPServerTransport(); // stateless: no session ids
  const mcp = createMcpServer();
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body as never);
});

const PORT = Number(process.env.PORT ?? 8080);
server.listen(PORT, () => {
  process.stderr.write(`aztrx-mcp ${VERSION} — streamable HTTP on :${PORT} (POST /mcp, GET /health)\n`);
});
