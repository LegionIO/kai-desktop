import { describe, it, expect } from 'vitest';
import { isCompactCommand } from '../slash-commands';

describe('isCompactCommand', () => {
  it('matches /compact exactly and with trailing args/whitespace', () => {
    expect(isCompactCommand('/compact')).toBe(true);
    expect(isCompactCommand('  /compact  ')).toBe(true);
    expect(isCompactCommand('/compact now please')).toBe(true);
    expect(isCompactCommand('/compact\n')).toBe(true);
  });

  it('does not match when /compact is not the leading token', () => {
    expect(isCompactCommand('please /compact')).toBe(false);
    expect(isCompactCommand('run /compact for me')).toBe(false);
  });

  it('does not match a different or partial command', () => {
    expect(isCompactCommand('/compaction')).toBe(false);
    expect(isCompactCommand('/comp')).toBe(false);
    expect(isCompactCommand('compact')).toBe(false);
    expect(isCompactCommand('')).toBe(false);
    expect(isCompactCommand('hello world')).toBe(false);
  });
});
