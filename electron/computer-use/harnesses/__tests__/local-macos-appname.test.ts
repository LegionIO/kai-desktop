/**
 * Tests for resolveAppName (local-macos.ts) — the guard applied to a model-
 * supplied app name before it reaches `open -a <name>` / osascript in the native
 * macOS computer-use harness. Name-only: reject a path (so a bundle can't be
 * launched by absolute/relative path) and a leading dash (defense-in-depth
 * against option-like values). `electron` is mocked so the module loads.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeImage: { createFromBuffer: vi.fn(), createEmpty: vi.fn() },
}));

const { resolveAppName } = await import('../local-macos.js');

describe('resolveAppName', () => {
  it('accepts a plain application name and trims it', () => {
    expect(resolveAppName('Safari', 'Open app')).toBe('Safari');
    expect(resolveAppName('  Google Chrome  ', 'Open app')).toBe('Google Chrome');
  });

  it('throws on empty / whitespace / undefined', () => {
    expect(() => resolveAppName(undefined, 'Open app')).toThrow(/requires appName/i);
    expect(() => resolveAppName('', 'Open app')).toThrow(/requires appName/i);
    expect(() => resolveAppName('   ', 'Focus window')).toThrow(/requires appName/i);
  });

  it('rejects a POSIX path (no launching a bundle by path)', () => {
    expect(() => resolveAppName('/Applications/Evil.app', 'Open app')).toThrow(/path/i);
    expect(() => resolveAppName('../Evil.app', 'Open app')).toThrow(/path/i);
    expect(() => resolveAppName('sub/dir', 'Open app')).toThrow(/path/i);
  });

  it('rejects a Windows-style backslash path', () => {
    expect(() => resolveAppName('C:\\Evil.app', 'Open app')).toThrow(/path/i);
  });

  it('rejects a leading-dash name (option-like)', () => {
    expect(() => resolveAppName('-e return 99', 'Focus window')).toThrow(/begins with/i);
    expect(() => resolveAppName('-g', 'Open app')).toThrow(/begins with/i);
  });

  it('interpolates the verb into the empty-name error', () => {
    expect(() => resolveAppName('', 'Focus window')).toThrow(/Focus window requires appName/);
  });
});
