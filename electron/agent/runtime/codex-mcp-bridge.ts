/**
 * Codex MCP Bridge — local HTTP MCP server that exposes Kai's custom tools
 * to the Codex CLI subprocess.
 *
 * The Codex SDK spawns a CLI process that only connects to MCP servers
 * configured in its own config. This bridge starts an in-process Streamable
 * HTTP MCP server on localhost, registers all of Kai's tools (plugins, skills,
 * etc.), and provides the URL for the Codex CLI to connect to via the
 * `config.mcp_servers` option.
 *
 * Lifecycle:
 *   1. `start(tools, conversationId, cwd)` — spins up the server, returns URL
 *   2. Codex CLI connects, discovers tools, invokes them during the turn
 *   3. `stop()` — shuts everything down after the turn completes
 */

import { createServer, type Server as HttpServer } from 'http';
import { randomUUID } from 'crypto';
import type { ToolDefinition, ToolExecutionContext } from '../../tools/types.js';
import { MAX_TOOL_NAME_LENGTH, makeSafeToolName } from '../../tools/naming.js';

// ---------------------------------------------------------------------------
// Types (dynamic imports — avoid hard compile-time dependency on MCP SDK)
// ---------------------------------------------------------------------------

type McpServerInstance = {
  resource(
    name: string,
    uri: string,
    metadata: Record<string, unknown>,
    handler: (uri: URL) => Promise<{
      contents: Array<{ uri: string; mimeType?: string; text: string }>;
    }>,
  ): unknown;
  tool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>,
  ): unknown;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
};

