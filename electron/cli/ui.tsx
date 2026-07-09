import React from 'react';
import { render } from 'ink';
import type { LocalBridgeClient } from './client.js';
import { App } from './app.js';

/**
 * Enter the interactive Ink TUI. Resolves when the user quits (Ink's
 * `waitUntilExit`), so the caller can then tear down cleanly.
 */
export async function startRepl(client: LocalBridgeClient): Promise<void> {
  const instance = render(<App client={client} />);
  await instance.waitUntilExit();
}
