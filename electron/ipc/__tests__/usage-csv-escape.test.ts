import { describe, it, expect } from 'vitest';
import { csvEscape } from '../usage.js';

describe('csvEscape', () => {
  it('leaves plain values untouched', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape('gpt-image-2')).toBe('gpt-image-2');
    expect(csvEscape('')).toBe('');
  });

  it('quotes and doubles quotes for delimiter-bearing values', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralizes spreadsheet formula/DDE injection by prefixing a quote', () => {
    expect(csvEscape('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvEscape('+1+1')).toBe("'+1+1");
    expect(csvEscape('-2+3')).toBe("'-2+3");
    expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvEscape('\t=1')).toBe("'\t=1");
    expect(csvEscape('\r=1')).toBe("'\r=1");
  });

  it('prefixes then still delimiter-quotes a formula value that also has a comma', () => {
    // leading '=' → prefixed with ', then contains ',' → wrapped in quotes
    expect(csvEscape('=cmd,x')).toBe('"\'=cmd,x"');
  });

  it('does not prefix values where the risky char is not first', () => {
    expect(csvEscape('a=b')).toBe('a=b');
    expect(csvEscape('total-2')).toBe('total-2');
  });
});
