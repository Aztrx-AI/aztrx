/**
 * Security behaviors — the Chaos Monkeys.
 *
 * These are the agents from the security co-founder spec. They share one
 * discipline: **proof or silence**. A finding is emitted only when the exploit
 * worked end to end — the gated route rendered, the escalated role was
 * accepted, the secret is in the page source. Anything short of that is noise,
 * and noise is exactly what a developer must never see.
 *
 * All three are self-limiting: no JWT in storage → tokenTamper does nothing,
 * no premium markers → paywallBypass sits still, no secret patterns → the SSR
 * scan reports nothing. They cost almost nothing when they have no target.
 */

import type { Page } from "playwright";
import { EventBus } from "./eventBus.js";
import { originOf } from "./domWalker.js";

/** Secret patterns that must never appear in HTML delivered to a browser.
 * Exported so heal's verification can re-scan a patched page with the same
 * table the detection used. */
export const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "Stripe live key", regex: /sk_live_[0-9a-zA-Z]{16,}/ },
  { name: "Stripe test key", regex: /sk_test_[0-9a-zA-Z]{16,}/ },
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "OpenAI key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "private key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "JWT secret", regex: /(jwt|session)[_-]?secret["'\s:=]+["'][A-Za-z0-9_-]{16,}["']/i },
  { name: "Slack webhook", regex: /hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/ },
  { name: "Generic bearer token", regex: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
];

export interface SsrScanOptions {
  /** Max routes to fetch and scan. */
  maxRoutes?: number;
  dryRun?: boolean;
}

/** Crawl internal routes, fetch each route's raw HTML (what the browser
 * receives — SSR + hydration payloads), and scan it for secrets. Emits a
 * `secret_leak` telemetry per hit, redacted to the key kind, never the value. */
export async function ssrKeyScan(
  page: Page,
  bus: EventBus,
  opts: SsrScanOptions = {}
): Promise<{ routes: number; leaks: number }> {
  const maxRoutes = opts.maxRoutes ?? 20;
  const startOrigin = originOf(page.url());
  const queue: string[] = [page.url()];
  const visited = new Set<string>();
  let routes = 0;
  let leaks = 0;

  const scan = (html: string, url: string): void => {
    for (const pattern of SECRET_PATTERNS) {
      const m = html.match(pattern.regex);
      if (!m) continue;
      leaks++;
      // `url` + `line` give the finding a source location (resolveFrame maps
      // the route to the file), so heal can read and patch the leaking file.
      bus.emit("telemetry", {
        type: "secret_leak",
        rawMessage: `Secret exposed in page source: ${pattern.name} on ${new URL(url).pathname || "/"} (from SSR/hydration HTML)`,
        rawStack: "",
        url,
        line: 1,
      });
    }
  };

  while (queue.length > 0 && routes < maxRoutes) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    routes++;

    // Fetch the raw response text — what the SERVER sent, not what the DOM
    // looks like after hydration. This is where SSR leaks live.
    const raw = await page
      .evaluate(async (u) => {
        try {
          const res = await fetch(u, { credentials: "include" });
          return await res.text();
        } catch {
          return "";
        }
      }, url)
      .catch(() => "");
    if (raw) scan(raw, url);

    // The DOM's own hydration payloads (__NEXT_DATA__ and friends) can leak
    // keys even when the visible markup is clean.
    const jsonBlobs = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('script[type="application/json"], script[id^="__"]'))
          .map((s) => s.textContent ?? "")
          .join("\n")
      )
      .catch(() => "");
    if (jsonBlobs) scan(jsonBlobs, url);

    // Discover internal links for the next fetch.
    const hrefs = await page
      .evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? ""))
      .catch(() => [] as string[]);
    for (const href of hrefs) {
      if (!href || /^(javascript:|mailto:|tel:|#)/.test(href)) continue;
      try {
        const target = new URL(href, url).href.split("#")[0];
        if (target.startsWith(startOrigin) && !visited.has(target) && queue.length < 30) {
          queue.push(target);
        }
      } catch {
        // unparseable href — ignore
      }
    }
  }

  return { routes, leaks };
}

