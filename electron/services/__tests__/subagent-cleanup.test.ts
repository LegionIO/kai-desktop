/**
 * Tests for the sub-agent cleanup SCHEDULER lifecycle (subagent-cleanup.ts) —
 * the timer arming/idempotency/teardown, NOT the sweep logic (which needs a real
 * memory DB). The concern this locks: initializeSubagentCleanup must arm its
 * setTimeout→setInterval chain at most once, so a re-init can't leak a second
 * (unref'd, uncancelable) chain running overlapping daily sweeps.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AppConfig } from '../../config/schema.js';
import { initializeSubagentCleanup, stopSubagentCleanup } from '../subagent-cleanup.js';

let appHome: string;
const memoryEnabled = () => ({ memory: { enabled: true } }) as unknown as AppConfig;
const memoryDisabled = () => ({ memory: { enabled: false } }) as unknown as AppConfig;

/** Pre-write a recent last-run so the startup catch-up sweep is skipped —
 *  keeps the DB-touching sweep out of these scheduler-only tests. */
function writeRecentLastRun() {
  const p = join(appHome, 'data', 'subagent-cleanup-last-run.txt');
  mkdirSync(join(appHome, 'data'), { recursive: true });
  writeFileSync(p, String(Date.now()));
}

beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), 'kai-sacleanup-'));
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  stopSubagentCleanup();
  vi.useRealTimers();
  rmSync(appHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('initializeSubagentCleanup scheduling', () => {
  it('arms exactly one timer chain on first init', () => {
    writeRecentLastRun();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    initializeSubagentCleanup(memoryEnabled, appHome, ':memory:');
    // One setTimeout for the 03:00 initial delay.
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second init does not arm another timer', () => {
    writeRecentLastRun();
    initializeSubagentCleanup(memoryEnabled, appHome, ':memory:');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    initializeSubagentCleanup(memoryEnabled, appHome, ':memory:');
    // No new timer armed; the skip path logs.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls.flat().some((a) => String(a).includes('already scheduled'))).toBe(true);
  });

  it('short-circuits when memory is disabled (no timer armed)', () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    initializeSubagentCleanup(memoryDisabled, appHome, ':memory:');
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('stopSubagentCleanup clears the arm guard so a later init re-arms', () => {
    writeRecentLastRun();
    initializeSubagentCleanup(memoryEnabled, appHome, ':memory:');
    stopSubagentCleanup();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    initializeSubagentCleanup(memoryEnabled, appHome, ':memory:');
    // After teardown, the second init arms a fresh timer (not skipped).
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('stopSubagentCleanup is safe to call when nothing is scheduled', () => {
    expect(() => stopSubagentCleanup()).not.toThrow();
  });

  it('does not run the startup catch-up sweep when last-run is recent', () => {
    writeRecentLastRun();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    initializeSubagentCleanup(memoryEnabled, appHome, ':memory:');
    // "Running startup catch-up sweep" must NOT be logged (last-run is fresh).
    expect(infoSpy.mock.calls.flat().some((a) => String(a).includes('catch-up'))).toBe(false);
  });
});
