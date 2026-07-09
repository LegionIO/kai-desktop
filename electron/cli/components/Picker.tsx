import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export type PickerItem = { label: string; value: string };

/**
 * A vertical selectable list (arrow keys + enter, digit shortcuts, Esc to
 * cancel). Used for tool-approval prompts, model/profile selection, and
 * resume-chat selection.
 */
export function Picker({
  title,
  items,
  onSelect,
  onCancel,
}: {
  title: string;
  items: PickerItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % items.length);
    else if (key.return) {
      if (items[index]) onSelect(items[index].value);
    } else if (key.escape) onCancel();
    else if (/^[1-9]$/.test(input)) {
      const n = parseInt(input, 10) - 1;
      if (n < items.length) onSelect(items[n].value);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      {items.map((item, i) => (
        <Text key={item.value} color={i === index ? 'cyan' : undefined} inverse={i === index}>
          {i === index ? '❯ ' : '  '}
          {i < 9 ? `${i + 1}. ` : '·  '}
          {item.label}
        </Text>
      ))}
      <Text dimColor>↑/↓ move · 1-9 quick-select · enter select · esc cancel</Text>
    </Box>
  );
}
