/**
 * `aztrx-cli mcp` — the server an editor talks to.
 *
 * stdio transport, newline-delimited JSON-RPC, one message per line. That is the
 * whole interface; everything else is in `protocol.ts` (framing and the two
 * protocol eras), `tools.ts` (the three tools) and `install.ts` (writing the
 * editor config).
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 *  - **stdout belongs to the protocol.** One stray byte and the client's parser
 *    dies on a line it cannot read. The orchestrator is silent under `ui: true`,
 *    and `redirectStdoutToStderr` catches anything else that prints.
 *  - **Boot fast, import late.** Editors time out slow servers, so nothing heavy
 *    is imported at module load. Playwright arrives on the first scan, not on
 *    `initialize`.
 *  - **Exit when stdin ends.** The stdio shutdown sequence is: the client closes
 *    our stdin, waits, then escalates to SIGTERM and SIGKILL. A server that
 *    ignores the first step leaves an orphan holding a dev server's port and a
 *    Chromium handle after every editor session.
 */

import { format } from "util";
import { VERSION } from "../core/version.js";
import {
  checkVersion,
  decode,
  encode,
  error,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  isNotification,
  METHOD_NOT_FOUND,
  META_SERVER_INFO,
  negotiate,
  ProtocolError,
  result,
  serverInfo,
  SUPPORTED_VERSIONS,
  supports,
  type RpcId,
  type RpcMessage,
} from "./protocol.js";
import { McpRuntime, TOOLS } from "./tools.js";

/** What a model sees when the tools are first offered to it. Short on purpose:
 * it is prepended to every conversation that has this server attached. */
const INSTRUCTIONS =
  "aztrx drives the app in a real browser and reports the runtime crashes it produced. " +
  "Call aztrx_scan before claiming a change works — treat its clean result as the evidence " +
  "that the app still runs. A scan that could not run says so; it never reports 'no findings' " +
  "for an app it never reached. Findings are proven, not guessed: aztrx_repro shows the exact " +
  "steps that reproduce one, and aztrx_fix patches it and re-verifies by replaying them.";

/** Nothing here varies per caller or per connection, so both list results are
 * publicly cacheable. Long enough to be worth caching, short enough that a
 * version upgrade is picked up without a restart. */
const TOOLS_TTL_MS = 300_000;
const DISCOVER_TTL_MS = 3_600_000;

export interface ServerIO {
  input: NodeJS.ReadableStream;
  output: { write(chunk: string): unknown };
  error: { write(chunk: string): unknown };
}

export interface StartServerOptions {
  /** Project used when a tool call does not name one. */
  repoRoot?: string;
  /** Test seam. Omitted in production, where the server owns process.stdin and
   * process.stdout and installs the shutdown handlers — a test that installed
   * those would take the test process down with it. */
  io?: ServerIO;
  runtime?: McpRuntime;
}

export interface ServerHandle {
  /** Stop serving and release everything this process booted. Idempotent. */
  stop: () => Promise<void>;
  runtime: McpRuntime;
}

/** Reroute the console's stdout-bound writers to stderr, for good.
 *
 * `ui: true` already silences the orchestrator, so this is the net under the net:
 * a dependency's warning, or a `console.log` in some path nobody thought about,
 * would otherwise land in the middle of the protocol stream. Nothing is lost by
 * moving it — the spec sanctions stderr for *all* logging on stdio transports.
 * `console.error` and `console.warn` already write to stderr and are left alone.
 *
 * Returns the undo, which the tests use to prove the guard can fail. */
export function redirectStdoutToStderr(target: { write(chunk: string): unknown }): () => void {
  const previous = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    dir: console.dir,
  };
  const toStderr = (...args: unknown[]): void => {
    target.write(format(...args) + "\n");
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.dir = ((item: unknown) => toStderr(item)) as typeof console.dir;
  return () => {
    Object.assign(console, previous);
  };
}

