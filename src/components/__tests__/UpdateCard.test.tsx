/**
 * Tests for fmtEta — the download-ETA formatter in UpdateCard.
 * It derives time-remaining from (total - transferred) / bytesPerSecond and
 * must (a) return null when it can't be estimated so the UI shows nothing
 * rather than a bogus "0s", and (b) format seconds/minutes/hours cleanly at
 * the boundaries.
 */
import { describe, it, expect } from 'vitest';
import { __test__ } from '../UpdateCard';

const { fmtEta } = __test__;

describe('fmtEta', () => {
  it('returns null when it cannot be estimated', () => {
    expect(fmtEta(0, 100, 0)).toBeNull(); // zero speed
    expect(fmtEta(0, 100, undefined)).toBeNull(); // no speed
    expect(fmtEta(undefined, 100, 10)).toBeNull(); // no transferred
    expect(fmtEta(0, undefined, 10)).toBeNull(); // no total
    expect(fmtEta(0, 100, -5)).toBeNull(); // negative speed
  });

  it('returns null when nothing remains (avoids a bogus "0s left")', () => {
    expect(fmtEta(100, 100, 10)).toBeNull();
    expect(fmtEta(120, 100, 10)).toBeNull(); // over-transferred
  });

  it('formats sub-minute as whole seconds (rounded up)', () => {
    // 90 bytes left at 10 B/s = 9s
    expect(fmtEta(10, 100, 10)).toBe('9s left');
    // 91 bytes left at 10 B/s = ceil(9.1) = 10s
    expect(fmtEta(9, 100, 10)).toBe('10s left');
  });

  it('crosses the 60s boundary into minutes', () => {
    // 59s stays seconds
    expect(fmtEta(0, 59, 1)).toBe('59s left');
    // 60s becomes 1m (no remainder)
    expect(fmtEta(0, 60, 1)).toBe('1m left');
    // 61s becomes 1m 1s
    expect(fmtEta(0, 61, 1)).toBe('1m 1s left');
  });

  it('formats minutes with and without a seconds remainder', () => {
    expect(fmtEta(0, 120, 1)).toBe('2m left'); // exactly 2m
    expect(fmtEta(0, 125, 1)).toBe('2m 5s left');
  });

  it('crosses the 60m boundary into hours', () => {
    expect(fmtEta(0, 3600, 1)).toBe('1h 0m left'); // exactly 1h
    expect(fmtEta(0, 3660, 1)).toBe('1h 1m left');
    expect(fmtEta(0, 7325, 1)).toBe('2h 2m left'); // 2h 2m 5s → drops the seconds
  });
});

describe('disconnectWarning', () => {
  const { disconnectWarning } = __test__;
  it('says nothing when no clients would be disconnected', () => {
    expect(disconnectWarning(undefined)).toBeNull();
    expect(disconnectWarning({ web: 0, cli: 0, mcp: 0 })).toBeNull();
  });
  it('lists only non-zero client kinds with correct plurals', () => {
    expect(disconnectWarning({ web: 1, cli: 0, mcp: 0 })).toBe('1 web client will be disconnected.');
    expect(disconnectWarning({ web: 1, cli: 0, mcp: 3 })).toBe('1 web client and 3 MCP connections will be disconnected.');
    expect(disconnectWarning({ web: 2, cli: 1, mcp: 1 })).toBe(
      '2 web clients, 1 CLI session and 1 MCP connection will be disconnected.',
    );
  });
});
