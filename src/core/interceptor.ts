import type { Page } from "playwright";
import { extractFrame } from "./resolver.js";
import type { EventBus } from "./eventBus.js";

/**
 * Canonical 5xx finding message. Shared by the interceptor (passive in-browser
 * capture) and the HTTP mutation fuzzer (active Node-side capture) so the two
 * produce byte-identical `rawMessage`s — otherwise a finding's fingerprint and
 * its replay fingerprint would diverge and repro would never match.
 */
export function network5xxMessage(status: number, url: string): string {
  return `HTTP ${status} ${url}`;
}

// Route unhandled rejections through console.error so a single capture path
// handles them alongside React Error Boundary logs (both land in console.error).
const INIT_SCRIPT = `
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    console.error("Unhandled Promise Rejection:", reason);
  });
`;

/**
 * F1 — CDP interceptor. Attaches capture to a page and emits typed
 * `telemetry` events on the bus. No framework hooks: works on React
 * (17/18/19), Next.js, Vite, Svelte, Remix, and Vue alike.
 *
 * The subtle part: `console.error` is the ONLY runtime-level way to see
 * errors a React Error Boundary swallows, because the boundary logs them
 * there instead of rethrowing — so `window.onerror` / `pageerror` never fire
 * for them. We pull the real throw-site stack off the Error *object* via
 * `msg.args()`, not `msg.text()` (which is just the message, no stack).
 */
export function attachInterceptor(page: Page, bus: EventBus): void {
  page.on("console", async (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();

    // The init script routes `unhandledrejection` through console.error with a
    // fixed prefix; recover the true signal type so Server Action failures and
    // other promise rejections classify as "error", not "warning".
    const type = text.startsWith("Unhandled Promise Rejection:")
      ? "unhandled_rejection"
      : "console_error";

    let source = text;
    for (const arg of msg.args()) {
      try {
        const s = await arg.evaluate((a) =>
          a instanceof Error ? a.stack || String(a) : String(a)
        );
        if (s.includes("http")) {
          source = s;
          break;
        }
      } catch {
        // non-serializable arg — keep msg.text()
      }
    }

    const loc = msg.location();
    const frame =
      extractFrame(source) ??
      ({ url: loc.url, line: loc.lineNumber, column: loc.columnNumber, message: text.split("\n")[0].slice(0, 200) });

    bus.emit("telemetry", {
      type,
      rawMessage: frame.message,
      rawStack: source,
      url: frame.url,
      line: frame.line,
      column: frame.column,
    });
  });

  page.on("crash", () => {
    bus.emit("telemetry", {
      type: "uncaught_exception",
      rawMessage: "Renderer process crashed",
      rawStack: "",
    });
  });

  page.on("pageerror", (err) => {
    const frame = extractFrame(err.stack ?? "");
    bus.emit("telemetry", {
      type: "uncaught_exception",
      rawMessage: err.message,
      rawStack: err.stack ?? err.message,
      url: frame?.url,
      line: frame?.line,
      column: frame?.column,
    });
  });

  page.on("requestfailed", (req) => {
    const f = req.failure();
    bus.emit("telemetry", {
      type: "network_timeout",
      rawMessage: `Request failed: ${req.url()} (${f?.errorText ?? "unknown"})`,
      rawStack: "",
    });
  });

  page.on("response", (res) => {
    if (res.status() >= 500) {
      bus.emit("telemetry", {
        type: "network_5xx",
        rawMessage: network5xxMessage(res.status(), res.url()),
        rawStack: "",
      });
    }
  });

  page.addInitScript(INIT_SCRIPT);
}
