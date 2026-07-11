import { describe, expect, it } from 'vitest';

import { normalizeTokenUsage } from '../../shared/token-usage.js';

describe('normalizeTokenUsage', () => {
  it('normalizes Legion daemon snake_case usage events', () => {
    expect(
      normalizeTokenUsage({
        input_tokens: '4200',
        output_tokens: 3600,
        cache_read_tokens: 120,
        cache_write_tokens: 8,
      }),
    ).toEqual({
      inputTokens: 4200,
      outputTokens: 3600,
      cacheReadTokens: 120,
      cacheWriteTokens: 8,
      totalTokens: 7800,
    });
  });

  it('normalizes OpenAI-compatible nested usage payloads', () => {
    expect(
      normalizeTokenUsage({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 55,
          total_tokens: 155,
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 55,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 155,
    });
  });

  it('ignores non-token context usage events', () => {
    expect(
      normalizeTokenUsage({
        usedTokens: 1000,
        contextWindowTokens: 128000,
        phase: 'pre-compaction',
      }),
    ).toBeNull();
  });

  it('reads Anthropic cache-creation / cache-read input token key variants', () => {
    expect(
      normalizeTokenUsage({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 12,
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 40,
      cacheWriteTokens: 12,
      totalTokens: 15, // fallback = input + output (cache tokens NOT added)
    });
  });

  it('floors fractional counts and coerces numeric strings', () => {
    expect(normalizeTokenUsage({ input_tokens: '12.9', output_tokens: 3.7 })).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
    });
  });

  it('rejects negative / NaN / non-numeric fields (treated as absent)', () => {
    // A negative input + NaN output are dropped; only the valid cache-read remains.
    expect(
      normalizeTokenUsage({
        input_tokens: -5,
        output_tokens: 'not-a-number',
        cache_read_tokens: 7,
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 7,
      cacheWriteTokens: 0,
      totalTokens: 0, // 0 input + 0 output
    });
  });

  it('returns null for a blank-string-only or empty-object payload', () => {
    expect(normalizeTokenUsage({ input_tokens: '' })).toBeNull();
    expect(normalizeTokenUsage({})).toBeNull();
  });

  it('returns null for non-object / array / nullish input', () => {
    expect(normalizeTokenUsage(null)).toBeNull();
    expect(normalizeTokenUsage(undefined)).toBeNull();
    expect(normalizeTokenUsage(42)).toBeNull();
    expect(normalizeTokenUsage('usage')).toBeNull();
    expect(normalizeTokenUsage([{ input_tokens: 1 }])).toBeNull();
  });

  it('prefers an explicit total over the input+output fallback', () => {
    // Explicit total that disagrees with input+output is preserved verbatim.
    expect(normalizeTokenUsage({ input_tokens: 100, output_tokens: 50, total_tokens: 999 })!.totalTokens).toBe(999);
  });

  it('reads top-level keys in preference to a nested usage object', () => {
    expect(
      normalizeTokenUsage({
        input_tokens: 7,
        usage: { input_tokens: 999 },
      })!.inputTokens,
    ).toBe(7);
  });
});
