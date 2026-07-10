import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { z as Z } from 'zod';
import type { ToolDefinition, ToolExecutionContext } from './types.js';
import { buildScopedToolName } from './naming.js';
import type { AppConfig } from '../config/schema.js';

type McpServerConfig = AppConfig['mcpServers'][number];

/** Cap on a single MCP tool call so a hung server can't keep the agent turn
 *  alive forever. The idle timer resets on progress notifications, but the
 *  ABSOLUTE cap does not — a server that streams progress forever is still
 *  bounded so it can never keep the turn (and its tool promise) alive. */
const MCP_CALL_TIMEOUT_MS = 120_000;
const MCP_CALL_MAX_TOTAL_MS = 600_000;

type McpConnection = {
  name: string;
  client: Client;
  transport: Transport;
  tools: ToolDefinition[];
  status: 'connected' | 'error' | 'disconnected';
  error?: string;
  fingerprint: string;
};

const connections = new Map<string, McpConnection>();

/** Convert a JSON Schema object to a Zod schema. Covers common MCP tool patterns. */
function jsonSchemaToZod(schema: Record<string, unknown>): Z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.object({}).passthrough();

  const type = schema.type as string | undefined;

  if (type === 'string') {
    let s = z.string();
    if (typeof schema.minLength === 'number') s = s.min(schema.minLength);
    if (typeof schema.maxLength === 'number') s = s.max(schema.maxLength);
    if (schema.enum && Array.isArray(schema.enum)) return z.enum(schema.enum as [string, ...string[]]);
    return s;
  }
  if (type === 'number' || type === 'integer') {
    let n = z.number();
    if (type === 'integer') n = n.int();
    if (typeof schema.minimum === 'number') n = n.min(schema.minimum);
    if (typeof schema.maximum === 'number') n = n.max(schema.maximum);
    return n;
  }
  if (type === 'boolean') return z.boolean();
  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    let arr = z.array(items ? jsonSchemaToZod(items) : z.unknown());
    if (typeof schema.minItems === 'number') arr = arr.min(schema.minItems);
    if (typeof schema.maxItems === 'number') arr = arr.max(schema.maxItems);
    return arr;
  }
  if (type === 'object' || schema.properties) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema.required as string[]) ?? []);
    const shape: Record<string, Z.ZodTypeAny> = {};
    for (const [key, propSchema] of Object.entries(props)) {
      const field = jsonSchemaToZod(propSchema);
      shape[key] = required.has(key) ? field : field.optional();
    }
    const obj = z.object(shape);
    return schema.additionalProperties === false ? obj : obj.passthrough();
  }

  // Fallback: accept anything but still serialize as type: "object"
  return z.object({}).passthrough();
}

async function createTransport(server: McpServerConfig): Promise<Transport> {
  if (server.command) {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: server.env ? ({ ...process.env, ...server.env } as Record<string, string>) : undefined,
    });
  }

  if (server.url) {
    // Try Streamable HTTP first (MCP 2025+), fall back to SSE
    try {
      const transport = new StreamableHTTPClientTransport(new URL(server.url));
      return transport;
    } catch {
      return new SSEClientTransport(new URL(server.url));
    }
  }

  throw new Error('Server must have either a "url" or "command" configured');
}

export async function connectMcpServer(server: McpServerConfig): Promise<McpConnection> {
  const existing = connections.get(server.name);
  if (existing && existing.status === 'connected') return existing;

  // Hoisted so the catch can tear down a client/transport that connected before
  // a later step (listTools / tool conversion) threw — otherwise a stdio child
  // or network handle leaks while the stored error connection holds null handles.
  let client: Client | null = null;
  let transport: Transport | null = null;

  try {
    transport = await createTransport(server);
    client = new Client({ name: __BRAND_MCP_CLIENT_NAME, version: '1.0.0' });

    await client.connect(transport);

    // Discover tools
    const { tools: mcpTools } = await client.listTools();
    const tools: ToolDefinition[] = mcpTools.map((t) => ({
      name: buildScopedToolName('mcp', server.name, t.name),
      description: `[MCP: ${server.name}] ${t.description ?? t.name}`,
      inputSchema: t.inputSchema ? jsonSchemaToZod(t.inputSchema as Record<string, unknown>) : z.object({}),
      source: 'mcp',
      sourceId: server.name,
      originalName: t.name,
      aliases: [`${server.name}:${t.name}`],
      execute: async (input: unknown, context?: ToolExecutionContext) => {
        // Propagate chat/user cancellation and cap the call so a hung MCP server
        // can't keep the tool promise (and the agent turn) alive forever.
        const result = await client!.callTool(
          { name: t.name, arguments: input as Record<string, unknown> },
          undefined,
          {
            ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
            timeout: MCP_CALL_TIMEOUT_MS,
            resetTimeoutOnProgress: true,
            maxTotalTimeout: MCP_CALL_MAX_TOTAL_MS,
          },
        );
        if (result.isError) throw new Error(JSON.stringify(result.content));
        // Extract text from content array
        const content = result.content as Array<{ type: string; text?: string }>;
        if (content.length === 1 && content[0].type === 'text') return content[0].text;
        return result.content;
      },
    }));

    const connection: McpConnection = {
      name: server.name,
      client,
      transport,
      tools,
      status: 'connected',
      fingerprint: serverFingerprint(server),
    };

    // If the transport closes or errors AFTER a successful connect (server crash,
    // stdio child exit, network drop), mark the connection disconnected so the
    // pool stops reporting it as healthy. The dead tool closures remain until the
    // next config rebuild, but the status reflects reality.
    const markDisconnected = () => {
      const current = connections.get(server.name);
      if (current === connection && current.status === 'connected') {
        current.status = 'disconnected';
      }
    };
    transport.onclose = markDisconnected;
    const priorOnError = transport.onerror?.bind(transport);
    transport.onerror = (err: Error) => {
      priorOnError?.(err);
      markDisconnected();
    };

    connections.set(server.name, connection);
    return connection;
  } catch (error) {
    // Tear down a half-open client/transport before recording the error.
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    try {
      await transport?.close();
    } catch {
      /* ignore */
    }
    const conn: McpConnection = {
      name: server.name,
      client: null as unknown as Client,
      transport: null as unknown as Transport,
      tools: [],
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      fingerprint: serverFingerprint(server),
    };
    connections.set(server.name, conn);
    return conn;
  }
}

