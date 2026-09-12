/**
 * MCP wire format — framing, version negotiation, result envelopes.
 *
 * Hand-rolled, deliberately. Revisions `2025-11-25` and earlier open with an
 * `initialize` handshake; `2026-07-28` removed it in favour of per-request
 * metadata. Editors are split across the two (Cursor still opens with
 * `initialize`), and neither official SDK speaks both: `@modelcontextprotocol/sdk`
 * is legacy-only and pulls 17 runtime dependencies — express, hono, cors, jose,
 * ajv — for a stdio server that needs none of them, and
 * `@modelcontextprotocol/server` is the new revision only. A server that speaks
 * one era is a server that is missing from somebody's editor. The spec has a name
 * for the thing that speaks both — **dual-era** — and rules for it, which this
 * follows rather than reinvents.
 *
 * This file imports nothing at all. It is loaded before the first request from
 * an editor, and editors time out servers that boot slowly.
 */

/** Every revision this server can serve, oldest first. `2026-07-28` is the one
 * that made `server/discover` mandatory and `resultType` required; the earlier
 * four are the handshake era, and `2025-06-18` / `2025-11-25` are what the
 * editors in the wild actually send today. */
export const SUPPORTED_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
] as const;

/** Newest revision implemented. Used only when we cannot serve what was asked
 * for — never to "upgrade" a client that asked for something older. */
export const LATEST_VERSION: string = SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1];

/** `_meta` keys, per the `_meta` naming rules in the 2026-07-28 base spec. */
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
/** `UnsupportedProtocolVersionError`, per the 2026-07-28 error-code table. The
 * number is not decorative: a modern client matches on it to tell "this server
 * speaks my language but not this dialect — retry with one off `supported`"
 * from "this server is old", and the two lead to opposite actions. */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

export type RpcId = string | number | null;

export interface RpcMessage {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** A failure of the *request* — bad method, bad shape. Distinct from a tool that
 * ran and reported a problem, which is a normal result with `isError: true`. */
export class ProtocolError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** One JSON-RPC message, one line. That is the stdio binding, and `JSON.stringify`
 * already guarantees it — a newline inside a string is escaped, never emitted raw. */
export function encode(message: unknown): string {
  return JSON.stringify(message) + "\n";
}

export type Decoded = { ok: true; msg: RpcMessage } | { ok: false; response: RpcMessage };

/** Parse one line. A line that is not JSON has an unknowable id, so the error
 * goes out with a null one — the JSON-RPC rule for exactly this case. */
export function decode(line: string): Decoded {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, response: error(null, PARSE_ERROR, "Parse error: line is not JSON") };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, response: error(null, INVALID_REQUEST, "Invalid request: not a JSON object") };
  }
  const msg = value as RpcMessage;
  if (typeof msg.method !== "string" && msg.id === undefined) {
    // A response we have no use for, or a garbage object. Either way there is
    // nothing to answer: an object with no method is not a request.
    return { ok: false, response: error(msg.id ?? null, INVALID_REQUEST, "Invalid request: no method") };
  }
  return { ok: true, msg };
}

/** A request expects exactly one response; a notification expects none, and
 * answering one is a protocol violation. `id` is what separates them — a
 * notification simply has no `id` member. */
export function isRequest(msg: RpcMessage): boolean {
  return typeof msg.method === "string" && msg.id !== undefined && msg.id !== null;
}

export function isNotification(msg: RpcMessage): boolean {
  return typeof msg.method === "string" && (msg.id === undefined || msg.id === null);
}

// ---------------------------------------------------------------------------
// Version negotiation
// ---------------------------------------------------------------------------

export function supports(version: unknown): version is string {
  return typeof version === "string" && (SUPPORTED_VERSIONS as readonly string[]).includes(version);
}

/** The version a *modern* request declares in `_meta`, or undefined for a legacy
 * request (which declares nothing — its version was fixed by `initialize`). */
export function declaredVersion(msg: RpcMessage): string | undefined {
  const meta = msg.params?.["_meta"];
  if (typeof meta !== "object" || meta === null) return undefined;
  const v = (meta as Record<string, unknown>)[META_PROTOCOL_VERSION];
  return typeof v === "string" ? v : undefined;
}

/** Which version to answer a legacy `initialize` with.
 *
 * The legacy spec makes this a **MUST**, not a courtesy: *"If the server supports
 * the requested protocol version, it MUST respond with the same version.
 * Otherwise, the server MUST respond with another protocol version it supports."*
 * So we echo what was asked for whenever we can serve it. Answering `initialize`
 * with our newest version when the client asked for an older one we support is a
 * spec violation, and it is the documented way to make a modern client refuse the
 * server outright ("Server's protocol version is not supported") — the client has
 * no fall-forward mechanism, so a needless mismatch is fatal, not merely noisy. */
export function negotiate(requested: unknown): string {
  return supports(requested) ? requested : LATEST_VERSION;
}

/** Reject a request that declares a version we do not implement. Returns a
 * ready-to-send error, or null when the request may proceed.
 *
 * Only modern requests declare a version; a legacy request carries none and is
 * served under legacy semantics for the life of the process. The `data` shape is
 * exact because it is load-bearing: the client picks a version off `supported`
 * and retries, so an inexact copy costs it the retry it needs. */
export function checkVersion(msg: RpcMessage): RpcMessage | null {
  const declared = declaredVersion(msg);
  if (declared === undefined || supports(declared)) return null;
  return error(msg.id ?? null, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
    supported: [...SUPPORTED_VERSIONS],
    requested: declared,
  });
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/** A successful result.
 *
 * `resultType: "complete"` is required on every result from `2026-07-28` on, and
 * older clients ignore fields they do not recognise — so it is written
 * unconditionally rather than behind an era check. One response shape for every
 * era is the whole reason this server can serve both. */
export function result(id: RpcId, payload: Record<string, unknown> = {}): RpcMessage {
  return { jsonrpc: "2.0", id, result: { resultType: "complete", ...payload } };
}

export function error(id: RpcId, code: number, message: string, data?: unknown): RpcMessage {
  const err: Record<string, unknown> = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error: err };
}

export function serverInfo(version: string): { name: string; version: string } {
  return { name: "aztrx-cli", version };
}
