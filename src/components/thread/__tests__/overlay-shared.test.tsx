/**
 * Test for overlay-shared.tsx formatDuration — the MM:SS recording-timer label
 * shown on the computer-use overlay (component-gated via 178f07b). This is a
 * DISTINCT formatter from the usage-dashboard chart-utils formatDuration (which
 * renders a human "1h 2m" style); this one is a zero-padded clock. Lock the
 * padding + minutes-overflow behavior so the two don't accidentally converge.
 */
import { describe, it, expect } from 'vitest';
import { formatDuration } from '../overlay-shared';

describe('overlay formatDuration (MM:SS)', () => {
  it('zero-pads minutes and seconds', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(5)).toBe('00:05');
    expect(formatDuration(65)).toBe('01:05');
  });

  it('counts full minutes (no hour rollover — a long timer keeps growing minutes)', () => {
    expect(formatDuration(600)).toBe('10:00');
    expect(formatDuration(3661)).toBe('61:01'); // 61 minutes, 1 second — no "1h"
  });

  it('handles the sub-minute and exact-minute boundaries', () => {
    expect(formatDuration(59)).toBe('00:59');
    expect(formatDuration(60)).toBe('01:00');
  });
});
