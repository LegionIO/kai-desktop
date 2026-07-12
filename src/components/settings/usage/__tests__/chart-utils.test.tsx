/**
 * Tests for the Usage dashboard chart-utils (component-gated via 178f07b). Pure
 * formatting + SVG-geometry helpers; describeArc's angle math (0° = top, the
 * large-arc flag when a segment sweeps past 180°) is the regression-prone part.
 */
import { describe, it, expect } from 'vitest';
import { formatTokenCount, formatDuration, formatDateShort, describeArc, getModelColorFallback } from '../chart-utils';

describe('formatTokenCount', () => {
  it('abbreviates millions and thousands to 1 decimal', () => {
    expect(formatTokenCount(2_500_000)).toBe('2.5M');
    expect(formatTokenCount(1_000_000)).toBe('1.0M');
    expect(formatTokenCount(1_500)).toBe('1.5K');
    expect(formatTokenCount(1_000)).toBe('1.0K');
  });
  it('renders sub-1000 counts with locale grouping', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(0)).toBe('0');
  });
});

describe('formatDuration', () => {
  it('shows seconds under a minute (rounded)', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45.4)).toBe('45s');
    expect(formatDuration(59)).toBe('59s');
  });
  it('shows minutes+seconds under an hour', () => {
    expect(formatDuration(60)).toBe('1m'); // no leftover seconds → "1m"
    expect(formatDuration(90)).toBe('1m 30s');
  });
  it('shows hours+minutes at/over an hour', () => {
    expect(formatDuration(3600)).toBe('1h 0m');
    expect(formatDuration(3661)).toBe('1h 1m');
  });
});

describe('formatDateShort', () => {
  it('returns "" for empty input', () => {
    expect(formatDateShort('')).toBe('');
  });
  it('formats to a short "Mon D" label', () => {
    // UTC-noon avoids a tz/DST date rollover; assert the shape, not an exact tz.
    expect(formatDateShort('2026-07-04T12:00:00.000Z')).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});

describe('describeArc', () => {
  it('starts a 0° segment at the top of the circle (12 o’clock)', () => {
    // 0° with the -90 rotation → point at (cx, cy - r) = top.
    const d = describeArc(50, 50, 40, 0, 90);
    expect(d.startsWith('M 50 10 ')).toBe(true); // cy - r = 10
  });
  it('sets the large-arc flag to 0 for a <=180° sweep and 1 for >180°', () => {
    expect(describeArc(0, 0, 10, 0, 90)).toContain('A 10 10 0 0 1');
    expect(describeArc(0, 0, 10, 0, 270)).toContain('A 10 10 0 1 1');
  });
  it('produces a full valid arc command shape', () => {
    expect(describeArc(0, 0, 10, 0, 180)).toMatch(/^M -?\d/);
    expect(describeArc(0, 0, 10, 0, 180)).toContain(' A 10 10 0 ');
  });
});

describe('getModelColorFallback', () => {
  it('wraps by modulo over the 8-color palette', () => {
    expect(getModelColorFallback(0)).toBe(getModelColorFallback(8));
    expect(getModelColorFallback(1)).toBe(getModelColorFallback(9));
    expect(getModelColorFallback(0)).not.toBe(getModelColorFallback(1));
    expect(getModelColorFallback(0)).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
