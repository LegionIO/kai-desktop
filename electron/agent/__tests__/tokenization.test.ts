import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveConversationTokenization,
  normalizeConversationModelName,
  estimateSerializedTokens,
  countBranchTokensCached,
  countSerializedTokens,
  serializeForTokenCounting,
  __clearExactTokenCacheForTests,
  MODEL_CONTEXT_WINDOWS,
} from '../tokenization';

describe('normalizeConversationModelName', () => {
  it('strips provider prefixes and -latest suffix', () => {
    expect(normalizeConversationModelName('openai/gpt-4o-latest')).toBe('gpt-4o');
    expect(normalizeConversationModelName('azure:gpt-4.1')).toBe('gpt-4.1');
  });

  it('normalizes reasoning-model variants to their base (most-specific wins)', () => {
    expect(normalizeConversationModelName('o4-mini-2025-04-16')).toBe('o4-mini');
    expect(normalizeConversationModelName('o3-mini-2025-01-31')).toBe('o3-mini');
    expect(normalizeConversationModelName('o3-2025-04-16')).toBe('o3');
  });
});

describe('resolveConversationTokenization', () => {
  it('resolves a context window for reasoning models (so compaction can trigger)', () => {
    for (const m of ['o3', 'o3-mini', 'o4-mini']) {
      const info = resolveConversationTokenization(m);
      expect(info.contextWindowTokens).toBe(MODEL_CONTEXT_WINDOWS[m]);
      expect(info.contextWindowTokens).toBeGreaterThan(0);
      // Encoding always resolves (falls back to gpt-5) so counting works.
      expect(info.encoding).not.toBeNull();
    }
  });

  it('resolves a context window for the base GPT models', () => {
    expect(resolveConversationTokenization('gpt-4o').contextWindowTokens).toBe(128000);
    expect(resolveConversationTokenization('gpt-5').contextWindowTokens).toBe(272000);
  });

  it('honors a positive finite override over the table', () => {
    expect(resolveConversationTokenization('o3', 50000).contextWindowTokens).toBe(50000);
  });

  it('ignores a non-positive/NaN override and falls back to the table', () => {
    expect(resolveConversationTokenization('o3', 0).contextWindowTokens).toBe(MODEL_CONTEXT_WINDOWS.o3);
    expect(resolveConversationTokenization('o3', Number.NaN).contextWindowTokens).toBe(MODEL_CONTEXT_WINDOWS.o3);
  });

  it('returns null context window for a wholly unknown model with no override', () => {
    expect(resolveConversationTokenization('totally-made-up-model-xyz').contextWindowTokens).toBeNull();
  });
});

describe('estimateSerializedTokens (cheap pre-check, no WASM)', () => {
  it('is an UPPER bound on the exact tiktoken count for real content', () => {
    const messages = [
      { role: 'user', content: 'Explain the CAP theorem in a few paragraphs with examples.' },
      {
        role: 'assistant',
        content:
          'The CAP theorem states that a distributed system can provide at most two of consistency, availability, and partition tolerance. '.repeat(
            20,
          ),
      },
    ];
    const tokenization = resolveConversationTokenization('gpt-4o');
    const exact = countSerializedTokens(messages, tokenization)!;
    const estimate = estimateSerializedTokens(messages);
    // The estimate must never UNDER-count the exact tokens, or the pre-check
    // could skip a compaction that should have run.
    expect(estimate).toBeGreaterThanOrEqual(exact);
  });

  it('scales with serialized length and is zero-ish for empty input', () => {
    expect(estimateSerializedTokens([])).toBeLessThanOrEqual(1);
    const small = estimateSerializedTokens([{ role: 'user', content: 'hi' }]);
    const big = estimateSerializedTokens([{ role: 'user', content: 'x'.repeat(10000) }]);
    expect(big).toBeGreaterThan(small);
  });
});

describe('countBranchTokensCached (memoized exact count)', () => {
  beforeEach(() => __clearExactTokenCacheForTests());

  it('matches the un-cached exact count', () => {
    const messages = [{ role: 'user', content: 'hello world, this is a token counting test' }];
    const tokenization = resolveConversationTokenization('gpt-4o');
    expect(countBranchTokensCached(messages, tokenization, 'm1')).toBe(countSerializedTokens(messages, tokenization));
  });

  it('returns the cached value for an identical branch signature (no re-encode)', () => {
    const messages = [{ role: 'user', content: 'cache me' }];
    const tokenization = resolveConversationTokenization('gpt-4o');
    const first = countBranchTokensCached(messages, tokenization, 'm1');
    // Corrupt the live encoding so a second real encode would differ/throw;
    // a cache HIT must not call it again.
    const spy = { calls: 0 };
    const wrapped = {
      ...tokenization,
      encoding: {
        encode: (s: string) => {
          spy.calls++;
          return tokenization.encoding!.encode(s);
        },
      } as typeof tokenization.encoding,
    };
    const second = countBranchTokensCached(messages, wrapped, 'm1');
    expect(second).toBe(first);
    expect(spy.calls).toBe(0); // served from cache, encode not called
  });

  it('recomputes when the branch grows (length + count + tail id change the key)', () => {
    const tokenization = resolveConversationTokenization('gpt-4o');
    const one = countBranchTokensCached([{ role: 'user', content: 'a' }], tokenization, 'm1')!;
    const two = countBranchTokensCached(
      [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'a much longer reply here' },
      ],
      tokenization,
      'm2',
    )!;
    expect(two).toBeGreaterThan(one);
  });

  it('returns null when no encoding is available', () => {
    const noEnc = { normalizedModelName: 'x', contextWindowTokens: null, encodingModelName: null, encoding: null };
    expect(countBranchTokensCached([{ role: 'user', content: 'hi' }], noEnc, 'm1')).toBeNull();
  });
});

describe('serializeForTokenCounting', () => {
  it('serializes to JSON and returns empty string on a cyclic value', () => {
    expect(serializeForTokenCounting({ a: 1 })).toBe('{"a":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(serializeForTokenCounting(cyclic)).toBe('');
  });
});
