import * as http from "http";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { loadConfig, type Config } from "./config.js";
import { buildKeyIndex, resolveOrg } from "./auth.js";
import { Store } from "./store.js";
import type { RunUpload, TelemetryEnvelopeUpload } from "./types.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        if (!tooLarge) {
          tooLarge = true;
          reject(new Error("payload too large"));
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function apiKeyOf(req: http.IncomingMessage): string | undefined {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

function isRunUpload(v: unknown): v is RunUpload {
  const o = v as RunUpload;
  return !!o && o.schema === "aztrx.run/1" && typeof o.sentAt === "string" && Array.isArray(o.findings);
}

function isTelemetryEnvelope(v: unknown): v is TelemetryEnvelopeUpload {
  const o = v as TelemetryEnvelopeUpload;
  return !!o && o.schema === "aztrx.telemetry/1" && typeof o.sentAt === "string" && Array.isArray(o.tuples);
}

/** Build the HTTP server. Exporting (rather than auto-listening) lets the smoke
 * test drive the whole ingest path in-process on an ephemeral port. */
export function createIngestServer(cfg: Config = loadConfig()): http.Server {
  const keyIndex = buildKeyIndex(cfg.keys);
  const store = new Store(cfg.dataDir);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-api-key, authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return void res.end();
    }

    const pathname = (req.url ?? "/").split("?")[0];

    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { ok: true, orgs: Object.keys(cfg.keys).length });
    }

    // Everything below requires a valid org key.
    const meta = resolveOrg(keyIndex, apiKeyOf(req));
    if (!meta) return sendJson(res, 401, { ok: false, error: "invalid api key" });

    if (req.method === "POST" && pathname === "/api/runs") {
      try {
        const body = await readBody(req);
        if (!isRunUpload(body)) return sendJson(res, 400, { ok: false, error: "invalid run payload" });
        const runId = randomUUID();
        const dedup = store.recordRun(meta.org, runId, body);
        return sendJson(res, 201, {
          ok: true,
          run_id: runId,
          findings: dedup.length,
          new: dedup.filter((d) => d.isNew).length,
        });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: (e as Error).message });
      }
    }

    if (req.method === "POST" && pathname === "/api/telemetry") {
      try {
        const body = await readBody(req);
        if (!isTelemetryEnvelope(body)) return sendJson(res, 400, { ok: false, error: "invalid telemetry payload" });
        const dedup = store.recordTelemetry(meta.org, body.tuples);
        return sendJson(res, 201, {
          ok: true,
          accepted: dedup.length,
          new: dedup.filter((d) => d.isNew).length,
        });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: (e as Error).message });
      }
    }

    if (req.method === "GET" && pathname === "/api/org") {
      return sendJson(res, 200, {
        ok: true,
        org: meta.org,
        label: meta.label,
        runs: store.listRuns(meta.org).length,
        findings: store.listFindings(meta.org),
      });
    }

    return sendJson(res, 404, { ok: false, error: "not found" });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal error" });
      else res.end();
    });
  });
}

// Run directly (`tsx server/index.ts`)? Start listening.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cfg = loadConfig();
  const server = createIngestServer(cfg);
  server.listen(cfg.port, () => {
    console.log("Aztrx cloud ingest");
    console.log(`   → http://localhost:${cfg.port}`);
    console.log(`   data: ${cfg.dataDir}`);
    console.log(`   keys: ${Object.keys(cfg.keys).length} org(s)`);
    console.log("   Ctrl+C to stop");
  });
}
