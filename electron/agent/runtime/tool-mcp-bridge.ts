/**
 * Tool → MCP Bridge (DEPRECATED).
 *
 * This module is superseded by the direct `createSdkMcpServer()` integration
 * in `claude-agent-runtime.ts`. The SDK's native `tool()` helper now handles
 * schema conversion and handler registration inline — no separate bridge class
 * is needed.
 *
 * Kept for backward compatibility with tests and any code that references it.
 * New code should use `createSdkMcpServer()` + SDK `tool()` directly.
 *
 * @deprecated Use createSdkMcpServer() from @anthropic-ai/claude-agent-sdk instead.
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
// Schema conversion cache
// ---------------------------------------------------------------------------

/**
 * Cache for converted JSON Schemas keyed by tool name.
 * Avoids re-converting on every listTools() call.
 */
const schemaCache = new WeakMap<object, Record<string, unknown>>();

/**
 * Convert a Zod schema to a plain JSON Schema object.
 *
 * Uses Zod 4's native `toJSONSchema()` method.  Falls back to a permissive
 * `{ type: 'object' }` if conversion fails (e.g. for very exotic schemas).
 */
function zodToJsonSchemaObject(zodSchema: unknown): Record<string, unknown> {
  if (!zodSchema || typeof zodSchema !== 'object') {
    return { type: 'object' };
  }

  // Check cache first
  const cached = schemaCache.get(zodSchema);
  if (cached) return cached;

  try {
    // Zod 4 exposes .toJSONSchema() natively
    const toJsonSchema = (zodSchema as { toJSONSchema?: () => Record<string, unknown> }).toJSONSchema;
    if (typeof toJsonSchema === 'function') {
      const jsonSchema = toJsonSchema.call(zodSchema);
      // Strip $schema metadata — MCP consumers don't need it
      const { $schema: _schema, ...rest } = jsonSchema;
      const result = rest as Record<string, unknown>;
      schemaCache.set(zodSchema, result);
      return result;
    }
  } catch {
    // Fall through to permissive fallback
  }

  // Fallback for non-Zod or incompatible schemas
  const fallback: Record<string, unknown> = { type: 'object' };
  schemaCache.set(zodSchema, fallback);
  return fallback;
}

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

  /** Returns tool definitions in MCP list_tools format with real JSON Schemas. */
  listTools(): McpToolListEntry[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: zodToJsonSchemaObject(tool.inputSchema),
    }));
  }

  /** Look up a single tool definition by name. */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
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
      // Validate args against Zod schema before execution
      let validatedArgs = args;
      try {
        const parseResult = tool.inputSchema.safeParse(args);
        if (parseResult.success) {
          validatedArgs = parseResult.data;
        }
        // If validation fails we still pass args through — the tool's own
        // execute() may handle partial/relaxed input gracefully.
      } catch {
        // Ignore validation errors for exotic schemas
      }

      const context: ToolExecutionContext = {
        toolCallId: `mcp-bridge-${Date.now()}`,
        conversationId: this.conversationId,
        cwd: this.cwd,
        abortSignal,
      };

      const result = await tool.execute(validatedArgs, context);
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

  /** Returns the number of registered tools. */
  get size(): number {
    return this.tools.size;
  }

  /** Returns true if a tool with the given name is registered. */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /** Update the set of available tools. */
  updateTools(tools: ToolDefinition[]): void {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  /** Disposes the bridge. */
  dispose(): void {
    this.tools.clear();
  }
}
