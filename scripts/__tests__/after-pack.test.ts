/**
 * Real-filesystem characterization test for scripts/after-pack.cjs (the
 * electron-builder afterPack hook). The hook branches on the TARGET platform
 * (context.electronPlatformName), not the host OS, so its linux branch can be
 * exercised on any host against a real temp appOutDir — no module mocking (the
 * .cjs uses require(), which defeats vitest's ESM vi.mock). We assert the real
 * side effect: the shipped `kai` launcher + helpers get their exec bit restored
 * (extraResources' copy drops it), which is what makes `kai` runnable after a
 * Linux build.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const afterPack = require('../after-pack.cjs') as (ctx: unknown) => Promise<void>;

const ctx = (platform: string, appOutDir: string) => ({
  electronPlatformName: platform,
  appOutDir,
  packager: { appInfo: { productFilename: 'Kai', productName: 'Kai' } },
});

const mode = (p: string) => statSync(p).mode & 0o777;

let outDir: string;
beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'kai-afterpack-'));
});
afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('after-pack.cjs linux branch — restores exec bit on shipped launcher + helpers', () => {
  it('chmods the kai launcher and helpers that exist to 0o755', async () => {
    const bin = join(outDir, 'resources', 'bin');
    mkdirSync(bin, { recursive: true });
    // Write them non-executable (mode 0o644), as an extraResources copy would.
    for (const f of ['kai', 'LocalLinuxHelper.sh', 'atspi_helper.py']) {
      writeFileSync(join(bin, f), '#!/bin/sh\n', { mode: 0o644 });
      chmodSync(join(bin, f), 0o644); // ensure the umask didn't widen it
    }
    await afterPack(ctx('linux', outDir));
    expect(mode(join(bin, 'kai'))).toBe(0o755);
    expect(mode(join(bin, 'LocalLinuxHelper.sh'))).toBe(0o755);
    expect(mode(join(bin, 'atspi_helper.py'))).toBe(0o755);
  });

  it('does not throw when a helper is missing (only chmods what exists)', async () => {
    const bin = join(outDir, 'resources', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'kai'), '#!/bin/sh\n', { mode: 0o644 });
    chmodSync(join(bin, 'kai'), 0o644);
    // atspi_helper.py / LocalLinuxHelper.sh intentionally absent.
    await expect(afterPack(ctx('linux', outDir))).resolves.toBeUndefined();
    expect(mode(join(bin, 'kai'))).toBe(0o755);
  });
});

describe('after-pack.cjs — non-darwin/non-linux is a no-op', () => {
  it('win32 touches nothing', async () => {
    const bin = join(outDir, 'resources', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'kai.cmd'), '@echo off\n', { mode: 0o644 });
    chmodSync(join(bin, 'kai.cmd'), 0o644);
    await afterPack(ctx('win32', outDir));
    expect(mode(join(bin, 'kai.cmd'))).toBe(0o644); // unchanged
  });
});

describe('after-pack.cjs darwin branch — exec bit + early bail', () => {
  const onMac = process.platform === 'darwin'; // PlistBuddy only exists on macOS

  it.runIf(onMac)('restores the kai shim exec bit inside the .app', async () => {
    const resBin = join(outDir, 'Kai.app', 'Contents', 'Resources', 'bin');
    mkdirSync(resBin, { recursive: true });
    writeFileSync(join(outDir, 'Kai.app', 'Contents', 'Info.plist'), '<plist/>', { mode: 0o644 });
    writeFileSync(join(resBin, 'kai'), '#!/bin/sh\n', { mode: 0o644 });
    chmodSync(join(resBin, 'kai'), 0o644);
    // No Frameworks/ dir → the hook bails before the helper-plist loop (still chmods the shim).
    await afterPack(ctx('darwin', outDir));
    expect(mode(join(resBin, 'kai'))).toBe(0o755);
  });

  it('bails cleanly when the main app Info.plist is absent (any host)', async () => {
    // No Kai.app/Contents/Info.plist → hook returns early, touches nothing, no throw.
    await expect(afterPack(ctx('darwin', outDir))).resolves.toBeUndefined();
  });
});
