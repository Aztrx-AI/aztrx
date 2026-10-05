/**
 * Security behaviors — the Chaos Monkeys.
 *
 * These are the agents from the security co-founder spec. They share one
 * discipline: **proof or silence**. A finding is emitted only when the exploit
 * worked end to end — the gated route rendered, the escalated role was
 * accepted, the secret is in the page source. Anything short of that is noise,
 * and noise is exactly what a developer must never see.
 *
 * All four are self-limiting: no JWT in storage → tokenTamper does nothing,
 * no premium markers → paywallBypass sits still, no secret patterns → the SSR
 * scan reports nothing, no numeric id in a URL the page touched → objectRefAudit
 * does nothing. They cost almost nothing when they have no target.
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
  // Every href below is read off THIS page's DOM — the loop only ever
  // `fetch()`es each queued url, it never navigates there. Resolving a
  // relative href against the loop's current (queued) url instead of the
  // page's real, unchanging url compounds: a link into a subdirectory
  // (`orders/184.html`) resolved against itself again produces
  // `orders/orders/184.html`, then `orders/orders/orders/184.html` — an
  // unbounded queue that OOMs the process. `baseUrl` never changes here.
  const baseUrl = page.url();
  const startOrigin = originOf(baseUrl);
  const queue: string[] = [baseUrl];
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
        const target = new URL(href, baseUrl).href.split("#")[0];
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
  // See the identical comment in `ssrKeyScan` — this loop never navigates,
  // it only reads this page's DOM and `fetch()`es whatever's queued, so
  // every href must resolve against the page's real, unchanging url, not
  // against the loop's current queue item.
  const baseUrl = page.url();
  const startOrigin = originOf(baseUrl);
  const queue: string[] = [baseUrl];
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
        const target = new URL(h.href, baseUrl).href.split("#")[0];
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
        const target = new URL(href, baseUrl).href.split("#")[0];
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

/**
 * Object-reference authorization. The general question: for a URL the page
 * already touched that carries a numeric id in its path or query, does
 * swapping that id for a sibling under the SAME session return another
 * record's protected data? Deliberately narrow in what counts as evidence —
 * **proof or silence**, same discipline as the rest of this file:
 *
 *   same session + a different valid id (200) + a response that actually
 *   differs + an identity-shaped field (owner/user/account/tenant, or an
 *   email) that differs from the original — all four, or it's silent.
 *
 * A bare "200 on a modified id" is not evidence by itself: most apps have
 * plenty of ids that are supposed to be publicly interchangeable (a product
 * catalog, a blog post). Only a resource that both varies by id AND carries
 * an identity fingerprint earns a finding.
 *
 * v1 scope, by design: numeric ids only (path segment or query value), one
 * candidate id per URL, ±1 siblings. UUIDs/slugs are a real gap this leaves
 * open, not an oversight — see `bench/security/README.md`.
 */
export const IDENTITY_KEY_RE = /owner|user|account|tenant|customer/i;
const NUMERIC_ID_RE = /^\d+$/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface ObjectRefOptions {
  maxCandidates?: number;
  dryRun?: boolean;
}

/** Same-origin URLs the page actually issued or linked to — discovery rides
 * on real traffic, not a blind id-space crawl. A relative href (`orders/184`)
 * must resolve against the page's actual url, not its bare origin — against
 * the origin alone it silently loses the page's own directory and resolves
 * to the wrong path entirely. */
async function collectObjectUrls(page: Page, origin: string): Promise<string[]> {
  const baseUrl = page.url();
  const seen = new Set<string>();
  const push = (raw: string) => {
    try {
      const u = new URL(raw, baseUrl);
      if (u.origin === origin) seen.add(u.href);
    } catch {
      // unparseable — ignore
    }
  };

  const resources = await page
    .evaluate(() => performance.getEntriesByType("resource").map((e) => e.name))
    .catch(() => [] as string[]);
  for (const r of resources) push(r);

  const domUrls = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("a[href], form[action]")).map(
        (el) => el.getAttribute("href") ?? el.getAttribute("action") ?? ""
      )
    )
    .catch(() => [] as string[]);
  for (const u of domUrls) push(u);

  push(page.url());
  return [...seen];
}

/** One sibling pair for one numeric id in `u` — query first, then the last
 * numeric path segment. Only ever one id per URL in v1. */