export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  const real = opts.io === undefined;
  const io: ServerIO = opts.io ?? {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
  };
  const runtime = opts.runtime ?? new McpRuntime({ defaultRepoRoot: opts.repoRoot });

  const restoreConsole = redirectStdoutToStderr(io.error);

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /** One message, one line, written whole.
   *
   * No interleaving guard is needed: `process.stdout` is a Writable, and a
   * Writable runs its queued chunks in the order they were written, so two
   * responses can never splice into each other. */
  function send(message: RpcMessage): void {
    io.output.write(encode(message));
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  let stopping: Promise<void> | undefined;

  async function teardown(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      restoreConsole();
      // Dev servers this process booted are its children and nothing else will
      // reap them. A browser inside an in-flight scan cannot be reached from
      // here, but Playwright launches Chromium on a CDP pipe — this process
      // exiting closes it, and that is what shuts the browser down.
      await runtime.closeAll().catch(() => {});
    })();
    return stopping;
  }

  function discoverResult(): Record<string, unknown> {
    return {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      // Server identity lives in `_meta` under this key, not in a top-level
      // field — the shape is the spec's, and a client that reads it from
      // anywhere else reads nothing.
      _meta: { [META_SERVER_INFO]: serverInfo(VERSION) },
      instructions: INSTRUCTIONS,
      ttlMs: DISCOVER_TTL_MS,
      cacheScope: "public",
    };
  }

  /** The legacy handshake. Answering it at all is what makes this dual-era. */
  function initializeResult(msg: RpcMessage): Record<string, unknown> {
    const requested = msg.params?.["protocolVersion"];
    const agreed = negotiate(requested);
    if (!supports(requested)) {
      io.error.write(
        `aztrx mcp: client asked for protocol version ${JSON.stringify(requested)}, ` +
          `serving ${agreed}. Legacy clients have no fall-forward, so this may end the session.\n`
      );
    }
    return {
      protocolVersion: agreed,
      // Exactly what we serve. Declaring `prompts`, `resources`, `logging` or
      // `completions` would be a promise the code would break.
      capabilities: { tools: {} },
      serverInfo: serverInfo(VERSION),
      instructions: INSTRUCTIONS,
    };
  }

  async function toolCall(id: RpcId, msg: RpcMessage): Promise<RpcMessage> {
    const name = msg.params?.["name"];
    if (typeof name !== "string" || !name) {
      throw new ProtocolError(INVALID_PARAMS, "tools/call requires a `name`");
    }
    const raw = msg.params?.["arguments"];
    if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
      throw new ProtocolError(INVALID_PARAMS, "`arguments` must be an object");
    }
    const res = await runtime.call(name, (raw ?? {}) as Record<string, unknown>);
    return result(id, {
      content: res.content,
      structuredContent: res.structuredContent,
      isError: res.isError === true,
    });
  }

  async function route(msg: RpcMessage): Promise<RpcMessage> {
    const id = msg.id ?? null;
    switch (msg.method) {
      case "initialize":
        return result(id, initializeResult(msg));
      case "server/discover":
        return result(id, discoverResult());
      case "tools/list":
        // Deterministic order (the array is a literal) and cacheable. There is no
        // pagination: three tools fit in one page, so `nextCursor` is never sent
        // and a cursor from a client is ignored.
        return result(id, { tools: TOOLS, ttlMs: TOOLS_TTL_MS, cacheScope: "public" });
      case "tools/call":
        return toolCall(id, msg);
      // Removed by 2026-07-28, still sent by handshake-era clients as a liveness
      // check. Answering costs nothing and a -32601 here reads to some of them as
      // a dead server.
      case "ping":
        return result(id);
      default:
        throw new ProtocolError(METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
    }
  }

  async function handleRequest(msg: RpcMessage): Promise<RpcMessage> {
    const id = msg.id ?? null;
    try {
      return await route(msg);
    } catch (e) {
      if (e instanceof ProtocolError) return error(id, e.code, e.message, e.data);
      io.error.write(`aztrx mcp: ${(e as Error).stack ?? String(e)}\n`);
      return error(id, INTERNAL_ERROR, `Internal error: ${(e as Error).message}`);
    }
  }

  // In-flight requests, by id, with the way to mark one abandoned.
  const inflight = new Map<string, () => void>();
  const abandoned = new Set<string>();
  const keyOf = (id: RpcId): string => `${typeof id}:${String(id)}`;

  /** How a stdio client abandons a request — a cancelled scan, a user who hit
   * stop. A notification, so it gets no reply of its own, and the request it
   * names gets none either: a response to a request the client has moved on from
   * is worse than silence, because it desynchronises the id sequence. */
  function cancelInFlight(msg: RpcMessage): void {
    const raw = msg.params?.["requestId"];
    if (typeof raw !== "string" && typeof raw !== "number") return;
    const key = keyOf(raw);
    const cancel = inflight.get(key);
    if (!cancel) return;
    abandoned.add(key);
    cancel();
  }

  async function handleMessage(msg: RpcMessage): Promise<void> {
    if (isNotification(msg)) {
      if (msg.method === "notifications/cancelled") cancelInFlight(msg);
      return;
    }

    const versionRejected = checkVersion(msg);
    if (versionRejected) {
      send(versionRejected);
      return;
    }

    const key = keyOf(msg.id ?? null);
    let markAbandoned!: () => void;
    const abandonedSignal = new Promise<null>((resolve) => {
      markAbandoned = () => resolve(null);
    });
    inflight.set(key, markAbandoned);
    try {
      // We stop *waiting*, we cannot stop the browser mid-walk — `run()` has no
      // abort. The abandoned scan finishes in the background, its result is
      // discarded, and its `finally` still stops the dev server it booted, so
      // nothing is orphaned either way.
      const response = await Promise.race([handleRequest(msg), abandonedSignal]);
      if (response !== null && !abandoned.has(key)) send(response);
    } finally {
      inflight.delete(key);
      abandoned.delete(key);
    }
  }

  async function handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    try {
      const decoded = decode(line.trim());
      if (!decoded.ok) {
        send(decoded.response);
        return;
      }
      await handleMessage(decoded.msg);
    } catch (e) {
      // Nothing above should throw, and the protocol channel must survive it if
      // something does.
      io.error.write(`aztrx mcp: unhandled error on a request: ${(e as Error).message}\n`);
    }
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** Feed the reader ourselves rather than using `readline`.
   *
   * The framing is newline-delimited JSON, which is a five-line buffer loop and
   * gives exact control over what counts as a message. `readline` also runs
   * terminal handling when its input is a TTY, which a protocol channel should
   * never be subject to. A chunk that ends mid-line is carried over — plenty of
   * clients write a request in more than one `write()`. */
  let buffer = "";
  const onData = (chunk: string | Buffer): void => {
    buffer += chunk.toString();
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      void handleLine(line);
    }
  };
  const onEnd = (): void => {
    void exitNow(0);
  };

  io.input.on("data", onData);
  io.input.on("end", onEnd);

  async function exitNow(code: number): Promise<void> {
    await teardown();
    // Only a real process exits. A test that called `startServer` with its own
    // streams keeps running and asserts on what it captured.
    if (real) process.exit(code);
  }

  if (real) {
    process.on("SIGTERM", () => void exitNow(143));
    process.on("SIGINT", () => void exitNow(130));
  }

  io.error.write(`aztrx mcp ${VERSION} — serving ${TOOLS.length} tools on stdio\n`);

  return {
    runtime,
    stop: async () => {
      io.input.off("data", onData);
      io.input.off("end", onEnd);
      await teardown();
    },
  };
}
