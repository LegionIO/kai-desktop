/**
 * CostMeter — hybrid token-budget enforcer for the real-API integration slice.
 *
 * Design (see docs/testing-conventions.md for the underlying rationale):
 *
 *   • Pre-call gate (T3): before a model call, estimate worst-case cost using
 *     the provider's authoritative token-counting endpoint (Anthropic's
 *     `messages.count_tokens`) for the input, plus `max_tokens × output_price`
 *     for the worst-case output. If the projection would push the cumulative
 *     spend past either the per-test or the suite-wide cap, the call is
 *     refused before bytes go on the wire. Estimates NEVER mutate the ledger.
 *
 *   • Post-call reconcile (T2): the authoritative spend comes from the SDK's
 *     `onFinish.usage` (`LanguageModelUsage`). Only those numbers update the
 *     running totals. This means a token-price drift between the table here
 *     and the provider's billing only affects the pre-call gate's worst-case
 *     projection — never the ledger row that lands on disk.
 *
 *   • Retry policy (R3): the AI SDK's internal exponential backoff fires
 *     transparently; `onFinish.usage` is the cumulative figure across every
 *     attempt the SDK made. CostMeter records that single rolled-up value;
 *     it does NOT try to track per-attempt usage. (R3 in the plan.)
 *
 *   • Tiered failure (F3 → F2 → F1):
 *       F3  per-test cap (default $1) — one runaway test can't tank others
 *       F2  on per-test trip: ledger row marked `cost_capped: true`, suite
 *           continues to the next test
 *       F1  suite-wide cap (default $5) — hard ceiling; on trip the ledger
 *           is flushed and `process.exit(1)` fires so CI fails loud
 *
 * Ledger format: JSONL, one row per test. See `LedgerRow` for the shape.
 *
 * Price tables below are hand-maintained; the comment on each block points
 * at the source-of-truth pricing page. Update when prices change — the T2
 * reconcile path reads `onFinish.usage` so pricing drift here only affects
 * the pre-call gate's worst-case projection, never what lands in the ledger.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ─── Price tables ──────────────────────────────────────────────────────────
// Dollars per million tokens (1e-6 $/token). The pre-call gate uses these;
// the ledger does not.

/**
 * Anthropic — https://www.anthropic.com/pricing (Messages API)
 *
 * Each entry covers a model family. Add a new entry when adding a new model
 * to the real-API smoke set. If the smoke set asks for a model that's not in
 * the table, the gate raises rather than silently letting the call through.
 */
const ANTHROPIC_PRICES: Record<string, AnthropicPriceEntry> = {
  'claude-3-5-haiku-latest': {
    inputPerMTok: 0.8,
    outputPerMTok: 4.0,
    cacheWritePerMTok: 1.0,
    cacheReadPerMTok: 0.08,
  },
  'claude-3-5-haiku-20241022': {
    inputPerMTok: 0.8,
    outputPerMTok: 4.0,
    cacheWritePerMTok: 1.0,
    cacheReadPerMTok: 0.08,
  },
};

interface AnthropicPriceEntry {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

/**
 * OpenAI — https://openai.com/api/pricing
 *
 * Same shape as Anthropic. OpenAI exposes cached-input pricing for some
 * models; on the mini models in this table cached input matches uncached, so
 * the field is omitted and the gate treats cache_read as input-priced.
 */
const OPENAI_PRICES: Record<string, OpenAIPriceEntry> = {
  'gpt-4o-mini': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
  },
  'gpt-4o-mini-2024-07-18': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
  },
};

interface OpenAIPriceEntry {
  inputPerMTok: number;
  outputPerMTok: number;
}

// ─── Public types ──────────────────────────────────────────────────────────

export type Provider = 'anthropic' | 'openai';

export interface CostMeterOptions {
  /** Cap for a single test, in USD. Default $1.00. */
  perTestCapUsd?: number;
  /** Hard ceiling for the whole suite, in USD. Default $5.00. */
  suiteCapUsd?: number;
  /** Path the JSONL ledger is appended to. */
  ledgerPath: string;
  /**
   * Hook the suite-wide trip path. Defaults to `process.exit(1)` so CI fails
   * loud. Tests override this to assert behavior without killing the runner.
   */
  onSuiteTrip?: (totalUsd: number, ceilingUsd: number) => void;
  /**
   * Clock injection point. Defaults to `Date.now()`; the unit test overrides
   * it for stable ledger timestamps.
   */
  now?: () => number;
}

/**
 * Authoritative usage shape pulled from `onFinish.usage`. This is a
 * structural subset of the AI SDK's `LanguageModelUsage` so the helper can
 * accept either the SDK's value directly or a hand-constructed test double.
 *
 * Only the four fields the ledger needs are required; the rest of
 * `LanguageModelUsage` is ignored.
 */
