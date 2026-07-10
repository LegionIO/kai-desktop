/**
 * Verifies the MCP-call cancellation contract that electron/tools/mcp-client.ts
 * relies on (commit 2da59f0): a hung MCP tool call must reject when a `timeout`
 * elapses or the provided AbortSignal fires — so a stuck MCP server can't keep
 * the agent turn alive after chat/user cancellation.
 *
 * Uses the SDK's in-memory linked transport (no network/flakiness) with a
 * deliberately hanging tool handler.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

describe('MCP tool-call cancellation contract', () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: 'hang-test', version: '1.0.0' });
    server.tool('hang', 'never resolves', { x: z.string().optional() }, () => {
      // Never resolves — simulates a hung MCP server.
      return new Promise<never>(() => {});
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'kai-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
  });

  it('rejects a hung call when the timeout elapses', async () => {
    await expect(client.callTool({ name: 'hang', arguments: {} }, undefined, { timeout: 150 })).rejects.toBeTruthy();
  });

  it('rejects a hung call when the AbortSignal fires', async () => {
    const ac = new AbortController();
    const p = client.callTool({ name: 'hang', arguments: {} }, undefined, {
      signal: ac.signal,
      // Large timeout so the abort — not the timer — is what ends the call.
      timeout: 60_000,
    });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toBeTruthy();
  });
});
