import { describe, it, expect, vi } from 'vitest';

// plugin-manager pulls in Electron + a heavy dependency graph; stub the bits its
// module top-level touches so we can unit-test the pure name-validation predicate.
vi.mock('electron', () => ({
  Notification: class {},
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp' },
}));

import { isValidPluginName } from '../plugin-manager.js';

describe('isValidPluginName (plugin-settings path-traversal guard)', () => {
  it('accepts a plain slug', () => {
    expect(isValidPluginName('my-plugin_2')).toBe(true);
    expect(isValidPluginName('Weather.Widget')).toBe(true);
  });

  it('rejects traversal + separators', () => {
    expect(isValidPluginName('../../target')).toBe(false);
    expect(isValidPluginName('a/b')).toBe(false);
    expect(isValidPluginName('a\\b')).toBe(false);
  });

  it('rejects dot names, empty, and leading dot', () => {
    expect(isValidPluginName('.')).toBe(false);
    expect(isValidPluginName('..')).toBe(false);
    expect(isValidPluginName('')).toBe(false);
    expect(isValidPluginName('.hidden')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidPluginName(null)).toBe(false);
    expect(isValidPluginName(42)).toBe(false);
    expect(isValidPluginName(undefined)).toBe(false);
  });
});