function siblingCandidate(u: URL): { original: string; sibling: string } | null {
  for (const key of u.searchParams.keys()) {
    const val = u.searchParams.get(key) ?? "";
    if (!NUMERIC_ID_RE.test(val)) continue;
    const n = Number(val);
    const next = n + 1 > 0 ? n + 1 : n - 1;
    if (next <= 0) continue;
    const sib = new URL(u.toString());
    sib.searchParams.set(key, String(next));
    return { original: u.toString(), sibling: sib.toString() };
  }

  // A path segment is a numeric id even with a file extension attached
  // (`184.html`, `184.json`) — static-mirrored or document-style APIs carry
  // the id that way as often as a bare `/orders/184`.
  const segments = u.pathname.split("/");
  for (let i = segments.length - 1; i >= 0; i--) {
    const m = segments[i].match(/^(\d+)(\.[A-Za-z0-9]+)?$/);
    if (!m) continue;
    const n = Number(m[1]);
    const next = n + 1 > 0 ? n + 1 : n - 1;
    if (next <= 0) continue;
    const segs = [...segments];
    segs[i] = `${next}${m[2] ?? ""}`;
    const sib = new URL(u.toString());
    sib.pathname = segs.join("/");
    return { original: u.toString(), sibling: sib.toString() };
  }

  return null;
}

/** Identity-shaped values in a response: JSON `owner`/`user`/`account`/
 * `tenant`/`customer`-ish keys (one level deep), falling back to email
 * addresses in plain text/HTML. Generic on purpose — not tuned to any one
 * fixture's wording. */
function extractIdentitySignals(body: string): string[] {
  try {
    const json = JSON.parse(body);
    const out: string[] = [];
    const scan = (obj: unknown, depth: number): void => {
      if (depth > 1 || typeof obj !== "object" || obj === null) return;
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (IDENTITY_KEY_RE.test(k) && (typeof v === "string" || typeof v === "number")) {
          out.push(String(v));
        } else if (typeof v === "object") {
          scan(v, depth + 1);
        }
      }
    };
    scan(json, 0);
    if (out.length > 0) return out;
  } catch {
    // not JSON — fall through to the text oracle
  }
  return [...body.matchAll(EMAIL_RE)].map((m) => m[0]);
}

async function fetchIdCandidate(page: Page, url: string): Promise<{ status: number; body: string }> {
  return page.evaluate(async (u) => {
    try {
      const res = await fetch(u, { credentials: "include" });
      return { status: res.status, body: await res.text() };
    } catch {
      return { status: 0, body: "" };
    }
  }, url);
}

export async function objectRefAudit(
  page: Page,
  bus: EventBus,
  opts: ObjectRefOptions = {}
): Promise<{ candidates: number; findings: number }> {
  const maxCandidates = opts.maxCandidates ?? 20;
  const origin = originOf(page.url());
  const urls = await collectObjectUrls(page, origin);

  let candidates = 0;
  let findings = 0;

  for (const raw of urls) {
    if (candidates >= maxCandidates) break;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const pair = siblingCandidate(u);
    if (!pair) continue;
    candidates++;
    if (opts.dryRun) continue;

    const [orig, sib] = await Promise.all([
      fetchIdCandidate(page, pair.original),
      fetchIdCandidate(page, pair.sibling),
    ]);
    if (orig.status !== 200 || sib.status !== 200) continue;
    if (orig.body === sib.body) continue; // identical response — no evidence either way

    const origIds = extractIdentitySignals(orig.body);
    const sibIds = extractIdentitySignals(sib.body);
    const leaked = sibIds.find((id) => !origIds.includes(id));
    if (!leaked) continue; // a content diff with no identity signal is not proof

    findings++;
    const sibPath = new URL(pair.sibling).pathname + (new URL(pair.sibling).search || "");
    bus.emit("telemetry", {
      type: "secret_leak",
      rawMessage: `Object reference tampering accepted: swapping the id to ${sibPath} returned another identity's data (${leaked})`,
      rawStack: "",
    });
  }

  return { candidates, findings };
}

/**
 * Repeat-use audit. The business-logic counterpart to the access-control
 * primitives above: for a control that LOOKS single-use by convention
 * (apply/redeem/activate/claim a coupon, promo, voucher, gift card), click
 * it twice and watch a dollar figure on the page. **Proof or silence**:
 *
 *   the first click visibly changes a `$` amount, AND the second click
 *   (same control, same session) changes it AGAIN, differently — not just
 *   "clicked twice," a guarded action would show zero further change on
 *   the second click.
 *
 * Discovery is marker-scoped on purpose, same reasoning as `paywallBypass`:
 * plenty of actions are *correctly* repeatable (add-to-cart, like a post),
 * and testing "does repeating this change a number" against all of them
 * would make every repeatable control a false positive. The marker only
 * decides what to try, never the verdict — the dollar-amount diff does.
 */
