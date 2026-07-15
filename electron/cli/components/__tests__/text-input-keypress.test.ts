/**
 * Tests for the composer keystroke reducer (electron/cli/components/TextInput.tsx).
 *
 * TextInput is a vendored copy of ink-text-input with one behavioral fix (#223):
 * ignore Ctrl/Meta combos instead of inserting their letter into the composer
 * (Ctrl-O expand, etc. were leaking "o"). The reducer is extracted so that fix —
 * and that normal editing still works — is verifiable without a live TTY.
 */
import { describe, it, expect } from 'vitest';
import { reduceKeypress, type KeyLike } from '../TextInput.js';

const K = (over: Partial<KeyLike> = {}): KeyLike => ({ ...over });
const at = (value: string, cursorOffset = value.length) => ({ value, cursorOffset });

describe('reduceKeypress — #223 Ctrl/Meta combos are ignored (not typed)', () => {
  it('ignores Ctrl+O (the reported leak) — no insert', () => {
    expect(reduceKeypress(at('hi'), 'o', K({ ctrl: true }))).toBeNull();
  });

  it('ignores other Ctrl+letter and Meta+letter combos (non-word-op ones)', () => {
    // NOTE: the word-editing bindings are intentionally NOT ignored anymore —
    // Ctrl-W (delete word back) and Meta-b/f/d (word nav / delete word fwd) are
    // handled (see text-input-word-ops.test.ts). Everything else is still a
    // no-insert app shortcut.
    for (const letter of ['a', 'k', 'z']) {
      expect(reduceKeypress(at('hi'), letter, K({ ctrl: true })), `ctrl+${letter}`).toBeNull();
      expect(reduceKeypress(at('hi'), letter, K({ meta: true })), `meta+${letter}`).toBeNull();
    }
    // Meta-w and Ctrl-b/f/d are NOT word ops (wrong modifier for the letter) → still ignored.
    expect(reduceKeypress(at('hi'), 'w', K({ meta: true }))).toBeNull();
    expect(reduceKeypress(at('hi'), 'b', K({ ctrl: true }))).toBeNull();
    expect(reduceKeypress(at('hi'), 'f', K({ ctrl: true }))).toBeNull();
    expect(reduceKeypress(at('hi'), 'd', K({ ctrl: true }))).toBeNull();
  });

  it('still ignores the navigation keys upstream skipped (up/down/tab/shift+tab/ctrl+c)', () => {
    expect(reduceKeypress(at('hi'), '', K({ upArrow: true }))).toBeNull();
    expect(reduceKeypress(at('hi'), '', K({ downArrow: true }))).toBeNull();
    expect(reduceKeypress(at('hi'), '', K({ tab: true }))).toBeNull();
    expect(reduceKeypress(at('hi'), '', K({ shift: true, tab: true }))).toBeNull();
    expect(reduceKeypress(at('hi'), 'c', K({ ctrl: true }))).toBeNull();
  });
});

describe('reduceKeypress — normal editing still works (regression guard for the vendored copy)', () => {
  it('inserts a typed character at the cursor', () => {
    expect(reduceKeypress(at('hi'), 'x', K())).toEqual({ value: 'hix', cursorOffset: 3 });
    // insert mid-string
    expect(reduceKeypress({ value: 'hi', cursorOffset: 1 }, 'X', K())).toEqual({ value: 'hXi', cursorOffset: 2 });
  });

  it('backspace deletes the char before the cursor', () => {
    expect(reduceKeypress(at('hi'), '', K({ backspace: true }))).toEqual({ value: 'h', cursorOffset: 1 });
    // at offset 0, nothing to delete
    expect(reduceKeypress({ value: 'hi', cursorOffset: 0 }, '', K({ backspace: true }))).toEqual({
      value: 'hi',
      cursorOffset: 0,
    });
  });

  it('left/right arrows move the cursor within bounds', () => {
    expect(reduceKeypress({ value: 'hi', cursorOffset: 2 }, '', K({ leftArrow: true }))).toEqual({
      value: 'hi',
      cursorOffset: 1,
    });
    // right arrow clamps at value length
    expect(reduceKeypress({ value: 'hi', cursorOffset: 2 }, '', K({ rightArrow: true }))).toEqual({
      value: 'hi',
      cursorOffset: 2,
    });
    // left arrow clamps at 0
    expect(reduceKeypress({ value: 'hi', cursorOffset: 0 }, '', K({ leftArrow: true }))).toEqual({
      value: 'hi',
      cursorOffset: 0,
    });
  });

  it('Enter returns a submit signal without mutating the value', () => {
    expect(reduceKeypress(at('send me'), '', K({ return: true }))).toEqual({
      value: 'send me',
      cursorOffset: 7,
      submit: true,
    });
  });

  it('a plain multi-char paste inserts the whole string and advances the cursor', () => {
    expect(reduceKeypress(at('a'), 'bcd', K())).toEqual({ value: 'abcd', cursorOffset: 4 });
  });
});
