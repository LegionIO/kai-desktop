import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, isReady: () => true, getPath: () => '/tmp' },
  shell: { openExternal: vi.fn() },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }) },
  clipboard: { readText: () => '', writeText: () => {} },
  systemPreferences: {
    isTrustedAccessibilityClient: () => false,
    getMediaAccessStatus: () => 'denied',
  },
}));

vi.mock('../../computer-use/permissions.js', () => ({
  resolveCompiledHelperBinary: () => null,
  buildDisplayLayout: () => undefined,
  getComputerUsePermissions: async () => ({
    target: 'local-macos',
    accessibilityTrusted: false,
    screenRecordingGranted: false,
    automationGranted: false,
    inputMonitoringGranted: false,
    helperReady: false,
  }),
  getLocalMacPointerPosition: async () => null,
  openLocalMacosPrivacySettings: async () => {},
  runLocalMacMouseCommand: async () => ({ ok: false }),
}));

vi.mock('../../computer-use/harnesses/local-macos.js', () => ({
  startLocalMacosTakeoverMonitor: () => ({ stop: () => {} }),
}));

import { getFallbackAdapter, getPlatformAdapter, resetPlatformAdapterForTests } from '../index.js';

describe('platform adapter factory', () => {
  afterEach(() => {
    resetPlatformAdapterForTests();
  });

  it('returns a singleton until reset', async () => {
    const a = await getPlatformAdapter();
    const b = await getPlatformAdapter();
    expect(a).toBe(b);
    resetPlatformAdapterForTests();
    const c = await getPlatformAdapter();
    expect(c).not.toBe(a);
  });

  it('fallback adapter advertises no text introspection', () => {
    const fallback = getFallbackAdapter();
    expect(fallback.kind).toBe('fallback');
    expect(fallback.capabilities.textIntrospection).toBe(false);
    expect(fallback.capabilities.uiTree).toBe(false);
  });
});
