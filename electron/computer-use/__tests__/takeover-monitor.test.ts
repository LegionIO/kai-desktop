/**
 * Tests for the takeover-suppression window in takeover-monitor.ts. The
 * suppression window stops the computer-use harness's OWN synthetic input from
 * being misread as a manual takeover (which pauses automation). The bug this
 * covers: the window was only ever extended (Math.max), never reset, so a stale
 * window from a prior session could blind takeover detection at the start of the
 * next one — dangerous on the experimental win/linux path where this is the
 * safety net. stopLocalMacosTakeoverMonitor now resets it.
 *
 * The native monitor import is mocked so start/stop don't spawn a helper.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../harnesses/local-macos.js', () => ({
  startLocalMacosTakeoverMonitor: () => ({ process: { on: vi.fn(), killed: false }, stop: vi.fn() }),
}));
vi.mock('../permissions.js', () => ({ resolveMaterializedHelperPath: () => '/tmp/helper' }));

import { suppressTakeoverEvents, isTakeoverSuppressed, stopLocalMacosTakeoverMonitor } from '../takeover-monitor.js';

afterEach(() => {
  stopLocalMacosTakeoverMonitor(); // resets the window
  vi.useRealTimers();
});

describe('suppressTakeoverEvents / isTakeoverSuppressed', () => {
  it('opens a suppression window for the given duration', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    expect(isTakeoverSuppressed()).toBe(false);
    suppressTakeoverEvents(500);
    expect(isTakeoverSuppressed()).toBe(true);
    vi.setSystemTime(1_000_499);
    expect(isTakeoverSuppressed()).toBe(true);
    vi.setSystemTime(1_000_501);
    expect(isTakeoverSuppressed()).toBe(false); // window elapsed
  });

  it('is monotonic: a shorter later suppression does not shrink the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    suppressTakeoverEvents(5000); // window → 2_005_000
    suppressTakeoverEvents(100); // shorter → must NOT shrink to 2_000_100
    vi.setSystemTime(2_003_000); // past the short window, within the long one
    expect(isTakeoverSuppressed()).toBe(true);
  });

  it('accepts an explicit now argument', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    suppressTakeoverEvents(1000); // window → 3_001_000
    expect(isTakeoverSuppressed(3_000_500)).toBe(true);
    expect(isTakeoverSuppressed(3_002_000)).toBe(false);
  });
});

describe('stopLocalMacosTakeoverMonitor resets the suppression window', () => {
  it('clears an open suppression window immediately (no cross-session bleed)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000_000);
    suppressTakeoverEvents(10_000); // long window, still open
    expect(isTakeoverSuppressed()).toBe(true);
    stopLocalMacosTakeoverMonitor();
    // The window is reset to 0 → not suppressed, even though 10s haven't passed.
    expect(isTakeoverSuppressed()).toBe(false);
  });
});