export async function connectAllMcpServers(config: AppConfig): Promise<ToolDefinition[]> {
  const allTools: ToolDefinition[] = [];

  for (const server of config.mcpServers) {
    if (server.enabled === false) continue;
    const conn = await connectMcpServer(server);
    allTools.push(...conn.tools);
  }

  return allTools;
}

export async function disconnectMcpServer(name: string): Promise<void> {
  const conn = connections.get(name);
  if (conn?.client) {
    try {
      await conn.client.close();
    } catch {
      /* ignore */
    }
  }
  connections.delete(name);
}

/** Close every MCP connection in the pool. Called from app-quit teardown so
 *  stdio child processes + network handles don't survive as orphans (a child is
 *  NOT killed automatically when its parent Electron process exits). */
export async function disconnectAllMcpServers(): Promise<void> {
  const names = Array.from(connections.keys());
  await Promise.allSettled(names.map((name) => disconnectMcpServer(name)));
}

/** Fingerprint a server config for change detection */
function serverFingerprint(s: McpServerConfig): string {
  return JSON.stringify({
    url: s.url,
    command: s.command,
    args: s.args,
    env: s.env,
    enabled: s.enabled,
  });
}

/**
 * Reconcile MCP connections with the current config.
 * Disconnects removed/changed/disabled servers, connects new/changed ones.
 * Returns the full set of MCP tools after reconciliation.
 *
 * Serialized: rapid config changes can fire overlapping rebuilds; running them
 * concurrently lets two calls spawn the same server, overwrite the map entry,
 * and leak the losing client. Each rebuild waits for the previous to finish so
 * the connection pool is only ever mutated by one reconcile at a time, and the
 * LAST caller's tool set is the one that reflects the final config.
 */
let rebuildChain: Promise<ToolDefinition[]> = Promise.resolve([]);

export function rebuildMcpTools(servers: McpServerConfig[]): Promise<ToolDefinition[]> {
  const run = rebuildChain.catch(() => []).then(() => rebuildMcpToolsInner(servers));
  // Keep the chain alive even if this run rejects, so a failure doesn't wedge
  // all future rebuilds.
  rebuildChain = run.catch(() => []);
  return run;
}

async function rebuildMcpToolsInner(servers: McpServerConfig[]): Promise<ToolDefinition[]> {
  const desired = new Map<string, McpServerConfig>();
  for (const s of servers) {
    if (s.enabled !== false) desired.set(s.name, s);
  }

  // Disconnect servers that were removed, disabled, or changed
  for (const [name, conn] of connections) {
    if (name.startsWith('__test__')) continue;
    const cfg = desired.get(name);
    if (!cfg) {
      await disconnectMcpServer(name);
    } else if (serverFingerprint(cfg) !== conn.fingerprint) {
      await disconnectMcpServer(name);
    }
  }

  // Connect all desired servers (connectMcpServer skips already-connected ones)
  const allTools: ToolDefinition[] = [];
  for (const server of desired.values()) {
    const conn = await connectMcpServer(server);
    allTools.push(...conn.tools);
  }

  return allTools;
}

export function getMcpStatus(): Array<{ name: string; status: string; toolCount: number; error?: string }> {
  return Array.from(connections.values()).map((c) => ({
    name: c.name,
    status: c.status,
    toolCount: c.tools.length,
    error: c.error,
  }));
}
