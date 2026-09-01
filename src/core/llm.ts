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

/** Human-readable description of the active provider + model, e.g. `grok-2 via https://api.x.ai/v1`. */
export function describeLlm(model?: string): string {
  const s = resolveSettings();
  const m = model || primaryModel();
  if (s.provider === "anthropic") return `${m} (Anthropic)`;
  return `${m} via ${s.baseUrl}`;
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

  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  return (data.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
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

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type?: string; text?: string } =>
          typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
      )
      .map((c) => (c as { text?: string }).text ?? "")
      .join("\n");
  }
  return "";
}
