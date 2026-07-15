import { describe, it, expect } from 'vitest';
import { reduceKeypress, prevWordOffset, nextWordOffset, type KeyLike } from '../components/TextInput.js';

const k = (over: Partial<KeyLike> = {}): KeyLike => ({ ...over });
const st = (value: string, cursorOffset: number) => ({ value, cursorOffset });

describe('word-boundary offsets', () => {
  it('prevWordOffset skips trailing whitespace then the word', () => {
    expect(prevWordOffset('hello world', 11)).toBe(6); // |world → before 'world'
    expect(prevWordOffset('hello world', 6)).toBe(0); // at 'world' start → 'hello'
    expect(prevWordOffset('hello   world', 13)).toBe(8); // multi-space
    expect(prevWordOffset('abc', 0)).toBe(0); // at start
  });

  it('nextWordOffset skips leading whitespace then the word', () => {
    expect(nextWordOffset('hello world', 0)).toBe(5); // end of 'hello'
    expect(nextWordOffset('hello world', 5)).toBe(11); // skip space + 'world'
    expect(nextWordOffset('hello   world', 5)).toBe(13);
    expect(nextWordOffset('abc', 3)).toBe(3); // at end
  });
});

describe('reduceKeypress — Option/Alt word editing (macOS bindings)', () => {
  it('Meta-b (Option+Left) jumps the cursor one word back, no value change', () => {
    const r = reduceKeypress(st('hello world', 11), 'b', k({ meta: true }));
    expect(r).toEqual({ value: 'hello world', cursorOffset: 6 });
  });

  it('Meta-f (Option+Right) jumps the cursor one word forward', () => {
    const r = reduceKeypress(st('hello world', 0), 'f', k({ meta: true }));
    expect(r).toEqual({ value: 'hello world', cursorOffset: 5 });
  });

  it('Ctrl-w (Option+Backspace) deletes the word before the cursor', () => {
    const r = reduceKeypress(st('hello world', 11), 'w', k({ ctrl: true }));
    expect(r).toEqual({ value: 'hello ', cursorOffset: 6 });
  });

  it('Ctrl-w deletes only up to the cursor (mid-word)', () => {
    const r = reduceKeypress(st('hello world', 8), 'w', k({ ctrl: true }));
    // cursor after "hello wo" → delete back to word start (6) → "hello rld"
    expect(r).toEqual({ value: 'hello rld', cursorOffset: 6 });
  });

  it('Meta-d (Option+Delete) deletes the word after the cursor, cursor stays', () => {
    const r = reduceKeypress(st('hello world', 5), 'd', k({ meta: true }));
    // from the space at 5: skip the space + delete "world" (through offset 11) → "hello"
    expect(r).toEqual({ value: 'hello', cursorOffset: 5 });
  });

  it('Meta-d mid-first-word deletes forward to the word end', () => {
    const r = reduceKeypress(st('hello world', 0), 'd', k({ meta: true }));
    expect(r).toEqual({ value: ' world', cursorOffset: 0 });
  });

  it('word ops are case-insensitive on the letter', () => {
    expect(reduceKeypress(st('a b', 3), 'B', k({ meta: true }))?.cursorOffset).toBe(2);
  });

  it('still swallows other Ctrl/Meta combos (not a word op) as null', () => {
    expect(reduceKeypress(st('hi', 2), 'o', k({ ctrl: true }))).toBeNull(); // Ctrl-O shortcut
    expect(reduceKeypress(st('hi', 2), 'x', k({ meta: true }))).toBeNull();
  });

  it('does not act on word ops when showCursor is false', () => {
    expect(reduceKeypress(st('hello world', 11), 'b', k({ meta: true }), false)).toBeNull();
  });
});
