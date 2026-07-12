/**
 * Platform-capability seam tests (#82, ADR-0005).
 *
 * All assertions run via injected platform strings — there is NO Windows
 * machine in CI or on the build hardware. These prove: the capability model
 * resolves per platform, the Windows stub harness routes + fails terminally
 * with a typed error, the dictation seam gates, and macOS output is unchanged.
 */

import { describe, it, expect, vi } from 'vitest';

// LocalDesktopHarness installs an app.on('activate'/'before-quit') recovery hook
// in its constructor; the global electron stub omits app.on. Provide a minimal
// no-op app + BrowserWindow so the experimental routing tests can construct it.
vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  nativeImage: { createFromBuffer: () => ({}) },
}));

import { getPlatformCapabilities } from '../capabilities.js';
import { getDictationPlatform } from '../../dictation/dictation-platform.js';
import { WindowsStubHarness, ComputerHarnessUnsupportedError } from '../../computer-use/harnesses/windows-stub.js';
import { getHarness } from '../../computer-use/orchestrator.js';
import type { ComputerHarness } from '../../computer-use/harnesses/shared.js';
import { LocalMacosHarness } from '../../computer-use/harnesses/local-macos.js';
import { LocalDesktopHarness } from '../../computer-use/harnesses/local-desktop.js';
import type { ComputerSession, ComputerUseTarget } from '../../../shared/computer-use.js';
import type { AppConfig } from '../../config/schema.js';

function sessionWithTarget(target: ComputerUseTarget): ComputerSession {
  // Only `target` is read by getHarness; the rest is a minimal cast.
  return { target } as unknown as ComputerSession;
}

const noopConfig = () => ({}) as AppConfig;

describe('getPlatformCapabilities', () => {
  it('reports every capability supported on darwin', () => {
    const caps = getPlatformCapabilities('darwin');
    expect(caps).toEqual({
      computerUseLocal: { supported: true },
      computerUseBrowser: { supported: true },
      dictationCapture: { supported: true },
      dictationAnywhere: { supported: true },
      dockIcon: { supported: true },
    });
  });

  it('marks local computer use + dictation-anywhere + dock as EXPERIMENTAL (not gated) on win32, keeps browser + capture native', () => {
    const caps = getPlatformCapabilities('win32');
    expect(caps.computerUseBrowser).toEqual({ supported: true });
    expect(caps.dictationCapture).toEqual({ supported: true });
    // Experimental-on posture (ADR-0005): available for feedback, flagged.
    expect(caps.computerUseLocal.supported).toBe(true);
    expect(caps.computerUseLocal.experimental).toBe(true);
    expect(caps.computerUseLocal.reason).toMatch(/experimental on Windows/i);
    expect(caps.dictationAnywhere).toMatchObject({ supported: true, experimental: true });
    expect(caps.dockIcon).toMatchObject({ supported: true, experimental: true });
  });

  it('marks the same set experimental on linux', () => {
    const caps = getPlatformCapabilities('linux');
    expect(caps.computerUseBrowser).toEqual({ supported: true });
    expect(caps.computerUseLocal).toMatchObject({ supported: true, experimental: true });
    expect(caps.computerUseLocal.reason).toMatch(/experimental on Linux/i);
    expect(caps.dictationAnywhere).toMatchObject({ supported: true, experimental: true });
  });

  it('an unknown platform is still conservatively unsupported for OS-specific features', () => {
    const caps = getPlatformCapabilities('sunos' as NodeJS.Platform);
    expect(caps.computerUseLocal.supported).toBe(false);
    expect(caps.dictationAnywhere.supported).toBe(false);
    expect(caps.computerUseBrowser.supported).toBe(true);
  });

  it('is pure: mutating one result does not affect a later call', () => {
    const a = getPlatformCapabilities('darwin');
    a.computerUseLocal.supported = false;
    a.computerUseBrowser.supported = false;
    const b = getPlatformCapabilities('darwin');
    expect(b.computerUseLocal.supported).toBe(true);
    expect(b.computerUseBrowser.supported).toBe(true);
  });

  it('returns only supported booleans + reason strings (no sensitive/extra fields)', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const caps = getPlatformCapabilities(platform);
      expect(Object.keys(caps).sort()).toEqual([
        'computerUseBrowser',
        'computerUseLocal',
        'dictationAnywhere',
        'dictationCapture',
        'dockIcon',
      ]);
      for (const result of Object.values(caps)) {
        expect(typeof result.supported).toBe('boolean');
        const keys = Object.keys(result).sort();
        // `supported` (+ optional `reason`/`experimental`) — nothing else may leak in.
        expect(keys.every((k) => k === 'supported' || k === 'reason' || k === 'experimental')).toBe(true);
        if (result.reason !== undefined) expect(typeof result.reason).toBe('string');
        if (result.experimental !== undefined) expect(typeof result.experimental).toBe('boolean');
      }
    }
  });
});

