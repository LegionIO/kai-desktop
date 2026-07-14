import React, { useState, useEffect } from 'react';
import { Text, useInput } from 'ink';

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
      if (key.upArrow || key.downArrow || (key.ctrl && input === 'c') || key.tab || (key.shift && key.tab)) {
        return;
      }
      // THE FIX: any Ctrl/Meta combo (bar the arrows/tab/Ctrl+C handled above) is
      // an app shortcut, not text — don't insert its letter into the composer.
      if ((key.ctrl || key.meta) && input) {
        return;
      }
      if (key.return) {
        onSubmit?.(originalValue);
        return;
      }

      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;

      if (key.leftArrow) {
        if (showCursor) nextCursorOffset--;
      } else if (key.rightArrow) {
        if (showCursor) nextCursorOffset++;
      } else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          nextValue =
            originalValue.slice(0, cursorOffset - 1) + originalValue.slice(cursorOffset, originalValue.length);
          nextCursorOffset--;
        }
      } else {
        nextValue =
          originalValue.slice(0, cursorOffset) + input + originalValue.slice(cursorOffset, originalValue.length);
        nextCursorOffset += input.length;
      }

      if (nextCursorOffset < 0) nextCursorOffset = 0;
      if (nextCursorOffset > nextValue.length) nextCursorOffset = nextValue.length;

      setCursorOffset(nextCursorOffset);
      if (nextValue !== originalValue) onChange(nextValue);
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
  const atCursor = value[cursorOffset] ?? ' ';
  const after = value.slice(cursorOffset + 1);
  return (
    <Text>
      {before}
      <Text inverse>{atCursor}</Text>
      {after}
    </Text>
  );
}

export default TextInput;
