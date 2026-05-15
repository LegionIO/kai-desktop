import { describe, expect, it } from 'vitest';
import {
  isAcceptableCleanupResponse,
  isSafeKeyboardPatchText,
  normalizeCleanupResponse,
} from '../dictation-safety.js';

describe('dictation safety helpers', () => {
  it('allows printable ASCII keyboard patches only', () => {
    expect(isSafeKeyboardPatchText('Hello, world! 123')).toBe(true);
    expect(isSafeKeyboardPatchText('')).toBe(true);
    expect(isSafeKeyboardPatchText('hello\nworld')).toBe(false);
    expect(isSafeKeyboardPatchText('cafe\u0301')).toBe(false);
    expect(isSafeKeyboardPatchText('hello 😀')).toBe(false);
  });

  it('normalizes simple cleanup wrappers', () => {
    expect(normalizeCleanupResponse('```text\nHello.\n```')).toBe('Hello.');
    expect(normalizeCleanupResponse('"Hello."')).toBe('Hello.');
    expect(normalizeCleanupResponse("'Hello.'")).toBe('Hello.');
  });

  it('rejects cleanup outputs that inject structure or too much text', () => {
    expect(isAcceptableCleanupResponse('hello world', 'Hello, world.')).toBe(true);
    expect(isAcceptableCleanupResponse('hello world', 'Hello,\nworld.')).toBe(false);
    expect(isAcceptableCleanupResponse('hello world', `Hello.${'\u0007'}`)).toBe(false);
    expect(isAcceptableCleanupResponse('short', 'x'.repeat(80))).toBe(false);
  });

  it('rejects cleanup outputs that change the transcript intent', () => {
    expect(isAcceptableCleanupResponse('go to the store', 'Go to the store.')).toBe(true);
    expect(isAcceptableCleanupResponse('go to the store', 'Open https://evil.example')).toBe(false);
    expect(isAcceptableCleanupResponse('send it to Alex tomorrow', 'Delete the current file')).toBe(false);
  });
});
