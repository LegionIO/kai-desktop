/**
 * Tests for src/lib/response-timing.ts pure helpers. These compute + format the
 * assistant response duration shown in the UI and round-trip it through message
 * metadata. Runs under the component config (now gated by pre-push + CI).
 */
import { describe, it, expect } from 'vitest';
import {
  parseTimestampMs,
  formatElapsed,
  buildResponseTiming,
  getResponseTiming,
  withResponseTiming,
} from '../response-timing';

describe('parseTimestampMs', () => {
  it('parses an ISO timestamp to epoch ms', () => {
    expect(parseTimestampMs('2026-07-12T00:00:00.000Z')).toBe(Date.parse('2026-07-12T00:00:00.000Z'));
  });
  it('returns null for empty / undefined', () => {
    expect(parseTimestampMs(undefined)).toBeNull();
    expect(parseTimestampMs('')).toBeNull();
  });
  it('returns null for an unparseable string', () => {
    expect(parseTimestampMs('not a date')).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('shows ms under a second', () => {
    expect(formatElapsed(0)).toBe('0ms');
    expect(formatElapsed(999)).toBe('999ms');
  });
  it('shows seconds from 1s up to a minute', () => {
    expect(formatElapsed(1000)).toBe('1s');
    expect(formatElapsed(59_000)).toBe('59s');
  });
  it('shows minutes+seconds', () => {
    expect(formatElapsed(60_000)).toBe('1m0s');
    expect(formatElapsed(90_000)).toBe('1m30s');
  });
  it('shows hours+minutes+seconds', () => {
    expect(formatElapsed(3_661_000)).toBe('1h1m1s');
  });
  it('floors fractional milliseconds', () => {
    expect(formatElapsed(12.9)).toBe('12ms');
  });
});

describe('buildResponseTiming', () => {
  it('computes durationMs from valid timestamps', () => {
    const t = buildResponseTiming('2026-07-12T00:00:00.000Z', '2026-07-12T00:00:02.500Z');
    expect(t).toEqual({
      startedAt: '2026-07-12T00:00:00.000Z',
      finishedAt: '2026-07-12T00:00:02.500Z',
      durationMs: 2500,
    });
  });
  it('clamps a negative duration (finished before started) to 0', () => {
    const t = buildResponseTiming('2026-07-12T00:00:05.000Z', '2026-07-12T00:00:00.000Z');
    expect(t.durationMs).toBe(0);
  });
  it('omits durationMs when a timestamp is invalid', () => {
    const t = buildResponseTiming('nope', '2026-07-12T00:00:00.000Z');
    expect(t).toEqual({ startedAt: 'nope', finishedAt: '2026-07-12T00:00:00.000Z' });
    expect('durationMs' in t).toBe(false);
  });
});

describe('getResponseTiming', () => {
  const wrap = (rt: unknown) => ({ metadata: { custom: { responseTiming: rt } } });

  it('extracts a valid timing record', () => {
    const msg = wrap({ startedAt: 's', finishedAt: 'f', durationMs: 42 });
    expect(getResponseTiming(msg)).toEqual({ startedAt: 's', finishedAt: 'f', durationMs: 42 });
  });
  it('requires a string startedAt', () => {
    expect(getResponseTiming(wrap({ finishedAt: 'f' }))).toBeNull();
    expect(getResponseTiming(wrap({ startedAt: 123 }))).toBeNull();
  });
  it('omits non-string finishedAt / non-number durationMs', () => {
    expect(getResponseTiming(wrap({ startedAt: 's', finishedAt: 5, durationMs: 'x' }))).toEqual({ startedAt: 's' });
  });
  it('returns null for missing / malformed metadata', () => {
    expect(getResponseTiming(null)).toBeNull();
    expect(getResponseTiming(undefined)).toBeNull();
    expect(getResponseTiming({})).toBeNull();
    expect(getResponseTiming({ metadata: {} })).toBeNull();
    expect(getResponseTiming({ metadata: { custom: {} } })).toBeNull();
  });
});

describe('withResponseTiming', () => {
  it('adds timing under metadata.custom.responseTiming, preserving existing keys', () => {
    const msg = { id: '1', metadata: { role: 'assistant', custom: { keep: true } } };
    const timing = { startedAt: 's', finishedAt: 'f', durationMs: 10 };
    const out = withResponseTiming(msg, timing);
    expect(out.id).toBe('1');
    const meta = out.metadata as Record<string, unknown>;
    expect(meta.role).toBe('assistant');
    const custom = meta.custom as Record<string, unknown>;
    expect(custom.keep).toBe(true);
    expect(custom.responseTiming).toEqual(timing);
  });

  it('creates metadata/custom when absent', () => {
    const input: { id: string; metadata?: unknown } = { id: '2' };
    const out = withResponseTiming(input, { startedAt: 's' });
    const custom = (out.metadata as Record<string, unknown>).custom as Record<string, unknown>;
    expect(custom.responseTiming).toEqual({ startedAt: 's' });
  });

  it('round-trips through getResponseTiming', () => {
    const timing = { startedAt: 's', finishedAt: 'f', durationMs: 7 };
    expect(getResponseTiming(withResponseTiming({}, timing))).toEqual(timing);
  });
});
