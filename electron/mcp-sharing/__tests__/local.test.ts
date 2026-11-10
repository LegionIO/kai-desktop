import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bridgeSystemFixture } from '../../../test-utils/plugin-bridge.js';
import { oauthDeferred } from '../../../test-utils/mcp-oauth.js';
import { LocalBridgeClient, tryConnect } from '../../cli/client.js';
import { getSocketPath } from '../../local-bridge/paths.js';
import { hasLocalBridgeClients, startLocalServer, stopLocalServer } from '../../local-bridge/local-server.js';
import { broadcastToLocalClients } from '../../local-bridge/local-clients.js';
import type { ToolDefinition } from '../../tools/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { exportSourceId } from '../service.js';

describe.skipIf(process.platform === 'win32')('restricted local MCP backend connection', () => {
  let f: ReturnType<typeof bridgeSystemFixture>, tool: ToolDefinition;
  const clients: LocalBridgeClient[] = [];
  beforeEach(async () => {
    tool = {
      name: 'fixture_msgraph_list_mail',
      originalName: 'list-mail',
      source: 'plugin',
      sourceId: 'msgraph',
      description: 'Fixture registered plugin tool',
      inputSchema: z.object({}),
      execute: vi.fn(async (_args, context) => ({
        content: [{ type: 'text', text: 'mail fixture' }],
        structuredContent: { client: context.connectorClientId },
      })),
    };
    f = bridgeSystemFixture([tool]);
    vi.stubEnv('KAI_USER_DATA', f.appHome);
    await f.system.initialize();
    await startLocalServer();
  });
  afterEach(async () => {
    clients.splice(0).forEach((client) => client.close());
    await stopLocalServer();
    await f.close();
    vi.unstubAllEnvs();
  });
  async function connect() {
    const client = f.system.credentials.createClient('local fixture', 'local', null);
    const token = f.system.credentials.issue(client.id, 'local', Date.now() + 86_400_000);
    const connection = new LocalBridgeClient(getSocketPath(), token);
    clients.push(connection);
    await connection.connect();
    return { connection, client, token };
  }
  async function enable() {
    await f.system.mutate({ action: 'sharing', enabled: true });
    await f.system.mutate({ action: 'exports', sources: [exportSourceId(tool)], tools: [] });
  }
  it('rejects disabled access and exposes only the dedicated connector channels', async () => {
    const disabled = f.system.credentials.createClient('disabled', 'local', null);
    expect(
      await tryConnect(getSocketPath(), f.system.credentials.issue(disabled.id, 'local', Date.now() + 100_000)),
    ).toBeNull();
    await enable();
    const { connection } = await connect();
    expect((await connection.invoke<Tool[]>('kai-mcp:list')).map((entry) => entry.name)).toEqual([tool.name]);
    for (const channel of ['config:get', 'config:set', 'plugin-bridge:mutate', 'conversations:list']) {
      await expect(connection.invoke(channel)).rejects.toThrow('administrative IPC');
    }
    const result = await connection.invoke<CallToolResult>('kai-mcp:call', {
      callId: randomUUID(),
      name: tool.name,
      args: {},
    });
    expect(result.content).toEqual([{ type: 'text', text: 'mail fixture' }]);
    expect(vi.mocked(tool.execute).mock.calls[0][1].conversationId).toBeUndefined();
  });
  it('never broadcasts general chat or administrative events to connector clients', async () => {
    await enable();
    const { connection } = await connect();
    const received = vi.fn();
    connection.on('private:fixture', received);
    broadcastToLocalClients('private:fixture', { privateData: 'not for MCP' });
    await connection.invoke('kai-mcp:list');
    expect(received).not.toHaveBeenCalled();
  });
  it('cancels in-flight calls and disconnects a revoked client', async () => {
    const entered = oauthDeferred(),
      abortSeen = oauthDeferred();
    tool.execute = async (_input, context) => {
      context.abortSignal!.addEventListener('abort', () => abortSeen.resolve(), { once: true });
      entered.resolve();
      return new Promise<never>(() => {});
    };
    await enable();
    const { connection, client } = await connect();
    const call = connection.invoke('kai-mcp:call', { callId: randomUUID(), name: tool.name, args: {} });
    const rejected = expect(call).rejects.toThrow();
    await entered.promise;
    f.system.credentials.revoke(client.id);
    await abortSeen.promise;
    await rejected;
    await expect(connection.invoke('kai-mcp:list')).rejects.toThrow();
  });
  it('scopes cancellation to its originating socket and notifies export withdrawal', async () => {
    const entered = oauthDeferred();
    tool.execute = async () => {
      entered.resolve();
      return new Promise<never>(() => {});
    };
    await enable();
    const first = await connect(),
      second = await connect();
    const id = randomUUID();
    let finished = false;
    const call = first.connection
      .invoke<CallToolResult>('kai-mcp:call', { callId: id, name: tool.name, args: {} })
      .then((result) => {
        finished = true;
        return result;
      });
    await entered.promise;
    await second.connection.invoke('kai-mcp:cancel', id);
    expect(finished).toBe(false);
    await first.connection.invoke('kai-mcp:cancel', id);
    expect(await call).toMatchObject({ isError: true });
    const changed = oauthDeferred();
    first.connection.on('kai-mcp:catalog-changed', () => changed.resolve());
    await f.system.mutate({ action: 'exports', sources: [], tools: [] });
    await changed.promise;
    expect(await first.connection.invoke('kai-mcp:list')).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('restricted connector cold startup', () => {
  let f: ReturnType<typeof bridgeSystemFixture>, connection: LocalBridgeClient;
  beforeEach(async () => {
    f = bridgeSystemFixture();
    vi.stubEnv('KAI_USER_DATA', f.appHome);
    await f.system.mutate({ action: 'sharing', enabled: true });
    const client = f.system.credentials.createClient('startup fixture', 'local', null);
    const token = f.system.credentials.issue(client.id, 'local', Date.now() + 100_000);
    await startLocalServer();
    connection = new LocalBridgeClient(getSocketPath(), token);
    await connection.connect();
  });
  afterEach(async () => {
    connection.close();
    await stopLocalServer();
    await f.close();
    vi.unstubAllEnvs();
  });
  it('authenticates early but waits for tool initialization before advertising the catalog', async () => {
    expect(hasLocalBridgeClients()).toBe(true);
    let resolved = false;
    const catalog = connection.invoke('kai-mcp:list').then((value) => {
      resolved = true;
      return value;
    });
    await expect(connection.invoke('config:get')).rejects.toThrow('administrative IPC');
    expect(resolved).toBe(false);
    await f.system.initialize();
    expect(await catalog).toEqual([]);
  });
  it('fails pending discovery explicitly if backend initialization fails', async () => {
    vi.spyOn(f.system.imports, 'refresh').mockRejectedValueOnce(new Error('fixture startup failure'));
    const catalog = expect(connection.invoke('kai-mcp:list')).rejects.toThrow('initialization failed');
    await expect(f.system.initialize()).rejects.toThrow('fixture startup failure');
    await catalog;
  });
});
