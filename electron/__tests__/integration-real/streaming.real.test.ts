/**
 * Real-API smoke: streaming completion against Anthropic.
 *
 * Skipped unless `RUN_REAL_API_TESTS=1`.
 *
 * What this proves: the SSE path actually streams chunks, the SDK's
 * `streamText` resolves to a usage promise after the stream closes, and
 * cumulative usage from `result.usage` matches what `onFinish` saw.
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import { CostMeter, countAnthropicInputTokens, type CanonicalUsage } from './cost-meter.js';

const TEST_ID = 'real.streaming.anthropic.haiku';
const MODEL = 'claude-3-5-haiku-latest';
const MAX_OUTPUT_TOKENS = 80;
const RUN = process.env.RUN_REAL_API_TESTS === '1';

describe.skipIf(!RUN)('real-API: streaming (Anthropic)', () => {
  let meter: CostMeter;
  let workDir: string;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';

  beforeAll(() => {
    if (!apiKey) {
      throw new Error('RUN_REAL_API_TESTS=1 but ANTHROPIC_API_KEY is unset.');
    }
    workDir = process.env.COST_LEDGER_DIR ?? mkdtempSync(join(tmpdir(), 'real-api-ledger-'));
    meter = new CostMeter({
      ledgerPath: join(workDir, 'cost-ledger.jsonl'),
    });
  });

  afterAll(() => {
    if (!process.env.COST_LEDGER_DIR && workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    try {
      meter.endTest({
        provider: 'anthropic',
        model: MODEL,
        status: 'error',
        note: 'afterEach catchall',
      });
    } catch {
      // No active test row.
    }
  });

  it('streams text chunks and resolves a usage promise that matches onFinish', async () => {
    meter.beginTest(TEST_ID);
    const messages = [{ role: 'user' as const, content: 'Count from 1 to 3, separated by spaces.' }];

    const inputTokens = await countAnthropicInputTokens({
      apiKey,
      model: MODEL,
      messages,
    });
    const decision = meter.gate('anthropic', MODEL, inputTokens, MAX_OUTPUT_TOKENS);
    expect(decision.allowed, decision.reason).toBe(true);

    const anthropic = createAnthropic({ apiKey });
    let onFinishUsage: CanonicalUsage | null = null;

    const result = streamText({
      model: anthropic(MODEL),
      messages,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      onFinish: (event) => {
        onFinishUsage = event.totalUsage as CanonicalUsage;
      },
    });

    // Drain the text stream so we observe actual chunks (proves SSE works).
    const chunks: string[] = [];
    for await (const delta of result.textStream) {
      chunks.push(delta);
    }
    expect(chunks.length).toBeGreaterThan(0);

    // Both surfaces must agree on usage. `result.usage` is a promise that
    // resolves once `onFinish` has fired.
    const finalUsage = await result.totalUsage;
    expect(onFinishUsage).not.toBeNull();
    expect(finalUsage.outputTokens).toBeGreaterThan(0);
    expect(finalUsage.inputTokens).toBeGreaterThan(0);
    // Sanity check that the SDK didn't split the rolled-up totals between
    // the two surfaces. If this diverges, the meter's T2 reconcile assumption
    // (one authoritative row per call) is wrong and we'd silently double-bill.
    expect(onFinishUsage!.outputTokens).toBe(finalUsage.outputTokens);
    expect(onFinishUsage!.inputTokens).toBe(finalUsage.inputTokens);

    meter.record('anthropic', MODEL, finalUsage);
    meter.endTest({
      provider: 'anthropic',
      model: MODEL,
      status: 'ok',
      usage: finalUsage,
    });
  });
});
