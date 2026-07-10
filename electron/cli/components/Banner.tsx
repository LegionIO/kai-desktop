import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { stripControl } from '../render/markdown.js';

/**
 * Top MOTD banner (Claude-Code / Codex style): product name + version, the
 * active model (with a fallback marker + inline "applying…" spinner), the
 * active profile, and the working directory.
 */
export function Banner({
  productName,
  version,
  modelLabel,
  modelFellBack,
  profileLabel,
  pending,
  effort,
  cwd,
}: {
  productName: string;
  version: string;
  modelLabel: string;
  modelFellBack?: boolean;
  profileLabel: string;
  /** Which line is mid-change: shows an inline spinner where the hint normally sits. */
  pending?: 'model' | 'profile' | null;
  effort?: string;
  cwd: string;
}): React.ReactElement {
  const home = process.env.HOME ?? '';
  const rawCwd = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  // model/profile labels come from config and cwd is a filesystem path — strip
  // ESC/OSC so a crafted model name or repo dir can't inject terminal escapes.
  const prettyCwd = stripControl(rawCwd);
  const modelLine = stripControl(effort ? `${modelLabel} ${effort}` : modelLabel);
  const safeProfileLabel = stripControl(profileLabel);

  const trailer = (line: 'model' | 'profile'): React.ReactElement =>
    pending === line ? (
      <Text color="yellow">
        {'   '}
        <Spinner type="dots" /> applying…
      </Text>
    ) : (
      <Text dimColor>
        {'   '}/{line} to change
      </Text>
    );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text>
        <Text color="cyan" bold>
          ✦ {productName}
        </Text>{' '}
        <Text dimColor>v{version}</Text>
      </Text>
      <Box>
        <Text dimColor>model: </Text>
        <Text color="yellow">{modelLine}</Text>
        {modelFellBack ? <Text color="magenta"> (fallback)</Text> : null}
        {trailer('model')}
      </Box>
      <Box>
        <Text dimColor>profile: </Text>
        <Text color="yellow">{safeProfileLabel}</Text>
        {trailer('profile')}
      </Box>
      <Box>
        <Text dimColor>dir: </Text>
        <Text>{prettyCwd}</Text>
      </Box>
    </Box>
  );
}
