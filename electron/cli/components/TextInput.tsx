import React, { useState, useEffect } from 'react';
import { Text, useInput } from 'ink';

/** The subset of Ink's Key we branch on — kept minimal so the pure reducer is
 *  testable without constructing a full Ink key object. */
export type KeyLike = {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  tab?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
};

export type TextInputState = { value: string; cursorOffset: number };

/**
 * Word-boundary helpers for Option/Alt + arrow/backspace editing, using readline
 * word semantics: from the cursor, skip any run of whitespace, then skip the run
 * of non-whitespace ("the word"). A "word char" is anything non-whitespace.
 */
function isWordChar(ch: string): boolean {
  return !!ch && !/\s/.test(ch);
}

/** Offset of the previous word boundary at or left of `cursor`. */
export function prevWordOffset(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !isWordChar(value[i - 1]!)) i--; // skip whitespace left
  while (i > 0 && isWordChar(value[i - 1]!)) i--; // skip word left
  return i;
}

/** Offset of the next word boundary at or right of `cursor`. */
export function nextWordOffset(value: string, cursor: number): number {
  let i = cursor;
  while (i < value.length && !isWordChar(value[i]!)) i++; // skip whitespace right
  while (i < value.length && isWordChar(value[i]!)) i++; // skip word right
  return i;
}

/** True if `value[i]` is the HIGH half of a surrogate pair (an astral char like
 *  an emoji), so cursor moves / deletes should step 2 code units, not 1. */
