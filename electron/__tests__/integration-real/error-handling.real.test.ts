/**
 * Real-API smoke: 4xx error surfaces correctly on OpenAI (gpt-4o-mini).
 *
 * Skipped unless `RUN_REAL_API_TESTS=1`.
 *
 * What this proves: when the provider rejects a request (here: an
 * intentionally bogus model name), the AI SDK surfaces the failure as a
 * thrown error rather than silently returning an empty result. If this
 * regresses we'd see silent success on failing prompts in production.
 *
 * Why OpenAI for this one: the four other smokes hit Anthropic, so this
 * test exercises the OpenAI provider's error path and incidentally proves
 * the OPENAI_API_KEY secret + base-URL plumbing is sound.
 *
 * Cost: a 4xx never bills, and the SDK does not retry on a 400-class
 * response. CostMeter still gates by max-output projection so the pre-call
 * gate also covers this path — though the projected cost will be zero by
 * the time the gate sees it because the SDK throws before any usage is
 * reported.
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import { CostMeter } from './cost-meter.js';

const TEST_ID = 'real.error-handling.openai.invalid-model';
const RUN = process.env.RUN_REAL_API_TESTS === '1';

// Intentionally invalid model id — the gateway returns a 4xx. We pin to a
// stable name pattern so a future provider change that starts accepting
// arbitrary names doesn't silently let this test pass without errors.
const BOGUS_MODEL = 'gpt-this-model-definitely-does-not-exist-xyz';

describe.skipIf(!RUN)('real-API: error handling (OpenAI)', () => {
  let meter: CostMeter;
  let workDir: string;
  const apiKey = process.env.OPENAI_API_KEY ?? '';

  beforeAll(() => {
    if (!apiKey) {
      throw new Error(
        'RUN_REAL_API_TESTS=1 but OPENAI_API_KEY is unset. The workflow injects it from the `eval` environment scope.',
      );
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
        provider: 'openai',
        model: BOGUS_MODEL,
        status: 'error',
        note: 'afterEach catchall',
      });
    } catch {
      // No active row.
    }
  });

  it('throws when the provider rejects an invalid model id', async () => {
    meter.beginTest(TEST_ID);
    const openai = createOpenAI({ apiKey });

    // We expect this to throw. If it RESOLVES, the test fails — that would
    // mean the SDK is swallowing a provider rejection.
    let caught: unknown = null;
    try {
      await generateText({
        model: openai.chat(BOGUS_MODEL),
        messages: [{ role: 'user', content: 'Reply with the word "ok".' }],
        maxOutputTokens: 16,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(Error);

    // The error message should reference the model or 404/400 to confirm
    // we received an actual provider rejection rather than a generic
    // network or parse failure. Match loosely; the SDK formats errors
    // differently across versions.
    const message = (caught as Error).message;
    expect(
      /model|invalid|404|400|not.?exist/i.test(message),
      `error message should reference the provider rejection, got: ${message}`,
    ).toBe(true);

    meter.endTest({
      provider: 'openai',
      model: BOGUS_MODEL,
      status: 'error',
      note: `expected 4xx: ${message.slice(0, 200)}`,
    });
  });
});
