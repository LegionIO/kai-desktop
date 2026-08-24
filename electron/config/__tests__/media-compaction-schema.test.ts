import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../schema';

const compactionSchema = appConfigSchema.shape.compaction;

describe('compaction.media schema', () => {
  it('applies defaults for the media section', () => {
    const parsed = compactionSchema.parse({
      tool: {
        enabled: true,
        useAI: true,
        triggerTokens: 5000,
        outputMaxTokens: 5000,
        truncateMinChars: 1000,
        truncateHeadRatio: 0.7,
        truncateMinTailChars: 300,
      },
      conversation: {
        enabled: true,
        mode: 'observational-memory',
        triggerPercent: 0.8,
        ignoreRecentUserMessages: 5,
        ignoreRecentAssistantMessages: 5,
        outputMaxTokens: 1200,
        promptReserveTokens: 1500,
      },
    });
    expect(parsed.media.enabled).toBe(true);
    expect(parsed.media.strategy).toBe('downscale');
    expect(parsed.media.maxImageBytes).toBe(5 * 1024 * 1024);
    expect(parsed.media.maxTotalBytes).toBe(12 * 1024 * 1024);
  });

  it('accepts a raised per-image cap that stays ≤ the total', () => {
    const media = { maxImageBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 };
    const parsed = compactionSchema.shape.media.parse(media);
    expect(parsed.maxImageBytes).toBe(16 * 1024 * 1024);
    expect(parsed.maxTotalBytes).toBe(32 * 1024 * 1024);
  });

  it('rejects a per-image cap larger than the total', () => {
    expect(() =>
      compactionSchema.shape.media.parse({ maxImageBytes: 20 * 1024 * 1024, maxTotalBytes: 12 * 1024 * 1024 }),
    ).toThrow(/maxImageBytes/);
  });

  it('rejects a per-image cap above the hard ceiling', () => {
    expect(() => compactionSchema.shape.media.parse({ maxImageBytes: 128 * 1024 * 1024 })).toThrow();
  });
});
