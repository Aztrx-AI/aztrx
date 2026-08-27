import type { Page } from "playwright";
import type { EventBus } from "./eventBus.js";
import type { HttpRequestAction } from "./types.js";
import { network5xxMessage } from "./interceptor.js";

export interface HttpFuzzOptions {
  maxRequests?: number;
  dryRun?: boolean;
  /** Hostnames the fuzzer may target — the Node-side self-enforcement of the
   * deny-by-default policy (the browser `networkGuard` only wraps the `Page`). */
  allowHosts?: Set<string>;
}

// Static assets carry no server-side logic worth mutating — skip them so we
// spend the request budget on data/API routes.
const STATIC_EXT = /\.(js|mjs|cjs|css|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|otf|eot|mp4|webm)(\?|#|$)/i;

// Mirror the DOM deny-list (domWalker.ts) at the path level: never throw
// hostile requests at endpoints that mutate real state — delete, pay, logout, etc.
const DESTRUCTIVE_PATH = /(delete|remove|logout|sign\s?out|log\s?out|pay|checkout|purchase|buy|unsubscribe|purge|drop|truncate)/i;

const HOSTILE_QUERY: Array<[string, string]> = [
  ["id", "-1"],
  ["id", "0"],
  ["id", "99999999999999999999"],
  ["q", "%00"],
  ["q", "<script>alert(1)</script>"],
  ["q", "'; DROP TABLE users;--"],
  ["limit", "-1"],
  ["page", "0"],
  ["ids", "[1,2,3]"],
];

// JSON bodies that trip naive server handlers: type confusion, malformed
// payloads, prototype-pollution probes, and overflow numerics.
const JSON_BODIES = [
  "{}",
  "[]",
  "null",
  "0",
  "99999999999999999999",
  '{"id":[]}',
  '{"__proto__":{"polluted":true}}',
  '{"a":',
];

// Hostile but valid (undici-sendable) headers: oversized values and
// content-type confusion are the two most likely to trip a server handler.
const HOSTILE_HEADERS: Array<[string, string]> = [
  ["x-forwarded-for", "x".repeat(8192)],
  ["content-type", "application/json"],
  ["content-type", "text/html"],
  ["accept", "application/x-www-form-urlencoded"],
  ["cookie", "a".repeat(4096)],
];

/** Is this host allowed under the deny-by-default policy (loopback always is)? */
function hostAllowed(url: string, allowHosts: Set<string>): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  for (const h of allowHosts) {
    if (host === h || host.endsWith("." + h)) return true;
  }
  return false;
}

/** Harvest candidate endpoints the app actually uses — not blind probing. */
async function collectEndpoints(page: Page, origin: string): Promise<URL[]> {
  const seen = new Map<string, URL>();
  const push = (raw: string) => {
    let u: URL;
    try {
      u = new URL(raw, origin);
    } catch {
      return;
    }
    if (u.origin !== origin) return;
    if (STATIC_EXT.test(u.pathname)) return;
    if (DESTRUCTIVE_PATH.test(u.pathname)) return;
    if (!seen.has(u.pathname)) seen.set(u.pathname, u);
  };

  // URLs the page already fetched (API calls, RSC/data endpoints).
  const resources = await page
    .evaluate(() => performance.getEntriesByType("resource").map((e) => e.name))
    .catch(() => [] as string[]);
  for (const r of resources) push(r);

  // Links and form actions in the DOM.
  const domUrls = await page
    .evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("a[href], form[action]").forEach((el) => {
        const v = el.getAttribute("href") ?? el.getAttribute("action");
        if (v) out.push(v);
      });
      return out;
    })
    .catch(() => [] as string[]);
  for (const u of domUrls) push(u);

  push(origin + "/");

  return [...seen.values()];
}

/** Expand one endpoint into a bounded set of hostile requests. Deterministic. */
function buildRequests(endpoint: URL): HttpRequestAction[] {
  const reqs: HttpRequestAction[] = [];
  const base = endpoint.toString();

  // Query mutations — rewrite existing params, or append hostile ones.
  if (endpoint.search) {
    const keys = [...endpoint.searchParams.keys()].slice(0, 2);
    for (const key of keys) {
      for (const val of ["-1", "0", "99999999999999999999", "%00"]) {
        const u = new URL(base);
        u.searchParams.set(key, val);
        reqs.push({ method: "GET", url: u.toString() });
      }
    }
  } else {
    for (const [key, val] of HOSTILE_QUERY) {
      const u = new URL(base);
      u.searchParams.set(key, val);
      reqs.push({ method: "GET", url: u.toString() });
    }
  }

  // Body mutations via method confusion (POST/PUT, never DELETE).
  for (const body of JSON_BODIES) {
    reqs.push({
      method: "POST",
      url: base,
      headers: { "content-type": "application/json" },
      body,
    });
  }
  reqs.push({
    method: "PUT",
    url: base,
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  // Header injection on a plain GET.
  for (const [name, value] of HOSTILE_HEADERS) {
    reqs.push({ method: "GET", url: base, headers: { [name]: value } });
  }

  return reqs;
}

/**
 * F5-http — server-side mutation fuzzer. Harvests the endpoints the app really
 * uses, then throws seeded hostile requests at them (query overflow, JSON type
 * confusion, header injection, method confusion). A response `status >= 500`
 * becomes a `network_5xx` finding — same type and message format the interceptor
 * emits for in-browser requests — so it flows through the existing
 * ddmin → spec → validate → heal pipeline unchanged.
 */
export async function httpFuzz(
  page: Page,
  targetUrl: string,
  bus: EventBus,
  opts: HttpFuzzOptions = {}
): Promise<number> {
  const max = opts.maxRequests ?? 100;
  const allowHosts = opts.allowHosts ?? new Set<string>();

  if (!hostAllowed(targetUrl, allowHosts)) return 0;

  if (!opts.dryRun) {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  const endpoints = await collectEndpoints(page, new URL(targetUrl).origin);
  endpoints.sort((a, b) => a.pathname.localeCompare(b.pathname));

  let sent = 0;
  outer: for (const endpoint of endpoints) {
    for (const req of buildRequests(endpoint)) {
      if (sent >= max) break outer;

      const { pathname, search } = new URL(req.url);
      const label = `${req.method} ${pathname}${search}`;
      bus.emit("action", {
        type: "request",
        selectors: [],
        value: label,
        request: req,
        timestamp: Date.now(),
      });

      if (opts.dryRun) {
        sent++;
        continue;
      }

      let status = 0;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          signal: ctrl.signal,
        });
        status = res.status;
        await res.arrayBuffer().catch(() => {});
      } catch {
        // network error or timeout — hang detection is a follow-up slice
        status = 0;
      } finally {
        clearTimeout(timer);
      }

      if (status >= 500) {
        bus.emit("telemetry", {
          type: "network_5xx",
          rawMessage: network5xxMessage(status, req.url),
          rawStack: "",
        });
      }

      sent++;
    }
  }

  return sent;
}
