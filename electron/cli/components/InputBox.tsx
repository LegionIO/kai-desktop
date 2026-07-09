import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';

const SLASH_COMMANDS = ['new', 'resume', 'model', 'profile', 'compact', 'rewind', 'clear', 'help', 'quit'];

export function InputBox({
  status,
  conversationId,
  onSubmit,
}: {
  status: 'idle' | 'running' | 'awaiting-approval';
  conversationId: string;
  onSubmit: (value: string) => void;
}): React.ReactElement {
  const [value, setValue] = useState('');

  // Autocomplete hints for slash commands.
  const showHints = value.startsWith('/') && !value.includes(' ');
  const partial = value.slice(1).toLowerCase();
  const matches = showHints ? SLASH_COMMANDS.filter((c) => c.startsWith(partial)) : [];

  const busy = status !== 'idle';
  const statusLabel = status === 'running' ? 'running' : status === 'awaiting-approval' ? 'awaiting approval' : 'ready';
  const statusColor = status === 'running' ? 'yellow' : status === 'awaiting-approval' ? 'yellow' : 'green';

  const handleSubmit = (v: string): void => {
    onSubmit(v);
    setValue('');
  };

  return (
    <Box flexDirection="column" marginTop={1}>
      {matches.length > 0 ? (
        <Box marginBottom={0}>
          <Text dimColor>{matches.map((m) => `/${m}`).join('  ')}</Text>
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor={busy ? 'yellow' : 'cyan'} paddingX={1}>
        <Text color={busy ? 'yellow' : 'cyan'}>{busy ? <Spinner type="dots" /> : '›'} </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder={busy ? 'working… (type to queue)' : 'Send a message, or / for commands'}
        />
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>{conversationId ? `chat ${conversationId.slice(0, 8)}` : 'connecting…'}</Text>
        <Text color={statusColor}>{statusLabel}</Text>
      </Box>
    </Box>
  );
}
