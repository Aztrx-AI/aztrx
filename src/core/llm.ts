/**
 * Provider-agnostic LLM client. Two transports behind one `complete()`:
 *
 *   - Anthropic Messages API (default) — key from `ANTHROPIC_API_KEY` (or
 *     `AZTRX_API_KEY`), primary model defaults to `claude-sonnet-5`.
 *   - Any OpenAI-compatible `/chat/completions` endpoint — selected by setting
 *     `AZTRX_API_BASE`. That single flag unlocks OpenAI, Grok, DeepSeek, Gemini,
 *     Kimi, Mistral, OpenRouter, and local models (Ollama / vLLM / LM Studio)
 *     with their existing keys.
 *
 * `AZTRX_MODEL` / `AZTRX_FAST_MODEL` pick the model(s); they default sensibly
 * for Anthropic and must be set explicitly when a custom base URL is used.
 */

export type Provider = "anthropic" | "openai";

export interface LlmSettings {
  provider: Provider;
  apiKey?: string;
  baseUrl?: string;
}

/** Resolve the active provider from the environment. */
export function resolveSettings(): LlmSettings {
  const base = process.env.AZTRX_API_BASE?.trim();
  if (base) {
    return {
      provider: "openai",
      apiKey: process.env.AZTRX_API_KEY || process.env.OPENAI_API_KEY,
      baseUrl: base.replace(/\/+$/, ""),
    };
  }
  return {
    provider: "anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.AZTRX_API_KEY,
  };
}

/** Is any provider configured? Used to decide whether to attempt an LLM call. */
export function hasLlmKey(): boolean {
  return Boolean(resolveSettings().apiKey);
}

/** The primary model for the active provider. */
export function primaryModel(): string {
  const s = resolveSettings();
  if (s.provider === "anthropic") return process.env.AZTRX_MODEL || "claude-sonnet-5";
  return process.env.AZTRX_MODEL || "";
}

/** The cheap/fast first tier, or undefined when the provider has none. */
export function fastModel(): string | undefined {
  const s = resolveSettings();
  if (s.provider === "anthropic") return process.env.AZTRX_FAST_MODEL || "claude-haiku-4-5-20251001";
  return process.env.AZTRX_FAST_MODEL || undefined;
}

export interface CompleteOptions {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

// Announce the resolved model once per distinct (provider, model), so the two-tier
// router shows each tier as it's tried without spamming. Written to stderr so it never
// corrupts the Ink TUI (which renders on stdout).
const announced = new Set<string>();
function announce(model: string, provider: Provider, baseUrl?: string): void {
  const key = `${provider}:${model}`;
  if (announced.has(key)) return;
  announced.add(key);
  const label = provider === "anthropic" ? `${model} (Anthropic)` : `${model} via ${baseUrl}`;
  process.stderr.write(`LLM: ${label}\n`);
}

/** Run one completion against the active provider and return the text. */
export async function complete(opts: CompleteOptions): Promise<string> {
  const s = resolveSettings();
  const model = opts.model || primaryModel();
  if (!model) {
    throw new Error("no model configured — set AZTRX_MODEL (e.g. AZTRX_MODEL=gpt-4o)");
  }
  if (!s.apiKey) {
    throw new Error(
      s.provider === "anthropic"
        ? "ANTHROPIC_API_KEY is not set"
        : "AZTRX_API_KEY (or OPENAI_API_KEY) is not set"
    );
  }
  announce(model, s.provider, s.baseUrl);
  return s.provider === "anthropic"
    ? anthropicComplete(s, model, opts)
    : openaiComplete(s, model, opts);
}

/**
 * Turn an empty completion into a diagnosable error.
 *
 * Returning `""` here is what makes a provider-side failure reach the caller as
 * `Unexpected end of JSON input` — a message that points at *our* parser rather
 * than at the model, and which the heal path then degrades to a bland "no-llm".
 * The stop reason is the entire diagnosis, so it is carried into the message.
 *
 * Real cases this covers: a free/contended endpoint failing mid-flight
 * (`finish_reason: "error"` on OpenRouter), a reasoning model spending the whole
 * budget before emitting any text (`length`), and provider-side filters.
 */
function emptyCompletion(provider: string, model: string, reason?: string): Error {
  const why =
    reason === "length" || reason === "max_tokens"
      ? "the token limit was reached before any text was emitted — the model is most likely spending its whole budget on reasoning; pick a different one with --heal-model / AZTRX_MODEL"
      : reason === "error"
        ? "the provider failed mid-response"
        : reason === "content_filter"
          ? "the provider blocked the response"
          : reason === "refusal"
            ? "the model refused the request"
            : "the provider returned no text";
  const seen = reason ? `finish_reason: ${reason}` : "no finish_reason given";
  return new Error(`${provider} returned no content (${seen}) — ${why}. Model: ${model}`);
}

async function anthropicComplete(
  s: LlmSettings,
  model: string,
  opts: CompleteOptions,
): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": s.apiKey as string,
    "anthropic-version": "2023-06-01",
  };
  // Identity-linked API keys must name the workspace they act in.
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  if (workspaceId) headers["anthropic-workspace-id"] = workspaceId;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0,
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string;
  };
  const text = (data.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  if (!text.trim()) throw emptyCompletion("Anthropic", model, data.stop_reason);
  return text;
}

async function openaiComplete(
  s: LlmSettings,
  model: string,
  opts: CompleteOptions,
): Promise<string> {
  const res = await fetch(`${s.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${s.apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.prompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    error?: { message?: string };
    choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>;
  };
  // OpenRouter reports upstream failures in the body with HTTP 200, so `res.ok`
  // alone does not mean the model answered.
  if (data.error) throw new Error(`LLM request failed: ${data.error.message ?? "unknown error"}`);

  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (c): c is { type?: string; text?: string } =>
          typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
      )
      .map((c) => (c as { text?: string }).text ?? "")
      .join("\n");
    if (text.trim()) return text;
  }
  throw emptyCompletion("OpenAI-compatible endpoint", model, choice?.finish_reason);
}
