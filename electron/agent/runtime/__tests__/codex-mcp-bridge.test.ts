import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import {
  buildCodexMcpPrompt,
  buildCodexMcpServerConfig,
  CodexMcpBridge,
  getCodexMcpToolEntries,
} from '../codex-mcp-bridge.js';
import type { ToolDefinition } from '../../../tools/types.js';
import { RUNTIME_BRIDGE_SKIP_TOOLS } from '../types.js';

function createTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: overrides.name ?? 'plugin__rally__rally_list_user_story_tasks',
    originalName: overrides.originalName ?? 'rally_list_user_story_tasks',
    description: overrides.description ?? 'Get tasks under a Rally user story.',
    source: overrides.source ?? 'plugin',
    sourceId: overrides.sourceId ?? 'rally',
    inputSchema:
      overrides.inputSchema ??
      z.object({
        formattedId: z.string().describe('User story FormattedID'),
      }),
    execute: overrides.execute ?? (async (input) => ({ ok: true, input })),
    ...overrides,
  };
}

describe('codex bridge tool inclusion (all sources, not just plugin/skill/mcp)', () => {
  it('bridges builtin + cli tools too, so codex can reach web_search/web_fetch/memory', () => {
    const tools: ToolDefinition[] = [
      createTool({ name: 'web_search', originalName: 'web_search', source: 'builtin', sourceId: undefined }),
      createTool({ name: 'web_fetch', originalName: 'web_fetch', source: 'builtin', sourceId: undefined }),
      createTool({ name: 'memory', originalName: 'memory', source: 'builtin', sourceId: undefined }),
      createTool({ name: 'my_cli_tool', originalName: 'my_cli_tool', source: 'cli', sourceId: undefined }),
      createTool(), // the plugin default
    ];
    const entries = getCodexMcpToolEntries(tools);
    const names = entries.map((e) => e.name);
    // The old filter (source==='plugin'||'skill'||'mcp') would have dropped the
    // first four. getCodexMcpToolEntries itself is source-agnostic; the runtime
    // now feeds it every non-skipped tool, so all survive.
    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
    expect(names).toContain('memory');
    expect(names).toContain('my_cli_tool');
    expect(entries).toHaveLength(5);
  });
});

describe('RUNTIME_BRIDGE_SKIP_TOOLS', () => {
  it('excludes sub_agent (SDK has its own) and nothing else by default', () => {
    expect(RUNTIME_BRIDGE_SKIP_TOOLS.has('sub_agent')).toBe(true);
    expect(RUNTIME_BRIDGE_SKIP_TOOLS.has('web_search')).toBe(false);
    expect(RUNTIME_BRIDGE_SKIP_TOOLS.has('memory')).toBe(false);
  });
});

describe('CodexMcpBridge', () => {
  let bridge: CodexMcpBridge | null = null;

  afterEach(async () => {
    await bridge?.stop();
    bridge = null;
  });

  it('exposes Kai plugin tools through streamable HTTP MCP', async () => {
    let receivedAbortSignal: AbortSignal | undefined;
    const abortController = new AbortController();
    bridge = new CodexMcpBridge();
    const url = await bridge.start(
      [
        createTool({
          execute: async (_input, context) => {
            receivedAbortSignal = context.abortSignal;
            return { ok: true, input: _input };
          },
        }),
      ],
      'test-conversation',
      '/tmp',
      abortController.signal,
    );
    const client = new Client({ name: 'kai-test-client', version: '1.0.0' });
    const authToken = bridge.getAuthToken();
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${authToken}` } },
    });

    try {
      await client.connect(transport);

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain('kai://tools');

      const catalog = await client.readResource({ uri: 'kai://tools' });
      expect(catalog.contents[0]).toMatchObject({
        mimeType: 'application/json',
        uri: 'kai://tools',
      });
      expect('text' in catalog.contents[0] && catalog.contents[0].text.includes('rally_list_user_story_tasks')).toBe(
        true,
      );

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain('rally_list_user_story_tasks');

      const result = await client.callTool({
        name: 'rally_list_user_story_tasks',
        arguments: { formattedId: 'US12345' },
      });

      expect(result.content).toEqual([
        {
          type: 'text',
          text: JSON.stringify({ ok: true, input: { formattedId: 'US12345' } }),
        },
      ]);
      expect(receivedAbortSignal).toBe(abortController.signal);
    } finally {
      await client.close();
    }
  });

  it('adds explicit Kai MCP tool guidance to the Codex prompt', () => {
    const prompt = buildCodexMcpPrompt('Can you read my Rally stories?', [createTool()]);

    expect(prompt).toContain('mcp__kai__rally_list_user_story_tasks');
    expect(prompt).toContain('Do not call bare mcp__kai__');
    expect(prompt).toContain('Do not use list_mcp_resources');
    expect(prompt).toContain('use tool_search');
    expect(prompt).toContain('Can you read my Rally stories?');
  });

  it('builds Codex MCP config with explicit enabled tools', () => {
    const config = buildCodexMcpServerConfig('http://127.0.0.1:12345/mcp', [
      createTool(),
      createTool({
        name: 'plugin__rally__rally_get_feature_details',
        originalName: 'rally_get_feature_details',
      }),
    ]);

    expect(config).toEqual({
      url: 'http://127.0.0.1:12345/mcp',
      enabled_tools: ['rally_list_user_story_tasks', 'rally_get_feature_details'],
    });
  });

  it('sanitizes and de-duplicates MCP-facing tool names', () => {
    const entries = getCodexMcpToolEntries([
      createTool({
        name: 'plugin__unsafe__first',
        originalName: 'unsafe tool name',
      }),
      createTool({
        name: 'plugin__unsafe__second',
        originalName: 'unsafe tool name',
      }),
      createTool({
        name: 'plugin__unsafe__long',
        originalName: 'x'.repeat(80),
      }),
    ]);

    const names = entries.map((entry) => entry.name);
    // First two: sanitized (invalid→_) + deduped by the bridge as before.
    expect(names[0]).toBe('unsafe_tool_name');
    expect(names[1]).toBe('plugin__unsafe__second');
    // Third: a charset-valid but 80-char name is now length-capped WITH a
    // deterministic hash suffix (not bare-truncated to 54 x's — that would let
    // two distinct long names sharing a 54-prefix collide). Fits the limit.
    expect(names[2]).toMatch(/^x+_[0-9a-f]{6}$/);
    expect(names[2].length).toBe(54);
    expect(entries.every((entry) => /^[a-zA-Z0-9_-]+$/.test(entry.name))).toBe(true);
    expect(entries.every((entry) => entry.name.length <= 54)).toBe(true);
  });
});
