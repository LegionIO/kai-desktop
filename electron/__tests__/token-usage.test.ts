import { describe, expect, it } from 'vitest';

import { normalizeTokenUsage } from '../../shared/token-usage.js';

describe('normalizeTokenUsage', () => {
  it('normalizes Legion daemon snake_case usage events', () => {
    expect(normalizeTokenUsage({
      input_tokens: '4200',
      output_tokens: 3600,
      cache_read_tokens: 120,
      cache_write_tokens: 8,
    })).toEqual({
      inputTokens: 4200,
      outputTokens: 3600,
      cacheReadTokens: 120,
      cacheWriteTokens: 8,
      totalTokens: 7800,
    });
  });

  it('normalizes OpenAI-compatible nested usage payloads', () => {
    expect(normalizeTokenUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 55,
        total_tokens: 155,
      },
    })).toEqual({
      inputTokens: 100,
      outputTokens: 55,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 155,
    });
  });

  it('ignores non-token context usage events', () => {
    expect(normalizeTokenUsage({
      usedTokens: 1000,
      contextWindowTokens: 128000,
      phase: 'pre-compaction',
    })).toBeNull();
  });
});