const SINGLE_USE_MARKERS = /apply|redeem|activate|claim|use code|promo|coupon|voucher|discount code|gift card/i;
const MONEY_RE = /\$\s?\d{1,6}(?:\.\d{2})?/g;

export interface RepeatUseOptions {
  maxCandidates?: number;
  dryRun?: boolean;
}

function extractMoney(text: string): string[] {
  return [...text.matchAll(MONEY_RE)].map((m) => m[0].replace(/\s+/g, ""));
}

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
}

export async function repeatUseAudit(
  page: Page,
  bus: EventBus,
  opts: RepeatUseOptions = {}
): Promise<{ candidates: number; findings: number }> {
  const maxCandidates = opts.maxCandidates ?? 10;
  const handles = await page.$$("button, input[type=submit], a").catch(() => []);

  let candidates = 0;
  let findings = 0;

  for (const handle of handles) {
    if (candidates >= maxCandidates) break;

    const label = await handle
      .evaluate((el) => `${(el as HTMLElement).innerText ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("value") ?? ""}`)
      .catch(() => "");
    if (!SINGLE_USE_MARKERS.test(label)) continue;

    const visible = await handle.isVisible().catch(() => false);
    const enabled = await handle.isEnabled().catch(() => false);
    if (!visible || !enabled) continue;

    candidates++;
    if (opts.dryRun) continue;

    const before = extractMoney(await bodyText(page));
    await handle.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(150);
    const afterFirst = extractMoney(await bodyText(page));
    await handle.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(150);
    const afterSecond = extractMoney(await bodyText(page));

    const firstClickHadEffect = before.join(",") !== afterFirst.join(",");
    const secondClickHadEffectToo = afterFirst.join(",") !== afterSecond.join(",");
    if (!firstClickHadEffect || !secondClickHadEffectToo) continue; // no effect, or guarded after one use

    findings++;
    bus.emit("telemetry", {
      type: "business_logic_violation",
      rawMessage: `Repeatable single-use action: "${label.trim().slice(0, 40)}" has no single-use guard — clicking it twice changed the page twice (${before.join("/")} -> ${afterFirst.join("/")} -> ${afterSecond.join("/")})`,
      rawStack: "",
    });
  }

  return { candidates, findings };
}

/**
 * Flow-skip audit. The question: does a resource that should require
 * finishing a prior step (payment, an order) actually require it? Unlike
 * `paywallBypass` (which only tests links already on the one page it
 * loaded), this one builds a small reachability graph by actually
 * navigating — because the gated resource is often evidenced two or three
 * hops away, not on the entry page.
 *
 * Evidence sources, in order of how far they reach: links/forms on pages
 * visited while crawling, quoted path-like string literals in inline and
 * same-origin external `<script>` text (`const downloadUrl = "/files/x"`,
 * `navigate("/confirmation")`), and `/sitemap.xml` if the app has one.
 * **Never a guess** — a candidate that isn't evidenced by one of these
 * is never tried, which is the whole difference between this and a
 * filename wordlist.
 *
 * A candidate only counts if its evidence came from somewhere other than
 * a link on the entry page itself — content prominently linked from page
 * one was never gated by anything, so flagging it proves nothing. And a
 * bare 200 still isn't proof: the candidate's own fetched body must show
 * the terminal-looking content with no gate/denial text, under a session
 * that never submitted anything — proof or silence, same as every other
 * primitive in this file.
 */
const TERMINAL_MARKERS = /confirm|receipt|download|invoice|activated|unlocked|report|order/i;
const FLOW_GATE_RE =
  /(payment required|please (complete|pay)|access denied|not authorized|forbidden|sign in to continue|order not found|please complete checkout|404)/i;
