import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { LocalBridgeClient } from '../electron/cli/client.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** Backend seam for testing the real MCP stdio server without a desktop process. */
export function connectorBackendFixture() {
  const events = new EventEmitter();
  const tools: Tool[] = [
    {
      name: 'fixture_mail',
      description: 'Fixture registered mail tool',
      inputSchema: { type: 'object', properties: { folder: { type: 'string' } } },
    },
  ];
  const connection = {
    invoke: vi.fn(async (channel: string, ..._args: unknown[]): Promise<unknown> => {
      if (channel === 'kai-mcp:list') return tools;
      if (channel === 'kai-mcp:cancel') return null;
      throw new Error(`Unexpected connector channel: ${channel}`);
    }),
    invokeWithTimeout: vi.fn(
      async (_channel: string, _timeout: number, _args: unknown): Promise<unknown> => ({
        content: [{ type: 'text', text: 'fixture result' }],
        structuredContent: { count: 1 },
      }),
    ),
    on: (channel: string, listener: (value: unknown) => void) => {
      events.on(channel, listener);
      return () => {
        events.off(channel, listener);
      };
    },
    onDisconnect: (listener: () => void) => {
      events.on('disconnect', listener);
      return () => {
        events.off('disconnect', listener);
      };
    },
    wasIntentionalClose: vi.fn(() => false),
    requestShutdown: vi.fn(async () => {}),
    close: vi.fn(),
  };
  return { tools, events, connection, client: connection as unknown as LocalBridgeClient };
}
