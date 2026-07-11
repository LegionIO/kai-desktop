/**
 * Tests for usage-pricing.ts — local cost estimation. A wrong number here is
 * user-visible and silent, so this pins the fuzzy model-name matching (exact →
 * ordered prefix → opus/sonnet/haiku keyword → null) and the estimateCost
 * malformed-usage guard (a corrupt stored event must never surface $NaN /
 * $Infinity / a negative cost).
 */
import { describe, it, expect } from 'vitest';
import { lookupPricing, estimateCost } from '../usage-pricing.js';

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };

describe('lookupPricing', () => {
  it('matches a known model exactly', () => {
    expect(lookupPricing('claude-opus-4')).toEqual({
      inputPer1M: 15,
      outputPer1M: 75,
      cacheReadPer1M: 1.5,
      cacheWritePer1M: 18.75,
    });
  });

  it('normalizes provider prefixes, version tags, and -latest suffixes', () => {
    // anthropic. prefix + :tag stripped
    expect(lookupPricing('anthropic.claude-sonnet-4:20260101')).toBe(lookupPricing('claude-sonnet-4'));
    // openai/ prefix + -latest stripped
    expect(lookupPricing('openai/gpt-4o-latest')).toBe(lookupPricing('gpt-4o'));
    // models/ prefix (Google) + case-insensitivity
    expect(lookupPricing('models/GEMINI-2.5-PRO')).toBe(lookupPricing('gemini-2.5-pro'));
  });

  it('resolves prefixes in specificity order (longer, more-specific first)', () => {
    // gpt-5.4-pro must NOT be swallowed by gpt-5 / gpt-5.4.
    expect(lookupPricing('gpt-5.4-pro-2026')).toEqual({ inputPer1M: 30, outputPer1M: 120 });
    // gpt-5.4 (not pro) resolves to the 10/30 tier.
    expect(lookupPricing('gpt-5.4-turbo')).toEqual({ inputPer1M: 10, outputPer1M: 30 });
    // bare gpt-5 variant.
    expect(lookupPricing('gpt-5-mini-preview')).toEqual({ inputPer1M: 10, outputPer1M: 30 });
    // gpt-4.1-mini must beat gpt-4.1.
    expect(lookupPricing('gpt-4.1-mini-2026')).toEqual({ inputPer1M: 0.4, outputPer1M: 1.6 });
  });

  it('falls back to keyword pricing for custom deployment names', () => {
    expect(lookupPricing('my-custom-opus-deployment')).toBe(lookupPricing('claude-opus-4'));
    expect(lookupPricing('internal-sonnet-proxy')).toBe(lookupPricing('claude-sonnet-4'));
    expect(lookupPricing('fast-haiku-endpoint')).toBe(lookupPricing('claude-3.5-haiku'));
  });

  it('returns null for a fully unknown model', () => {
    expect(lookupPricing('llama-3-70b')).toBeNull();
    expect(lookupPricing('')).toBeNull();
  });
});

describe('estimateCost', () => {
  it('computes exact input + output + cache costs for an Anthropic model', () => {
    // 1M input @15, 2M output @75, 4M cacheRead @1.5, 0.5M cacheWrite @18.75
    const cost = estimateCost('claude-opus-4', {
      inputTokens: 1_000_000,
      outputTokens: 2_000_000,
      cacheReadTokens: 4_000_000,
      cacheWriteTokens: 500_000,
      totalTokens: 7_500_000,
    });
    // 15 + 150 + 6 + 9.375 = 180.375
    expect(cost).toBeCloseTo(180.375, 6);
  });

  it('ignores cache tokens for a model without cache pricing (OpenAI)', () => {
    const cost = estimateCost('gpt-4o', {
      inputTokens: 1_000_000, // @2.5
      outputTokens: 1_000_000, // @10
      cacheReadTokens: 9_000_000, // no cacheReadPer1M → contributes 0
      cacheWriteTokens: 9_000_000,
      totalTokens: 20_000_000,
    });
    expect(cost).toBeCloseTo(12.5, 6); // 2.5 + 10 only
  });

  it('returns 0 for an unknown model', () => {
    expect(estimateCost('llama-3', { ...zeroUsage, inputTokens: 1_000_000 })).toBe(0);
  });

  it('clamps malformed usage values to 0 (no NaN / Infinity / negative cost)', () => {
    const cost = estimateCost('claude-opus-4', {
      inputTokens: NaN,
      outputTokens: -500,
      cacheReadTokens: Infinity, // finite check → 0
      cacheWriteTokens: undefined as unknown as number,
      totalTokens: 0,
    });
    expect(cost).toBe(0);
    expect(Number.isFinite(cost)).toBe(true);
  });

  it('caps an absurdly large token count at 1e12 before pricing', () => {
    const cost = estimateCost('gpt-4o', { ...zeroUsage, inputTokens: 1e30 });
    // capped at 1e12 tokens → (1e12 / 1e6) * 2.5 = 2.5e6
    expect(cost).toBeCloseTo(2.5e6, 0);
    expect(Number.isFinite(cost)).toBe(true);
  });

  it('is zero when all usage is zero', () => {
    expect(estimateCost('claude-opus-4', zeroUsage)).toBe(0);
  });
});
