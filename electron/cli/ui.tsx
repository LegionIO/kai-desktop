import React from 'react';
import { render } from 'ink';
import type { LocalBridgeClient } from './client.js';
import { App } from './app.js';

/**
 * Enter the interactive Ink TUI. On quit — whether via `/quit`, Ctrl-C, or a
 * SIGTERM — we ask the backend to shut down. The backend only honors it if no
 * other clients (GUI / another CLI) remain, so quitting the last client tears
 * the backend down promptly while co-existing clients keep it alive.
 *
 * We disable Ink's built-in exitOnCtrlC and trap the signals ourselves so the
 * async "Cleaning up…" → requestShutdown handshake actually completes before
 * the process exits (Ink's default Ctrl-C would kill us mid-handshake).
 */
export async function startRepl(client: LocalBridgeClient, recover?: () => Promise<boolean>): Promise<void> {
  // App writes the active conversation id + busy flag here so cleanup can cancel
  // an in-flight turn on quit. Requesting backend shutdown is NOT enough when a
  // GUI leader is attached (idleShutdown is false there, so the request is a
  // no-op) — the model/tool run would otherwise continue after the CLI is gone,
  // including a permanently stuck approval prompt.
  const runtimeRef: { activeConversationId: string | null; busy: boolean } = {
    activeConversationId: null,
    busy: false,
  };
  const instance = render(<App client={client} recover={recover} runtimeRef={runtimeRef} />, { exitOnCtrlC: false });

  let cleaningUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleaningUp) return;
    cleaningUp = true;
    try {
      instance.unmount();
    } catch {
      /* already unmounted */
    }
    process.stdout.write('\x1b[2m Cleaning up…\x1b[0m\n');
    // Cancel the in-flight turn (if any) so it doesn't keep running on a shared
    // backend after we detach. Best-effort — don't let it block the exit.
    if (runtimeRef.busy && runtimeRef.activeConversationId) {
      try {
        await client.invoke('agent:cancel-stream', runtimeRef.activeConversationId);
      } catch {
        /* ignore */
      }
    }
    await client.requestShutdown();
    client.close();
    process.exit(0);
  };

  // Ctrl-C / SIGTERM must run the graceful shutdown, not kill us instantly.
  process.once('SIGINT', () => void cleanup());
  process.once('SIGTERM', () => void cleanup());

  await instance.waitUntilExit(); // resolves on /quit (App calls Ink exit())
  await cleanup();
}