function jwtOf(value: string): { token: string } | null {
  // A JWT: three base64url parts, header.payload.signature.
  if (!/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./.test(value)) return null;
  return { token: value };
}

function b64urlDecode(part: string): Record<string, unknown> | null {
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

function b64urlEncode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface TokenTamperOptions {
  maxTokens?: number;
  dryRun?: boolean;
}

/** Collect JWT-shaped tokens from localStorage and cookies. */
async function collectTokens(page: Page): Promise<Array<{ storage: "localStorage" | "cookie"; key: string; token: string }>> {
  const found: Array<{ storage: "localStorage" | "cookie"; key: string; token: string }> = [];
  const ls = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) out[k] = localStorage.getItem(k) ?? "";
    }
    return out;
  }).catch(() => ({} as Record<string, string>));
  for (const [key, value] of Object.entries(ls)) {
    const t = jwtOf(value);
    if (t) found.push({ storage: "localStorage", key, token: t.token });
  }
  const cookies = await page.context().cookies().catch(() => []);
  for (const c of cookies) {
    const t = jwtOf(c.value);
    if (t) found.push({ storage: "cookie", key: c.name, token: t.token });
  }
  return found;
}

/** Does the page now show admin/premium evidence it didn't before? */
async function escalatedEvidence(page: Page): Promise<string | null> {
  const markers = await page
    .evaluate(() => {
      const text = document.body?.innerText ?? "";
      const adminHits = /(admin panel|administrator|manage users|управление пользователями|панель администратора)/i.exec(text);
      if (adminHits) return adminHits[0];
      const premiumHits = /(premium plan active|your plan: premium|pro features unlocked|подписка активна|премиум активен)/i.exec(text);
      if (premiumHits) return premiumHits[0];
      return null;
    })
    .catch(() => null);
  return markers;
}

/**
 * JWT/role tampering. For every token in storage: try alg:none and role-claim
 * escalation, reload, and look for evidence the tampered identity was
 * ACCEPTED (admin/premium UI appears). Emits a finding per proven escalation,
 * then restores the original token.
 */
export async function tokenTamper(
  page: Page,
  bus: EventBus,
  opts: TokenTamperOptions = {}
): Promise<{ tokens: number; escalations: number }> {
  const tokens = await collectTokens(page);
  let escalations = 0;

  for (const t of tokens.slice(0, opts.maxTokens ?? 5)) {
    const parts = t.token.split(".");
    const header = b64urlDecode(parts[0]);
    const payload = b64urlDecode(parts[1]);
    if (!header || !payload || parts.length < 3) continue;

    // Candidate claim to escalate: the one that smells like a role/plan.
    const roleKey = Object.keys(payload).find((k) => /role|admin|plan|tier|perm|scope/i.test(k));
    if (!roleKey) continue;

    const original = t.token;
    try {
      // 1) alg:none — strip the signature and drop the alg.
      const noneToken = `${b64urlEncode({ ...header, alg: "none" })}.${parts[1]}.`;
      // 2) Role escalation — flip the claim to the most privileged value we can name.
      const escalatedToken = `${parts[0]}.${b64urlEncode({ ...payload, [roleKey]: "admin" })}.${parts[2]}`;

      for (const [attempt, forged] of [
        ["alg:none", noneToken],
        [`${roleKey}=admin`, escalatedToken],
      ] as const) {
        if (opts.dryRun) continue;
        if (t.storage === "localStorage") {
          await page.evaluate(({ k, v }) => localStorage.setItem(k, v), { k: t.key, v: forged }).catch(() => {});
        } else {
          await page.context().addCookies([{ name: t.key, value: forged, url: page.url() }]).catch(() => {});
        }
        await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(800);

        const evidence = await escalatedEvidence(page);
        if (evidence) {
          escalations++;
          bus.emit("telemetry", {
            type: "secret_leak",
            rawMessage: `Token tampering accepted: ${attempt} on ${t.key} opened "${evidence}" — the app trusted a forged identity claim`,
            rawStack: "",
          });
        }
        // Restore the original before the next attempt.
        if (t.storage === "localStorage") {
          await page.evaluate(({ k, v }) => localStorage.setItem(k, v), { k: t.key, v: original }).catch(() => {});
        } else {
          await page.context().addCookies([{ name: t.key, value: original, url: page.url() }]).catch(() => {});
        }
      }
    } catch {
      // A tamper attempt that throws is not a finding — proof or silence.
    }
  }

  return { tokens: tokens.length, escalations };
}

