import React, { useState, useEffect } from 'react';
import { Text, useInput } from 'ink';
import chalk from 'chalk';

/**
 * Local port of `ink-text-input` v6 with ONE behavioral fix: ignore Ctrl/Meta
 * key combos instead of inserting their letter into the value.
 *
 * Why vendored: the upstream component's useInput only skips `Ctrl+C`, so every
 * OTHER ctrl combo (Ctrl-O expand, etc. — which the app handles as shortcuts via
 * its own useInput) ALSO falls through to the character-insert path and leaks
 * that letter into the composer (Ink fans a keypress to every active useInput
 * with no propagation-stop). The fix is a single guard in the input handler; the
 * rest is a faithful copy so cursor/render behavior is unchanged. Only the
 * controlled TextInput is kept (the uncontrolled variant is unused here).
 */
type Props = {
  value: string;
  placeholder?: string;
  focus?: boolean;
  mask?: string;
  highlightPastedText?: boolean;
  showCursor?: boolean;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
};

export function TextInput({
  value: originalValue,
  placeholder = '',
  focus = true,
  mask,
  highlightPastedText = false,
  showCursor = true,
  onChange,
  onSubmit,
}: Props): React.ReactElement {
  const [state, setState] = useState({
    cursorOffset: (originalValue || '').length,
    cursorWidth: 0,
  });
  const { cursorOffset, cursorWidth } = state;

  useEffect(() => {
    setState((previousState) => {
      if (!focus || !showCursor) return previousState;
      const newValue = originalValue || '';
      if (previousState.cursorOffset > newValue.length - 1) {
        return { cursorOffset: newValue.length, cursorWidth: 0 };
      }
      return previousState;
    });
  }, [originalValue, focus, showCursor]);

  const cursorActualWidth = highlightPastedText ? cursorWidth : 0;
  const value = mask ? mask.repeat(originalValue.length) : originalValue;
  let renderedValue = value;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0 ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1)) : chalk.inverse(' ');
    renderedValue = value.length > 0 ? '' : chalk.inverse(' ');
    let i = 0;
    for (const char of value) {
      renderedValue += i >= cursorOffset - cursorActualWidth && i <= cursorOffset ? chalk.inverse(char) : char;
      i++;
    }
    if (value.length > 0 && cursorOffset === value.length) {
      renderedValue += chalk.inverse(' ');
    }
  }

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
      let nextCursorWidth = 0;

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
        if (input.length > 1) nextCursorWidth = input.length;
      }

      if (cursorOffset < 0) nextCursorOffset = 0;
      if (cursorOffset > originalValue.length) nextCursorOffset = originalValue.length;

      setState({ cursorOffset: nextCursorOffset, cursorWidth: nextCursorWidth });
      if (nextValue !== originalValue) onChange(nextValue);
    },
    { isActive: focus },
  );

  return <Text>{placeholder ? (value.length > 0 ? renderedValue : renderedPlaceholder) : renderedValue}</Text>;
}

export default TextInput;
