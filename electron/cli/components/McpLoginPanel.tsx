import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from './TextInput.js';
import type { McpLogin } from '../../../shared/mcp.js';
import type { LocalBridgeClient } from '../client.js';
import { stripControl } from '../render/markdown.js';

export function McpLoginPanel({
  flow,
  client,
  onClose,
}: {
  flow: McpLogin & { name: string };
  client: LocalBridgeClient;
  onClose: () => void;
}) {
  const [callback, setCallback] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useInput((_input, key) => {
    if (key.escape) {
      void client.invoke('mcp:cancel-login', flow.name).catch(() => undefined);
      setCallback('');
      onClose();
    }
  });
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Sign in to {stripControl(flow.name)}</Text>
      <Text>{flow.authorizationUrl}</Text>
      <Text dimColor>Complete sign-in in your browser, or paste the full callback URL below. Esc cancels.</Text>
      <Text dimColor>
        If the page shows invalid_client, press Esc and use /mcp reset-registration followed by the server name, then
        /mcp login. Only dynamic registrations can be reset.
      </Text>
      <TextInput
        value={callback}
        onChange={setCallback}
        mask="*"
        placeholder="Callback URL (hidden)"
        onSubmit={(value) => {
          if (busy || !value.trim()) return;
          setBusy(true);
          setCallback('');
          void client
            .invoke('mcp:complete-login', flow.loginId, value.trim())
            .then(onClose, (e) => setError(e instanceof Error ? e.message : 'Sign-in failed.'))
            .finally(() => setBusy(false));
        }}
      />
      {error && <Text color="red">{stripControl(error)}</Text>}
    </Box>
  );
}
