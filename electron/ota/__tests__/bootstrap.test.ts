/**
 * Tests for resolveCodePaths (electron/ota/bootstrap.ts) — the CORE OTA security
 * decision: at boot, load code from the attacker-WRITABLE overlay dir or fall
 * back to the BUNDLED signed code. Every reject branch MUST return bundledPaths
 * (fail-closed); a regression here means executing tampered code. These tests
 * lock the full decision chain.
 *
 * `./signing.js` is mocked so the signature/hash outcomes are controllable
 * without the build-baked key: shouldSkipOtaSignature and verifyOtaSignature are
 * spies; computeFilesHash uses the real implementation so the filesHash-table
 * integrity check is exercised for real. HOME is repointed before import.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import type * as SigningModule from '../signing.js';

const HOME = mkdtempSync(join(tmpdir(), 'kai-ota-bootstrap-'));
process.env.HOME = HOME;

vi.mock('electron', () => ({ app: { isPackaged: true } }));

// Controllable signing surface; computeFilesHash stays real.
const signState = { skip: false, sigOk: true };
vi.mock('../signing.js', async () => {
  const actual = await vi.importActual<typeof SigningModule>('../signing.js');
  return {
    ...actual,
    shouldSkipOtaSignature: () => signState.skip,
    verifyOtaSignature: () => signState.sigOk,
  };
});

const { resolveCodePaths } = await import('../bootstrap.js');
const { computeFilesHash } = await import('../signing.js');

const SLUG = 'kai-bs-test';
const SHELL = '2.0.0';
const BUNDLED = join(HOME, 'bundled', 'out', 'main');
const OTA_CURRENT = join(HOME, '.' + SLUG, 'ota', 'current');

const sha512 = (buf: Buffer | string) => createHash('sha512').update(buf).digest('hex');

/** Write the 3 overlay entrypoint files with given contents; return the files map. */
function writeOverlayFiles(contents: Record<string, string>): Record<string, { sha512: string }> {
  const files: Record<string, { sha512: string }> = {};
  for (const [rel, body] of Object.entries(contents)) {
    const p = join(OTA_CURRENT, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
    files[rel] = { sha512: sha512(body) };
  }
  return files;
}

const ENTRYPOINTS = {
  'out/main/index.js': 'main-code',
  'out/preload/index.mjs': 'preload-code',
  'out/renderer/index.html': '<html>',
};

/** Write a manifest.json at the overlay root. */
function writeManifest(m: Record<string, unknown>) {
  mkdirSync(OTA_CURRENT, { recursive: true });
  writeFileSync(join(OTA_CURRENT, 'manifest.json'), JSON.stringify(m));
}

/** Build a fully-valid signed-style manifest for a good overlay. */
function validManifest(overrides: Record<string, unknown> = {}) {
  const files = writeOverlayFiles(ENTRYPOINTS);
  const filesHash = computeFilesHash(files);
  return {
    codeVersion: '2.1.0',
    minBaseVersion: '2.0.0',
    sha512: 'archsha',
    filesHash,
    signature: 'sig',
    files,
    ...overrides,
  };
}

const resolve = () => resolveCodePaths(SLUG, SHELL, BUNDLED);

beforeEach(() => {
  rmSync(join(HOME, '.' + SLUG), { recursive: true, force: true });
  signState.skip = false;
  signState.sigOk = true;
});
afterEach(() => vi.clearAllMocks());

describe('resolveCodePaths — bundled fallback (fail-closed)', () => {
  it('returns bundled when no overlay manifest exists', () => {
    const r = resolve();
    expect(r.isOverlay).toBe(false);
    expect(r.main).toBe(BUNDLED);
    expect(r.codeVersion).toBe(SHELL);
  });

  it('falls back when the manifest is missing required fields', () => {
    writeManifest({ codeVersion: '2.1.0' }); // no minBaseVersion
    expect(resolve().isOverlay).toBe(false);
  });

  it('falls back on invalid semver in the manifest', () => {
    writeManifest({ codeVersion: '2.1.0', minBaseVersion: 'not-semver' });
    expect(resolve().isOverlay).toBe(false);
  });

  it('falls back when shell version < minBaseVersion', () => {
    writeManifest({ codeVersion: '3.0.0', minBaseVersion: '9.9.9' });
    expect(resolve().isOverlay).toBe(false);
  });

  it('anti-rollback floor: wipes + falls back when overlay codeVersion < shell', () => {
    writeManifest({ codeVersion: '1.0.0', minBaseVersion: '1.0.0' }); // < shell 2.0.0
    const r = resolve();
    expect(r.isOverlay).toBe(false);
    // Overlay wiped.
    expect(resolve().isOverlay).toBe(false);
  });
});

describe('resolveCodePaths — signature-required branches', () => {
  it('refuses + wipes an unsigned manifest when verification is required', () => {
    writeManifest({ codeVersion: '2.1.0', minBaseVersion: '2.0.0' }); // no signature/sha512/filesHash
    expect(resolve().isOverlay).toBe(false);
  });

  it('refuses + wipes on a bad signature', () => {
    writeManifest(validManifest());
    signState.sigOk = false;
    expect(resolve().isOverlay).toBe(false);
  });

  it('refuses when the manifest.files hash table was tampered (filesHash mismatch)', () => {
    // Valid signature, but filesHash doesn't match the actual files map.
    const m = validManifest({ filesHash: 'deadbeef-not-the-real-hash' });
    writeManifest(m);
    signState.sigOk = true;
    expect(resolve().isOverlay).toBe(false);
  });

  it('refuses when a manifest file path escapes the overlay dir', () => {
    const files = writeOverlayFiles(ENTRYPOINTS);
    files['../../../etc/evil'] = { sha512: sha512('x') };
    writeManifest(validManifest({ files, filesHash: computeFilesHash(files) }));
    expect(resolve().isOverlay).toBe(false);
  });

  it('refuses when a listed file hash does not match the on-disk file', () => {
    const files = writeOverlayFiles(ENTRYPOINTS);
    // Corrupt the recorded hash for one entrypoint AFTER building the table.
    files['out/preload/index.mjs'] = { sha512: sha512('different-content') };
    writeManifest(validManifest({ files, filesHash: computeFilesHash(files) }));
    expect(resolve().isOverlay).toBe(false);
  });

  it('refuses when the manifest omits a required entrypoint', () => {
    const partial = { 'out/main/index.js': 'main-code', 'out/preload/index.mjs': 'preload-code' };
    const files = writeOverlayFiles(partial); // missing renderer entrypoint in the map
    writeManifest(validManifest({ files, filesHash: computeFilesHash(files) }));
    expect(resolve().isOverlay).toBe(false);
  });

  it('LOADS the overlay (preload+renderer) when signature + all file hashes verify', () => {
    writeManifest(validManifest());
    signState.sigOk = true;
    const r = resolve();
    expect(r.isOverlay).toBe(true);
    expect(r.preload).toBe(join(OTA_CURRENT, 'out', 'preload'));
    expect(r.renderer).toBe(join(OTA_CURRENT, 'out', 'renderer'));
    // main is NEVER swapped by an overlay — always bundled, and mainCodeVersion stays the shell's.
    expect(r.main).toBe(BUNDLED);
    expect(r.codeVersion).toBe('2.1.0');
    expect(r.mainCodeVersion).toBe(SHELL);
  });
});

describe('resolveCodePaths — skip-signature (dev) mode', () => {
  it('loads a structurally-complete overlay without verifying signatures', () => {
    signState.skip = true;
    writeManifest({ codeVersion: '2.1.0', minBaseVersion: '2.0.0' }); // unsigned but skip=true
    writeOverlayFiles(ENTRYPOINTS);
    const r = resolve();
    expect(r.isOverlay).toBe(true);
  });

  it('still falls back if an overlay entrypoint file is missing on disk', () => {
    signState.skip = true;
    writeManifest({ codeVersion: '2.1.0', minBaseVersion: '2.0.0' });
    // Only write main + preload, not renderer index.html.
    writeOverlayFiles({ 'out/main/index.js': 'm', 'out/preload/index.mjs': 'p' });
    expect(resolve().isOverlay).toBe(false);
  });
});
