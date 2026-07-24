import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveConversationTokenization,
  normalizeConversationModelName,
  estimateSerializedTokens,
  countBranchTokensCached,
  countSerializedTokens,
  serializeForTokenCounting,
  sumBranchTokenCounts,
  countMessageTokensCanonical,
  computeMessageCount,
  messageContentSig,
  tokenProjectionByteCeiling,
  tokenProjectionSerializedLength,
  encodeCappedWith,
  resolveEncodingForModel,
  MAX_SYNC_ENCODE_CHARS,
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

  it('falls back to a conservative context window for a wholly unknown model (compaction stays enabled)', () => {
    // Previously returned null, which silently disabled compaction and let an
    // unknown model's history grow unbounded until it froze the main thread.
    const win = resolveConversationTokenization('totally-made-up-model-xyz').contextWindowTokens;
    expect(win).not.toBeNull();
    expect(win).toBeGreaterThan(0);
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

describe('gpt-5.5 + unknown-model context windows', () => {
  it('recognizes gpt-5.5 and gpt-5.5-pro with a context window', () => {
    expect(normalizeConversationModelName('openai/gpt-5.5-2026-01-01')).toBe('gpt-5.5');
    expect(normalizeConversationModelName('gpt-5.5-pro')).toBe('gpt-5.5-pro');
    expect(resolveConversationTokenization('gpt-5.5').contextWindowTokens).toBe(MODEL_CONTEXT_WINDOWS['gpt-5.5']);
    expect(resolveConversationTokenization('gpt-5.5-pro').contextWindowTokens).toBe(
      MODEL_CONTEXT_WINDOWS['gpt-5.5-pro'],
    );
  });

  it('falls back to a conservative window for an unknown model (so compaction still runs)', () => {
    const info = resolveConversationTokenization('some-brand-new-model-9');
    // Was previously null (which silently disabled compaction and let history grow unbounded).
    expect(info.contextWindowTokens).toBeGreaterThan(0);
  });

  it('an explicit override always wins over the default', () => {
    expect(resolveConversationTokenization('some-brand-new-model-9', 999_999).contextWindowTokens).toBe(999_999);
  });
});

describe('sumBranchTokenCounts', () => {
  it('sums present numeric counts directly (integer-only fast path, no reserialize)', () => {
    const msgs = [
      { role: 'user', content: 'aa', tokenCount: 10 },
      { role: 'user', content: 'bb', tokenCount: 5 },
      { role: 'user', content: 'cc', tokenCount: 0 },
    ];
    expect(sumBranchTokenCounts(msgs)).toBe(15);
  });

  it('does NOT re-serialize a message that has a valid cached count', () => {
    // A content value whose serialization would throw if touched — proves the sum
    // trusts the count without serializing/estimating it.
    const exploding: Record<string, unknown> = { role: 'user', tokenCount: 7 };
    Object.defineProperty(exploding, 'content', {
      enumerable: true,
      get() {
        throw new Error('content must not be read when a valid count is present');
      },
    });
    expect(() => sumBranchTokenCounts([exploding])).not.toThrow();
    expect(sumBranchTokenCounts([exploding])).toBe(7);
  });

  it('falls back to an over-biased estimate for messages missing a count', () => {
    const missing = sumBranchTokenCounts([{ role: 'user', content: 'hello world' }]);
    expect(missing).toBeGreaterThan(0);
  });

  it('ignores invalid (negative/NaN) counts and estimates instead', () => {
    const s = sumBranchTokenCounts([
      { role: 'user', content: 'x', tokenCount: -4 },
      { role: 'user', content: 'y', tokenCount: Number.NaN },
    ]);
    expect(s).toBeGreaterThan(0);
  });

  it('the summed value is a safe over-estimate of the whole-array exact count', () => {
    const msgs = [
      { role: 'user' as const, content: 'The quick brown fox jumps over the lazy dog.' },
      { role: 'assistant' as const, content: 'A summary of the prior message with some detail.' },
      { role: 'user' as const, content: 'Another follow-up question about the topic at hand.' },
    ];
    const withCounts = msgs.map((m) => {
      const { count, sig: s } = computeMessageCount(m);
      return { ...m, tokenCount: count, tokenCountSig: s };
    });
    const tokenization = resolveConversationTokenization('gpt-5');
    const exactWhole = countSerializedTokens(
      msgs.map((m) => ({ role: m.role, content: m.content })),
      tokenization,
    )!;
    const summed = sumBranchTokenCounts(withCounts);
    // Per-message counts don't share BPE merges across delimiters, so the sum is
    // >= the whole-array encode. Never-skip property: gate value must not undercount.
    expect(summed).toBeGreaterThanOrEqual(exactWhole);
  });
});

describe('messageContentSig', () => {
  it('differs for same-LENGTH but different content (collision-resistant)', () => {
    // A length-only signature would collide here; the hash must not.
    const a = messageContentSig({ role: 'user', content: 'aaaaaaaaaa' });
    const b = messageContentSig({ role: 'user', content: 'bbbbbbbbbb' });
    expect(a).not.toBe(b);
  });

  it('is stable for identical content and changes when content changes', () => {
    const base = { role: 'user', content: 'hello world' };
    expect(messageContentSig(base)).toBe(messageContentSig({ ...base }));
    expect(messageContentSig(base)).not.toBe(messageContentSig({ role: 'user', content: 'hello worlds' }));
  });

  it('accounts for top-level tool_calls (model-bearing) in the count and signature', () => {
    const withArgs = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', function: { name: 'run', arguments: JSON.stringify({ q: 'x'.repeat(2000) }) } }],
    };
    const withoutArgs = { role: 'assistant', content: '' };
    // Big tool args must raise the count (otherwise it under-counts and can bypass
    // the compaction gate) and change the signature.
    expect(countMessageTokensCanonical(withArgs)!).toBeGreaterThan(countMessageTokensCanonical(withoutArgs)!);
    expect(messageContentSig(withArgs)).not.toBe(messageContentSig(withoutArgs));
    // A change to tool_calls alone flips the signature.
    const changed = { ...withArgs, tool_calls: [{ id: 'c1', function: { name: 'run', arguments: '{}' } }] };
    expect(messageContentSig(changed)).not.toBe(messageContentSig(withArgs));
  });
});

describe('tokenProjectionByteCeiling', () => {
  it('is a true token ceiling (>= exact count) for CJK / token-dense content', () => {
    const cjk = { role: 'user', content: '日本語のテキストをたくさん'.repeat(50) };
    const ceiling = tokenProjectionByteCeiling(cjk);
    const exact = countMessageTokensCanonical(cjk)!;
    expect(ceiling).toBeGreaterThanOrEqual(exact); // never under-counts
    // And strictly greater than the old length/3 estimate would be for CJK.
    const projLen = tokenProjectionSerializedLength(cjk);
    expect(ceiling).toBeGreaterThan(Math.ceil(projLen / 3));
  });
});

describe('countMessageTokensCanonical', () => {
  it('counts a single message via the canonical encoding', () => {
    const n = countMessageTokensCanonical({ role: 'user', content: 'hello' });
    expect(typeof n).toBe('number');
    expect(n).toBeGreaterThan(0);
  });

  it('counts only the {role, content} projection (tree bookkeeping is irrelevant)', () => {
    const a = countMessageTokensCanonical({ role: 'user', content: 'hello' });
    const b = countMessageTokensCanonical({
      // extra tree fields must not change the count
      ...{ id: 'x', parentId: 'y', createdAt: 'z' },
      role: 'user',
      content: 'hello',
    } as { role: string; content: string });
    expect(a).toBe(b);
  });
});

describe('encode cap (main-thread freeze backstop)', () => {
  it('encodes normally below the cap', () => {
    const enc = resolveEncodingForModel('gpt-5')!;
    const small = 'hello world '.repeat(10);
    expect(encodeCappedWith(small, enc)).toBe(enc.encode(small).length);
  });

  it('falls back to a TRUE-UPPER-BOUND char count above the cap instead of encoding', () => {
    const enc = resolveEncodingForModel('gpt-5')!;
    const huge = 'a'.repeat(MAX_SYNC_ENCODE_CHARS + 1);
    const capped = encodeCappedWith(huge, enc);
    // Above the cap we must NOT run the slow encode, and must return a value that
    // can never UNDER-count (1 token/char worst case), so budget-fit never accepts
    // an over-window prefix. For this ASCII string the real count is far smaller,
    // so the ceiling being >= real is the safe property.
    expect(capped).toBe(huge.length);
  });

  it('countBranchTokensCached honors the cap for a pathological branch', () => {
    __clearExactTokenCacheForTests();
    const tokenization = resolveConversationTokenization('gpt-5');
    const bigContent = 'z'.repeat(MAX_SYNC_ENCODE_CHARS + 100);
    const n = countBranchTokensCached([{ role: 'user', content: bigContent }], tokenization, 'big');
    expect(n).toBeGreaterThan(0);
  });
});