const PATH_STRING_RE = /["'](\/[a-zA-Z0-9_\-./]{1,80})["']/g;

export interface FlowSkipOptions {
  maxPages?: number;
  maxCandidates?: number;
  dryRun?: boolean;
}

type EvidenceSource = "link-entry" | "link-deep" | "script" | "sitemap";

async function scriptEvidence(page: Page, origin: string): Promise<string[]> {
  const inline = await page
    .evaluate(() => Array.from(document.querySelectorAll("script:not([src])")).map((s) => s.textContent ?? ""))
    .catch(() => [] as string[]);
  const srcs = await page
    .evaluate(() => Array.from(document.querySelectorAll("script[src]")).map((s) => s.getAttribute("src") ?? ""))
    .catch(() => [] as string[]);

  const externals: string[] = [];
  for (const src of srcs.slice(0, 5)) {
    try {
      const u = new URL(src, page.url());
      if (u.origin !== origin) continue;
      const text = await page
        .evaluate(async (url) => {
          try {
            return await (await fetch(url, { credentials: "include" })).text();
          } catch {
            return "";
          }
        }, u.href)
        .catch(() => "");
      if (text) externals.push(text);
    } catch {
      // unparseable src — ignore
    }
  }

  const paths = new Set<string>();
  for (const text of [...inline, ...externals]) {
    for (const m of text.matchAll(PATH_STRING_RE)) paths.add(m[1]);
  }
  return [...paths];
}

/** Breadth-first crawl, bounded, that actually navigates (unlike the
 * single-page scans above) — the only way to see links/scripts that live
 * two hops from the entry page. Returns every same-origin url touched,
 * tagged with how it was found. */
async function collectFlowEvidence(
  page: Page,
  origin: string,
  entryUrl: string,
  maxPages: number
): Promise<Map<string, EvidenceSource>> {
  const evidence = new Map<string, EvidenceSource>();
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: entryUrl, depth: 0 }];
  let pages = 0;

  while (queue.length > 0 && pages < maxPages) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    pages++;

    if (!samePageUrl(page.url(), url)) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(200);
    }

    const links = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll("a[href], form[action]")).map(
          (el) => el.getAttribute("href") ?? el.getAttribute("action") ?? ""
        )
      )
      .catch(() => [] as string[]);
    for (const href of links) {
      if (!href || /^(javascript:|mailto:|tel:|#)/.test(href)) continue;
      try {
        const target = new URL(href, url).href.split("#")[0];
        if (!target.startsWith(origin)) continue;
        const source: EvidenceSource = depth === 0 ? "link-entry" : "link-deep";
        if (!evidence.has(target)) evidence.set(target, source);
        if (!visited.has(target) && queue.length + pages < maxPages * 2) queue.push({ url: target, depth: depth + 1 });
      } catch {
        // unparseable href — ignore
      }
    }

    for (const path of await scriptEvidence(page, origin)) {
      try {
        const target = new URL(path, origin).href;
        if (target.startsWith(origin) && !evidence.has(target)) evidence.set(target, "script");
      } catch {
        // unparseable path literal — ignore
      }
    }

    if (depth === 0) {
      const sitemap = await page
        .evaluate(async (base) => {
          try {
            const res = await fetch(new URL("/sitemap.xml", base).href);
            return res.ok ? await res.text() : "";
          } catch {
            return "";
          }
        }, origin)
        .catch(() => "");
      for (const m of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        try {
          const target = new URL(m[1].trim()).href;
          if (target.startsWith(origin) && !evidence.has(target)) evidence.set(target, "sitemap");
        } catch {
          // malformed <loc> — ignore
        }
      }
    }
  }

  return evidence;
}

function samePageUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

export async function flowSkipAudit(
  page: Page,
  bus: EventBus,
  opts: FlowSkipOptions = {}
): Promise<{ candidates: number; findings: number }> {
  const maxPages = opts.maxPages ?? 8;
  const maxCandidates = opts.maxCandidates ?? 10;
  const origin = originOf(page.url());
  const entryUrl = page.url();

  const evidence = await collectFlowEvidence(page, origin, entryUrl, maxPages);

  let candidates = 0;
  let findings = 0;

  for (const [url, source] of evidence) {
    if (candidates >= maxCandidates) break;
    if (source === "link-entry") continue; // prominently linked from page one — never gated by anything
    if (!TERMINAL_MARKERS.test(url)) continue;

    candidates++;
    if (opts.dryRun) continue;

    await page.evaluate(() => localStorage.clear()).catch(() => {});
    const res = await page
      .evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: "include" });
          return { status: r.status, body: await r.text() };
        } catch {
          return { status: 0, body: "" };
        }
      }, url)
      .catch(() => ({ status: 0, body: "" }));
    if (res.status !== 200) continue;
    if (FLOW_GATE_RE.test(res.body)) continue; // the wall held
    if (!TERMINAL_MARKERS.test(res.body)) continue; // 200, but nothing that looks like the protected content either

    findings++;
    bus.emit("telemetry", {
      type: "business_logic_violation",
      rawMessage: `Flow step skipped: ${new URL(url).pathname} (found via ${source}) rendered its protected content with no prior step completed and no gate`,
      rawStack: "",
    });
  }

  return { candidates, findings };
}
