import { describe, it, expect } from 'vitest';
import { classifyError, calculateDelay, isSameModelRetryable, isContextOverflowError } from '../retry';

describe('classifyError', () => {
  it('treats 408 as transient (retryable) despite being a 4xx', () => {
    expect(classifyError({ status: 408 }).isTransient).toBe(true);
    expect(classifyError({ status: 408 }).category).toBe('timeout');
  });

  it('treats 429 as transient (rate-limit)', () => {
    expect(classifyError({ status: 429 }).isTransient).toBe(true);
    expect(classifyError({ status: 429 }).category).toBe('rate-limit');
  });

  it('treats other 4xx as non-transient client errors', () => {
    expect(classifyError({ status: 400 }).isTransient).toBe(false);
    expect(classifyError({ status: 404 }).isTransient).toBe(false);
    expect(classifyError({ status: 422 }).isTransient).toBe(false);
  });

  it('classifies context-overflow errors distinctly (400/413 or statusless message)', () => {
    for (const msg of [
      "This model's maximum context length is 200000 tokens",
      'prompt is too long: 210000 tokens > 200000 maximum',
      'input is too long for requested model',
      'too many tokens in the request',
      'Please reduce the length of the messages',
      'context window exceeded',
    ]) {
      const info = classifyError({ status: 400, message: msg });
      expect(info.category, msg).toBe('context-overflow');
      expect(info.isTransient, msg).toBe(false);
      expect(isContextOverflowError({ status: 400, message: msg }), msg).toBe(true);
    }
    // Statusless (mid-stream error string) still classifies.
    expect(classifyError(new Error('maximum context length exceeded')).category).toBe('context-overflow');
    // 413 payload-too-large with an overflow message.
    expect(classifyError({ status: 413, message: 'prompt is too long' }).category).toBe('context-overflow');
    // 422 Unprocessable Entity — OpenAI-compatible servers (vLLM/LM Studio) use it
    // for "prompt is too long"; must route to overflow recovery, not client-error.
    expect(classifyError({ status: 422, message: 'prompt is too long' }).category).toBe('context-overflow');
    expect(isContextOverflowError({ status: 422, message: 'prompt is too long' })).toBe(true);
  });

  it('a bare 422 with no overflow phrasing stays a client-error (not misrouted to overflow)', () => {
    expect(classifyError({ status: 422, message: 'validation failed: field required' }).category).toBe(
      'client-error',
    );
    expect(isContextOverflowError({ status: 422 })).toBe(false);
  });

  it('classifies 413 payload phrasing as overflow ONLY with token/context evidence', () => {
    // A canonical 413 body WITHOUT token/context evidence is ambiguous (may be a
    // gateway body-size limit compaction can't fix) → client-error, not overflow.
    expect(classifyError({ status: 413, message: 'Payload Too Large' }).category).toBe('client-error');
    expect(classifyError({ status: 413, message: 'Request Entity Too Large' }).category).toBe('client-error');
    expect(classifyError(new Error('payload too large')).category).not.toBe('context-overflow');
    // WITH token/context evidence → overflow (compaction can help).
    expect(
      classifyError({ status: 413, message: 'Payload Too Large: prompt is too long' }).category,
    ).toBe('context-overflow');
    // A BARE 413 (no phrasing at all) → client-error.
    expect(classifyError({ status: 413 }).category).toBe('client-error');
    expect(isContextOverflowError({ status: 413 })).toBe(false);
  });

  it('does not misclassify a plain 400 (no overflow keywords) as context-overflow', () => {
    expect(classifyError({ status: 400, message: 'invalid request' }).category).toBe('client-error');
    expect(isContextOverflowError({ status: 400, message: 'invalid request' })).toBe(false);
  });

  it('does not treat a rate-limit "too many requests" as context-overflow', () => {
    expect(classifyError({ status: 429, message: 'too many requests' }).category).toBe('rate-limit');
  });

  it('does NOT classify OUTPUT-token or QUOTA errors as context-overflow', () => {
    // Compacting the INPUT context can't fix an output cap or an account quota, so
    // these must NOT trigger paid compaction / `/compact` guidance.
    for (const msg of [
      'output token limit exceeded',
      'max_tokens exceeded',
      'completion tokens exceeded the maximum',
      'token quota exceeded for this month',
      'billing quota exceeded',
      // Generation-cap phrasing from custom/OSS endpoints (vLLM/TGI) — bounds OUTPUT,
      // so compacting the INPUT can't fix it and would re-fail on the same cap.
      'max_new_tokens must not exceed 4096',
      'max_output_tokens is greater than the allowed maximum',
      'max_completion_tokens exceeds the limit',
    ]) {
      expect(classifyError({ status: 400, message: msg }).category, msg).not.toBe('context-overflow');
      expect(isContextOverflowError({ status: 400, message: msg }), msg).toBe(false);
    }
  });

  it('DOES classify an input overflow that also mentions max_tokens (context phrasing present)', () => {
    // Some providers phrase a genuine INPUT overflow as "prompt tokens + max_tokens
    // exceed the context length" — the max_tokens exclusion must NOT swallow it.
    const msg = 'prompt tokens + max_tokens exceed the context length of this model';
    expect(classifyError({ status: 400, message: msg }).category).toBe('context-overflow');
    expect(isContextOverflowError({ status: 400, message: msg })).toBe(true);
  });

  it('classifies token-throttling errors as rate-limit, NOT context-overflow', () => {
    // AWS-style throttle exception with "tokens" → rate-limit (transient), not overflow.
    expect(classifyError(new Error('ThrottlingException: too many tokens')).category).toBe('rate-limit');
    expect(isContextOverflowError(new Error('ThrottlingException: too many tokens'))).toBe(false);
    // Other throttle phrasings mentioning tokens must at least NOT be misfiled as
    // context-overflow (which would trigger a pointless compaction).
    expect(isContextOverflowError(new Error('token rate exceeded, retry later'))).toBe(false);
    expect(isContextOverflowError(new Error('tokens per minute limit exceeded'))).toBe(false);
  });

  it('treats 402 as transient (quota/billing) despite being a 4xx', () => {
    expect(classifyError({ status: 402 }).isTransient).toBe(true);
    expect(classifyError({ status: 402 }).category).toBe('quota');
    expect(classifyError(new Error('Payment Required')).category).toBe('unknown');
    expect(classifyError({ status: 402, message: 'Payment Required' }).isTransient).toBe(true);
  });

  it('treats 401/403 as non-transient auth', () => {
    expect(classifyError({ status: 401 }).category).toBe('auth');
    expect(classifyError({ status: 403 }).category).toBe('auth');
    expect(classifyError({ status: 401 }).isTransient).toBe(false);
  });

  it('treats 5xx and 529 as transient', () => {
    expect(classifyError({ status: 500 }).isTransient).toBe(true);
    expect(classifyError({ status: 503 }).isTransient).toBe(true);
    expect(classifyError({ status: 529 }).category).toBe('overload');
  });

  it('recognizes a statusless timeout message as transient', () => {
    expect(classifyError(new Error('Request timed out')).isTransient).toBe(true);
    expect(classifyError(new Error('operation timeout')).isTransient).toBe(true);
  });

  it('recognizes network-keyword errors as transient', () => {
    expect(classifyError(new Error('ECONNRESET')).isTransient).toBe(true);
    expect(classifyError(new Error('fetch failed')).isTransient).toBe(true);
  });

  it('parses Retry-After from a plain headers object (seconds)', () => {
    const info = classifyError({ status: 429, headers: { 'retry-after': '2' } });
    expect(info.retryAfterMs).toBe(2000);
  });

  it('parses Retry-After from a Fetch Headers instance', () => {
    const headers = new Headers({ 'retry-after': '3' });
    const info = classifyError({ status: 429, headers });
    expect(info.retryAfterMs).toBe(3000);
  });

  it('unknown errors are non-transient', () => {
    expect(classifyError(new Error('something weird')).isTransient).toBe(false);
    expect(classifyError('a string').isTransient).toBe(false);
  });

  it('classifies string-only messages (no status code) that arrive as mid-stream error events', () => {
    // These commonly surface as a bare string in an `error` stream event with no
    // status object — must be transient so mid-stream fallback engages.
    expect(classifyError('Internal Server Error').isTransient).toBe(true);
    expect(classifyError('Internal Server Error').category).toBe('server-error');
    expect(classifyError('Overloaded').isTransient).toBe(true);
    expect(classifyError('Overloaded').category).toBe('overload');
    expect(classifyError('503 Service Unavailable').isTransient).toBe(true);
    expect(classifyError('Bad Gateway').isTransient).toBe(true);
    expect(classifyError('The response was canceled').isTransient).toBe(true);
    expect(classifyError('premature close').isTransient).toBe(true);
    // A plain 4xx-style message stays non-transient.
    expect(classifyError('400 bad request').isTransient).toBe(false);
  });

  it('honors an explicit isRetryable marker and "unable to process" gateway text', () => {
    // Some SDKs/gateways set isRetryable on a statusless error object.
    expect(classifyError({ isRetryable: true, message: 'weird' }).isTransient).toBe(true);
    // Gateways often return "unable to process" for a transient dip.
    expect(classifyError('Unable to process your request').isTransient).toBe(true);
    // isRetryable:false / absent stays governed by the other rules.
    expect(classifyError({ isRetryable: false, message: 'nope' }).isTransient).toBe(false);
  });
});