function isSurrogatePairAt(value: string, i: number): boolean {
  const hi = value.charCodeAt(i);
  const lo = value.charCodeAt(i + 1);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

/** Step one grapheme (surrogate-pair-aware) forward/back from `offset`. */
function stepRight(value: string, offset: number): number {
  return offset + (isSurrogatePairAt(value, offset) ? 2 : 1);
}
function stepLeft(value: string, offset: number): number {
  // A low surrogate at offset-1 means offset-2 is the pair start.
  const lo = value.charCodeAt(offset - 1);
  const hi = value.charCodeAt(offset - 2);
  const isPair = lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff;
  return offset - (isPair ? 2 : 1);
}

/**
 * Pure keystroke reducer for the composer. Returns the next {value,cursorOffset}
 * (plus `submit` on Enter), or null when the keystroke is IGNORED (navigation
 * keys we don't act on, or — the #223 fix — any Ctrl/Meta combo, which is an app
 * shortcut, not text). Extracted from the useInput handler so the "Ctrl+O
 * doesn't type 'o'" fix and normal editing are unit-testable without a TTY.
 */
export function reduceKeypress(
  state: TextInputState,
  input: string,
  key: KeyLike,
  showCursor = true,
): (TextInputState & { submit?: boolean }) | null {
  if (key.upArrow || key.downArrow || (key.ctrl && input === 'c') || key.tab || (key.shift && key.tab)) {
    return null;
  }

  // Word-wise editing (macOS Option+arrow / Option+Delete / Option+Backspace).
  // Those keys arrive NOT as arrow/backspace flags but as the readline/Emacs
  // word bindings this terminal + Ink emit: Meta-b (word back), Meta-f (word
  // forward), Meta-d (delete word forward), Ctrl-w (delete word back). Handle
  // them BEFORE the generic Ctrl/Meta swallow below (which would otherwise drop
  // them). Only act when showing a live cursor.
  if (showCursor) {
    const lower = input.toLowerCase();
    if ((key.meta && lower === 'b') || (key.meta && key.leftArrow)) {
      // Word back (Meta-b, or terminals that send Option+Left as meta+leftArrow).
      return { ...state, cursorOffset: prevWordOffset(state.value, state.cursorOffset) };
    }
    if ((key.meta && lower === 'f') || (key.meta && key.rightArrow)) {
      return { ...state, cursorOffset: nextWordOffset(state.value, state.cursorOffset) };
    }
    if (key.ctrl && lower === 'w') {
      // Delete word BACKWARD (Option+Backspace).
      const start = prevWordOffset(state.value, state.cursorOffset);
      return {
        value: state.value.slice(0, start) + state.value.slice(state.cursorOffset),
        cursorOffset: start,
      };
    }
    if (key.meta && lower === 'd') {
      // Delete word FORWARD (Option+Delete) — cursor stays put.
      const end = nextWordOffset(state.value, state.cursorOffset);
      return {
        value: state.value.slice(0, state.cursorOffset) + state.value.slice(end),
        cursorOffset: state.cursorOffset,
      };
    }
  }

  // THE FIX: any Ctrl/Meta combo (bar the arrows/tab/Ctrl+C handled above) is an
  // app shortcut, not text — don't insert its letter into the composer.
  if ((key.ctrl || key.meta) && input) return null;
  if (key.return) return { ...state, submit: true };

  let { value: nextValue, cursorOffset: nextCursorOffset } = state;
  const { value: originalValue, cursorOffset } = state;

  if (key.leftArrow) {
    if (showCursor && cursorOffset > 0) nextCursorOffset = stepLeft(originalValue, cursorOffset);
  } else if (key.rightArrow) {
    if (showCursor && cursorOffset < originalValue.length) nextCursorOffset = stepRight(originalValue, cursorOffset);
  } else if (key.backspace) {
    // Delete the grapheme BEFORE the cursor (surrogate-pair-aware so an emoji is
    // removed whole, not split into an unpaired half).
    if (cursorOffset > 0) {
      const from = stepLeft(originalValue, cursorOffset);
      nextValue = originalValue.slice(0, from) + originalValue.slice(cursorOffset);
      nextCursorOffset = from;
    }
  } else if (key.delete) {
    // Forward delete: remove the grapheme AFTER the cursor; cursor stays put.
    if (cursorOffset < originalValue.length) {
      const to = stepRight(originalValue, cursorOffset);
      nextValue = originalValue.slice(0, cursorOffset) + originalValue.slice(to);
    }
  } else {
    nextValue = originalValue.slice(0, cursorOffset) + input + originalValue.slice(cursorOffset);
    nextCursorOffset += input.length;
  }

  if (nextCursorOffset < 0) nextCursorOffset = 0;
  if (nextCursorOffset > nextValue.length) nextCursorOffset = nextValue.length;
  return { value: nextValue, cursorOffset: nextCursorOffset };
}

/**
 * Local port of `ink-text-input` v6 with ONE behavioral fix: ignore Ctrl/Meta
 * key combos instead of inserting their letter into the value.
 *
 * Why vendored: the upstream component's useInput only skips `Ctrl+C`, so every
 * OTHER ctrl combo (Ctrl-O expand, etc. — which the app handles as shortcuts via
 * its own useInput) ALSO falls through to the character-insert path and leaks
 * that letter into the composer (Ink fans a keypress to every active useInput
 * with no propagation-stop). The fix is a single guard in the input handler.
 *
 * Unlike upstream (which builds an ANSI string with `chalk`), this renders the
 * cursor/placeholder with Ink's own <Text inverse/dimColor> — chalk isn't
 * resolvable in the electron-builder packaging build, and Ink styling is the
 * idiomatic equivalent. Only the controlled TextInput is kept.
 */
type Props = {
  value: string;
  placeholder?: string;
  focus?: boolean;
  mask?: string;
  showCursor?: boolean;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
};

export function TextInput({
  value: originalValue,
  placeholder = '',
  focus = true,
  mask,
  showCursor = true,
  onChange,
  onSubmit,
}: Props): React.ReactElement {
  const [cursorOffset, setCursorOffset] = useState((originalValue || '').length);

  useEffect(() => {
    if (!focus || !showCursor) return;
    const newValue = originalValue || '';
    setCursorOffset((prev) => (prev > newValue.length ? newValue.length : prev));
  }, [originalValue, focus, showCursor]);

  useInput(
    (input, key) => {
      const next = reduceKeypress({ value: originalValue, cursorOffset }, input, key, showCursor);
      if (!next) return;
      if (next.submit) {
        onSubmit?.(originalValue);
        return;
      }
      setCursorOffset(next.cursorOffset);
      if (next.value !== originalValue) onChange(next.value);
    },
    { isActive: focus },
  );

  const value = mask ? mask.repeat(originalValue.length) : originalValue;

  // Placeholder (empty value): show it with the cursor block on its first char.
  if (value.length === 0 && placeholder) {
    if (showCursor && focus) {
      return (
        <Text>
          <Text inverse>{placeholder[0]}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      );
    }
    return <Text dimColor>{placeholder}</Text>;
  }
  if (value.length === 0) {
    return showCursor && focus ? <Text inverse> </Text> : <Text> </Text>;
  }

  // Value with a fake block cursor rendered via Ink's inverse styling.
  if (!showCursor || !focus) return <Text>{value}</Text>;

  const before = value.slice(0, cursorOffset);
  // Surrogate-pair-aware: highlight the whole grapheme under the cursor (an emoji
  // is 2 code units) so we don't style/split half a surrogate pair.
  const cursorEnd = cursorOffset < value.length ? stepRight(value, cursorOffset) : cursorOffset + 1;
  const atCursor = value.slice(cursorOffset, cursorEnd) || ' ';
  const after = value.slice(cursorEnd);
  return (
    <Text>
      {before}
      <Text inverse>{atCursor}</Text>
      {after}
    </Text>
  );
}

export default TextInput;