type TransportInstance = {
  handleRequest(req: unknown, res: unknown, body?: unknown): Promise<void>;
  close(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Schema conversion
// ---------------------------------------------------------------------------

export type CodexMcpToolEntry = {
  name: string;
  tool: ToolDefinition;
};

export function getCodexMcpToolEntries(tools: ToolDefinition[]): CodexMcpToolEntry[] {
  const entries: CodexMcpToolEntry[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    // Prefer originalName (e.g. "rally_list_user_story_tasks") over the scoped
    // name (e.g. "plugin__rally__rally_list_user_story_tasks") for model use.
    const preferredName = makeCodexMcpToolName(tool.originalName ?? tool.name);
    const fallbackName = makeCodexMcpToolName(tool.name);
    const name = seen.has(preferredName) ? makeUniqueToolName(fallbackName, seen) : preferredName;
    seen.add(name);
    entries.push({ name, tool });
  }

  return entries;
}

function makeCodexMcpToolName(name: string): string {
  return makeSafeToolName(name).slice(0, MAX_TOOL_NAME_LENGTH);
}

function makeUniqueToolName(baseName: string, seen: Set<string>): string {
  if (!seen.has(baseName)) return baseName;

  let counter = 2;
  while (true) {
    const suffix = `_${counter}`;
    const candidate = `${baseName.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!seen.has(candidate)) return candidate;
    counter++;
  }
}

export function buildCodexMcpPrompt(prompt: string, tools: ToolDefinition[]): string {
  if (tools.length === 0) return prompt;

  const toolLines = getCodexMcpToolEntries(tools)
    .map(({ name, tool }) => `- mcp__kai__${name}: ${tool.description ?? ''}`.slice(0, 280))
    .join('\n');

  return [
    'Kai has exposed plugin, skill, and MCP tools as Codex-callable MCP tools for this turn.',
    'When a user asks for an installed plugin such as Rally, call the matching tool name below.',
    'Do not call bare mcp__kai__; that is only the server prefix and is not a tool.',
    'Do not use list_mcp_resources or list_mcp_resource_templates to discover Kai plugin tools; these are tools, not resources.',
    'If a listed tool is not immediately callable, use tool_search for the exact mcp__kai__ tool name, then call the returned tool.',
    '',
    'Available Kai MCP callable tool names:',
    toolLines,
    '',
    'User request:',
    prompt,
  ].join('\n');
}

export function buildCodexMcpServerConfig(
  url: string,
  tools: ToolDefinition[],
  authToken?: string | null,
  authTokenEnvVar?: string | null,
): Record<string, unknown> {
  return {
    url,
    // Codex CLI's streamable-HTTP MCP transport reads the bearer token from
    // an env var named here, NOT from an http_headers map. The runtime sets
    // process.env[<authTokenEnvVar>] before spawning the CLI. The env var
    // name is unique per bridge instance so concurrent Codex runs do not
    // clobber each other's tokens.
    ...(authToken && authTokenEnvVar ? { bearer_token_env_var: authTokenEnvVar } : {}),
    enabled_tools: getCodexMcpToolEntries(tools).map(({ name }) => name),
  };
}

/**
 * Extract the raw Zod shape from a z.object() schema.
 *
 * The McpServer.tool() method accepts a `ZodRawShapeCompat` (Record<string, ZodType>),
 * which is the `.shape` of a z.object(). For non-object schemas, we return an empty
 * shape and rely on JSON Schema fallback.
 */
function extractZodShape(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== 'object') return null;

  // Zod v4: shape is on _zod.def.shape
  const v4 = schema as { _zod?: { def?: { shape?: unknown } } };
  if (v4._zod?.def?.shape) {
    const shape = v4._zod.def.shape;
    if (typeof shape === 'function') return shape() as Record<string, unknown>;
    if (typeof shape === 'object') return shape as Record<string, unknown>;
  }

  // Zod v3: shape is directly on the schema
  const v3 = schema as { shape?: unknown };
  if (v3.shape) {
    if (typeof v3.shape === 'function') return v3.shape() as Record<string, unknown>;
    if (typeof v3.shape === 'object') return v3.shape as Record<string, unknown>;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Bridge implementation
// ---------------------------------------------------------------------------

/** True if a tool result is error-shaped (so we can set the MCP isError flag). */
function isErrorResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as { isError?: unknown; error?: unknown };
  return r.isError === true || (typeof r.error === 'string' && r.error.length > 0);
}

/** Short human-readable description of a Zod safeParse error for the MCP client. */
function describeZodError(error: unknown): string {
  if (error && typeof error === 'object') {
    const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues
        .slice(0, 5)
        .map((i) => `${Array.isArray(i.path) && i.path.length ? i.path.join('.') + ': ' : ''}${i.message ?? 'invalid'}`)
        .join('; ');
    }
  }
  return 'arguments did not match the expected schema';
}

export class CodexMcpBridge {
  private httpServer: HttpServer | null = null;
  private mcpServer: McpServerInstance | null = null;
  private transport: TransportInstance | null = null;
  private port: number | null = null;
  private authToken: string | null = null;
  private authTokenEnvVar: string | null = null;
  /** In-flight start() promise — serializes concurrent starts so two callers
   *  can't both pass the already-running guard and leak a server. */
  private startPromise: Promise<string> | null = null;

  /**
   * Start the local MCP bridge server.
   *
   * @param tools - Kai custom tools to expose via MCP
   * @param conversationId - Current conversation ID for tool execution context
   * @param cwd - Working directory for tool execution
   * @returns The URL the Codex CLI should connect to (e.g. "http://127.0.0.1:54321/mcp")
   */
  async start(
    tools: ToolDefinition[],
    conversationId: string,
    cwd?: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    // Serialize concurrent start() calls: a second caller awaits the first's
    // in-flight promise instead of racing past the already-running guard (which
    // would overwrite state + leak the first server).
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      // Guard against a double-start leaking the previous server/port/token.
      if (this.httpServer || this.mcpServer || this.transport) {
        await this.stop();
      }
      try {
        return await this.startInternal(tools, conversationId, cwd, abortSignal);
      } catch (err) {
        // Partial start (e.g. listen() succeeded but connect() threw) would leave
        // a live HTTP server + stale state; tear everything down before rethrowing.
        await this.stop();
        throw err;
      }
    })();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(
    tools: ToolDefinition[],
    conversationId: string,
    cwd?: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    // Dynamic imports to avoid hard dependency if SDK is not installed
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

    // 1. Create MCP server with instructions for the model
    const toolEntries = getCodexMcpToolEntries(tools);
    const toolCatalog = JSON.stringify(
      {
        tools: toolEntries.map(({ name, tool }) => ({
          name,
          description: tool.description ?? '',
          source: tool.source,
          sourceId: tool.sourceId,
          internalName: tool.name,
          originalName: tool.originalName,
        })),
      },
      null,
      2,
    );
    const toolSummary = toolEntries.map(({ name, tool }) => `- ${name}: ${tool.description ?? ''}`).join('\n');
    this.mcpServer = new McpServer(
      { name: 'kai', version: '1.0.0' },
      {
        capabilities: { resources: {}, tools: {} },
        instructions: [
          'This MCP server provides Kai plugin and skill tools.',
          'These tools are ready to use; call them directly by name.',
          'Do NOT use list_mcp_resources to discover them; they are tools, not resources.',
          '',
          'Available tools:',
          toolSummary,
        ].join('\n'),
      },
    ) as unknown as McpServerInstance;

    this.mcpServer.resource(
      'kai_tool_catalog',
      'kai://tools',
      {
        title: 'Kai Tool Catalog',
        description: 'JSON catalog of Kai plugin, skill, and MCP tools bridged for this turn.',
        mimeType: 'application/json',
      },
      async (uri: URL) => ({
        contents: [{ uri: uri.href, mimeType: 'application/json', text: toolCatalog }],
      }),
    );

    // 2. Register each Kai tool
    //    Use originalName when available for cleaner tool names in the Codex CLI.
    //    Map from MCP-facing name back to the internal tool for handler dispatch.
    for (const { name: finalName, tool } of toolEntries) {
      const zodShape = extractZodShape(tool.inputSchema);

      // Build the handler
      const boundTool = tool;
      const handler = async (args: Record<string, unknown>) => {
        const context: ToolExecutionContext = {
          toolCallId: `codex-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conversationId,
          cwd,
          abortSignal,
        };

        try {
          // Validate against the tool's Zod schema. These tools run with full
          // local privileges, so if the schema EXISTS and rejects, fail the call
          // instead of passing unvalidated input through. Tools without a
          // safeParse-capable schema can't be validated here — pass args as-is.
          let validatedArgs: unknown = args;
          const safeParse = (
            boundTool.inputSchema as {
              safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: unknown };
            }
          ).safeParse;
          if (typeof safeParse === 'function') {
            const parseResult = safeParse.call(boundTool.inputSchema, args);
            if (!parseResult.success) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Invalid arguments for tool "${finalName}": ${describeZodError(parseResult.error)}`,
                  },
                ],
                isError: true,
              };
            }
            validatedArgs = parseResult.data;
          }

          const result = await boundTool.execute(validatedArgs, context);
          const text = typeof result === 'string' ? result : JSON.stringify(result);
          // A tool that returns an error-shaped result (isError / error field)
          // must surface as an MCP error, not a successful call — otherwise Codex
          // treats a failed tool as success.
          return { content: [{ type: 'text' as const, text }], ...(isErrorResult(result) ? { isError: true } : {}) };
        } catch (error) {
          return {
            content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          };
        }
      };

      // Register with McpServer — use shape if available, otherwise pass empty shape
      if (zodShape) {
        (this.mcpServer as unknown as McpServerInstance).tool(finalName, tool.description ?? '', zodShape, handler);
      } else {
        (this.mcpServer as unknown as McpServerInstance).tool(finalName, tool.description ?? '', {}, handler);
      }
    }

    // 3. Create transport (stateful mode — required for multi-request MCP sessions)
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    }) as unknown as TransportInstance;

    // Per-bridge bearer token — only the spawned Codex CLI is given this value,
    // so other local processes cannot drive Kai's tools via this loopback port.
    this.authToken = randomUUID();
    // Unique env-var name per bridge instance so concurrent Codex runs each
    // read their own token instead of racing on a shared process.env key.
    this.authTokenEnvVar = 'KAI_MCP_BRIDGE_TOKEN_' + randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();

    // 4. Create HTTP server
    await new Promise<void>((resolve, reject) => {
      this.httpServer = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1`);
        console.info(`[codex-mcp-bridge] ${req.method} ${url.pathname}`);
        if (url.pathname === '/mcp') {
          if (req.headers.authorization !== `Bearer ${this.authToken}`) {
            res.writeHead(401);
            res.end('Unauthorized');
            return;
          }
          try {
            await this.transport!.handleRequest(req, res);
          } catch (err) {
            if (!res.headersSent) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: 'Internal server error' }));
            }
            console.warn('[codex-mcp-bridge] Request handling error:', err);
          }
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      this.httpServer.on('error', reject);
      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve();
      });
    });

    // 5. Connect MCP server to transport
    await this.mcpServer.connect(this.transport as unknown);

    const url = `http://127.0.0.1:${this.port}/mcp`;
    console.info(`[codex-mcp-bridge] Started on ${url} with ${tools.length} tool(s)`);
    return url;
  }

  /**
   * Stop the MCP bridge server and release all resources.
   */
  async stop(): Promise<void> {
    try {
      if (this.mcpServer) {
        await this.mcpServer.close();
        this.mcpServer = null;
      }
    } catch {
      // Ignore close errors
    }

    try {
      if (this.transport) {
        await this.transport.close();
        this.transport = null;
      }
    } catch {
      // Ignore close errors
    }

    try {
      if (this.httpServer) {
        await new Promise<void>((resolve) => {
          this.httpServer!.close(() => resolve());
        });
        this.httpServer = null;
      }
    } catch {
      // Ignore close errors
    }

    this.port = null;
    this.authToken = null;
    this.authTokenEnvVar = null;
    console.info('[codex-mcp-bridge] Stopped');
  }

  /** Whether the bridge is currently running. */
  get isRunning(): boolean {
    return this.httpServer !== null && this.port !== null;
  }

  /** Bearer token required in the Authorization header, or null if not running. */
  getAuthToken(): string | null {
    return this.authToken;
  }

  /** Per-instance env var name the Codex CLI reads the bearer token from, or null if not running. */
  getAuthTokenEnvVar(): string | null {
    return this.authTokenEnvVar;
  }

  /** The port the bridge is listening on, or null if not running. */
  get serverPort(): number | null {
    return this.port;
  }
}
