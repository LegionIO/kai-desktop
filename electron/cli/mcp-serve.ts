import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { getAppHome, getSocketPath } from '../local-bridge/paths.js';
import { localCredentialPath } from '../mcp-sharing/setup.js';
import { readBoundedFile } from '../plugin-bridge/files.js';
import { tryConnect } from './client.js';
import { BOOT_TIMEOUT_MS, cliLog, recoverBackend, spawnHeadlessBackend, waitForSocket } from './spawn-backend.js';

export function parseMcpServe(argv: string[]): { credential: string } | null {
  const args = argv.filter((arg) => arg !== '--kai-cli');
  if (args[0] !== 'mcp' || args[1] !== 'serve') return null;
  if (args.length !== 4 || args[2] !== '--credential')
    throw new Error('Usage: kai mcp serve --credential <reference>. Create a connector in Settings → Plugin Bridge.');
  return { credential: args[3] };
}
export async function serveMcp(credential: string, fromElectron: boolean): Promise<void> {
  // Only this connector's credential is loaded. Never load the administrative
  // local-bridge token or provider/plugin credentials into this process.
  const token = readBoundedFile(localCredentialPath(getAppHome(), credential), 1024).trim();
  let client = await tryConnect(getSocketPath(), token);
  if (!client) {
    cliLog('Starting the Kai backend for MCP sharing…');
    if (!(await spawnHeadlessBackend(fromElectron))) throw new Error('Kai backend startup failed.');
    client = await waitForSocket(getSocketPath(), BOOT_TIMEOUT_MS, token);
    if (!client) throw new Error('Kai MCP sharing is disabled, this client was revoked, or the backend did not start.');
  }
  const connection = client;
  // Verify the restricted endpoint before advertising any tools to the client.
  try {
    await connection.invoke('kai-mcp:list');
  } catch (error) {
    connection.close();
    throw error;
  }
  const server = new Server({ name: 'kai-mcp', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  const lifetime = new AbortController();
  let recovery: Promise<boolean> | undefined;
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (recovery && !(await recovery)) throw new Error('Kai backend is unavailable.');
    return { tools: await connection.invoke<Tool[]>('kai-mcp:list') };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (recovery && !(await recovery)) throw new Error('Kai backend is unavailable.');
    const callId = randomUUID();
    const cancel = () => {
      void connection.invoke('kai-mcp:cancel', callId).catch(() => {});
    };
    extra.signal.addEventListener('abort', cancel, { once: true });
    const unsubscribe = connection.on('kai-mcp:progress', (value) => {
      const progress = value as {
        callId: string;
        delta?: string;
        bytesSeen?: number;
        progress?: number;
        total?: number;
      };
      if (progress.callId !== callId || request.params._meta?.progressToken === undefined) return;
      void extra
        .sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: request.params._meta.progressToken,
            progress: progress.progress ?? progress.bytesSeen ?? 0,
            total: progress.total,
            message: progress.delta,
          },
        })
        .catch(() => {});
    });
    try {
      extra.signal.throwIfAborted();
      return await connection.invokeWithTimeout<CallToolResult>('kai-mcp:call', 610_000, {
        callId,
        name: request.params.name,
        args: request.params.arguments ?? {},
        origin: request.params._meta?.['kai.origin'],
      });
    } finally {
      extra.signal.removeEventListener('abort', cancel);
      unsubscribe();
    }
  });
  const stopCatalog = connection.on('kai-mcp:catalog-changed', () => {
    void server.notification({ method: 'notifications/tools/list_changed' }).catch(() => {});
  });
  const stopDisconnect = connection.onDisconnect(() => {
    if (lifetime.signal.aborted || connection.wasIntentionalClose() || recovery) return;
    recovery = recoverBackend(connection, fromElectron, lifetime.signal)
      .catch(() => false)
      .finally(() => {
        recovery = undefined;
      });
    void recovery.then((ok) => {
      if (!ok && !lifetime.signal.aborted) {
        cliLog('Kai backend connection lost. Reconnect the MCP client.');
        void server.close();
      }
    });
  });
  let closed!: () => void;
  const ended = new Promise<void>((resolve) => {
    closed = resolve;
  });
  server.onclose = closed;
  process.stdin.once('end', closed);
  process.once('SIGTERM', closed);
  process.once('SIGINT', closed);
  try {
    await server.connect(new StdioServerTransport());
    await ended;
  } finally {
    lifetime.abort();
    process.stdin.removeListener('end', closed);
    process.removeListener('SIGTERM', closed);
    process.removeListener('SIGINT', closed);
    stopCatalog();
    stopDisconnect();
    await server.close();
    await connection.requestShutdown().catch(() => {});
    connection.close();
  }
}