export interface CanonicalUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export interface PreCallEstimate {
  /** Worst-case projected cost in USD (input + max output). */
  projectedCostUsd: number;
  /** Tokens the input is estimated to occupy (authoritative for Anthropic). */
  inputTokens: number;
  /** Worst-case output tokens (`max_tokens` from the request). */
  maxOutputTokens: number;
}

export interface GateDecision {
  allowed: boolean;
  /** Human-readable reason when `allowed === false`. */
  reason?: string;
  /** The projection the gate evaluated. */
  estimate: PreCallEstimate;
}

export interface LedgerRow {
  test_id: string;
  status: 'ok' | 'error' | 'capped' | 'gate-refused';
  provider: Provider;
  model: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_capped: boolean;
  timestamp: string;
  note?: string;
}

// ─── Implementation ────────────────────────────────────────────────────────

const DEFAULT_PER_TEST_CAP = 1.0;
const DEFAULT_SUITE_CAP = 5.0;

/**
 * Compute the authoritative cost in USD from a `CanonicalUsage` object.
 * Used by both the post-call reconcile and the unit tests.
 */
export function priceUsage(provider: Provider, model: string, usage: CanonicalUsage): number {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;

  if (provider === 'anthropic') {
    const entry = ANTHROPIC_PRICES[model];
    if (!entry) {
      throw new Error(
        `cost-meter: no Anthropic price entry for "${model}". Add it to ANTHROPIC_PRICES in cost-meter.ts.`,
      );
    }
    // Non-cached input tokens = total input minus cache-read minus cache-write.
    // The SDK already reports cache-read separately; cache-write is a one-time
    // surcharge on the writing call. Belt-and-suspenders: clamp to zero.
    const baseInput = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
    return (
      (baseInput * entry.inputPerMTok) / 1_000_000 +
      (cacheWriteTokens * entry.cacheWritePerMTok) / 1_000_000 +
      (cacheReadTokens * entry.cacheReadPerMTok) / 1_000_000 +
      (outputTokens * entry.outputPerMTok) / 1_000_000
    );
  }

  const entry = OPENAI_PRICES[model];
  if (!entry) {
    throw new Error(`cost-meter: no OpenAI price entry for "${model}". Add it to OPENAI_PRICES in cost-meter.ts.`);
  }
  // OpenAI mini models in this table don't expose cached-input pricing.
  // Treat cache-read tokens as ordinary input so we never under-charge.
  return (inputTokens * entry.inputPerMTok) / 1_000_000 + (outputTokens * entry.outputPerMTok) / 1_000_000;
}

/**
 * Worst-case pre-call projection. Multiplies `max_tokens` by the output
 * price (the highest per-token rate for chat models), assuming the model
 * exhausts its output budget. Input cost uses authoritative token counts
 * when available (`inputTokens` from the caller, typically pulled from
 * Anthropic's `messages.count_tokens` endpoint).
 */
export function projectWorstCase(
  provider: Provider,
  model: string,
  inputTokens: number,
  maxOutputTokens: number,
): PreCallEstimate {
  const projectedCostUsd = priceUsage(provider, model, {
    inputTokens,
    outputTokens: maxOutputTokens,
  });
  return { projectedCostUsd, inputTokens, maxOutputTokens };
}

export class CostMeter {
  private readonly perTestCap: number;
  private readonly suiteCap: number;
  private readonly ledgerPath: string;
  private readonly onSuiteTrip: (totalUsd: number, ceilingUsd: number) => void;
  private readonly now: () => number;

  private suiteTotalUsd = 0;
  private currentTestId: string | null = null;
  private currentTestUsd = 0;

  constructor(opts: CostMeterOptions) {
    this.perTestCap = opts.perTestCapUsd ?? DEFAULT_PER_TEST_CAP;
    this.suiteCap = opts.suiteCapUsd ?? DEFAULT_SUITE_CAP;
    this.ledgerPath = opts.ledgerPath;
    this.onSuiteTrip =
      opts.onSuiteTrip ??
      ((total, ceiling) => {
        // Default behavior — fail the CI run loudly. See the F1 tier in the
        // file header comment.
        console.error(
          `cost-meter: suite ceiling tripped (total=$${total.toFixed(4)}, ceiling=$${ceiling.toFixed(4)}). Aborting.`,
        );
        process.exit(1);
      });
    this.now = opts.now ?? Date.now;

    // Make sure the ledger directory exists. Each row is appended atomically;
    // we never rewrite the file.
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
  }

  /** Begin recording usage for a test. Subsequent gate/record calls accrue. */
  beginTest(testId: string): void {
    this.currentTestId = testId;
    this.currentTestUsd = 0;
  }

