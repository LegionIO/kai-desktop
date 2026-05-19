/**
 * Real-API smoke: tool use against Anthropic.
 *
 * Skipped unless `RUN_REAL_API_TESTS=1`.
 *
 * What this proves: the AI SDK can register a tool, the model picks it,
 * the SDK round-trips the tool result, and the final message reflects
 * the tool's output. This is the smoke for the runtime path that every
 * production conversation uses.
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { generateText, stepCountIs, tool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import { CostMeter, countAnthropicInputTokens } from './cost-meter.js';

const TEST_ID = 'real.tool-use.anthropic.haiku';
const MODEL = 'claude-3-5-haiku-latest';
const MAX_OUTPUT_TOKENS = 200;
const RUN = process.env.RUN_REAL_API_TESTS === '1';

describe.skipIf(!RUN)('real-API: tool use (Anthropic)', () => {
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

  it('invokes a typed tool and incorporates the result into the final answer', async () => {
    meter.beginTest(TEST_ID);
    const messages = [
      {
        role: 'user' as const,
        content: 'Use the calc tool with a=17 and b=4 to compute the sum, then state the result as: "the answer is X".',
      },
    ];

    const inputTokens = await countAnthropicInputTokens({
      apiKey,
      model: MODEL,
      messages,
    });
    // Allow extra worst-case budget for the multi-step tool-use loop.
    const decision = meter.gate('anthropic', MODEL, inputTokens * 3, MAX_OUTPUT_TOKENS);
    expect(decision.allowed, decision.reason).toBe(true);

    const anthropic = createAnthropic({ apiKey });
    let calcInvocations = 0;
    const calc = tool({
      description: 'Sum two integers.',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => {
        calcInvocations += 1;
        return { sum: a + b };
      },
    });

    const result = await generateText({
      model: anthropic(MODEL),
      messages,
      tools: { calc },
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // Cap the loop at 4 steps so a tool-flapping model can't infinite-loop
      // the test. `stepCountIs` is the AI SDK's first-party helper.
      stopWhen: stepCountIs(4),
    });

    expect(calcInvocations).toBeGreaterThanOrEqual(1);
    expect(result.text).toMatch(/21/);
    expect(result.totalUsage.outputTokens).toBeGreaterThan(0);

    meter.record('anthropic', MODEL, result.totalUsage);
    meter.endTest({
      provider: 'anthropic',
      model: MODEL,
      status: 'ok',
      usage: result.totalUsage,
    });
  });
});
