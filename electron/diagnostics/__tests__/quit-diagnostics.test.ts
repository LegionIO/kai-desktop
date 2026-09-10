/**
 * Tests for the opt-in quit-diagnostics writer. Load-bearing behavior:
 *  - opening a session writes a quit header + the at-quit (T0) handle snapshot;
 *  - `step()` brackets a cleanup call with start + done lines carrying elapsedMs,
 *    and the done-fn is idempotent (a double-fire won't double-log);
 *  - the handle describer tolerates a throwing getter and an unknown handle type
 *    without throwing (it runs during quit — it must never throw);
 *  - when Node's _getActiveHandles/_getActiveRequests are unavailable it records
 *    an "unavailable" marker instead of throwing;
 *  - the log is bounded (single-roll to `.1`) so repeated quits can't grow it
 *    without limit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beginQuitDiagnostics } from '../quit-diagnostics';

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kai-quitdiag-'));
  logPath = join(dir, 'quit-diagnostics.log');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('beginQuitDiagnostics', () => {
  it('writes a quit header and the at-quit (T0) snapshot on open', () => {
    beginQuitDiagnostics(logPath);
    const text = readFileSync(logPath, 'utf-8');
    expect(text).toContain('===== QUIT');
    expect(text).toContain(`pid=${process.pid}`);
    expect(text).toContain('[T0 at-quit snapshot]');
    // A live test process always has at least one active handle.
    expect(text).toMatch(/handles: \d+/);
  });

  it('brackets a step with start + done lines carrying elapsedMs', () => {
    const session = beginQuitDiagnostics(logPath);
    const done = session.step('shutdownBrowserManager');
    done();
    const text = readFileSync(logPath, 'utf-8');
    expect(text).toContain('step-start shutdownBrowserManager');
    expect(text).toMatch(/step-done shutdownBrowserManager elapsedMs=\d+/);
  });

  it('does not double-log a step whose done-fn fires twice', () => {
    const session = beginQuitDiagnostics(logPath);
    const done = session.step('stopWebServer');
    done();
    done();
    const text = readFileSync(logPath, 'utf-8');
    const matches = text.match(/step-done stopWebServer/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('writes structured mark lines with key=value pairs', () => {
    const session = beginQuitDiagnostics(logPath);
    session.mark('quit', { exitCode: 0 });
    session.mark('will-quit');
    const text = readFileSync(logPath, 'utf-8');
    expect(text).toContain('quit exitCode=0');
    expect(text).toContain('will-quit');
  });

  it('arms an unref’d T1 timer that writes the post-drain snapshot', () => {
    vi.useFakeTimers();
    // Spy on the returned timer so we can assert it was unref'd — the diagnostic
    // timer must never itself keep the event loop alive.
    const unref = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => ({ unref })) as never);
    try {
      beginQuitDiagnostics(logPath);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('records the post-drain snapshot when the T1 timer fires', () => {
    vi.useFakeTimers();
    beginQuitDiagnostics(logPath);
    vi.advanceTimersByTime(3000);
    const text = readFileSync(logPath, 'utf-8');
    expect(text).toContain('post-drain snapshot');
    expect(text).toContain('FAILED to drain');
  });

  it('records an unavailable marker when Node handle internals are missing', () => {
    const proc = process as unknown as {
      _getActiveHandles?: unknown;
      _getActiveRequests?: unknown;
    };
    const origH = proc._getActiveHandles;
    const origR = proc._getActiveRequests;
    proc._getActiveHandles = undefined;
    proc._getActiveRequests = undefined;
    try {
      beginQuitDiagnostics(logPath);
      const text = readFileSync(logPath, 'utf-8');
      expect(text).toContain('unavailable');
    } finally {
      proc._getActiveHandles = origH;
      proc._getActiveRequests = origR;
    }
  });

  it('describes handles without throwing when a getter throws or the type is unknown', () => {
    const proc = process as unknown as { _getActiveHandles?: () => unknown[] };
    const orig = proc._getActiveHandles;
    // A handle whose field getter throws, plus a bare unknown object.
    const throwingHandle = {
      get path() {
        throw new Error('getter boom');
      },
    };
    proc._getActiveHandles = () => [throwingHandle, {}, Object.create(null)];
    try {
      expect(() => beginQuitDiagnostics(logPath)).not.toThrow();
      const text = readFileSync(logPath, 'utf-8');
      expect(text).toContain('handles: 3');
    } finally {
      proc._getActiveHandles = orig;
    }
  });

  it('collapses identical handles into an Nx count', () => {
    const proc = process as unknown as { _getActiveHandles?: () => unknown[] };
    const orig = proc._getActiveHandles;
    class FSWatcher {}
    proc._getActiveHandles = () => [new FSWatcher(), new FSWatcher(), new FSWatcher()];
    try {
      beginQuitDiagnostics(logPath);
      const text = readFileSync(logPath, 'utf-8');
      expect(text).toContain('3x FSWatcher');
    } finally {
      proc._getActiveHandles = orig;
    }
  });

  it('rotates to .1 rather than growing without bound', () => {
    // Pre-fill past a tiny cap so the next open triggers a single roll.
    writeFileSync(logPath, 'x'.repeat(5000));
    beginQuitDiagnostics(logPath, 1024);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    // The live log after rotation holds only the fresh quit header.
    expect(statSync(logPath).size).toBeLessThan(5000);
  });
});
