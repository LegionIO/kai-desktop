import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { bridgeFixture } from '../../../test-utils/plugin-bridge.js';
import { oauthDeferred } from '../../../test-utils/mcp-oauth.js';
import { KaiMcpService, exportSourceId, exportToolId } from '../service.js';
import type { ToolDefinition, ToolExecutionContext } from '../../tools/types.js';
import { hookDispatcher } from '../../agent/hooks/dispatcher.js';

describe('Kai MCP sharing authority and protocol', () => {
  let f: ReturnType<typeof bridgeFixture>, service: KaiMcpService, tools: ToolDefinition[], sourceOn: boolean;
  const source = 'kai-plugin-msgraph';
  beforeEach(() => {
    f = bridgeFixture();
    sourceOn = true;
    tools = [
      {
        name: 'plugin__msgraph__list_mail',
        originalName: 'list_mail',
        source: 'plugin',
        sourceId: source,
        description: 'List fixture mail',
        inputSchema: z.object({ folder: z.string().default('inbox') }),
        execute: vi.fn(async () => ({ mail: [] })),
      },
    ];
    service = new KaiMcpService(
      f.store,
      () => f.config,
      () => tools,
      () => sourceOn,
      (p) => f.credentials.active(p),
    );
    f.credentials.onRevoked = () => service.changed();
  });
  afterEach(async () => {
    await service.stop();
    f.cleanup();
  });
  function ready() {
    f.enableSharing();
    service.select([exportSourceId(tools[0])], []);
    return f.localClient().principal;
  }
  it('lists and invokes only after sharing, source and export consent', async () => {
    const p = f.localClient().principal;
    expect(() => service.list(p)).toThrow('disabled');
    f.enableSharing();
    expect(service.list(p)).toEqual([]);
    await expect(service.call(p, tools[0].name, {}, { sessionId: 'one' })).rejects.toThrow('not exported');
    service.select([], [exportToolId(tools[0])]);
    expect(service.list(p)).toHaveLength(1);
    const result = await service.call(p, tools[0].name, {}, { sessionId: 'one' });
    expect(result.structuredContent).toEqual({ mail: [] });
    expect(tools[0].execute).toHaveBeenCalledWith(
      { folder: 'inbox' },
      expect.objectContaining({
        connectorClientId: p.clientId,
        isHeadless: true,
        bridgeSessionId: `connector:${p.clientId}:one`,
      }),
    );
    const ctx = vi.mocked(tools[0].execute).mock.calls[0][1];
    expect(ctx.conversationId).toBeUndefined();
    sourceOn = false;
    expect(service.list(p)).toEqual([]);
    await expect(service.call(p, tools[0].name, {}, { sessionId: 'one' })).rejects.toThrow('not exported');
  });
  it('preserves registered plugin schemas and full MCP content without plugin changes', async () => {
    tools[0].jsonInputSchema = {
      type: 'object',
      properties: { folder: { type: 'string', default: 'inbox' } },
      additionalProperties: false,
    };
    tools[0].jsonOutputSchema = { type: 'object', properties: { count: { type: 'number' } } };
    const result = {
      content: [
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'resource_link', uri: 'fixture://mail/1', name: 'Mail' },
      ],
      structuredContent: { count: 1 },
      isError: false,
    };
    tools[0].execute = async () => result;
    const p = ready();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fixture', version: '1' });
    await service.connect(p, serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools[0].inputSchema).toEqual(tools[0].jsonInputSchema);
    expect(listed.tools[0].outputSchema).toEqual(tools[0].jsonOutputSchema);
    expect(await client.callTool({ name: tools[0].name, arguments: {} })).toEqual(result);
    const changed = oauthDeferred();
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed.resolve();
    });
    service.select([], []);
    await changed.promise;
    expect((await client.listTools()).tools).toEqual([]);
    await client.close();
  });
  it('settles cancelled calls even if a plugin ignores AbortSignal, scoped to the originating connection', async () => {
    const entered = oauthDeferred(),
      pending = oauthDeferred<unknown>();
    tools[0].execute = async () => {
      entered.resolve();
      return pending.promise;
    };
    const p = ready();
    const call = service.call(p, tools[0].name, {}, { sessionId: 'one', callId: 'owned-call' });
    await entered.promise;
    service.cancel(p, 'other-session', 'owned-call');
    expect(
      (service as unknown as { calls: Map<string, { controller: AbortController }> }).calls.get('owned-call')
        ?.controller.signal.aborted,
    ).toBe(false);
    service.cancel(p, 'one', 'owned-call');
    expect(await call).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Kai MCP call cancelled.' }] });
    pending.resolve({ late: true });
  });
  it('revokes outstanding calls and rechecks selection after an awaited policy hook', async () => {
    const entered = oauthDeferred(),
      release = oauthDeferred();
    const off = hookDispatcher.register(
      'PreToolUse',
      async () => {
        entered.resolve();
        await release.promise;
      },
      { mode: 'modify', source: 'plugin' },
    );
    try {
      const p = ready();
      const call = service.call(p, tools[0].name, {}, { sessionId: 'one' });
      await entered.promise;
      service.select([], []);
      release.resolve();
      expect(await call).toMatchObject({ isError: true });
      expect(tools[0].execute).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });
  it('preserves native denial and error status', async () => {
    const off = hookDispatcher.register('PreToolUse', () => ({ decision: 'deny', reason: 'Native policy denial' }), {
      mode: 'block',
      source: 'plugin',
    });
    try {
      const p = ready();
      expect(await service.call(p, tools[0].name, {}, { sessionId: 'one' })).toMatchObject({ isError: true });
      expect(tools[0].execute).not.toHaveBeenCalled();
    } finally {
      off();
    }
    tools[0].execute = async () => {
      throw new Error('Plugin needs sign-in.');
    };
    expect(await service.call(f.localClient().principal, tools[0].name, {}, { sessionId: 'one' })).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Plugin needs sign-in.' }],
    });
  });
  it('excludes administration, credentials, delegation and unsupported UI capabilities', () => {
    tools = [
      ...['peer_credential', 'sub_agent', 'config_manage', 'set_client_secret', 'login'].map((name) => ({
        ...tools[0],
        name,
        originalName: name,
      })),
      { ...tools[0], name: 'read_ui', originalName: 'read_ui', mcpExportUnavailableReason: 'Needs a visible chat.' },
    ];
    const p = ready();
    expect(service.list(p)).toEqual([]);
    expect(service.inventory()[0].tools.every((t) => !t.available)).toBe(true);
  });
  it('applies plan mode and rejects known forwarding cycles', async () => {
    const p = ready();
    await expect(
      service.call(p, tools[0].name, {}, { sessionId: 'one', origin: [f.store.get().instanceId] }),
    ).rejects.toThrow('cycle');
    f.config.tools.executionMode = 'plan-first';
    expect(service.list(p)).toEqual([]);
  });
  it('retains unavailable selections and does not crash on an unrepresentable schema', () => {
    ready();
    service.select([], [exportToolId(tools[0])]);
    const id = exportToolId(tools[0]);
    tools = [];
    expect(service.inventory()[0].tools[0]).toMatchObject({ id, selected: true, available: false });
    service.select([], [id]);
    tools = [
      {
        name: 'bad_schema',
        source: 'plugin',
        sourceId: source,
        inputSchema: z.object({ bad: z.custom() }),
        description: 'schema fixture',
        execute: async () => ({}),
      },
    ];
    service.select([exportSourceId(tools[0])], []);
    expect(() => service.changed()).not.toThrow();
  });
  it('forwards progress and independently revokes clients', async () => {
    const progress = vi.fn();
    tools[0].execute = async (_input, ctx: ToolExecutionContext) => {
      ctx.onProgress?.({
        stream: 'stdout',
        delta: 'one',
        output: 'one',
        bytesSeen: 0,
        progress: 1,
        total: 2,
        truncated: false,
        stopped: false,
      });
      return { done: true };
    };
    const a = ready(),
      b = f.localClient('second').principal;
    await service.call(a, tools[0].name, {}, { sessionId: 'one', onProgress: progress });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ progress: 1, total: 2 }));
    f.credentials.revoke(a.clientId);
    expect(() => service.list(a)).toThrow('revoked');
    expect(service.list(b)).toHaveLength(1);
  });
});
