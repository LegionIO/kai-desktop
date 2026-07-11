/**
 * Platform-capability seam tests (#82, ADR-0005).
 *
 * All assertions run via injected platform strings — there is NO Windows
 * machine in CI or on the build hardware. These prove: the capability model
 * resolves per platform, the Windows stub harness routes + fails terminally
 * with a typed error, the dictation seam gates, and macOS output is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { getPlatformCapabilities } from '../capabilities.js';
import { getDictationPlatform } from '../../dictation/dictation-platform.js';
import { WindowsStubHarness, ComputerHarnessUnsupportedError } from '../../computer-use/harnesses/windows-stub.js';
import { getHarness } from '../../computer-use/orchestrator.js';
import type { ComputerHarness } from '../../computer-use/harnesses/shared.js';
import { LocalMacosHarness } from '../../computer-use/harnesses/local-macos.js';
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

  it('gates local computer use + dictation-anywhere + dock on win32, keeps browser + capture', () => {
    const caps = getPlatformCapabilities('win32');
    expect(caps.computerUseBrowser.supported).toBe(true);
    expect(caps.dictationCapture.supported).toBe(true);
    expect(caps.computerUseLocal.supported).toBe(false);
    expect(caps.computerUseLocal.reason).toMatch(/Windows/);
    expect(caps.dictationAnywhere.supported).toBe(false);
    expect(caps.dockIcon.supported).toBe(false);
  });

  it('gates the same set on linux', () => {
    const caps = getPlatformCapabilities('linux');
    expect(caps.computerUseBrowser.supported).toBe(true);
    expect(caps.computerUseLocal.supported).toBe(false);
    expect(caps.dictationAnywhere.supported).toBe(false);
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
        // Only `supported` (+ optional `reason`) — nothing else may leak in.
        expect(keys.every((k) => k === 'supported' || k === 'reason')).toBe(true);
        if (result.reason !== undefined) expect(typeof result.reason).toBe('string');
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
  it('routes the local-windows target to the terminal WindowsStubHarness', () => {
    const h = getHarness(noopConfig(), sessionWithTarget('local-windows'), noopConfig);
    expect(h).toBeInstanceOf(WindowsStubHarness);
  });

  it('routes local-macos per platform capability: native on darwin, terminal stub elsewhere', () => {
    const h = getHarness(noopConfig(), sessionWithTarget('local-macos'), noopConfig);
    if (process.platform === 'darwin') {
      // macOS supports local computer use → the real native harness, never the stub.
      expect(h).toBeInstanceOf(LocalMacosHarness);
      expect(h).not.toBeInstanceOf(WindowsStubHarness);
    } else {
      // On an unsupported OS a stale local-macos default must NOT silently
      // degrade to nut-js — it routes to the terminal stub (#82 chokepoint).
      expect(h).toBeInstanceOf(WindowsStubHarness);
    }
  });

  it('routes the browser target cross-platform (never gated)', () => {
    const h = getHarness(noopConfig(), sessionWithTarget('isolated-browser'), noopConfig);
    expect(h).not.toBeInstanceOf(WindowsStubHarness);
  });

  it('capability chokepoint: on win32 a local target routes to the terminal stub, not nut-js', () => {
    // vitest.setup forces process.platform=darwin in CI; override to win32 for
    // this case so the capability chokepoint's unsupported-OS branch is actually
    // exercised (a regression removing the chokepoint would fail here).
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(getHarness(noopConfig(), sessionWithTarget('local-macos'), noopConfig)).toBeInstanceOf(WindowsStubHarness);
      expect(getHarness(noopConfig(), sessionWithTarget('local-windows'), noopConfig)).toBeInstanceOf(
        WindowsStubHarness,
      );
      // The browser target stays cross-platform even on win32.
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
