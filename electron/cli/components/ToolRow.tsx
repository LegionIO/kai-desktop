import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { stripControl } from '../render/markdown.js';

export type ToolStatus = 'running' | 'awaiting' | 'done' | 'error';

export function ToolRow({
  name,
  status,
  durationMs,
  error,
}: {
  name: string;
  status: ToolStatus;
  durationMs?: number;
  error?: string;
}): React.ReactElement {
  // Tool names + errors are model/tool-controlled; strip ESC/OSC at the terminal
  // boundary so they can't inject cursor/color/link escapes.
  name = stripControl(name);
  error = error !== undefined ? stripControl(error) : error;
  const dur = typeof durationMs === 'number' ? ` ${(durationMs / 1000).toFixed(1)}s` : '';
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
        </Text>
      );
    case 'error':
      return (
        <Box flexDirection="column">
          <Text>
            <Text color="red">✗</Text> <Text>{name}</Text>
          </Text>
          {error ? <Text color="red"> {error}</Text> : null}
        </Box>
      );
  }
}
