import { describe, it, expect } from 'vitest';
import { estimateStaticRequestTokens } from '../static-tokens';
import { z } from 'zod';

describe('estimateStaticRequestTokens', () => {
  it('adds the workspace tool-schema allowance to the counted static tokens', async () => {
    const withoutAllowance = await estimateStaticRequestTokens('hello', undefined, [], 0, 'gpt-4o');
    const withAllowance = await estimateStaticRequestTokens('hello', undefined, [], 500, 'gpt-4o');
    expect(withAllowance - withoutAllowance).toBe(500);
  });

  it('COUNTS tool schemas — many/large tool schemas raise the estimate substantially', async () => {
    const tool = (n: number) => ({
      name: `tool_${n}`,
      description: 'A tool with a reasonably long description '.repeat(10),
      inputSchema: z.object({
        query: z.string().describe('the search query '.repeat(20)),
        limit: z.number().describe('max results '.repeat(20)),
      }),
    });
    const noTools = await estimateStaticRequestTokens('base prompt', undefined, [], 0, 'gpt-4o');
    const manyTools = await estimateStaticRequestTokens(
      'base prompt',
      undefined,
      Array.from({ length: 20 }, (_, i) => tool(i)),
      0,
      'gpt-4o',
    );
    // 20 verbose tool schemas must add real cost — the whole point of counting them
    // (a prompt-only estimate would report the SAME number and under-budget /compact).
    expect(manyTools).toBeGreaterThan(noTools + 500);
  });

  it('uses the UTF-8 byte ceiling for a fallback-encoding model (never the o200k undercount)', async () => {
    // Claude is not tiktoken-canonical → byte ceiling (a true upper bound).
    const claude = await estimateStaticRequestTokens('x'.repeat(400), undefined, [], 0, 'claude-3-5-sonnet');
    expect(claude).toBeGreaterThanOrEqual(400);
  });
});
