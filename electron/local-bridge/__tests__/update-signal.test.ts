/**
 * Tests for the cross-process update-ready signal (electron/local-bridge/
 * update-signal.ts). The GUI writes it on update-downloaded; a detached HEADLESS
 * backend leader reads it (non-destructively) and self-exits when it names a
 * version different from the one it's running, so the next `kai` connect spawns a
 * fresh backend instead of a stale leader on old code. Backed by a real temp
 * KAI_USER_DATA (the module resolves the run dir under getAppHome()).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let kaiHome: string;

beforeEach(() => {
  kaiHome = mkdtempSync(join(tmpdir(), 'kai-updsig-'));
  process.env.KAI_USER_DATA = kaiHome;
  vi.resetModules();
});
afterEach(() => {
  delete process.env.KAI_USER_DATA;
  rmSync(kaiHome, { recursive: true, force: true });
});

async function load() {
  return import('../update-signal.js');
}

describe('update-signal', () => {
  it('read returns null when no signal has been written', async () => {
    const { readUpdateReady, shouldStepAsideForUpdate } = await load();
    expect(readUpdateReady()).toBeNull();
    expect(shouldStepAsideForUpdate('1.0.0')).toBe(false);
  });

  it('write then read round-trips the version (non-destructive: two reads see it)', async () => {
    const { writeUpdateReady, readUpdateReady } = await load();
    writeUpdateReady('2.0.0');
    expect(readUpdateReady()?.version).toBe('2.0.0');
    expect(readUpdateReady()?.version).toBe('2.0.0'); // still there — not consumed
  });

  it('shouldStepAsideForUpdate is true only when the signal names a DIFFERENT version', async () => {
    const { writeUpdateReady, shouldStepAsideForUpdate } = await load();
    writeUpdateReady('2.0.0');
    expect(shouldStepAsideForUpdate('1.0.0')).toBe(true); // stale leader on 1.0.0, update to 2.0.0
    expect(shouldStepAsideForUpdate('2.0.0')).toBe(false); // already the downloaded version
  });

  it('clear makes a subsequent read return null (and step-aside false)', async () => {
    const { writeUpdateReady, clearUpdateReady, readUpdateReady, shouldStepAsideForUpdate } = await load();
    writeUpdateReady('2.0.0');
    clearUpdateReady();
    expect(readUpdateReady()).toBeNull();
    expect(shouldStepAsideForUpdate('1.0.0')).toBe(false);
  });

  it('a corrupt / malformed signal file reads as null (fail safe — no spurious restart)', async () => {
    const { readUpdateReady, shouldStepAsideForUpdate } = await load();
    const runDir = join(kaiHome, 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'update-ready.json'), '{ not json', 'utf-8');
    expect(readUpdateReady()).toBeNull();
    expect(shouldStepAsideForUpdate('1.0.0')).toBe(false);
  });

  it('a signal with a non-string version is ignored', async () => {
    const { readUpdateReady } = await load();
    const runDir = join(kaiHome, 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'update-ready.json'), JSON.stringify({ version: 42 }), 'utf-8');
    expect(readUpdateReady()).toBeNull();
  });
});
