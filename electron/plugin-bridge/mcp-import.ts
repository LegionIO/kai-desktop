import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { OwnedStdioTransport } from './stdio-transport.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema, type Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolExecutionContext } from '../tools/types.js';
import type { ComponentPlan, PluginPlan } from './types.js';
import { hash, object } from './files.js';

/** Clanks declares hook delivery with --hooks. If its hooks were not approved,
 * use the same installed MCP program's polling mode; never claim idle delivery. */
export function importedMcpArgs(plan: PluginPlan, component: ComponentPlan, lifecycleHooks = true): string[] {
  const config = component.mcp!;
  const mcpIndex = config.args.indexOf('mcp');
  // Installed Clanks packages also use `node /path/to/clanks.mjs mcp`.
  // Match the executable/script, never a display name or an arbitrary argument.
  const executable = basename(config.command ?? '').replace(/\.exe$/i, '');
  const clanks =
    mcpIndex >= 0 &&
    (executable === 'clanks' ||
      (['node', 'nodejs', 'bun'].includes(executable) &&
        config.args.slice(0, mcpIndex).some((arg) => /^clanks\.(?:mjs|cjs|js)$/.test(basename(arg)))));
  // Claude packages do not declare Interrupt. Require it only when supplied by
  // the package (for example Codex), so approved Claude hooks stay operational.
  const requiredEvents = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'];
  if (plan.components.some((c) => c.hooks?.event === 'Interrupt')) requiredEvents.push('Interrupt');
  const hasHooks = requiredEvents.every((event) =>
    plan.components.some((c) => c.hooks?.event === event && c.public.status === 'approved'),
  );
  return clanks && (!hasHooks || !lifecycleHooks) ? config.args.filter((arg) => arg !== '--hooks') : config.args;
}
export function mcpExecutionRevision(plan: PluginPlan, component: ComponentPlan): string {
  return component.mcp
    ? hash([component.public.revision, importedMcpArgs(plan, component)])
    : component.public.revision;
}

export type ImportedConnection = {
  client: Client;
  transport: Transport;
  tools: McpTool[];
  controller: AbortController;
  componentId: string;
  pluginId: string;
  activeCalls: number;
  retired: boolean;
  sessionId: string;
  revision: string;
  clanks: boolean;
  instructions?: string;
};
export class ImportedMcpPool {
  private readonly clanksHandles = new Map<string, Map<string, string>>();
  private readonly connections = new Map<
    string,
    {
      pending: Promise<ImportedConnection>;
      controller: AbortController;
      componentId: string;
      revision: string;
      sessionId: string;
      connection?: ImportedConnection;
    }
  >();
  onCatalogChanged: () => void = () => {};
  constructor(private readonly instanceId: string) {}

  observeHookContext(pluginId: string, sessionId: string, context: string): void {
    const handle = /^Clanks: this session's local handle is ([A-Za-z0-9_-]{1,200})\./.exec(context)?.[1];
    if (handle && context.includes(`native_session_id=${JSON.stringify(sessionId)}.`))
      this.bindHandle(pluginId, sessionId, handle);
  }
  private bindHandle(pluginId: string, sessionId: string, handle: string): void {
    let sessions = this.clanksHandles.get(pluginId);
    if (!sessions) {
      sessions = new Map();
      this.clanksHandles.set(pluginId, sessions);
    }
    sessions.set(sessionId, handle);
  }

