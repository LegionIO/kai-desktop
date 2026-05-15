import { describe, expect, it } from 'vitest';
import { parseHotkeyCodes } from '../hotkey-codes.js';

function sorted(codes: Set<number>): number[] {
  return [...codes].sort((a, b) => a - b);
}

describe('dictation hotkey code parsing', () => {
  it('tracks both modifiers and the primary key for the default hold shortcut', () => {
    const parsed = parseHotkeyCodes('CommandOrControl+Shift+D');

    expect(sorted(parsed.modifierCodes)).toEqual([54, 55, 56, 60]);
    expect(sorted(parsed.primaryCodes)).toEqual([2]);
  });

  it('supports non-letter primary keys', () => {
    const parsed = parseHotkeyCodes('Control+Option+Space');

    expect(sorted(parsed.modifierCodes)).toEqual([58, 59, 61, 62]);
    expect(sorted(parsed.primaryCodes)).toEqual([49]);
  });

  it('supports plus as a literal primary key', () => {
    const parsed = parseHotkeyCodes('Command+Shift++');

    expect(sorted(parsed.modifierCodes)).toEqual([54, 55, 56, 60]);
    expect(sorted(parsed.primaryCodes)).toEqual([24]);
  });
});
