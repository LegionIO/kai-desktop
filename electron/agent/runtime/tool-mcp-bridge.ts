/**
 * Tool → MCP Bridge (skeleton).
 *
 * Wraps Kai's internal tool definitions as an in-process MCP server so that
 * external SDK runtimes (Claude Agent SDK, Codex SDK) can discover and invoke
 * Kai's custom tools (skills, plugins, CLI tools) through the MCP protocol.
 *
 * Claude Agent SDK natively supports MCP connections via:
 *   mcpServers: { "kai-tools": { type: "sdk", instance: bridgeServer } }
 *
 * Implementation will be fleshed out when the Claude Agent SDK runtime is
 * fully integrated.
 */

import type { ToolDefinition, ToolExecutionContext } from '../../tools/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpToolListEntry = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolCallResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ---------------------------------------------------------------------------
// Bridge implementation
// ---------------------------------------------------------------------------

/**
 * Wraps Kai's custom tools as an in-process MCP-compatible server.
 *
 * External SDKs connect to this bridge to access Kai's skills, plugins,
 * and CLI tools without requiring a real stdio/network MCP server.
 */
export class ToolMcpBridge {
  private tools: Map<string, ToolDefinition>;
  private conversationId: string;
  private cwd?: string;

  constructor(options: {
    tools: ToolDefinition[];
    conversationId: string;
    cwd?: string;
  }) {
    this.tools = new Map(options.tools.map((t) => [t.name, t]));
    this.conversationId = options.conversationId;
    this.cwd = options.cwd;
  }

  /** Returns tool definitions in MCP list_tools format. */
  listTools(): McpToolListEntry[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      // Convert Zod schema to a plain JSON Schema object.
      // For a full implementation, use zod-to-json-schema or the SDK's
      // jsonSchema() helper.  For now, expose a permissive object schema.
      inputSchema: { type: 'object' } as Record<string, unknown>,
    }));
  }

  /** Executes a tool call by name. */
  async callTool(name: string, args: unknown, abortSignal?: AbortSignal): Promise<McpToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Tool "${name}" not found.` }],
        isError: true,
      };
    }

    try {
      const context: ToolExecutionContext = {
        toolCallId: `mcp-bridge-${Date.now()}`,
        conversationId: this.conversationId,
        cwd: this.cwd,
        abortSignal,
      };

      const result = await tool.execute(args, context);
      const text = typeof result === 'string' ? result : JSON.stringify(result);

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  }

  /** Update the set of available tools. */
  updateTools(tools: ToolDefinition[]): void {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  /** Disposes the bridge (no-op for in-process bridge). */
  dispose(): void {
    this.tools.clear();
  }
}
