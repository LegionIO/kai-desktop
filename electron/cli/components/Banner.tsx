import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

/**
 * Top MOTD banner (Claude-Code / Codex style): product name + version, the
 * active model / reasoning effort, and the working directory. Shown once at the
 * top of the transcript.
 */
export function Banner({
  productName,
  version,
  modelLabel,
  profileLabel,
  pending,
  effort,
  cwd,
}: {
  productName: string;
  version: string;
  modelLabel: string;
  profileLabel: string;
  pending?: string | null;
  effort?: string;
  cwd: string;
}): React.ReactElement {
  const home = process.env.HOME ?? '';
  const prettyCwd = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  const modelLine = effort ? `${modelLabel} ${effort}` : modelLabel;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text>
        <Text color="cyan" bold>
          ✦ {productName}
        </Text>{' '}
        <Text dimColor>v{version}</Text>
        {pending ? (
          <Text color="yellow">
            {'   '}
            <Spinner type="dots" /> {pending}
          </Text>
        ) : null}
      </Text>
      <Box>
        <Text dimColor>model: </Text>
        <Text color="yellow">{modelLine}</Text>
        <Text dimColor>{'   '}/model to change</Text>
      </Box>
      <Box>
        <Text dimColor>profile: </Text>
        <Text color="yellow">{profileLabel}</Text>
        <Text dimColor>{'   '}/profile to change</Text>
      </Box>
      <Box>
        <Text dimColor>dir: </Text>
        <Text>{prettyCwd}</Text>
      </Box>
    </Box>
  );
}
