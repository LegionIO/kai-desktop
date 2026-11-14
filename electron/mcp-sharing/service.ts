import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import { toolsForExecutionMode } from '../agent/plan-mode-tools.js';
import { executeToolWithLifecycleHooks } from '../agent/hooks/tool-lifecycle.js';
import type { McpExportSource } from '../../shared/plugin-bridge.js';
import type { BridgeStateStore } from '../plugin-bridge/state.js';
import { hash } from '../plugin-bridge/files.js';
import { exportedResult, exportedSchema } from './protocol.js';

export type McpPrincipal = { clientId: string; credentialHash: string; kind: 'local' | 'remote'; expiresAt: number };
type OwnedCall = { controller: AbortController; principal: McpPrincipal; toolId: string; sessionId: string };
const SAFE_BUILTINS = new Set(['web_search', 'web_fetch']);

function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Kai MCP call cancelled.'));
    if (signal.aborted) {
      operation.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => {});
  });
}

export function exportSourceId(tool: ToolDefinition): string {
  return `${tool.source ?? 'builtin'}:${tool.sourceId ?? 'kai'}`;
}
export function exportToolId(tool: ToolDefinition): string {
  return `${exportSourceId(tool)}/${tool.originalName ?? tool.name}`;
}
export function exportUnavailableReason(tool: ToolDefinition): string | undefined {
  if (tool.mcpExportUnavailableReason) return tool.mcpExportUnavailableReason;
  if (
    Array.isArray(tool.mcpDescriptor?._meta?.['kai.origin']) ||
    typeof tool.mcpDescriptor?._meta?.['kai.source'] === 'string'
  )
    return 'A Kai forwarding connector cannot be shared back through Kai.';
  const name = (tool.originalName ?? tool.name).replaceAll('-', '_');
  if (
    /(?:^|_)(?:sub_agent|delegate|ask_user|request_review|credential|login|logout|sign_in|set_client_secret|plugin_bridge|mcp_export|enter_plan_mode|exit_plan_mode|config_manage)(?:_|$)/i.test(
      name,
    )
  )
    return 'Delegation, credentials, approvals and bridge administration are unavailable over MCP.';
  if (tool.source === 'browser' || tool.source === 'skill' || tool.bridge?.componentId.includes('/skill/'))
    return 'This capability requires Kai chat or UI context.';
  if (!tool.source || tool.source === 'builtin')
    return SAFE_BUILTINS.has(name) ? undefined : 'This built-in tool requires Kai chat or administrative context.';
  if (tool.source === 'cli') return 'CLI tools require the chat working-directory and approval context.';
  return undefined;
}

