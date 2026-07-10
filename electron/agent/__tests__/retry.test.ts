import { describe, it, expect } from 'vitest';
import { classifyError, calculateDelay } from '../retry';

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
