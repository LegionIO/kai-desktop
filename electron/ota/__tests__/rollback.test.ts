/**
 * Tests for the OTA crash-loop rollback (electron/ota/rollback.ts). SAFETY-
 * CRITICAL: this decides when a bad OTA overlay is wiped so the app falls back to
 * bundled signed code. A regression either bricks the app (premature wipe) or
 * leaves it stuck crashlooping (never rolls back). These lock the crash-count
 * model (tolerate 2, roll back on the 3rd boot), the stable-run reset, the
 * graceful-quit reset, and manualRollback's dir swap.
 *
 * getOtaRoot memoizes a homedir-derived path on first call, so HOME is repointed
 * to a temp dir BEFORE import and one appSlug is used throughout; the OTA dir is
 * wiped between tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOME = mkdtempSync(join(tmpdir(), 'kai-ota-rollback-'));
process.env.HOME = HOME;

const SLUG = 'kai-test';
const { checkAndHandleRollback, signalAppRunning, signalGracefulQuit, manualRollback, getOtaMeta } =
  await import('../rollback.js');

const OTA_ROOT = join(HOME, '.' + SLUG, 'ota');
const CURRENT = join(OTA_ROOT, 'current');
const ROLLBACK = join(OTA_ROOT, 'rollback');
const META = join(OTA_ROOT, 'meta.json');

const mkOverlay = () => {
  mkdirSync(CURRENT, { recursive: true });
  writeFileSync(join(CURRENT, 'entry.js'), 'code');
};
const writeMeta = (m: Record<string, unknown>) => {
  mkdirSync(OTA_ROOT, { recursive: true });
  writeFileSync(META, JSON.stringify(m));
};
const readCount = () => getOtaMeta(SLUG).crashCount;

beforeEach(() => {
  rmSync(OTA_ROOT, { recursive: true, force: true });
});
afterEach(() => {
  signalGracefulQuit(SLUG); // clear any pending stable timer
  vi.useRealTimers();
});

describe('checkAndHandleRollback', () => {
  it('returns null and resets crashCount when no overlay exists', () => {
    writeMeta({ crashCount: 2, lastStableVersion: null, shellVersion: '', lastStableTimestamp: null });
    expect(checkAndHandleRollback(SLUG, '1.0.0')).toBeNull();
    expect(readCount()).toBe(0);
  });

  it('increments crashCount on each boot while an overlay exists (no rollback below threshold)', () => {
    mkOverlay();
    expect(checkAndHandleRollback(SLUG, '1.0.0')).toBeNull(); // boot 1 → count 1
    expect(readCount()).toBe(1);
    expect(checkAndHandleRollback(SLUG, '1.0.0')).toBeNull(); // boot 2 → count 2
    expect(readCount()).toBe(2);
    expect(existsSync(CURRENT)).toBe(true); // not wiped yet
  });

  it('rolls back (wipes overlay) on the 3rd consecutive crash-boot', () => {
    mkOverlay();
    writeMeta({ crashCount: 2, lastStableVersion: '0.9.0', shellVersion: '', lastStableTimestamp: null });
    const result = checkAndHandleRollback(SLUG, '1.0.0'); // count 2 → 3 → wipe
    expect(result).not.toBeNull();
    expect(result!.rolledBackFrom).toBe('0.9.0');
    expect(result!.reason).toContain('3 times');
    expect(existsSync(CURRENT)).toBe(false); // overlay wiped
    expect(readCount()).toBe(0); // reset after rollback
  });

  it('reports rolledBackFrom "unknown" when no lastStableVersion is recorded', () => {
    mkOverlay();
    writeMeta({ crashCount: 2, lastStableVersion: null, shellVersion: '', lastStableTimestamp: null });
    const result = checkAndHandleRollback(SLUG, '1.0.0');
    expect(result!.rolledBackFrom).toBe('unknown');
  });

  it('treats a corrupt meta file as defaults (crashCount 0)', () => {
    mkOverlay();
    writeMeta({} as never);
    writeFileSync(META, '{ this is not json');
    expect(checkAndHandleRollback(SLUG, '1.0.0')).toBeNull(); // defaults → count 0 → 1
    expect(readCount()).toBe(1);
  });
});

describe('signalAppRunning', () => {
  it('resets crashCount + records the stable version after the stability threshold', () => {
    vi.useFakeTimers();
    mkOverlay();
    checkAndHandleRollback(SLUG, '1.0.0'); // count → 1
    expect(readCount()).toBe(1);

    signalAppRunning(SLUG, '1.0.0');
    vi.advanceTimersByTime(30_000); // OTA_STABLE_THRESHOLD_MS

    expect(readCount()).toBe(0);
    const meta = getOtaMeta(SLUG);
    expect(meta.lastStableVersion).toBe('1.0.0');
    expect(meta.lastStableTimestamp).toBeTruthy();
  });

  it('does not reset before the threshold elapses', () => {
    vi.useFakeTimers();
    mkOverlay();
    checkAndHandleRollback(SLUG, '1.0.0');
    signalAppRunning(SLUG, '1.0.0');
    vi.advanceTimersByTime(29_000); // just under
    expect(readCount()).toBe(1); // not reset yet
  });

  it('clears a prior pending timer when called again (no double-reset race)', () => {
    vi.useFakeTimers();
    mkOverlay();
    checkAndHandleRollback(SLUG, '1.0.0');
    signalAppRunning(SLUG, '1.0.0');
    signalAppRunning(SLUG, '1.0.1'); // re-arm → only the latest fires
    vi.advanceTimersByTime(30_000);
    expect(getOtaMeta(SLUG).lastStableVersion).toBe('1.0.1');
  });
});

describe('signalGracefulQuit', () => {
  it('resets crashCount so a clean quit is not counted as a crash', () => {
    mkOverlay();
    checkAndHandleRollback(SLUG, '1.0.0');
    checkAndHandleRollback(SLUG, '1.0.0'); // count 2
    expect(readCount()).toBe(2);
    signalGracefulQuit(SLUG);
    expect(readCount()).toBe(0);
  });

  it('cancels a pending stable timer (does not fire after quit)', () => {
    vi.useFakeTimers();
    mkOverlay();
    checkAndHandleRollback(SLUG, '1.0.0');
    signalAppRunning(SLUG, '1.0.0');
    signalGracefulQuit(SLUG); // resets count to 0 + clears timer
    vi.advanceTimersByTime(30_000);
    // The timer must NOT have written a lastStableVersion after quit.
    expect(getOtaMeta(SLUG).lastStableVersion).toBeNull();
  });
});

describe('manualRollback', () => {
  it('moves current → rollback and resets crashCount', () => {
    mkOverlay();
    writeMeta({ crashCount: 2, lastStableVersion: '0.9.0', shellVersion: '', lastStableTimestamp: null });
    const res = manualRollback(SLUG);
    expect(res.success).toBe(true);
    expect(existsSync(CURRENT)).toBe(false);
    expect(existsSync(ROLLBACK)).toBe(true);
    expect(readFileSync(join(ROLLBACK, 'entry.js'), 'utf-8')).toBe('code'); // content preserved
    expect(readCount()).toBe(0);
  });

  it('errors when no overlay is active', () => {
    const res = manualRollback(SLUG);
    expect(res.success).toBe(false);
    expect(res.error).toContain('No OTA overlay');
  });

  it('replaces a pre-existing rollback dir', () => {
    mkOverlay();
    mkdirSync(ROLLBACK, { recursive: true });
    writeFileSync(join(ROLLBACK, 'stale.js'), 'old');
    const res = manualRollback(SLUG);
    expect(res.success).toBe(true);
    expect(existsSync(join(ROLLBACK, 'stale.js'))).toBe(false); // old rollback replaced
    expect(existsSync(join(ROLLBACK, 'entry.js'))).toBe(true); // new current moved in
  });
});

describe('meta hardening (corrupt/malformed tolerance)', () => {
  it('treats a truncated/corrupt meta file as defaults (crashCount 0), not a crash', () => {
    mkdirSync(OTA_ROOT, { recursive: true });
    writeFileSync(META, '{ "crashCount": 2, "lastStabl'); // truncated JSON (crash mid-write)
    // A corrupt meta must not read as a high crashCount; it falls back to 0.
    expect(readCount()).toBe(0);
  });

  it('coerces a valid-JSON-but-wrong-shape meta to defaults', () => {
    mkdirSync(OTA_ROOT, { recursive: true });
    writeFileSync(META, 'null'); // valid JSON, wrong shape — must not crash readMeta
    expect(readCount()).toBe(0);
    writeFileSync(META, JSON.stringify({ crashCount: 'not-a-number' }));
    expect(readCount()).toBe(0); // non-numeric crashCount coerced to 0
  });

  it('round-trips a well-formed meta unchanged', () => {
    writeMeta({ crashCount: 1, lastStableVersion: '1.2.3', shellVersion: '9.9', lastStableTimestamp: null });
    expect(readCount()).toBe(1);
    expect(getOtaMeta(SLUG).lastStableVersion).toBe('1.2.3');
  });

  it('persists the crash count atomically across a simulated boot sequence', () => {
    mkOverlay();
    // 2 crash boots tolerated (count reaches 2, no rollback yet)
    expect(checkAndHandleRollback(SLUG, '1.0.0')).toBeNull();
    expect(checkAndHandleRollback(SLUG, '1.0.0')).toBeNull();
    expect(readCount()).toBe(2);
    // 3rd boot rolls back (overlay wiped) and resets the counter
    const res = checkAndHandleRollback(SLUG, '1.0.0');
    expect(res).not.toBeNull();
    expect(existsSync(CURRENT)).toBe(false);
    expect(readCount()).toBe(0);
  });
});