export class KaiMcpService {
  private readonly calls = new Map<string, OwnedCall>();
  private readonly sessions = new Map<Server, { principal: McpPrincipal; sessionId: string }>();
  private readonly listeners = new Set<() => void>();
  private catalogFingerprint = '';
  onSessionClosed: (sessionId: string) => void = () => {};
  constructor(
    readonly store: BridgeStateStore,
    private readonly getConfig: () => AppConfig,
    private readonly getTools: () => ToolDefinition[],
    private readonly sourceEnabled: (tool: ToolDefinition) => boolean,
    private readonly principalActive: (principal: McpPrincipal) => boolean,
  ) {}
  enabled(): boolean {
    return this.store.get().sharingEnabled && this.getConfig().mcpExport?.enabled === true;
  }
  private selected(tool: ToolDefinition): boolean {
    const state = this.store.get();
    return state.exportSources.includes(exportSourceId(tool)) || state.exportTools.includes(exportToolId(tool));
  }
  private available(tool: ToolDefinition): boolean {
    return (
      !exportUnavailableReason(tool) &&
      this.sourceEnabled(tool) &&
      toolsForExecutionMode([tool], this.getConfig().tools.executionMode).length > 0
    );
  }
  private allowedTools(): ToolDefinition[] {
    return this.enabled() ? this.getTools().filter((tool) => this.selected(tool) && this.available(tool)) : [];
  }
  private authorize(principal: McpPrincipal): void {
    if (!this.enabled()) throw new Error('Kai MCP sharing is disabled. Enable Share Kai in Settings → Plugin Bridge.');
    if (!this.principalActive(principal) || principal.expiresAt <= Date.now())
      throw new Error('Kai MCP client access expired or was revoked.');
  }
  inventory(): McpExportSource[] {
    const groups = new Map<string, McpExportSource>();
    const state = this.store.get();
    for (const tool of this.getTools()) {
      const id = exportSourceId(tool);
      let source = groups.get(id);
      if (!source) {
        source = {
          id,
          name:
            tool.sourceId ??
            (tool.source === 'cli'
              ? 'Kai CLI tools'
              : tool.source === 'browser'
                ? 'Kai browser tools'
                : 'Kai built-in tools'),
          imported: tool.source === 'bridge',
          selected: state.exportSources.includes(id),
          tools: [],
        };
        groups.set(id, source);
      }
      let reason = exportUnavailableReason(tool);
      if (!reason && !this.sourceEnabled(tool)) reason = 'The underlying source is disabled or unavailable.';
      if (!reason && !this.available(tool))
        reason = 'Kai execution policy does not allow this tool in the current mode.';
      try {
        exportedSchema(tool);
      } catch {
        reason = 'The tool input schema cannot be represented by MCP.';
      }
      source.tools.push({
        id: exportToolId(tool),
        name: tool.name,
        description: tool.description,
        selected: this.selected(tool),
        available: !reason,
        reason,
      });
    }
    for (const id of state.exportSources)
      if (!groups.has(id))
        groups.set(id, {
          id,
          name: id,
          imported: id.startsWith('bridge:'),
          selected: true,
          tools: [],
        });
    for (const id of state.exportTools) {
      if ([...groups.values()].some((source) => source.tools.some((tool) => tool.id === id))) continue;
      const sourceId = id.slice(0, id.lastIndexOf('/'));
      let source = groups.get(sourceId);
      if (!source) {
        source = {
          id: sourceId,
          name: sourceId,
          imported: sourceId.startsWith('bridge:'),
          selected: state.exportSources.includes(sourceId),
          tools: [],
        };
        groups.set(sourceId, source);
      }
      source.tools.push({
        id,
        name: id.slice(id.lastIndexOf('/') + 1),
        description: '',
        selected: true,
        available: false,
        reason: 'The selected source is unavailable. Selection is retained until you remove it.',
      });
    }
    return [...groups.values()];
  }
  select(sources: string[], tools: string[]): void {
    const inventory = this.inventory();
    if (
      sources.some((id) => !inventory.some((source) => source.id === id)) ||
      tools.some(
        (id) =>
          !inventory.some((source) =>
            source.tools.some(
              (tool) => tool.id === id && (tool.available || this.store.get().exportTools.includes(id)),
            ),
          ),
      )
    )
      throw new Error('The tool inventory changed. Refresh the export selection.');
    this.store.update((state) => {
      state.exportSources = [...new Set(sources)];
      state.exportTools = [...new Set(tools)];
    });
    this.store.record('approval', 'Updated the shared MCP export selection.');
    this.changed();
  }
  list(principal: McpPrincipal): Tool[] {
    this.authorize(principal);
    return this.allowedTools().flatMap((tool) => {
      try {
        return [
          {
            ...exportedSchema(tool),
            _meta: {
              ...exportedSchema(tool)._meta,
              'kai.origin': [...new Set([this.store.get().instanceId, ...(tool.bridge?.origin ?? [])])],
              'kai.source': exportToolId(tool),
            },
          },
        ];
      } catch {
        return [];
      }
    });
  }
  async call(
    principal: McpPrincipal,
    name: string,
    args: unknown,
    options: {
      sessionId: string;
      callId?: string;
      signal?: AbortSignal;
      onProgress?: ToolExecutionContext['onProgress'];
      origin?: string[];
    },
  ): Promise<CallToolResult> {
    this.authorize(principal);
    if (options.origin?.includes(this.store.get().instanceId) || (options.origin?.length ?? 0) >= 8)
      throw new Error('Kai MCP forwarding cycle rejected.');
    const tool = this.allowedTools().find((candidate) => candidate.name === name);
    if (!tool) throw new Error('This tool is not exported or its source is unavailable. Check Kai and plugin sign-in.');
    const callId = options.callId ?? randomUUID();
    if (this.calls.has(callId) || this.calls.size >= 64) throw new Error('Kai MCP call limit reached.');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(600_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    const sessionId = `connector:${principal.clientId}:${options.sessionId}`;
    this.calls.set(callId, { controller, principal, toolId: exportToolId(tool), sessionId: options.sessionId });
    try {
      signal.throwIfAborted();
      const result = await withCancellation(
        executeToolWithLifecycleHooks({
          conversationId: sessionId,
          toolCallId: callId,
          toolName: tool.name,
          args,
          // A source MCP validates its full JSON schema. Avoid the native chat
          // adapter's lossy Zod conversion stripping fields on the sharing path.
          validate: (input) => {
            if (tool.executeMcp && tool.jsonInputSchema) {
              if (!input || typeof input !== 'object' || Array.isArray(input))
                throw new Error('MCP arguments must be an object.');
              return input;
            }
            return tool.inputSchema.parse(input);
          },
          execute: async (input) => {
            // A hook may await human input. Recheck after that await, too.
            this.authorize(principal);
            if (!this.allowedTools().some((current) => exportToolId(current) === exportToolId(tool)))
              throw new Error('Tool export revoked.');
            signal.throwIfAborted();
            return withCancellation(
              (tool.executeMcp ?? tool.execute)(input, {
                toolCallId: callId,
                bridgeSessionId: sessionId,
                connectorClientId: principal.clientId,
                cwd: homedir(),
                isHeadless: true,
                abortSignal: signal,
                onProgress: options.onProgress,
              }),
              signal,
            );
          },
        }),
        signal,
      );
      signal.throwIfAborted();
      this.store.record('call', `MCP tool completed: ${tool.name}`, exportSourceId(tool));
      return exportedResult(result);
    } catch (error) {
      this.store.record('error', `MCP tool failed or was cancelled: ${tool.name}`, exportSourceId(tool));
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: signal.aborted
              ? 'Kai MCP call cancelled.'
              : error instanceof Error
                ? error.message
                : 'Kai MCP tool failed.',
          },
        ],
      };
    } finally {
      this.calls.delete(callId);
    }
  }
  cancel(principal: McpPrincipal, sessionId: string, callId: string): void {
    const call = this.calls.get(callId);
    if (call?.principal.credentialHash === principal.credentialHash && call.sessionId === sessionId)
      call.controller.abort();
  }
  closeSession(principal: McpPrincipal, sessionId: string): void {
    for (const call of this.calls.values())
      if (call.principal.credentialHash === principal.credentialHash && call.sessionId === sessionId)
        call.controller.abort();
    this.onSessionClosed(`connector:${principal.clientId}:${sessionId}`);
  }
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  changed(): void {
    const allowed = new Set(this.allowedTools().map(exportToolId));
    for (const call of this.calls.values())
      if (!allowed.has(call.toolId) || !this.principalActive(call.principal)) call.controller.abort();
    for (const [server, session] of this.sessions) {
      if (!this.enabled() || !this.principalActive(session.principal)) {
        void server.close();
        this.sessions.delete(server);
      }
    }
    const fingerprint = hash(
      this.allowedTools().flatMap((tool) => {
        try {
          return [exportedSchema(tool)];
        } catch {
          return [];
        }
      }),
    );
    this.listeners.forEach((listener) => listener());
    if (fingerprint === this.catalogFingerprint) return;
    this.catalogFingerprint = fingerprint;
    for (const server of this.sessions.keys())
      void server.notification({ method: 'notifications/tools/list_changed' }).catch(() => {});
  }
  async connect(principal: McpPrincipal, transport: Transport, sessionId = randomUUID()): Promise<Server> {
    this.authorize(principal);
    const server = new Server(
      { name: 'kai-mcp', version: '1.0.0' },
      {
        capabilities: { tools: { listChanged: true } },
        instructions:
          'Only explicitly shared Kai tools are available. Calls use the accounts signed in to this Kai installation.',
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.list(principal) }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const progressToken = request.params._meta?.progressToken;
      const origin = request.params._meta?.['kai.origin'];
      return this.call(principal, request.params.name, request.params.arguments ?? {}, {
        sessionId,
        signal: extra.signal,
        origin: Array.isArray(origin) ? origin.filter((v): v is string => typeof v === 'string') : undefined,
        onProgress:
          progressToken === undefined
            ? undefined
            : (progress) => {
                void extra
                  .sendNotification({
                    method: 'notifications/progress',
                    params: {
                      progressToken,
                      progress: progress.progress ?? progress.bytesSeen,
                      total: progress.total,
                      message: progress.delta,
                    },
                  })
                  .catch(() => {});
              },
      });
    });
    server.onclose = () => {
      this.sessions.delete(server);
      this.closeSession(principal, sessionId);
    };
    await server.connect(transport);
    this.sessions.set(server, { principal, sessionId });
    return server;
  }
  async stop(): Promise<void> {
    for (const call of this.calls.values()) call.controller.abort();
    await Promise.allSettled([...this.sessions.keys()].map((server) => server.close()));
    this.sessions.clear();
  }
}
