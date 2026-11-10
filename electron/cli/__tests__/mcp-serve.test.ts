import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProgressNotificationSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { bridgeFixture, writeBridgeFile } from '../../../test-utils/plugin-bridge.js';
import { connectorBackendFixture } from '../../../test-utils/mcp-connector.js';
import { oauthDeferred } from '../../../test-utils/mcp-oauth.js';
import { localCredentialPath } from '../../mcp-sharing/setup.js';

const mocks = vi.hoisted(() => ({
  tryConnect: vi.fn(),
  spawn: vi.fn(),
  wait: vi.fn(),
  recover: vi.fn(),
  log: vi.fn(),
  transport: vi.fn(),
}));
vi.mock('../client.js', () => ({ tryConnect: mocks.tryConnect }));
vi.mock('../spawn-backend.js', () => ({
  BOOT_TIMEOUT_MS: 30_000,
  cliLog: mocks.log,
  spawnHeadlessBackend: mocks.spawn,
  waitForSocket: mocks.wait,
  recoverBackend: mocks.recover,
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: function () {
    return mocks.transport();
  },
}));

import { parseMcpServe, serveMcp } from '../mcp-serve.js';

describe('kai mcp serve connector lifecycle', () => {
  let f: ReturnType<typeof bridgeFixture>;
  let backend: ReturnType<typeof connectorBackendFixture>;
  let client: Client;
  let pair: ReturnType<typeof InMemoryTransport.createLinkedPair>;
  let serving: Promise<void> | undefined;
  const reference = '00000000-0000-4000-8000-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
    f = bridgeFixture();
    vi.stubEnv('KAI_USER_DATA', f.appHome);
    writeBridgeFile(localCredentialPath(f.appHome, reference), 'fixture-connector-token\n');
    backend = connectorBackendFixture();
    pair = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'fixture-client', version: '1' });
    mocks.tryConnect.mockResolvedValue(backend.client);
    mocks.spawn.mockResolvedValue(true);
    mocks.wait.mockResolvedValue(backend.client);
    mocks.recover.mockResolvedValue(true);
    mocks.transport.mockReturnValue(pair[1]);
  });
  afterEach(async () => {
    await client.close();
    await pair[0].close();
    await serving?.catch(() => {});
    serving = undefined;
    f.cleanup();
    vi.unstubAllEnvs();
  });
  async function connect() {
    serving = serveMcp(reference, false);
    await vi.waitFor(() => expect(mocks.transport).toHaveBeenCalledOnce());
    await client.connect(pair[0]);
  }

  it('leaves existing MCP commands intact and rejects incomplete launcher arguments', () => {
    for (const command of ['list', 'login', 'logout', 'register']) {
      expect(parseMcpServe(['mcp', command])).toBeNull();
    }
    expect(parseMcpServe(['--kai-cli', 'mcp', 'serve', '--credential', reference])).toEqual({ credential: reference });
    expect(() => parseMcpServe(['mcp', 'serve'])).toThrow('Usage');
    expect(() => parseMcpServe(['mcp', 'serve', '--token', 'secret'])).toThrow('Usage');
  });
  it('fails before connecting for a missing or invalid credential reference', async () => {
    await expect(serveMcp('../admin', false)).rejects.toThrow('credential reference');
    await expect(serveMcp('00000000-0000-4000-8000-000000000002', false)).rejects.toThrow();
    expect(mocks.tryConnect).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each([false, true])('reports headless launch failure promptly (Electron=%s)', async (fromElectron) => {
    mocks.tryConnect.mockResolvedValue(null);
    mocks.spawn.mockResolvedValue(false);
    await expect(serveMcp(reference, fromElectron)).rejects.toThrow('startup failed');
    expect(mocks.spawn).toHaveBeenCalledWith(fromElectron);
    expect(mocks.wait).not.toHaveBeenCalled();
    expect(mocks.transport).not.toHaveBeenCalled();
  });
  it('reports disabled/revoked startup and never advertises an administrative connection', async () => {
    mocks.tryConnect.mockResolvedValue(null);
    mocks.wait.mockResolvedValue(null);
    await expect(serveMcp(reference, false)).rejects.toThrow('disabled');
    expect(mocks.wait).toHaveBeenCalledWith(expect.any(String), 30_000, 'fixture-connector-token');
    expect(mocks.transport).not.toHaveBeenCalled();
    mocks.tryConnect.mockResolvedValue(backend.client);
    backend.connection.invoke.mockRejectedValue(new Error('MCP sharing is disabled.'));
    await expect(serveMcp(reference, false)).rejects.toThrow('disabled');
    expect(backend.connection.close).toHaveBeenCalledOnce();
  });
  it('starts a backend with only the referenced credential and preserves the protocol through shutdown', async () => {
    mocks.tryConnect.mockResolvedValue(null);
    await connect();
    expect(mocks.tryConnect).toHaveBeenCalledWith(expect.any(String), 'fixture-connector-token');
    expect((await client.listTools()).tools).toEqual(backend.tools);
    expect(await client.callTool({ name: 'fixture_mail', arguments: { folder: 'inbox' } })).toMatchObject({
      content: [{ type: 'text', text: 'fixture result' }],
      structuredContent: { count: 1 },
    });
    const changed = oauthDeferred();
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => changed.resolve());
    backend.events.emit('kai-mcp:catalog-changed');
    await changed.promise;
    await client.close();
    await serving;
    expect(backend.connection.requestShutdown).toHaveBeenCalledOnce();
    expect(backend.connection.close).toHaveBeenCalledOnce();
    expect(backend.events.eventNames()).toEqual([]);
  });
  it('forwards progress and cancellation only for the pending MCP call', async () => {
    const entered = oauthDeferred<{ callId: string }>();
    const result = oauthDeferred<unknown>();
    backend.connection.invokeWithTimeout.mockImplementation(async (_channel, _timeout, args) => {
      entered.resolve(args as { callId: string });
      return result.promise;
    });
    await connect();
    const progress = oauthDeferred();
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      expect(notification.params).toMatchObject({ progressToken: 'fixture-progress', progress: 1, total: 2 });
      progress.resolve();
    });
    const cancellation = new AbortController();
    const call = client.callTool(
      { name: 'fixture_mail', arguments: {}, _meta: { progressToken: 'fixture-progress' } },
      undefined,
      { signal: cancellation.signal },
    );
    const { callId } = await entered.promise;
    backend.events.emit('kai-mcp:progress', { callId, progress: 1, total: 2 });
    await progress.promise;
    const rejected = expect(call).rejects.toThrow();
    cancellation.abort();
    await rejected;
    await vi.waitFor(() => expect(backend.connection.invoke).toHaveBeenCalledWith('kai-mcp:cancel', callId));
    result.resolve({ content: [{ type: 'text', text: 'cancelled' }], isError: true });
    await vi.waitFor(() => expect(backend.events.listenerCount('kai-mcp:progress')).toBe(0));
  });
  it('waits for backend recovery without retrying the interrupted tool call', async () => {
    await connect();
    const recovered = oauthDeferred<boolean>();
    mocks.recover.mockReturnValue(recovered.promise);
    backend.events.emit('disconnect');
    const listing = client.listTools();
    recovered.resolve(true);
    expect((await listing).tools).toEqual(backend.tools);
    expect(backend.connection.invokeWithTimeout).not.toHaveBeenCalled();
    mocks.recover.mockRejectedValue(new Error('Backend could not recover.'));
    backend.events.emit('disconnect');
    await serving;
    expect(backend.connection.close).toHaveBeenCalledOnce();
    expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
  });
  it('cancels backend recovery when the external MCP client closes', async () => {
    await connect();
    let recoverySignal: AbortSignal | undefined;
    const recoveryStopped = oauthDeferred();
    mocks.recover.mockImplementation((_connection, _fromElectron, signal: AbortSignal) => {
      recoverySignal = signal;
      return new Promise<boolean>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            recoveryStopped.resolve();
            resolve(false);
          },
          { once: true },
        ),
      );
    });
    backend.events.emit('disconnect');
    await client.close();
    await serving;
    await recoveryStopped.promise;
    expect(recoverySignal?.aborted).toBe(true);
    expect(backend.events.eventNames()).toEqual([]);
  });
});
