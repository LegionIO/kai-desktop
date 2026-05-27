/**
 * Real-API smoke: simple non-streaming chat completion against Anthropic.
 *
 * Skipped unless `RUN_REAL_API_TESTS=1` is set in the environment (the
 * nightly workflow exports it; local `pnpm test:unit` and ordinary
 * `pnpm test:integration` runs do not).
 *
 * What this proves: the Anthropic JSON path responds with the expected
 * usage shape and the SDK surfaces it through `generateText`'s `usage`
 * promise. If this regresses, every other smoke in this slice is suspect.
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import { CostMeter, countAnthropicInputTokens } from './cost-meter.js';

// Stable test-id used by the workflow's auto-issue deduper. Changing this
// detaches new failures from any prior open issue, so update deliberately.
const TEST_ID = 'real.chat-completion.anthropic.haiku';

const MODEL = 'claude-3-5-haiku-latest';
const MAX_OUTPUT_TOKENS = 64;
const RUN = process.env.RUN_REAL_API_TESTS === '1';

describe.skipIf(!RUN)('real-API: chat completion (Anthropic)', () => {
  let meter: CostMeter;
  let workDir: string;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';

  beforeAll(() => {
    if (!apiKey) {
      throw new Error(
        'RUN_REAL_API_TESTS=1 but ANTHROPIC_API_KEY is unset. The workflow injects it from the `eval` environment scope.',
      );
    }
    workDir = process.env.COST_LEDGER_DIR ?? mkdtempSync(join(tmpdir(), 'real-api-ledger-'));
    meter = new CostMeter({
      ledgerPath: join(workDir, 'cost-ledger.jsonl'),
    });
  });

  afterAll(() => {
    // Only clean up if we created the dir ourselves. When the workflow
    // pre-seeds `COST_LEDGER_DIR`, leave the ledger in place for upload.
    if (!process.env.COST_LEDGER_DIR && workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Defense-in-depth: if the test threw before its own endTest, flush a
    // synthetic error row so the ledger reflects every started test.
    try {
      meter.endTest({
        provider: 'anthropic',
        model: MODEL,
        status: 'error',
        note: 'afterEach catchall',
      });
    } catch {
      // beginTest was either followed by an explicit endTest or never
      // called — either way no row to write.
    }
  });

  it('answers a one-line question and surfaces usage', async () => {
    meter.beginTest(TEST_ID);
    const messages = [{ role: 'user' as const, content: 'Reply with the single word "ready".' }];

    const inputTokens = await countAnthropicInputTokens({
      apiKey,
      model: MODEL,
      messages,
    });
    const decision = meter.gate('anthropic', MODEL, inputTokens, MAX_OUTPUT_TOKENS);
    expect(decision.allowed, decision.reason).toBe(true);

    const anthropic = createAnthropic({ apiKey });
    const result = await generateText({
      model: anthropic(MODEL),
      messages,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    expect(result.text).toBeTruthy();
    expect(typeof result.text).toBe('string');
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);

    meter.record('anthropic', MODEL, result.usage);
    meter.endTest({
      provider: 'anthropic',
      model: MODEL,
      status: 'ok',
      usage: result.usage,
    });
  });
});
