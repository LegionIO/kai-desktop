import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bridgeFixture } from '../../../test-utils/plugin-bridge.js';
import { installCatalogMcp } from '../../../test-utils/plugin-bridge-files.js';
import { buildCodexMcpServerConfig, CodexMcpBridge } from '../../agent/runtime/codex-mcp-bridge.js';
import { PluginBridgeManager } from '../manager.js';
import type { ToolDefinition } from '../../tools/types.js';

describe('imported MCP catalog and runtime protocol', () => {
  let f: ReturnType<typeof bridgeFixture>;
  let fixture: ReturnType<typeof installCatalogMcp>;
  let manager: PluginBridgeManager;
  let tools: ToolDefinition[];
  let runtime: CodexMcpBridge;
  let client: Client;
  beforeEach(async () => {
    f = bridgeFixture();
    fixture = installCatalogMcp(f.install('codex'));
    tools = [];
    manager = new PluginBridgeManager(
      f.appHome,
      f.store,
      () => f.config,
      () => [],
      (next) => {
        tools = next;
      },
    );
    runtime = new CodexMcpBridge();
    client = new Client({ name: 'fixture-sdk-client', version: '1' });
    f.enableImports();
    await manager.refresh();
    const plugin = manager.inventory()[0];
    await manager.approve(
      plugin.id,
      Object.fromEntries(plugin.components.map((c) => [c.id, c.revision])),
      false,
      plugin.packagePath,
    );
  });
  afterEach(async () => {
    await client.close();
    await runtime.stop();
    await manager.stop();
    f.cleanup();
  });

  it('retains full input/output schemas, metadata and content through the actual runtime adapter', async () => {
    const url = await runtime.start(tools, 'fixture-chat', f.root);
    expect(buildCodexMcpServerConfig(url, tools).required).toBe(true);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${runtime.getAuthToken()}` } },
      }),
    );
    const mail = tools.find((t) => t.originalName === 'read_mail')!;
    const listed = (await client.listTools()).tools.find((t) => t.name === mail.name)!;
    expect(listed.inputSchema).toEqual(fixture.schema);
    expect(listed.outputSchema).toEqual(fixture.descriptor.outputSchema);
    expect(listed.annotations).toEqual({ readOnlyHint: true });
    expect(listed._meta?.fixture).toBe('source metadata');
    expect(await client.callTool({ name: mail.name, arguments: { selector: { folder: 'inbox' } } })).toEqual(
      fixture.result,
    );
    expect(await client.callTool({ name: mail.name, arguments: { selector: 3 } })).toMatchObject({ isError: true });
  });
  it('reconciles announced catalog changes and rejects a tool withdrawn by its source', async () => {
    const removed = tools.find((t) => t.originalName === 'read_mail')!;
    const change = tools.find((t) => t.originalName === 'change_catalog')!;
    const context = { conversationId: 'fixture-chat', cwd: f.root, toolCallId: 'change' };
    await change.execute({ selector: 'inbox' }, context);
    await vi.waitFor(() => expect(tools.map((t) => t.originalName)).toEqual(['read_calendar', 'change_catalog']));
    await expect(removed.execute({ selector: 'inbox' }, context)).rejects.toThrow('no longer available');
    expect(await tools.find((t) => t.originalName === 'read_calendar')!.execute({ selector: 'work' }, context)).toEqual(
      fixture.result,
    );
  });
});