const PREMIUM_MARKERS = /(upgrade|premium|pro\b|unlock|subscribe|paywall|обновит|премиум|подпис|купить|оплатит|разблокиров)/i;

export interface PaywallOptions {
  maxRoutes?: number;
  dryRun?: boolean;
}

/**
 * Paywall bypass. Finds premium-gated routes, visits them directly (fresh
 * storage — no payment, no auth), and reports a finding only when premium
 * content actually renders anyway. Proof or silence.
 */
export async function paywallBypass(
  page: Page,
  bus: EventBus,
  opts: PaywallOptions = {}
): Promise<{ routes: number; bypasses: number }> {
  const maxRoutes = opts.maxRoutes ?? 15;
  const startOrigin = originOf(page.url());
  const queue: string[] = [page.url()];
  const visited = new Set<string>();
  const gated: string[] = [];
  let bypasses = 0;

  // Pass 1 — find premium markers: gated links and locked controls.
  while (queue.length > 0 && gated.length < maxRoutes) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    const hits = await page
      .evaluate(({ markerSource }) => {
        const marker = new RegExp(markerSource, "i");
        const found: Array<{ href: string; label: string }> = [];
        for (const a of document.querySelectorAll("a[href]")) {
          const label = ((a as HTMLElement).innerText ?? "").trim();
          const attrs = `${a.getAttribute("aria-label") ?? ""} ${a.getAttribute("href") ?? ""}`;
          if (marker.test(`${label} ${attrs}`)) {
            found.push({ href: a.getAttribute("href") ?? "", label: label.slice(0, 60) });
          }
        }
        const lockText = (document.body?.innerText ?? "").match(/locked|premium only|upgrade to access|только для|требуется подписка/i);
        return { found, lockText: lockText?.[0] ?? "" };
      }, { markerSource: PREMIUM_MARKERS.source })
      .catch(() => ({ found: [], lockText: "" }));

    for (const h of hits.found) {
      try {
        const target = new URL(h.href, url).href.split("#")[0];
        if (target.startsWith(startOrigin) && !gated.includes(target)) gated.push(target);
      } catch {
        // unparseable href — ignore
      }
    }
    if (hits.lockText && !gated.includes(url)) gated.push(url);

    const hrefs = await page
      .evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? ""))
      .catch(() => [] as string[]);
    for (const href of hrefs) {
      if (!href || /^(javascript:|mailto:|tel:|#)/.test(href)) continue;
      try {
        const target = new URL(href, url).href.split("#")[0];
        if (target.startsWith(startOrigin) && !visited.has(target) && queue.length < 30) queue.push(target);
      } catch {
        // unparseable href — ignore
      }
    }
  }

  // Pass 2 — direct access, clean slate: no storage, no cookies, no payment.
  for (const url of gated) {
    if (opts.dryRun) continue;
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);

    // Evidence: premium-labeled content rendered without a payment/auth gate.
    const evidence = await page
      .evaluate(() => {
        const text = document.body?.innerText ?? "";
        const paywallGate = /(upgrade to access|sign in to continue|требуется подписка|войдите, чтобы продолжить|оплатите, чтобы)/i;
        const premiumContent = /(download( the)? file|скачать файл|your download is ready|premium content|полный доступ)/i;
        if (paywallGate.test(text)) return null; // the wall held
        const hit = premiumContent.exec(text);
        return hit ? hit[0] : null;
      })
      .catch(() => null);

    if (evidence) {
      bypasses++;
      bus.emit("telemetry", {
        type: "secret_leak",
        rawMessage: `Paywall bypassed: ${new URL(url).pathname || "/"} renders "${evidence}" without payment or login`,
        rawStack: "",
      });
    }
  }

  return { routes: gated.length, bypasses };
}
