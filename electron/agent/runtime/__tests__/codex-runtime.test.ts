import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildCodexRuntimeConfig,
  buildCodexThreadOptions,
} from '../codex-runtime.js';
import type { ToolDefinition } from '../../../tools/types.js';

function createTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: overrides.name ?? 'plugin__aithena__memory_stats',
    originalName: overrides.originalName ?? 'memory_stats',
    description: overrides.description ?? 'Get Aithena memory statistics.',
    source: overrides.source ?? 'plugin',
    sourceId: overrides.sourceId ?? 'aithena',
    inputSchema: overrides.inputSchema ?? z.object({}),
    execute: overrides.execute ?? (async () => ({ ok: true })),
    ...overrides,
  };
}

describe('CodexRuntime MCP config', () => {
  it('enables localhost network access when the MCP bridge is configured', () => {
    const config = buildCodexRuntimeConfig('http://127.0.0.1:12345/mcp', [createTool()]);

    expect(config).toMatchObject({
      sandbox_workspace_write: {
        network_access: true,
      },
      mcp_servers: {
        kai: {
          url: 'http://127.0.0.1:12345/mcp',
          enabled_tools: ['aithena_memory_stats'],
        },
      },
    });
  });

  it('passes networkAccessEnabled through thread options only for bridged turns', () => {
    expect(buildCodexThreadOptions({
      cwd: '/tmp/project',
      modelEffort: 'high',
      approvalPolicy: 'on-request',
      enableMcpBridgeNetwork: true,
    })).toMatchObject({
      workingDirectory: '/tmp/project',
      modelReasoningEffort: 'high',
      approvalPolicy: 'on-request',
      skipGitRepoCheck: true,
      networkAccessEnabled: true,
    });

    expect(buildCodexThreadOptions({
      cwd: '/tmp/project',
      modelEffort: 'high',
      approvalPolicy: 'on-request',
      enableMcpBridgeNetwork: false,
    })).not.toHaveProperty('networkAccessEnabled');
  });
});
