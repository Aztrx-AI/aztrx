/**
 * Telemetry sanitizer — the privacy gate before any byte is packaged. A strict
 * superset of the heal redaction layer, applied irreversibly: secrets first
 * (the redaction map is discarded), then URLs, webpack namespaces, and
 * repo-absolute paths. The output must be safe to leave the machine even if the
 * user's app, routes, and file layout are proprietary.
 */

import { redact } from "../heal/redact.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Anonymize a single URL: strip query/fragment/userinfo; keep only a localhost
 * authority (already anonymous) or a literal `<host>` placeholder. The route
 * path is kept — it's structural, not identifying.
 */
export function sanitizeUrl(raw: string): string {
  const noQuery = raw.split(/[?#]/)[0];
  const m = noQuery.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(\/.*)?$/i);
  if (!m) return noQuery;
  const scheme = m[1];
  const authority = m[2];
  const pathPart = m[3] ?? "";
  const hostPort = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  const host = hostPort.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (LOCAL_HOSTS.has(host)) return `${scheme}${hostPort}${pathPart}`;
  return `${scheme}<host>${pathPart}`;
}

const URL_RE = /https?:\/\/[^\s"')\]]+/g;
const WEBPACK_RE = /webpack:\/\/[^/\s]+/g;

export interface Sanitizer {
  url: (raw: string) => string;
  text: (raw: string) => string;
}

/** Bound to a repo root so repo-absolute paths and the repo name can be scrubbed. */
export function createSanitizer(repoRoot: string): Sanitizer {
  const rootFwd = repoRoot.replace(/\\/g, "/");
  const rootBk = repoRoot.replace(/\//g, "\\");
  const rootFwdRe = new RegExp(escapeRe(rootFwd), "g");
  const rootBkRe = new RegExp(escapeRe(rootBk), "g");

  return {
    url: sanitizeUrl,
    text(raw: string): string {
      // 1. Secrets — irreversibly (the placeholder→secret map is discarded).
      let out = redact(raw).text;
      // 2. URLs — anonymize the authority, drop query-string secrets.
      out = out.replace(URL_RE, (u) => sanitizeUrl(u));
      // 3. Webpack namespaces embed the repo name.
      out = out.replace(WEBPACK_RE, "webpack://<repo>");
      // 4. Repo-absolute paths (both separators) → `<repo>`.
      out = out.replace(rootFwdRe, "<repo>");
      out = out.replace(rootBkRe, "<repo>");
      return out;
    },
  };
}
