/**
 * Hermetic unit tests for CostMeter. No real API traffic — the egress
 * firewall in vitest.setup.ts would block it anyway. We feed the meter
 * synthetic `CanonicalUsage` objects and assert against the ledger / state.
 *
 * This test file lives next to its subject in the integration-real/
 * directory but is intentionally named `cost-meter.test.ts` (not
 * `*.real.test.ts`), so it runs under the regular unit slice. The real-API
 * `*.real.test.ts` siblings are skipped unless `RUN_REAL_API_TESTS=1`.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CostMeter,
  type CanonicalUsage,
  countAnthropicInputTokens,
  priceUsage,
  projectWorstCase,
} from './cost-meter.js';

let workDir: string;
let ledgerPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cost-meter-'));
  ledgerPath = join(workDir, 'cost.jsonl');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function readLedger(): Array<Record<string, unknown>> {
  const raw = readFileSync(ledgerPath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('priceUsage', () => {
  // The pricing math itself is the only thing that depends on the table, so
  // we lock it down with explicit hand-computed expected values. If a price
  // entry changes intentionally, the matching expectation here must change
  // too — the assertion exists exactly to make that a deliberate edit.

  it('prices Anthropic haiku input+output correctly without cache fields', () => {
    // 1000 input × $0.80/MTok = $0.0008
    // 500 output × $4.00/MTok = $0.0020
    // total = $0.0028
    const cost = priceUsage('anthropic', 'claude-3-5-haiku-latest', {
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cost).toBeCloseTo(0.0028, 6);
  });

  it('splits Anthropic input across cache read, cache write, and base buckets', () => {
    // 1000 input total = 200 base + 300 cache_write + 500 cache_read
    // 200 base × $0.80 / 1e6 = $0.00016
    // 300 cache_write × $1.00 / 1e6 = $0.00030
    // 500 cache_read × $0.08 / 1e6 = $0.00004
    // 100 output × $4.00 / 1e6 = $0.00040
    // total = $0.00090
    const cost = priceUsage('anthropic', 'claude-3-5-haiku-latest', {
      inputTokens: 1000,
      outputTokens: 100,
      inputTokenDetails: { cacheReadTokens: 500, cacheWriteTokens: 300 },
    });
    expect(cost).toBeCloseTo(0.0009, 6);
  });

  it('prices OpenAI gpt-4o-mini input+output correctly', () => {
    // 2000 input × $0.15/MTok = $0.0003
    // 1000 output × $0.60/MTok = $0.0006
    // total = $0.0009
    const cost = priceUsage('openai', 'gpt-4o-mini', {
      inputTokens: 2000,
      outputTokens: 1000,
    });
    expect(cost).toBeCloseTo(0.0009, 6);
  });

  it('raises a loud error for an unknown model so the gate refuses to project blindly', () => {
    expect(() => priceUsage('anthropic', 'claude-fictional-model', { inputTokens: 100 })).toThrow(
      /no Anthropic price entry/,
    );
    expect(() => priceUsage('openai', 'gpt-fictional', { inputTokens: 100 })).toThrow(/no OpenAI price entry/);
  });
});

describe('projectWorstCase', () => {
  it('multiplies max_tokens by the output price for the worst-case projection', () => {
    const est = projectWorstCase('anthropic', 'claude-3-5-haiku-latest', 500, 2000);
    // input: 500 × $0.80 / 1e6 = $0.00040
    // output (worst-case): 2000 × $4.00 / 1e6 = $0.00800
    // total: $0.00840
    expect(est.projectedCostUsd).toBeCloseTo(0.0084, 6);
    expect(est.inputTokens).toBe(500);
    expect(est.maxOutputTokens).toBe(2000);
  });
});

describe('CostMeter pre-call gate', () => {
  it('allows a call comfortably inside both budgets', () => {
    const meter = new CostMeter({ ledgerPath });
    meter.beginTest('hermetic.gate.allow');
    const decision = meter.gate('anthropic', 'claude-3-5-haiku-latest', 100, 100);
    expect(decision.allowed).toBe(true);
    expect(decision.estimate.projectedCostUsd).toBeGreaterThan(0);
  });

  it('refuses when the projection would exceed the per-test cap', () => {
    // Per-test cap $0.001, projection ≈ $0.00040 (input) + $0.00400 (output) = $0.0044
    const meter = new CostMeter({ ledgerPath, perTestCapUsd: 0.001 });
    meter.beginTest('hermetic.gate.percap');
    const decision = meter.gate('anthropic', 'claude-3-5-haiku-latest', 500, 1000);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/per-test cap/);
  });

  it('refuses when the projection would exceed the suite-wide cap', () => {
    // Suite cap $0.001, per-test cap left at default — only the suite branch
    // should fire on the first gate.
    const meter = new CostMeter({ ledgerPath, suiteCapUsd: 0.001 });
    meter.beginTest('hermetic.gate.suitecap');
    const decision = meter.gate('anthropic', 'claude-3-5-haiku-latest', 500, 1000);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/suite cap/);
  });
});

describe('CostMeter post-call reconcile (T2)', () => {
  it('updates totals from authoritative usage only, never from the gate estimate', () => {
    const meter = new CostMeter({ ledgerPath });
    meter.beginTest('hermetic.reconcile.t2');

    // Pre-call estimate says ~$0.0084. We never persist that.
    const gate = meter.gate('anthropic', 'claude-3-5-haiku-latest', 500, 2000);
    expect(gate.allowed).toBe(true);
    expect(meter.suiteTotal).toBe(0); // gate does NOT touch totals
    expect(meter.testTotal).toBe(0);

    // Authoritative usage from "onFinish" — actual output was much smaller.
    const usage: CanonicalUsage = { inputTokens: 480, outputTokens: 50 };
    const result = meter.record('anthropic', 'claude-3-5-haiku-latest', usage);

    // 480 × $0.80 / 1e6 + 50 × $4.00 / 1e6 = $0.000384 + $0.0002 = $0.000584
    expect(result.testTotalUsd).toBeCloseTo(0.000584, 6);
    expect(result.suiteTotalUsd).toBeCloseTo(0.000584, 6);
    expect(meter.suiteTotal).toBeCloseTo(0.000584, 6);
    expect(result.capped).toBe(false);
  });

  it('reports capped=true when authoritative usage pushes past the per-test cap', () => {
    // Generous suite cap so we can isolate the per-test trip.
    const meter = new CostMeter({ ledgerPath, perTestCapUsd: 0.0001, suiteCapUsd: 10 });
    meter.beginTest('hermetic.reconcile.percap');
    const result = meter.record('anthropic', 'claude-3-5-haiku-latest', {
      inputTokens: 1000,
      outputTokens: 500,
    });
    // Cost ≈ $0.0028 > cap $0.0001
    expect(result.capped).toBe(true);
    expect(result.testTotalUsd).toBeGreaterThan(0.0001);
  });

  it('recordOnError bills against the suite cap when the error body carries usage', () => {
    const meter = new CostMeter({ ledgerPath });
    meter.beginTest('hermetic.reconcile.error-with-usage');

    // Simulate the 429 path: provider billed the input but rejected the
    // response. The harness must still record those input tokens against
    // the suite ceiling, otherwise an error loop spends silently.
    const result = meter.recordOnError('anthropic', 'claude-3-5-haiku-latest', {
      inputTokens: 1000,
      outputTokens: 0,
    });

    // 1000 × $0.80 / 1e6 = $0.0008
    expect(result.testTotalUsd).toBeCloseTo(0.0008, 6);
    expect(result.suiteTotalUsd).toBeCloseTo(0.0008, 6);
  });

  it('recordOnError returns the current accumulator when usage is unknown (null)', () => {
    const meter = new CostMeter({ ledgerPath });
    meter.beginTest('hermetic.reconcile.error-no-usage');

    // Some failure modes (network reset before any byte) genuinely have no
    // usage to record. We still call recordOnError so the failure path is
    // explicit, but the helper must not fabricate cost.
    const result = meter.recordOnError('openai', 'gpt-4o-mini', null);

    expect(result.testTotalUsd).toBe(0);
    expect(result.suiteTotalUsd).toBe(0);
    expect(result.capped).toBe(false);
  });
});

describe('CostMeter ledger output', () => {
  it('writes one JSONL row per test with the documented shape', () => {
    const meter = new CostMeter({
      ledgerPath,
      // Stable timestamp for assertion. Real runs use Date.now.
      now: () => Date.parse('2026-01-15T00:00:00.000Z'),
    });
    meter.beginTest('hermetic.ledger.row');
    meter.record('anthropic', 'claude-3-5-haiku-latest', {
      inputTokens: 100,
      outputTokens: 50,
      inputTokenDetails: { cacheReadTokens: 25, cacheWriteTokens: 10 },
    });
    meter.endTest({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      status: 'ok',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: { cacheReadTokens: 25, cacheWriteTokens: 10 },
      },
    });

    const rows = readLedger();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      test_id: 'hermetic.ledger.row',
      status: 'ok',
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 25,
      cost_capped: false,
      timestamp: '2026-01-15T00:00:00.000Z',
    });
    expect(row.cost_usd).toBeGreaterThan(0);
  });

  it('stamps cost_capped=true on a per-test trip without aborting the suite', () => {
    const meter = new CostMeter({
      ledgerPath,
      perTestCapUsd: 0.0001,
      suiteCapUsd: 10,
    });
    meter.beginTest('hermetic.ledger.capped');
    meter.record('anthropic', 'claude-3-5-haiku-latest', {
      inputTokens: 1000,
      outputTokens: 500,
    });
    const row = meter.endTest({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      status: 'capped',
      usage: { inputTokens: 1000, outputTokens: 500 },
    });
    expect(row.cost_capped).toBe(true);
    expect(row.status).toBe('capped');

    // The next test can still begin: F2 in the tiered failure model.
    meter.beginTest('hermetic.ledger.next');
    expect(meter.testTotal).toBe(0); // accumulator reset
  });

  it('appends to an existing ledger rather than rewriting it', () => {
    const meter = new CostMeter({
      ledgerPath,
      now: () => Date.parse('2026-01-15T00:00:00.000Z'),
    });
    meter.beginTest('first');
    meter.record('openai', 'gpt-4o-mini', { inputTokens: 100, outputTokens: 50 });
    meter.endTest({
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    meter.beginTest('second');
    meter.record('openai', 'gpt-4o-mini', { inputTokens: 200, outputTokens: 75 });
    meter.endTest({
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
      usage: { inputTokens: 200, outputTokens: 75 },
    });

    const rows = readLedger();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.test_id).toBe('first');
    expect(rows[1]?.test_id).toBe('second');
  });
});

describe('CostMeter suite-wide ceiling (F1)', () => {
  it('fires onSuiteTrip after the ledger row is written when the ceiling trips', () => {
    let tripCount = 0;
    let tripTotal = 0;
    const meter = new CostMeter({
      ledgerPath,
      suiteCapUsd: 0.0001,
      // Override the default process.exit hook so the unit test stays alive.
      onSuiteTrip: (total) => {
        tripCount += 1;
        tripTotal = total;
      },
    });
    meter.beginTest('hermetic.suite.trip');
    meter.record('anthropic', 'claude-3-5-haiku-latest', {
      inputTokens: 1000,
      outputTokens: 500,
    });
    const row = meter.endTest({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      status: 'ok',
      usage: { inputTokens: 1000, outputTokens: 500 },
    });

    // Ledger row landed first; trip handler fired afterward. Both must hold:
    // the ledger is the durable record, the trip is the runtime signal.
    expect(readLedger()).toHaveLength(1);
    expect(row.test_id).toBe('hermetic.suite.trip');
    expect(tripCount).toBe(1);
    expect(tripTotal).toBeGreaterThan(0.0001);
  });
});

describe('CostMeter input validation', () => {
  it('refuses endTest before beginTest', () => {
    const meter = new CostMeter({ ledgerPath });
    expect(() =>
      meter.endTest({
        provider: 'anthropic',
        model: 'claude-3-5-haiku-latest',
        status: 'ok',
      }),
    ).toThrow(/endTest called without beginTest/);
  });
});

describe('countAnthropicInputTokens', () => {
  it('parses input_tokens from the count_tokens endpoint response', async () => {
    const fakeFetch: typeof fetch = async (url, init) => {
      // The helper hits a stable, documented URL. Lock that down so a typo in
      // the path can never sneak through unnoticed.
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages/count_tokens');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe('test-key');
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      return new Response(JSON.stringify({ input_tokens: 42 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const count = await countAnthropicInputTokens({
      apiKey: 'test-key',
      model: 'claude-3-5-haiku-latest',
      messages: [{ role: 'user', content: 'hello' }],
      fetchImpl: fakeFetch,
    });
    expect(count).toBe(42);
  });

  it('raises when the endpoint returns a non-2xx', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' });
    await expect(
      countAnthropicInputTokens({
        apiKey: 'test-key',
        model: 'claude-3-5-haiku-latest',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/count_tokens failed: 429/);
  });

  it('raises when input_tokens is missing or wrong type', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ wrong_key: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      countAnthropicInputTokens({
        apiKey: 'test-key',
        model: 'claude-3-5-haiku-latest',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/missing input_tokens/);
  });
});
