/**
 * The run ledger: what a discovery attempt cost and what it was given.
 *
 * Spend is counted from the token usage the provider reports, priced with
 * numbers the *operator* supplies. There is no built-in price table: a price we
 * remembered is a price we might have wrong, and the cap below is only as good
 * as the numbers behind it.
 */

import { createHash } from "node:crypto";
import type { LlmUsage } from "../llm.js";

export interface Pricing {
  /** USD per one million input / output tokens. */
  inputPerM: number;
  outputPerM: number;
}

export class BudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceeded";
  }
}

/** Read prices from `AZTRX_PRICE_IN` / `AZTRX_PRICE_OUT` (USD per 1M tokens). */
export function pricingFromEnv(env: NodeJS.ProcessEnv = process.env): Pricing | undefined {
  const i = Number(env.AZTRX_PRICE_IN);
  const o = Number(env.AZTRX_PRICE_OUT);
  return Number.isFinite(i) && Number.isFinite(o) && env.AZTRX_PRICE_IN && env.AZTRX_PRICE_OUT
    ? { inputPerM: i, outputPerM: o }
    : undefined;
}

export interface LedgerOptions {
  /** Hard cap in USD. Requires `pricing`; without it the ledger refuses to
   * start rather than run uncapped under a cap the operator thinks exists. */
  capUsd?: number;
  pricing?: Pricing;
}

export class Ledger {
  private readonly started = Date.now();
  inputTokens = 0;
  outputTokens = 0;
  calls = 0;
  readonly models = new Set<string>();

  constructor(private readonly opts: LedgerOptions = {}) {
    if (opts.capUsd !== undefined && !opts.pricing) {
      throw new Error("a spend cap needs prices — set AZTRX_PRICE_IN and AZTRX_PRICE_OUT (USD per 1M tokens)");
    }
  }

  get costUsd(): number | undefined {
    const p = this.opts.pricing;
    if (!p) return undefined;
    return (this.inputTokens * p.inputPerM + this.outputTokens * p.outputPerM) / 1_000_000;
  }

  get elapsedMs(): number {
    return Date.now() - this.started;
  }

  /** Feed from `setUsageSink`. */
  record = (u: LlmUsage): void => {
    this.calls++;
    this.inputTokens += u.inputTokens;
    this.outputTokens += u.outputTokens;
    this.models.add(u.model);
  };

  /**
   * Refuse a request whose *worst case* would cross the cap: the input is
   * priced from its size (4 chars per token, deliberately pessimistic for
   * English) and the output at its full `maxTokens`.
   */
  guard(promptChars: number, maxOutputTokens: number): void {
    const { capUsd, pricing } = this.opts;
    if (capUsd === undefined || !pricing) return;
    const worst =
      ((this.inputTokens + Math.ceil(promptChars / 4)) * pricing.inputPerM +
        (this.outputTokens + maxOutputTokens) * pricing.outputPerM) /
      1_000_000;
    if (worst > capUsd) {
      throw new BudgetExceeded(
        `next call could take spend to $${worst.toFixed(4)}, over the $${capUsd.toFixed(2)} cap (spent so far $${(this.costUsd ?? 0).toFixed(4)})`
      );
    }
  }

  summary() {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd ?? null,
      priced: Boolean(this.opts.pricing),
      capUsd: this.opts.capUsd ?? null,
      models: [...this.models],
      elapsedMs: this.elapsedMs,
    };
  }
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Strip anything shaped like a credential before text reaches a log or file. */
export function redact(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-key]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "[redacted-auth]")
    .replace(/\b(api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, "$1$2[redacted]");
}

/**
 * Post-hoc leak check, run by the *evaluator* (which holds the sealed answer),
 * never by the discovery process. Returns the sealed fragments that appear in
 * anything the agent was shown or produced. A non-empty result voids the run.
 */
export function findLeaks(agentVisible: string[], sealedFragments: string[]): string[] {
  const hay = agentVisible.join("\n").toLowerCase();
  return sealedFragments.filter((f) => f.trim().length >= 6 && hay.includes(f.trim().toLowerCase()));
}
