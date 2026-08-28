/**
 * Secret redaction layer — F10 gate #1. Before any byte leaves the machine
 * (sent to an LLM, written to a log, streamed to a dashboard) it passes through
 * here. Redaction is *reversible*: the caller keeps the placeholder→secret map
 * so a generated Search & Replace diff (which references placeholders) can be
 * unredacted back onto the raw source before it is applied.
 */

export interface Redaction {
  text: string;
  map: Map<string, string>;
}

const PLACEHOLDER = (n: number) => `__AZTRX_REDACTED_${n}__`;

// Whole-match secrets: the entire match is replaced by a placeholder.
const WHOLE_MATCH: Array<{ re: RegExp; label: string }> = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, label: "private_key" },
  { re: /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, label: "api_key" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "aws_key" },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, label: "github_token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "github_token" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: "slack_token" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: "jwt" },
  { re: /\bBearer [A-Za-z0-9._-]{20,}/g, label: "bearer_token" },
  { re: /\bBasic [A-Za-z0-9+/=]{10,}\b/g, label: "basic_auth" },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, label: "google_api_key" },
  { re: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g, label: "stripe_key" },
];

// Prefix-preserving: group 1 stays in place (so the code structure — the key
// name, the scheme+user of a URL — remains visible to the model), group 2 is
// the secret value that is replaced.
const VALUE_MATCH: Array<{ re: RegExp; label: string }> = [
  {
    // `key = value` where the key is (or embeds) a secret-shaped word. Boundary
    // is "not a letter/digit" — so `_`/`-`/`.` join compound names like
    // `aws_secret_access_key` / `FOO_ACCESS_KEY`, while a plain `secret = x`
    // still matches. (JS `\b` treats `_` as a word char, which would miss the
    // compound forms — hence the explicit lookarounds.)
    re: /(["']?[A-Za-z0-9._-]*(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|auth[_-]?token|credential|authorization)(?![A-Za-z0-9])[A-Za-z0-9._-]*["']?\s*[:=]\s*)(["']?(?!__AZTRX_REDACTED_)[^"'\s;,&}{=]{8,}["']?)/gi,
    label: "secret_value",
  },
  {
    // CamelCase / bare form (`apiKey`, `accessToken`, `secretKey`) — the
    // lookaround form above misses these because the keyword is glued to a
    // letter. No boundary here, so a keyword directly before `:`/`=` matches
    // even mid-identifier.
    re: /(["']?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|auth[_-]?token|credential|authorization)["']?\s*[:=]\s*)(["']?(?!__AZTRX_REDACTED_)[^"'\s;,&}{=]{8,}["']?)/gi,
    label: "secret_value",
  },
  {
    re: /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|amqps):\/\/[^:/\s]+:)[^@\s]+(@)/gi,
    label: "url_password",
  },
];

export function redact(input: string): Redaction {
  const map = new Map<string, string>();
  let counter = 0;
  let text = input;

  for (const { re, label } of WHOLE_MATCH) {
    re.lastIndex = 0;
    text = text.replace(re, (match) => {
      const ph = PLACEHOLDER(counter++);
      map.set(ph, match);
      void label;
      return ph;
    });
  }

  for (const { re, label } of VALUE_MATCH) {
    re.lastIndex = 0;
    text = text.replace(re, (_match, prefix: string, secret: string) => {
      const ph = PLACEHOLDER(counter++);
      map.set(ph, secret);
      void label;
      return prefix + ph;
    });
  }

  return { text, map };
}

/** Reverse a redaction: swap every placeholder back to its original secret. */
export function unredact(input: string, map: Map<string, string>): string {
  let out = input;
  for (const [ph, secret] of map) out = out.split(ph).join(secret);
  return out;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Irreversible secret scrub for anything rendered to a human or written to a
 * report / PR comment. Runs the same patterns as `redact()` but discards the
 * map — every secret collapses to a fixed `[REDACTED]` token — then scrubs
 * emails, which `redact()` deliberately leaves alone (they aren't secrets and
 * the reversible layer must not mangle non-secret code it may need to patch).
 */
export function sanitizeSecrets(input: string): string {
  const { text } = redact(input);
  return text
    .replace(/__AZTRX_REDACTED_\d+__/g, "[REDACTED]")
    .replace(EMAIL_RE, "[REDACTED]");
}