describe('WindowsStubHarness', () => {
  it('reports the local-windows target', () => {
    expect(new WindowsStubHarness().target).toBe('local-windows');
  });

  it('rejects every action method with a typed ComputerHarnessUnsupportedError', async () => {
    const h: ComputerHarness = new WindowsStubHarness();
    const session = sessionWithTarget('local-windows');
    const action = {} as never;
    const methods: Array<() => Promise<unknown>> = [
      () => h.initialize(session),
      () => h.captureFrame(session),
      () => h.movePointer(session, action),
      () => h.click(session, action),
      () => h.doubleClick(session, action),
      () => h.drag(session, action),
      () => h.scroll(session, action),
      () => h.typeText(session, action),
      () => h.pressKeys(session, action),
      () => h.openApp(session, action),
      () => h.focusWindow(session, action),
      () => h.navigate(session, action),
      () => h.waitForIdle(session, action),
      () => h.getEnvironmentMetadata(session),
    ];
    for (const call of methods) {
      await expect(call()).rejects.toBeInstanceOf(ComputerHarnessUnsupportedError);
    }
  });

  it('dispose() is a safe no-op (orchestrator cleanup must not throw)', async () => {
    await expect(new WindowsStubHarness().dispose('sid')).resolves.toBeUndefined();
  });
});

describe('getHarness routing', () => {
  it('routes the local-windows target to the real desktop harness (experimental), native on darwin', () => {
    const h = getHarness(noopConfig(), sessionWithTarget('local-windows'), noopConfig);
    // Experimental-on: local-windows attempts a real harness, never the terminal stub.
    expect(h).not.toBeInstanceOf(WindowsStubHarness);
    if (process.platform === 'darwin') expect(h).toBeInstanceOf(LocalMacosHarness);
    else expect(h).toBeInstanceOf(LocalDesktopHarness);
  });

  it('routes local-macos to the native harness on darwin, the real desktop harness elsewhere (experimental)', () => {
    const h = getHarness(noopConfig(), sessionWithTarget('local-macos'), noopConfig);
    if (process.platform === 'darwin') {
      expect(h).toBeInstanceOf(LocalMacosHarness);
    } else {
      // Experimental-on posture: no longer degrades to the terminal stub — it
      // attempts the real cross-platform nut-js harness so users can try it.
      expect(h).toBeInstanceOf(LocalDesktopHarness);
    }
    expect(h).not.toBeInstanceOf(WindowsStubHarness);
  });

  it('routes the browser target cross-platform (never gated)', () => {
    const h = getHarness(noopConfig(), sessionWithTarget('isolated-browser'), noopConfig);
    expect(h).not.toBeInstanceOf(WindowsStubHarness);
  });

  it('experimental-on: on win32 a local target attempts the real desktop harness, not the terminal stub', () => {
    // vitest.setup forces process.platform=darwin in CI; override to win32 so the
    // win32 branch is actually exercised. Under the experimental-on posture the
    // capability is supported → LocalDesktopHarness, NOT the stub.
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(getHarness(noopConfig(), sessionWithTarget('local-macos'), noopConfig)).toBeInstanceOf(
        LocalDesktopHarness,
      );
      expect(getHarness(noopConfig(), sessionWithTarget('local-windows'), noopConfig)).toBeInstanceOf(
        LocalDesktopHarness,
      );
      expect(getHarness(noopConfig(), sessionWithTarget('isolated-browser'), noopConfig)).not.toBeInstanceOf(
        WindowsStubHarness,
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});

describe('getDictationPlatform', () => {
  it('macOS supports anywhere insertion via native AX', () => {
    const p = getDictationPlatform('darwin');
    expect(p.insertionMode).toBe('native-ax');
    expect(p.supportsAnywhereInsertion()).toBe(true);
  });

  it('Windows does not support anywhere insertion yet', () => {
    const p = getDictationPlatform('win32');
    expect(p.insertionMode).toBe('unsupported');
    expect(p.supportsAnywhereInsertion()).toBe(false);
  });

  it('Linux does not support anywhere insertion yet', () => {
    expect(getDictationPlatform('linux').supportsAnywhereInsertion()).toBe(false);
  });
});