  /**
   * Pre-call gate. Returns whether the projected call fits in both budgets.
   * The caller MUST honor the decision — CostMeter does not have a hook
   * into the SDK fetch path.
   */
  gate(provider: Provider, model: string, inputTokens: number, maxOutputTokens: number): GateDecision {
    const estimate = projectWorstCase(provider, model, inputTokens, maxOutputTokens);

    if (this.currentTestUsd + estimate.projectedCostUsd > this.perTestCap) {
      return {
        allowed: false,
        estimate,
        reason: `per-test cap would trip: current=$${this.currentTestUsd.toFixed(4)} + projected=$${estimate.projectedCostUsd.toFixed(4)} > cap=$${this.perTestCap.toFixed(4)}`,
      };
    }
    if (this.suiteTotalUsd + estimate.projectedCostUsd > this.suiteCap) {
      return {
        allowed: false,
        estimate,
        reason: `suite cap would trip: current=$${this.suiteTotalUsd.toFixed(4)} + projected=$${estimate.projectedCostUsd.toFixed(4)} > cap=$${this.suiteCap.toFixed(4)}`,
      };
    }
    return { allowed: true, estimate };
  }

  /**
   * Post-call reconcile. Records authoritative usage to the test's running
   * total. Returns the resulting accumulator state. If the suite ceiling
   * trips here (rather than at the gate), the configured `onSuiteTrip`
   * fires AFTER the ledger row is written.
   */
  record(
    provider: Provider,
    model: string,
    usage: CanonicalUsage,
  ): { suiteTotalUsd: number; testTotalUsd: number; capped: boolean } {
    const cost = priceUsage(provider, model, usage);
    this.currentTestUsd += cost;
    this.suiteTotalUsd += cost;

    const capped = this.currentTestUsd > this.perTestCap;
    const suiteCapped = this.suiteTotalUsd > this.suiteCap;

    return {
      suiteTotalUsd: this.suiteTotalUsd,
      testTotalUsd: this.currentTestUsd,
      capped: capped || suiteCapped,
    };
  }

  /**
   * Flush a final row for the current test and clear per-test accumulators.
   * Call this from an `afterEach` so every test contributes exactly one row.
   */
  endTest(opts: {
    provider: Provider;
    model: string;
    status: 'ok' | 'error' | 'capped' | 'gate-refused';
    usage?: CanonicalUsage;
    note?: string;
  }): LedgerRow {
    if (!this.currentTestId) {
      throw new Error('cost-meter: endTest called without beginTest');
    }
    const usage = opts.usage ?? {};
    const row: LedgerRow = {
      test_id: this.currentTestId,
      status: opts.status,
      provider: opts.provider,
      model: opts.model,
      cost_usd: Number(this.currentTestUsd.toFixed(6)),
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      cache_creation_input_tokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
      cache_read_input_tokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
      cost_capped: opts.status === 'capped' || this.currentTestUsd > this.perTestCap,
      timestamp: new Date(this.now()).toISOString(),
      ...(opts.note ? { note: opts.note } : {}),
    };

    // Atomic append — one JSONL row at a time. Never rewrite earlier rows.
    appendFileSync(this.ledgerPath, JSON.stringify(row) + '\n');

    // Trigger the suite-trip hook AFTER the ledger row lands. If we exit here,
    // the partial-but-honest ledger is already on disk.
    if (this.suiteTotalUsd > this.suiteCap) {
      this.onSuiteTrip(this.suiteTotalUsd, this.suiteCap);
    }

    this.currentTestId = null;
    this.currentTestUsd = 0;
    return row;
  }

  /** Read-only accessors so tests can assert against accumulator state. */
  get suiteTotal(): number {
    return this.suiteTotalUsd;
  }
  get testTotal(): number {
    return this.currentTestUsd;
  }
}

// ─── Anthropic token-count helper ──────────────────────────────────────────

/**
 * Authoritative input-token count via Anthropic's `messages.count_tokens`
 * endpoint. Bypasses the egress firewall in vitest.setup.ts because the
 * caller (real-API smoke tests) is gated on `RUN_REAL_API_TESTS=1` AND opens
 * its own fetch path (see the file header in each `*.real.test.ts`).
 *
 * Returns the raw token count; the cost projection lives in `projectWorstCase`.
 */
export async function countAnthropicInputTokens(opts: {
  apiKey: string;
  model: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  system?: string;
  /** Optional fetch impl so tests can inject a mock. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
  };
  if (opts.system) body.system = opts.system;

  const response = await fetchImpl('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`count_tokens failed: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as { input_tokens?: number };
  if (typeof json.input_tokens !== 'number') {
    throw new Error('count_tokens response missing input_tokens');
  }
  return json.input_tokens;
}