describe('calculateDelay', () => {
  const info = classifyError({ status: 500 });

  it('respects Retry-After when present (capped)', () => {
    const withRetryAfter = { ...info, retryAfterMs: 5000 };
    expect(calculateDelay(0, withRetryAfter, 500, 32000)).toBe(5000);
  });

  it('produces a finite backoff within the cap', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const d = calculateDelay(attempt, info, 500, 32000);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(32000);
    }
  });
});

describe('isSameModelRetryable — quota (402) is fallback-eligible but NOT same-model-retryable', () => {
  it('402 quota: transient (so fallback engages) but not same-model-retryable', () => {
    const info = classifyError({ status: 402 });
    expect(info.category).toBe('quota');
    expect(info.isTransient).toBe(true); // still eligible for model FALLBACK
    expect(isSameModelRetryable(info)).toBe(false); // but never retry the depleted account
  });

  it('a Retry-After 402 does not become a same-model retry (would sleep for hours)', () => {
    const info = classifyError({ status: 402, headers: { 'retry-after': '21600' } });
    expect(isSameModelRetryable(info)).toBe(false);
  });

  it('ordinary transient errors remain same-model-retryable', () => {
    expect(isSameModelRetryable(classifyError({ status: 429 }))).toBe(true);
    expect(isSameModelRetryable(classifyError({ status: 503 }))).toBe(true);
    expect(isSameModelRetryable(classifyError({ status: 408 }))).toBe(true);
  });

  it('non-transient errors are not same-model-retryable', () => {
    expect(isSameModelRetryable(classifyError({ status: 400 }))).toBe(false);
  });
});
