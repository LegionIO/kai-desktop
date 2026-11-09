import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { LocalBridgeClient } from './client.js';
import type { McpLogin, McpLogout, McpStatus } from '../../shared/mcp.js';
import { stripControl } from './render/markdown.js';

export function parseMcpCommand(argv: string[]): string[] | undefined {
  const args = argv.filter((value) => value !== '--kai-cli');
  return args[0] === 'mcp' ? args.slice(1) : undefined;
}
export async function startMcpLogin(client: LocalBridgeClient, name: string, noBrowser = false): Promise<McpLogin> {
  const flow = await client.invoke<McpLogin>('mcp:login', name);
  const remote =
    process.env.SSH_CONNECTION ||
    (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  if (!noBrowser && !remote) await client.invoke('mcp:open-login', flow.loginId).catch(() => undefined);
  return flow;
}

export async function runMcpCommand(client: LocalBridgeClient, args: string[]): Promise<void> {
  const [action = 'list', name] = args;
  if (action === 'list') {
    const status = await client.invoke<McpStatus[]>('mcp:status');
    for (const item of status)
      process.stdout.write(
        `${stripControl(item.name)}: ${item.enabled ? item.status : 'disabled'}; ${item.state}${item.message ? ` — ${stripControl(item.message)}` : ''}\n`,
      );
    return;
  }
  if (!name || !['login', 'logout', 'reconnect', 'reset-registration', 'client-secret'].includes(action))
    throw new Error(
      'Usage: kai mcp list | login <name> [--no-browser] | logout <name> | reconnect <name> | reset-registration <name> | client-secret <name>',
    );
  if (action === 'reset-registration') {
    await client.invoke('mcp:reset-registration', name);
    process.stdout.write('Local OAuth registration cleared. Run kai mcp login <name> to register again.\n');
    return;
  }
  if (action === 'logout') {
    const result = await client.invoke<McpLogout>('mcp:logout', name);
    process.stdout.write(`Signed out locally. Server revocation: ${result.revocation}.\n`);
    return;
  }
  if (action === 'reconnect') {
    await client.invoke('mcp:reconnect', name);
    const status = (await client.invoke<McpStatus[]>('mcp:status')).find((item) => item.name === name);
    if (status?.state !== 'required') {
      if (status?.status !== 'connected') throw new Error(status?.error ?? 'Server did not reconnect.');
      process.stdout.write('Reconnected.\n');
      return;
    }
  }
  if (!process.stdin.isTTY)
    throw new Error(
      'OAuth login and client-secret entry require an interactive terminal. Use kai mcp login from a terminal first.',
    );
  // Suppress terminal echo. Callback URLs and secrets never enter argv or chat.
  const silentOutput = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const reader = createInterface({ input: process.stdin, output: silentOutput, terminal: true });
  if (action === 'client-secret') {
    try {
      process.stdout.write('Client secret (hidden; empty removes it): ');
      const secret = await reader.question('');
      await client.invoke('mcp:set-client-secret', name, secret || null);
      process.stdout.write('\nClient secret updated. Sign in again.\n');
    } finally {
      reader.close();
    }
    return;
  }
  let completed = false;
  let off: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const state = (await client.invoke<McpStatus[]>('mcp:status')).find((item) => item.name === name);
    if (state?.storage === 'session')
      process.stdout.write('OS secure storage is unavailable. Credentials last for this backend session only.\n');
    const flow = await startMcpLogin(client, name, args.includes('--no-browser'));
    process.stdout.write(`Open this URL to sign in:\n${flow.authorizationUrl}\n`);
    process.stdout.write(
      'If the page shows invalid_client without returning to Kai, cancel and use kai mcp reset-registration <name>, then sign in again. This applies only to dynamic clients.\n',
    );
    const finished = new Promise<void>((resolve, reject) => {
      const update = (items: McpStatus[]) => {
        const state = items.find((item) => item.name === name);
        if (state?.state === 'authorized') {
          completed = true;
          resolve();
        } else if (state?.state === 'required') reject(new Error(state.message ?? 'Sign-in ended. Try again.'));
      };
      off = client.on('mcp:status-changed', (items) => update(items as McpStatus[]));
      void client.invoke<McpStatus[]>('mcp:status').then(update, reject);
      timer = setTimeout(
        () => reject(new Error('Sign-in timed out. Run kai mcp login again.')),
        Math.max(1, flow.expiresAt - Date.now()),
      );
    });
    const paste = (async () => {
      while (!completed) {
        process.stdout.write('If the callback cannot reach Kai, paste the full callback URL (hidden), then Enter: ');
        const callback = await reader.question('');
        if (callback.trim()) {
          try {
            await client.invoke('mcp:complete-login', flow.loginId, callback.trim());
            completed = true;
            return;
          } catch (error) {
            process.stdout.write(`\n${error instanceof Error ? error.message : 'Invalid callback. Try again.'}\n`);
          }
        }
      }
    })();
    await Promise.race([finished, paste]);
    process.stdout.write('\nSigned in.\n');
  } finally {
    off?.();
    if (timer) clearTimeout(timer);
    reader.close();
    if (!completed) await client.invoke('mcp:cancel-login', name).catch(() => undefined);
  }
}
