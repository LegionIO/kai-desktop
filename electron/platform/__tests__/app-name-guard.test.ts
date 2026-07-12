/**
 * Tests for the shared app-name guard (electron/platform/app-name-guard.ts) —
 * gates a model-supplied computer-use openApp/focusApp name before it reaches
 * `open -a` (macOS) or `Start-Process -FilePath` (Windows). It must accept a
 * bare app name and reject anything that could resolve to an arbitrary
 * executable path: separators, Windows drive-relative (`C:...`), UNC, leading
 * dash, and control characters.
 */
import { describe, it, expect } from 'vitest';
import { assertPlainAppName } from '../app-name-guard.js';

describe('assertPlainAppName', () => {
  it('accepts + trims a plain app name', () => {
    expect(assertPlainAppName('Safari')).toBe('Safari');
    expect(assertPlainAppName('  Google Chrome  ')).toBe('Google Chrome');
    expect(assertPlainAppName('notepad')).toBe('notepad');
  });

  it('rejects empty / whitespace', () => {
    expect(() => assertPlainAppName('')).toThrow(/required/i);
    expect(() => assertPlainAppName('   ')).toThrow(/required/i);
  });

  it('rejects POSIX + Windows separator paths', () => {
    expect(() => assertPlainAppName('/Applications/Evil.app')).toThrow(/path/i);
    expect(() => assertPlainAppName('..\\Evil.exe')).toThrow(/path/i);
    expect(() => assertPlainAppName('sub/dir/app')).toThrow(/path/i);
  });

  it('rejects UNC paths (\\\\host\\share\\evil.exe)', () => {
    expect(() => assertPlainAppName('\\\\attacker\\share\\evil.exe')).toThrow(/path/i);
  });

  it('rejects Windows drive-absolute AND drive-relative paths (the : cases)', () => {
    expect(() => assertPlainAppName('C:\\Windows\\System32\\evil.exe')).toThrow(/path/i);
    expect(() => assertPlainAppName('C:payload.exe')).toThrow(/path/i); // drive-relative — separator check alone misses this
    expect(() => assertPlainAppName('app:stream')).toThrow(/path/i); // NTFS alternate data stream
  });

  it('rejects a leading-dash (option-like) name', () => {
    expect(() => assertPlainAppName('-e return 99')).toThrow(/begins with/i);
    expect(() => assertPlainAppName('-g')).toThrow(/begins with/i);
  });

  it('rejects control characters / NUL', () => {
    expect(() => assertPlainAppName('note\x00pad')).toThrow(/control/i);
    expect(() => assertPlainAppName('note\tpad')).toThrow(/control/i);
    expect(() => assertPlainAppName('note\x7fpad')).toThrow(/control/i);
  });
});