  async connect(
    plan: PluginPlan,
    component: ComponentPlan,
    context: { sessionId: string; cwd: string; lifecycleHooks?: boolean },
  ): Promise<ImportedConnection> {
    const revision = mcpExecutionRevision(plan, component);
    const key = hash([component.public.id, revision, context.sessionId, context.cwd, context.lifecycleHooks !== false]);
    const existing = this.connections.get(key);
    if (existing && !existing.controller.signal.aborted) return existing.pending;
    if (this.connections.size >= 256) throw new Error('Imported MCP session limit reached.');
    const controller = new AbortController();
    const entry = {
      pending: this.open(plan, component, context, controller),
      controller,
      componentId: component.public.id,
      revision,
      sessionId: context.sessionId,
      connection: undefined as ImportedConnection | undefined,
    };
    const pending = entry.pending;
    this.connections.set(key, entry);
    controller.signal.addEventListener('abort', () => this.connections.delete(key), { once: true });
    pending.then(
      (connection) => {
        entry.connection = connection;
      },
      () => {
        if (this.connections.get(key) === entry) this.connections.delete(key);
      },
    );
    return pending;
  }
  private async open(
    plan: PluginPlan,
    component: ComponentPlan,
    context: { sessionId: string; cwd: string; lifecycleHooks?: boolean },
    controller: AbortController,
  ): Promise<ImportedConnection> {
    const config = component.mcp!;
    const client = new Client({ name: 'kai-plugin-bridge', version: '1.0.0' }, { capabilities: {} });
    client.onclose = () => controller.abort();
    mkdirSync(plan.dataDir, { recursive: true, mode: 0o700 });
    const sessionEnv = {
      KAI_BRIDGE_SESSION_ID: context.sessionId,
      KAI_BRIDGE_INSTANCE_ID: this.instanceId,
      CODEX_THREAD_ID: context.sessionId,
      PLUGIN_ROOT: plan.root,
      PLUGIN_DATA: plan.dataDir,
      CLAUDE_SESSION_ID: context.sessionId,
      CLAUDE_PLUGIN_ROOT: plan.root,
      CODEX_PLUGIN_ROOT: plan.root,
      CLAUDE_PLUGIN_DATA: plan.dataDir,
      CODEX_PLUGIN_DATA: plan.dataDir,
    };
    const transport: Transport = config.command
      ? new OwnedStdioTransport({
          command: config.command,
          args: importedMcpArgs(plan, component, context.lifecycleHooks),
          cwd: context.cwd,
          // Do not pass provider secrets from the backend's entire environment.
          env: {
            ...Object.fromEntries(
              ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA'].flatMap((key) =>
                process.env[key] ? [[key, process.env[key]!]] : [],
              ),
            ),
            ...config.env,
            ...sessionEnv,
          },
        })
      : config.transport === 'sse'
        ? new SSEClientTransport(new URL(config.url!), { requestInit: { headers: config.headers } })
        : new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: config.headers } });
    const abort = () => {
      void transport.close();
    };
    controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      controller.abort();
      void transport.close();
    }, 15_000);
    try {
      controller.signal.throwIfAborted();
      await client.connect(transport);
      if (client.getServerVersion()?.name.toLowerCase() === 'kai-mcp') throw new Error('Kai connector loop rejected.');
      const tools = await this.readTools(client, controller.signal);
      controller.signal.throwIfAborted();
      const connection = {
        client,
        transport,
        tools,
        controller,
        componentId: component.public.id,
        pluginId: plan.public.id,
        activeCalls: 0,
        retired: false,
        sessionId: context.sessionId,
        revision: mcpExecutionRevision(plan, component),
        clanks: client.getServerVersion()?.name === 'peer-agent-chat',
        instructions: client.getInstructions()?.slice(0, 16 * 1024),
      };
      let refreshing = false;
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (refreshing || controller.signal.aborted || connection.retired) return;
        refreshing = true;
        try {
          await this.refreshTools(connection);
        } catch {
          controller.abort();
        } finally {
          refreshing = false;
          this.onCatalogChanged();
        }
      });
      return connection;
    } catch {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw new Error('MCP connection failed. Check the installed program, required environment, or plugin sign-in.');
    } finally {
      clearTimeout(timer);
    }
  }
  private async readTools(client: Client, signal: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { signal: bounded, timeout: 15_000 });
      if (
        page.tools.some(
          (tool) => Array.isArray(tool._meta?.['kai.origin']) || typeof tool._meta?.['kai.source'] === 'string',
        )
      )
        throw new Error('Kai forwarding connector loop rejected.');
      tools.push(...page.tools);
      if (tools.length > 1000 || (page.nextCursor && seen.has(page.nextCursor)))
        throw new Error('MCP tool catalog exceeds bridge limits.');
      cursor = page.nextCursor;
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error('Duplicate MCP tool names.');
    return tools;
  }
  async refreshTools(connection: ImportedConnection): Promise<void> {
    connection.tools = await this.readTools(connection.client, connection.controller.signal);
  }
  async call(
    connection: ImportedConnection,
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const signal = context.abortSignal
      ? AbortSignal.any([connection.controller.signal, context.abortSignal])
      : connection.controller.signal;
    signal.throwIfAborted();
    if (connection.retired) throw new Error('Imported MCP version changed. Retry with the refreshed tool.');
    connection.activeCalls++;
    try {
      const args: Record<string, unknown> =
        connection.clanks && name === 'peer_register'
          ? { ...object(input), native_session_id: connection.sessionId }
          : object(input);
      if (connection.clanks) {
        if (name === 'peer_register') delete args.agent_id;
        else if (
          typeof args.handle === 'string' &&
          this.clanksHandles.get(connection.pluginId)?.get(connection.sessionId) !== args.handle
        )
          throw new Error(
            'Use this Kai session’s own Clanks handle. Call peer_register to bind it before using other tools.',
          );
      }
      const result = await connection.client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: 120_000,
        maxTotalTimeout: 600_000,
        resetTimeoutOnProgress: true,
        onprogress: (progress) =>
          context.onProgress?.({
            stream: 'stdout',
            delta: progress.message ?? '',
            output: progress.message ?? '',
            bytesSeen: progress.progress,
            progress: progress.progress,
            total: progress.total,
            truncated: false,
            stopped: false,
          }),
      });
      if (connection.clanks && !result.isError) {
        if (name === 'peer_register') {
          let value = object(result.structuredContent);
          if (!value.handle) {
            try {
              value = object(JSON.parse(String(object((result.content as unknown[])?.[0]).text)));
            } catch {
              /* Older MCP peers may omit structured results. */
            }
          }
          if (typeof value.handle === 'string')
            this.bindHandle(connection.pluginId, connection.sessionId, value.handle);
        } else if (name === 'peer_deregister')
          this.clanksHandles.get(connection.pluginId)?.delete(connection.sessionId);
      }
      return result;
    } finally {
      connection.activeCalls--;
      if (connection.retired && connection.activeCalls === 0) connection.controller.abort();
    }
  }
  reconcile(allowed: Map<string, string>): void {
    for (const [key, entry] of this.connections) {
      const revision = allowed.get(entry.componentId);
      if (revision === entry.revision) continue;
      if (revision && entry.connection?.activeCalls) entry.connection.retired = true;
      else {
        this.connections.delete(key);
        entry.controller.abort(new Error('Plugin Bridge component disabled or updated.'));
      }
    }
  }
  async closeSession(sessionId: string): Promise<void> {
    for (const sessions of this.clanksHandles.values()) sessions.delete(sessionId);
    const closed: Promise<unknown>[] = [];
    for (const [key, entry] of this.connections) {
      if (entry.sessionId !== sessionId) continue;
      this.connections.delete(key);
      entry.controller.abort();
      closed.push(entry.pending.then((connection) => connection.client.close()));
    }
    await Promise.allSettled(closed);
  }
  async revoke(allowed = new Set<string>()): Promise<void> {
    if (!allowed.size) this.clanksHandles.clear();
    const closed: Promise<unknown>[] = [];
    for (const [key, entry] of this.connections) {
      if (allowed.has(entry.componentId)) continue;
      this.connections.delete(key);
      entry.controller.abort(new Error('Plugin Bridge access revoked.'));
      closed.push(entry.pending.then((connection) => connection.client.close()));
    }
    await Promise.allSettled(closed);
  }
}
