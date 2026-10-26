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
  // OpenAI-compatible providers, most-specific first:
  //  1) AZTRX_API_BASE — an explicit endpoint (OpenAI, Grok, OpenRouter, …)
  //  2) DEEPSEEK_API_KEY — DeepSeek's OpenAI-compatible API
  //  3) OPENAI_API_KEY — OpenAI proper, or whatever OPENAI_BASE_URL names
  const base = process.env.AZTRX_API_BASE?.trim();
  if (base) {
    return {
      provider: "openai",
      apiKey: process.env.AZTRX_API_KEY || process.env.OPENAI_API_KEY,
      baseUrl: base.replace(/\/+$/, ""),
    };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      provider: "openai",
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, ""),
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
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
  if ((s.baseUrl ?? "").includes("deepseek")) return process.env.AZTRX_MODEL || "deepseek-chat";
  return process.env.AZTRX_MODEL || "gpt-4o-mini";
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
  /** JSON Schema the reply must satisfy. Enforced by constrained decoding where the
   * transport supports it (Ollama native); ignored elsewhere, so callers still validate. */
  schema?: object;
  /** Let a reasoning model think before answering. Default off on the Ollama
   * transport: thinking tokens count against `maxTokens` there and can starve the answer. */
  think?: boolean;
}

/** A completion plus why it stopped — `length` means the text may be cut off. */
export interface CompletionResult {
  text: string;
  finishReason?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: object;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolReply {
  calls: ToolCall[];
  text: string;
  finishReason?: string;
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

/** Token usage of one completed request, as the provider reported it. */
export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

let usageSink: ((u: LlmUsage) => void) | undefined;

/** Observe the usage of every completion made from now on (one sink; pass
 * undefined to stop). Spend accounting hangs off this — the client itself
 * keeps no totals. */
export function setUsageSink(fn: ((u: LlmUsage) => void) | undefined): void {
  usageSink = fn;
}

/**
 * Ollama serves an OpenAI-compatible `/v1`, but that surface cannot turn thinking
 * off, so reasoning tokens eat `max_tokens`. Its native `/api/chat` can, and also
 * constrains output to a JSON Schema. An Ollama endpoint is therefore talked to
 * natively. Detected by the default port, or forced with `AZTRX_TRANSPORT=ollama`.
 */
export function isOllama(s: LlmSettings = resolveSettings()): boolean {
  if (process.env.AZTRX_TRANSPORT?.trim().toLowerCase() === "ollama") return true;
  if (s.provider !== "openai" || !s.baseUrl) return false;
  try {
    return new URL(s.baseUrl).port === "11434";
  } catch {
    return false;
  }
}

/** Run one completion against the active provider and return the text. */
export async function complete(opts: CompleteOptions): Promise<string> {
  return (await completeDetailed(opts)).text;
}

/** Like `complete`, but also reports the stop reason. */
export async function completeDetailed(opts: CompleteOptions): Promise<CompletionResult> {
  const s = resolveSettings();
  if (isOllama(s)) {
    const model = opts.model || primaryModel();
    announce(model, s.provider, s.baseUrl);
    const r = await ollamaChat(s, model, opts);
    return { text: r.text, finishReason: r.finishReason };
  }
  return { text: await completeRemote(opts) };
}

/**
 * One turn with tools the model may call. Supported on Ollama (native) and on
 * OpenAI-compatible endpoints; the Anthropic transport has none here.
 */
export async function completeWithTools(opts: CompleteOptions & { tools: ToolDef[] }): Promise<ToolReply> {
  const s = resolveSettings();
  const model = opts.model || primaryModel();
  announce(model, s.provider, s.baseUrl);
  if (isOllama(s)) return ollamaChat(s, model, opts);
  if (s.provider === "openai") return openaiTools(s, model, opts);
  throw new Error("tool calling is not implemented for the Anthropic transport");
}

async function completeRemote(opts: CompleteOptions): Promise<string> {
  const s = resolveSettings();
  const model = opts.model || primaryModel();
  if (!model) {
    throw new Error("no model configured — set AZTRX_MODEL (e.g. AZTRX_MODEL=gpt-4o)");
  }
  if (!s.apiKey) {
    throw new Error(
      s.provider === "anthropic"
        ? "ANTHROPIC_API_KEY is not set"
        : "no OpenAI-compatible key is set — AZTRX_API_KEY, OPENAI_API_KEY or DEEPSEEK_API_KEY"
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
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  usageSink?.({ model, inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 });
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
  // OpenAI proper rejects `max_tokens` on current models and `temperature` on
  // reasoning ones; other OpenAI-compatible endpoints still expect the old shape.
  const official = (s.baseUrl ?? "").includes("api.openai.com");
  const res = await fetch(`${s.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${s.apiKey}`,
    },
    body: JSON.stringify({
      model,
      ...(official
        ? { max_completion_tokens: opts.maxTokens ?? 2048 }
        : { max_tokens: opts.maxTokens ?? 2048, temperature: opts.temperature ?? 0 }),
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
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  usageSink?.({ model, inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 });
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

const toolWire = (tools: ToolDef[]) =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

function toArgs(raw: unknown): Record<string, unknown> {
  let v = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch { v = undefined; }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Native Ollama `/api/chat`: schema-constrained output, tool calls, thinking switch. */
async function ollamaChat(
  s: LlmSettings,
  model: string,
  opts: CompleteOptions & { tools?: ToolDef[] },
): Promise<ToolReply> {
  const root = (s.baseUrl ?? "http://localhost:11434").replace(/\/v1$/, "");
  const res = await fetch(`${root}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      stream: false,
      think: opts.think ?? false,
      // Ollama's default window is 4096 tokens shared by prompt and reply, and it silently
      // truncates beyond that — a real app's inventory plus a 6000-token reply does not fit.
      options: { temperature: opts.temperature ?? 0, num_predict: opts.maxTokens ?? 2048, num_ctx: Number(process.env.AZTRX_NUM_CTX) || 16384 },
      ...(opts.schema ? { format: opts.schema } : {}),
      ...(opts.tools ? { tools: toolWire(opts.tools) } : {}),
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
    error?: string;
    message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  if (data.error) throw new Error(`LLM request failed: ${data.error}`);
  usageSink?.({ model, inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 });
  const calls: ToolCall[] = (data.message?.tool_calls ?? []).map((c) => ({
    name: String(c.function?.name ?? ""),
    arguments: toArgs(c.function?.arguments),
  }));
  const text = data.message?.content ?? "";
  if (!calls.length && !text.trim()) throw emptyCompletion("Ollama", model, data.done_reason);
  return { calls, text, finishReason: data.done_reason };
}

async function openaiTools(s: LlmSettings, model: string, opts: CompleteOptions & { tools: ToolDef[] }): Promise<ToolReply> {
  const official = (s.baseUrl ?? "").includes("api.openai.com");
  const res = await fetch(`${s.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify({
      model,
      ...(official ? { max_completion_tokens: opts.maxTokens ?? 2048 } : { max_tokens: opts.maxTokens ?? 2048, temperature: opts.temperature ?? 0 }),
      tools: toolWire(opts.tools),
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
    choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  usageSink?.({ model, inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 });
  if (data.error) throw new Error(`LLM request failed: ${data.error.message ?? "unknown error"}`);
  const choice = data.choices?.[0];
  const calls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((c) => ({
    name: String(c.function?.name ?? ""),
    arguments: toArgs(c.function?.arguments),
  }));
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  if (!calls.length && !text.trim()) throw emptyCompletion("OpenAI-compatible endpoint", model, choice?.finish_reason);
  return { calls, text, finishReason: choice?.finish_reason };
}
