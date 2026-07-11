import { describe, it, expect } from 'vitest';
import { stripDisplayUnsafeChars } from '../display-safe.js';

describe('stripDisplayUnsafeChars', () => {
  it('removes C0 control chars (NUL, ESC)', () => {
    expect(stripDisplayUnsafeChars('Hel\u0000lo\u001b World')).toBe('Hello World');
  });

  it('removes DEL/C1 control chars', () => {
    expect(stripDisplayUnsafeChars('a\u007fb\u009fc')).toBe('abc');
  });

  it('removes bidi override + isolate codepoints', () => {
    expect(stripDisplayUnsafeChars('safe\u202etxet\u202c name')).toBe('safetxet name');
    expect(stripDisplayUnsafeChars('a\u2066b\u2069c')).toBe('abc');
  });

  it('leaves ordinary text (incl. spaces, unicode letters) intact', () => {
    expect(stripDisplayUnsafeChars('Iron Sentinel')).toBe('Iron Sentinel');
    expect(stripDisplayUnsafeChars('Café Über')).toBe('Café Über');
  });
});
