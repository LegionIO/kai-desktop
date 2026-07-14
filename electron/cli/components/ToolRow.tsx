import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { stripControl } from '../render/markdown.js';

export type ToolStatus = 'running' | 'awaiting' | 'done' | 'error';

/** Cap the expanded arg/result preview so a huge tool payload can't flood the
 *  terminal. Model/tool-controlled, so also control-stripped. */
const MAX_EXPAND_CHARS = 4000;

function previewValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  text = stripControl(text);
  return text.length > MAX_EXPAND_CHARS ? text.slice(0, MAX_EXPAND_CHARS) + '\n…(truncated)' : text;
}

export function ToolRow({
  name,
  status,
  durationMs,
  error,
  expanded,
  args,
  result,
}: {
  name: string;
  status: ToolStatus;
  durationMs?: number;
  error?: string;
  expanded?: boolean;
  args?: unknown;
  result?: unknown;
}): React.ReactElement {
  // Tool names + errors are model/tool-controlled; strip ESC/OSC at the terminal
  // boundary so they can't inject cursor/color/link escapes.
  name = stripControl(name);
  error = error !== undefined ? stripControl(error) : error;
  const dur = typeof durationMs === 'number' ? ` ${(durationMs / 1000).toFixed(1)}s` : '';

  // A dim hint that this row can be expanded/collapsed with Ctrl-O, shown only
  // when there IS expandable content (args/result) — so the user discovers the
  // shortcut where it's useful without cluttering rows that have nothing to dig
  // into.
  const hasExpandable = args !== undefined || result !== undefined;
  const expandHint = hasExpandable ? <Text dimColor> · Ctrl-O {expanded ? 'collapse' : 'expand'}</Text> : null;

  const detail =
    expanded && (args !== undefined || result !== undefined) ? (
      <Box flexDirection="column" marginLeft={2}>
        {args !== undefined ? (
          <Box flexDirection="column">
            <Text dimColor>input:</Text>
            <Text dimColor>{previewValue(args)}</Text>
          </Box>
        ) : null}
        {result !== undefined ? (
          <Box flexDirection="column">
            <Text dimColor>output:</Text>
            <Text dimColor>{previewValue(result)}</Text>
          </Box>
        ) : null}
      </Box>
    ) : null;

  const header = ((): React.ReactElement => {
    switch (status) {
      case 'running':
        return (
          <Text>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>{' '}
            <Text color="cyan">{name}</Text>
            <Text dimColor>…</Text>
          </Text>
        );
      case 'awaiting':
        return (
          <Text>
            <Text color="yellow">⚠</Text> <Text color="yellow">{name}</Text> <Text dimColor>awaiting approval</Text>
          </Text>
        );
      case 'done':
        return (
          <Text>
            <Text color="green">✓</Text> <Text>{name}</Text>
            <Text dimColor>{dur}</Text>
            {expandHint}
          </Text>
        );
      case 'error':
        return (
          <Box flexDirection="column">
            <Text>
              <Text color="red">✗</Text> <Text>{name}</Text>
              {expandHint}
            </Text>
            {error ? <Text color="red"> {error}</Text> : null}
          </Box>
        );
    }
  })();

  if (!detail) return header;
  return (
    <Box flexDirection="column">
      {header}
      {detail}
    </Box>
  );
}
