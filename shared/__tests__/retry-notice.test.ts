import { describe, it, expect } from 'vitest';

import { formatRetryNotice, formatRetryNoticeLine } from '../retry-notice';

describe('formatRetryNotice', () => {
  it('returns null for absent payloads so callers can skip rendering', () => {
    expect(formatRetryNotice(undefined)).toBeNull();
    expect(formatRetryNotice(null)).toBeNull();
    expect(formatRetryNoticeLine(undefined)).toBeNull();
  });

  it('never emits the old attempt/delay/category shorthand', () => {
    // The regression this module exists for: "Retrying (1/4) in 0s — compatibility"
    // read like assistant prose and explained nothing.
    const notice = formatRetryNotice({
      kind: 'provider-compatibility',
      adjustment: 'omit-temperature',
      attempt: 1,
      maxRetries: 4,
      delayMs: 0,
      category: 'compatibility',
    });
    expect(notice?.title).not.toMatch(/Retrying \(/);
    expect(notice?.title).not.toMatch(/in 0s/);
    expect(notice?.title).not.toMatch(/— compatibility/);
  });

  describe('provider-compatibility', () => {
    it('names the temperature adjustment and why it happened', () => {
      const notice = formatRetryNotice({
        kind: 'provider-compatibility',
        adjustment: 'omit-temperature',
        attempt: 1,
        maxRetries: 4,
        delayMs: 0,
        reason: "Unsupported parameter: 'temperature' is not supported with this model.",
        category: 'compatibility',
      });
      expect(notice?.title).toContain('temperature');
      expect(notice?.title).toContain('re-sent');
      expect(notice?.detail).toContain('Unsupported parameter');
    });

    it('names the history repair for a sanitization retry', () => {
      const notice = formatRetryNotice({
        kind: 'provider-compatibility',
        adjustment: 'sanitize-messages',
        reason: 'Expected toolResult blocks',
      });
      expect(notice?.title).toContain('conversation history');
      expect(notice?.detail).toBe('Expected toolResult blocks');
    });

    it('falls back to a generic adjustment line when the adjustment is unknown', () => {
      const notice = formatRetryNotice({ kind: 'provider-compatibility' });
      expect(notice?.title).toMatch(/adjusted the request/i);
      expect(notice?.detail).toBeUndefined();
    });

    it('omits the zero-delay wait entirely', () => {
      const notice = formatRetryNotice({
        kind: 'provider-compatibility',
        adjustment: 'omit-temperature',
        delayMs: 0,
      });
      expect(notice?.title).not.toMatch(/0s|in 0/);
    });
  });

  describe('transient', () => {
    it('explains the category in plain English and reports the wait', () => {
      const notice = formatRetryNotice({
        kind: 'transient',
        attempt: 2,
        maxRetries: 4,
        delayMs: 2000,
        category: 'rate-limit',
        reason: '429 Too Many Requests',
      });
      expect(notice?.title).toContain('rate-limited');
      expect(notice?.title).toContain('retrying in 2s');
      expect(notice?.title).toContain('attempt 2 of 4');
      expect(notice?.detail).toBe('429 Too Many Requests');
    });

    it('formats a long backoff in minutes', () => {
      const notice = formatRetryNotice({ kind: 'transient', delayMs: 90_000, category: 'overload' });
      expect(notice?.title).toContain('1m 30s');
    });

    it('rounds a whole-minute backoff without a dangling zero', () => {
      const notice = formatRetryNotice({ kind: 'transient', delayMs: 120_000, category: 'overload' });
      expect(notice?.title).toContain('2m');
      expect(notice?.title).not.toContain('2m 0s');
    });

    it('drops a sub-second backoff rather than claiming "in 0s"', () => {
      const notice = formatRetryNotice({ kind: 'transient', delayMs: 500, category: 'network' });
      expect(notice?.title).toContain('retrying.');
      expect(notice?.title).not.toMatch(/in 0s/);
    });

    it('omits the attempt counter unless BOTH numbers are known', () => {
      expect(formatRetryNotice({ kind: 'transient', attempt: 2 })?.title).not.toContain('attempt');
      expect(formatRetryNotice({ kind: 'transient', maxRetries: 4 })?.title).not.toContain('attempt');
      // Never render "(2/undefined)" or a NaN.
      expect(formatRetryNotice({ kind: 'transient', attempt: 2, maxRetries: 4 })?.title).toContain('attempt 2 of 4');
    });

    it('never renders NaN from a non-finite delay', () => {
      const notice = formatRetryNotice({ kind: 'transient', delayMs: Number.NaN, category: 'network' });
      expect(notice?.title).not.toMatch(/NaN/);
    });

    it('accepts the Claude-SDK delaySeconds spelling', () => {
      const notice = formatRetryNotice({ kind: 'transient', delaySeconds: 3, reason: 'API retry' });
      expect(notice?.title).toContain('retrying in 3s');
      expect(notice?.detail).toBe('API retry');
    });

    it('treats an untagged legacy payload as transient rather than throwing', () => {
      const notice = formatRetryNotice({ attempt: 1, maxRetries: 4, delayMs: 1000, category: 'server-error' });
      expect(notice?.title).toContain('server error');
    });
  });

  describe('context-overflow', () => {
    it('says what Kai did about the oversized request', () => {
      const notice = formatRetryNotice({ kind: 'context-overflow', category: 'context-overflow' });
      expect(notice?.title).toContain('context window');
      expect(notice?.title).toContain('compacted');
    });
  });

  describe('pre-formatted text override', () => {
    it('honours a legacy producer’s own sentence', () => {
      const notice = formatRetryNotice({ text: 'Something bespoke happened.' });
      expect(notice?.title).toBe('Something bespoke happened.');
    });

    it('strips the markdown blockquote + info emoji lead-in', () => {
      const notice = formatRetryNotice({ text: '> ℹ️ The request was too large; compacted and retrying…' });
      expect(notice?.title).toBe('The request was too large; compacted and retrying…');
    });

    it('ignores a blank override and falls through to the tagged wording', () => {
      const notice = formatRetryNotice({ text: '   ', kind: 'context-overflow' });
      expect(notice?.title).toContain('context window');
    });
  });

  it('collapses whitespace and elides an overlong provider message', () => {
    const long = 'x'.repeat(400);
    const notice = formatRetryNotice({ kind: 'transient', reason: `429\n\n   ${long}` });
    expect(notice?.detail?.length).toBeLessThanOrEqual(240);
    expect(notice?.detail).toMatch(/…$/);
    expect(notice?.detail).not.toContain('\n');
  });

  describe('formatRetryNoticeLine', () => {
    it('joins the title and detail for plain-text surfaces', () => {
      const line = formatRetryNoticeLine({
        kind: 'provider-compatibility',
        adjustment: 'omit-temperature',
        reason: "Unsupported parameter: 'temperature'",
      });
      expect(line).toContain('temperature');
      expect(line).toContain("— Unsupported parameter: 'temperature'");
    });

    it('returns just the title when there is no detail', () => {
      const line = formatRetryNoticeLine({ kind: 'context-overflow' });
      expect(line).not.toContain(' — ');
    });
  });
});
