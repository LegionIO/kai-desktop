/**
 * Regression coverage for the applyOtaUpdate apply-time downgrade guard
 * (commit 9f4dfa9): a staged overlay must not be applied over an equal/newer
 * running version, and the rejected staging dir is wiped.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';
import type { OtaManifest } from '../types';
import { OTA_DIR_NAME, OTA_STAGING_DIR, OTA_CURRENT_DIR, OTA_MANIFEST_FILE } from '../types';

// The module references electron `app`/`net` only inside functions, but the
// import must resolve — stub electron + the window broadcast + redirect homedir.
vi.mock('electron', () => ({ app: { isPackaged: true }, net: {} }));
vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: () => {} }));

let fakeHome: string;
vi.mock('node:os', async (orig) => {
  const actual = (await orig()) as typeof NodeOs;
  return { ...actual, homedir: () => fakeHome };
});
// Some code paths import from 'os' (not 'node:os') — mirror the mock.
vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof NodeOs;
  return { ...actual, homedir: () => fakeHome };
});

import { applyOtaUpdate } from '../ota-updater';

const APP_SLUG = 'kai-test';

function manifest(codeVersion: string): OtaManifest {
  return {
    codeVersion,
    baseVersion: '1.0.0',
    minBaseVersion: '1.0.0',
    files: {},
    createdAt: new Date().toISOString(),
  };
}

function stageOverlay(codeVersion: string): string {
  const otaRoot = join(fakeHome, '.' + APP_SLUG, OTA_DIR_NAME);
  const stagingDir = join(otaRoot, OTA_STAGING_DIR);
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(stagingDir, OTA_MANIFEST_FILE), JSON.stringify(manifest(codeVersion)), 'utf-8');
  return otaRoot;
}

describe('applyOtaUpdate downgrade guard', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'kai-ota-'));
  });
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('errors when there is no staged update', () => {
    const res = applyOtaUpdate(APP_SLUG, '1.0.0');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no staged/i);
  });

  it('refuses to apply a staged overlay not newer than the current version, and wipes staging', () => {
    const otaRoot = stageOverlay('1.0.5');
    const res = applyOtaUpdate(APP_SLUG, '1.0.5'); // equal → not newer
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not newer/i);
    expect(existsSync(join(otaRoot, OTA_STAGING_DIR))).toBe(false);
  });

  it('refuses a strict downgrade and wipes staging', () => {
    const otaRoot = stageOverlay('1.0.3');
    const res = applyOtaUpdate(APP_SLUG, '1.0.9');
    expect(res.success).toBe(false);
    expect(existsSync(join(otaRoot, OTA_STAGING_DIR))).toBe(false);
  });

  it('applies a strictly-newer staged overlay (staging → current)', () => {
    const otaRoot = stageOverlay('1.1.0');
    const res = applyOtaUpdate(APP_SLUG, '1.0.9');
    expect(res.success).toBe(true);
    expect(existsSync(join(otaRoot, OTA_STAGING_DIR))).toBe(false);
    expect(existsSync(join(otaRoot, OTA_CURRENT_DIR, OTA_MANIFEST_FILE))).toBe(true);
  });

  it('applies without a version floor when currentCodeVersion is omitted (back-compat)', () => {
    const otaRoot = stageOverlay('0.0.1');
    const res = applyOtaUpdate(APP_SLUG);
    expect(res.success).toBe(true);
    expect(existsSync(join(otaRoot, OTA_CURRENT_DIR, OTA_MANIFEST_FILE))).toBe(true);
  });
});
