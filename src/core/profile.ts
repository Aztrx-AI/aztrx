/**
 * Project profile — the swarm's quick read of what it is looking at.
 *
 * Before any agent moves, a scout pass answers one question: what kind of
 * product is this, and who uses it? The answer comes from three free,
 * deterministic sources — no LLM, no key, a few seconds:
 *
 *   1. package.json — dependencies say a lot (stripe → payments,
 *      socket.io → realtime, monaco → editors).
 *   2. README head — the project's own words about itself.
 *   3. the running app — labels, input types and links on the first route.
 *
 * The raw text is fed to a curated signal table; signals map to domains
 * (e-commerce, collaboration, media, …). synthesize.ts turns domains into
 * audience personas.
 */

import * as fs from "fs";
import * as path from "path";
import type { Page } from "playwright";
import { detectFrameworkMeta } from "./init.js";

/** One domain signal: a regex over app/library text, and the domain it votes for. */
interface SignalRule {
  id: string;
  regex: RegExp;
  domain: string;
}

/** Curated rules — deliberately coarse; this is a first impression, not a census. */
const SIGNAL_RULES: SignalRule[] = [
  { id: "cart", regex: /\b(cart|basket|checkout|purchase|buy now|add to cart)\b/i, domain: "e-commerce" },
  { id: "pricing", regex: /\b(price|discount|coupon|promo|sale|subscription|billing)\b/i, domain: "e-commerce" },
  { id: "payments-lib", regex: /\b(stripe|paypal|braintree|adyen|klarna|square)\b/i, domain: "e-commerce" },
  { id: "auth", regex: /\b(sign ?in|log ?in|sign ?up|password|auth|o ?auth|sso)\b/i, domain: "accounts" },
  { id: "upload", regex: /\b(upload|drop ?zone|attach|file (picker|input)|import file)\b/i, domain: "files" },
  { id: "chat", regex: /\b(chat|message|thread|mention|comment|inbox|dm)\b/i, domain: "collaboration" },
  { id: "editor", regex: /\b(monaco|codemirror|editor|canvas|draw|slate|tiptap|prosemirror|quill)\b/i, domain: "creation" },
  { id: "analytics", regex: /\b(dashboard|report|analytics|chart|metrics|kpi|insight)\b/i, domain: "analytics" },
  { id: "realtime", regex: /\b(socket\.io|websocket|realtime|live|stream)\b/i, domain: "realtime" },
  { id: "media", regex: /\b(video|audio|stream|player|podcast|transcode)\b/i, domain: "media" },
  { id: "search", regex: /\b(search|filter|sort by|facet)\b/i, domain: "search" },
  { id: "devtools", regex: /\b(api key|webhook|token|sdk|endpoint|integration)\b/i, domain: "developer" },
  { id: "geo", regex: /\b(mapbox|leaflet|geolocation|map|address|postal|latitude)\b/i, domain: "geo" },
  { id: "game", regex: /\b(score|level|leaderboard|achievement|multiplayer|matchmaking)\b/i, domain: "gaming" },
];

export interface ProjectProfile {
  /** Domains the signals voted for, most-voted first (max 2). */
  domains: string[];
  /** The signal ids that fired. */
  signals: string[];
  framework: string;
}

/** Feed raw text through the signal table; returns the firing signal ids. */
export function extractSignals(text: string): string[] {
  const hits = new Set<string>();
  for (const rule of SIGNAL_RULES) {
    if (rule.regex.test(text)) hits.add(rule.id);
  }
  return [...hits];
}

/** Read the static half of the profile: package.json deps + README head. */
export function profileFromRepo(repoRoot: string): { deps: string; readmeHead: string; framework: string } {
  let deps = "";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
    deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).join(" ");
  } catch {
    // no package.json — not a fatal problem, the DOM scan still speaks
  }
  let readmeHead = "";
  for (const name of ["README.md", "readme.md"]) {
    try {
      readmeHead = fs.readFileSync(path.join(repoRoot, name), "utf-8").slice(0, 4000);
      break;
    } catch {
      // try the next spelling
    }
  }
  let framework = "";
  try {
    framework = detectFrameworkMeta(repoRoot).framework ?? "";
  } catch {
    // framework detection is best-effort
  }
  return { deps, readmeHead, framework };
}

/** The running-app half: labels, input types and links of the first route. */
async function domText(page: Page): Promise<string> {
  const text = await page
    .evaluate(() => {
      const labels = Array.from(document.querySelectorAll("button, a, label, input, [placeholder], [aria-label]"))
        .map((el) => {
          const attrs = `${el.getAttribute("placeholder") ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("type") ?? ""}`;
          return `${(el as HTMLElement).innerText ?? ""} ${attrs}`;
        })
        .join(" ");
      return `${labels} ${document.body?.innerText ?? ""}`;
    })
    .catch(() => "");
  return text.slice(0, 20000);
}

/** The scout pass: one quiet page load, then merge all three sources. */
export async function analyzeTarget(page: Page, repoRoot: string): Promise<ProjectProfile> {
  const staticProfile = profileFromRepo(repoRoot);
  const text = `${staticProfile.deps} ${staticProfile.readmeHead} ${await domText(page)}`;

  const signals = extractSignals(text);
  const domainVotes = new Map<string, number>();
  for (const s of signals) {
    const rule = SIGNAL_RULES.find((r) => r.id === s);
    if (rule) domainVotes.set(rule.domain, (domainVotes.get(rule.domain) ?? 0) + 1);
  }
  const domains = [...domainVotes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([d]) => d);

  return { domains, signals, framework: staticProfile.framework };
}
