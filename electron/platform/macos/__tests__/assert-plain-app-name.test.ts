/**
 * Tests for assertPlainAppName (platform/macos/adapter.ts) — the app-name guard
 * applied before `open -a` / osascript in the macOS platform adapter. Mirrors
 * the local-macos harness resolveAppName guard: name-only (reject paths so a
 * bundle can't be launched by path) and no leading dash (option-like). `electron`
 * is mocked so the adapter module loads in a plain-node test.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(), openExternal: vi.fn() } }));

const { assertPlainAppName } = await import('../adapter.js');

describe('assertPlainAppName', () => {
  it('accepts + trims a plain app name', () => {
    expect(assertPlainAppName('Safari')).toBe('Safari');
    expect(assertPlainAppName('  Google Chrome  ')).toBe('Google Chrome');
  });

  it('rejects empty / whitespace', () => {
    expect(() => assertPlainAppName('')).toThrow(/required/i);
    expect(() => assertPlainAppName('   ')).toThrow(/required/i);
  });

  it('rejects POSIX + Windows paths', () => {
    expect(() => assertPlainAppName('/Applications/Evil.app')).toThrow(/path/i);
    expect(() => assertPlainAppName('../Evil.app')).toThrow(/path/i);
    expect(() => assertPlainAppName('C:\\Evil.app')).toThrow(/path/i);
  });

  it('rejects leading-dash (osascript option-like) names', () => {
    expect(() => assertPlainAppName('-e return 99')).toThrow(/begins with/i);
    expect(() => assertPlainAppName('-g')).toThrow(/begins with/i);
  });
});
