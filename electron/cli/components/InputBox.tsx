import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import TextInput from './TextInput.js';
import Spinner from 'ink-spinner';
import { SPINNER_VERBS } from '../../../shared/spinner-verbs.js';

const SLASH_COMMANDS = ['new', 'resume', 'model', 'profile', 'rewind', 'clear', 'help', 'quit'];

const randomVerb = (exclude?: string): string => {
  let v = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
  // Avoid repeating the same verb twice in a row when there's a choice.
  for (let i = 0; v === exclude && i < 5; i++) v = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
  return v;
};

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

  // Rotating thinking-verb label while running (mirrors the desktop GUI's
  // playful spinner: "Spinning…", "Pondering…", etc. from the shared verb list).
  const [verb, setVerb] = useState<string>(() => randomVerb());
  const verbRef = useRef(verb);
  verbRef.current = verb;
  useEffect(() => {
    if (status !== 'running') return;
    // Fresh verb when a run starts, then cycle every ~3s until it ends.
    setVerb(randomVerb(verbRef.current));
    const t = setInterval(() => setVerb(randomVerb(verbRef.current)), 3000);
    return () => clearInterval(t);
  }, [status]);

  // Autocomplete hints for slash commands.
  const showHints = value.startsWith('/') && !value.includes(' ');
  const partial = value.slice(1).toLowerCase();
  const matches = showHints ? SLASH_COMMANDS.filter((c) => c.startsWith(partial)) : [];

  const busy = status !== 'idle';
  const statusLabel =
    status === 'running' ? `${verb}…` : status === 'awaiting-approval' ? 'awaiting approval' : 'ready';
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
