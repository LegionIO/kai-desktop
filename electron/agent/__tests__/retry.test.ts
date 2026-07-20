import { describe, it, expect } from 'vitest';
import { classifyError, calculateDelay, isSameModelRetryable } from '../retry';

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
