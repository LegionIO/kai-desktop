/**
 * Real-API model runner for the behavioural evaluation harness.
 *
 * Kept in its own module so `run-evals.ts` can dynamic-import it only on
 * the real-API path. Static-importing the AI SDK packages from
 * `run-evals.ts` would pull them into the unit-test slice as well, and
 * the fetch firewall in `vitest.setup.ts` would flag any accidental
 * client construction.
 *
 * No tests import this file. The unit-test suite for the harness lives
 * at `run-evals.test.ts` and tests the pure helpers only.
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

export interface PinnedModel {
  id: string;
  provider: 'anthropic' | 'openai';
}

/**
 * Bound the per-sample generation length so a runaway "explain everything"
 * response can't blow the cost ceiling. The rubric's `length.max` would
 * flag an over-long answer post-hoc, but it can't refund the spend.
 * 1024 tokens fits the longest prompt's expected answer (refactor /
 * write-tests) with headroom; tighten further if cost-meter ever flags a
 * single-sample overage.
 */
const SAMPLE_MAX_TOKENS = 1024;

/**
 * Run a single sample against a pinned model.
 *
 * Reads provider credentials from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
 * The harness is responsible for ensuring those are set before calling.
 */
export async function runModel(model: PinnedModel, prompt: string): Promise<string> {
  if (model.provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set; cannot evaluate Anthropic model.');
    }
    const provider = createAnthropic({ apiKey });
    const { text } = await generateText({
      model: provider(model.id),
      prompt,
      // Temperature 0 for closest-to-deterministic outputs. Sampling
      // variance still comes from server-side stochasticity but the
      // shape is tightened so the deterministic rubric is meaningful.
      temperature: 0,
      maxOutputTokens: SAMPLE_MAX_TOKENS,
    });
    return text;
  }
  if (model.provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set; cannot evaluate OpenAI model.');
    }
    const provider = createOpenAI({ apiKey });
    const { text } = await generateText({
      model: provider(model.id),
      prompt,
      temperature: 0,
      maxOutputTokens: SAMPLE_MAX_TOKENS,
    });
    return text;
  }
  throw new Error(`Unknown provider for model ${model.id}`);
}
