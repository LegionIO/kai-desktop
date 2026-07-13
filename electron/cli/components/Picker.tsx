import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { stripControl } from '../render/markdown.js';

export type PickerItem = { label: string; value: string };

/**
 * A vertical selectable list (arrow keys + enter, digit shortcuts, Esc to
 * cancel). Used for tool-approval prompts, model/profile selection, and
 * resume-chat selection.
 *
 * When `onFreeText` is provided, an extra "Other (type a message)…" row is
 * appended; selecting it switches the picker into a text-input mode and submits
 * the typed value via onFreeText — matching the GUI AskUserQuestion's free-text
 * "Other" affordance so a CLI user isn't boxed into the offered options.
 */
export function Picker({
  title,
  items,
  onSelect,
  onCancel,
  onFreeText,
  freeTextLabel = 'Other (type a message)…',
}: {
  title: string;
  items: PickerItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  onFreeText?: (value: string) => void;
  freeTextLabel?: string;
}): React.ReactElement {
  const [index, setIndex] = useState(0);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');

  // The "Other…" row (when enabled) sits at the end; its index is items.length.
  const otherIndex = onFreeText ? items.length : -1;
  const rowCount = items.length + (onFreeText ? 1 : 0);

  useInput(
    (input, key) => {
      if (typing) return; // TextInput owns keystrokes in free-text mode
      if (key.upArrow) setIndex((i) => (i - 1 + rowCount) % rowCount);
      else if (key.downArrow) setIndex((i) => (i + 1) % rowCount);
      else if (key.return) {
        if (index === otherIndex) setTyping(true);
        else if (items[index]) onSelect(items[index].value);
      } else if (key.escape) onCancel();
      else if (/^[1-9]$/.test(input)) {
        const n = parseInt(input, 10) - 1;
        if (n === otherIndex) setTyping(true);
        else if (n < items.length) onSelect(items[n].value);
      }
    },
    { isActive: !typing },
  );

  if (typing && onFreeText) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
        <Text bold color="cyan">
          {stripControl(title)}
        </Text>
        <Box>
          <Text color="cyan">› </Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={(v) => onFreeText(v)}
            placeholder="type your answer…"
          />
        </Box>
        <Text dimColor>enter submit · esc cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold color="cyan">
        {/* title/labels may be model-controlled — strip ESC/OSC at the render
            boundary; `value` (selection payload) is left untouched. */}
        {stripControl(title)}
      </Text>
      {items.map((item, i) => (
        <Text key={item.value} color={i === index ? 'cyan' : undefined} inverse={i === index}>
          {i === index ? '❯ ' : '  '}
          {i < 9 ? `${i + 1}. ` : '·  '}
          {stripControl(item.label)}
        </Text>
      ))}
      {onFreeText ? (
        <Text
          color={index === otherIndex ? 'cyan' : undefined}
          inverse={index === otherIndex}
          dimColor={index !== otherIndex}
        >
          {index === otherIndex ? '❯ ' : '  '}
          {otherIndex < 9 ? `${otherIndex + 1}. ` : '·  '}
          {freeTextLabel}
        </Text>
      ) : null}
      <Text dimColor>↑/↓ move · 1-9 quick-select · enter select · esc cancel</Text>
    </Box>
  );
}
