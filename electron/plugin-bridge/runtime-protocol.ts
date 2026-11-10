import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import { exportedSchema } from '../mcp-sharing/protocol.js';

export type RuntimeMcpEntry = {
  name: string;
  tool: ToolDefinition;
  call: (
    args: Record<string, unknown>,
    extra: { signal: AbortSignal; onProgress?: ToolExecutionContext['onProgress'] },
  ) => Promise<CallToolResult>;
};

/** High-level SDK tool helpers accept a Zod object shape, which loses root
 * constraints and raw MCP metadata. When imported components are present,
 * use the SDK's protocol handlers while retaining the same existing, gated
 * executors and per-turn transport lifecycle. Native-only turns are untouched. */
export function installImportedRuntimeProtocol(server: Server, entries: RuntimeMcpEntry[]): void {
  if (!entries.some((entry) => entry.tool.bridge)) return;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: entries.map(({ name, tool }) => {
      try {
        return exportedSchema({ ...tool, name });
      } catch {
        if (tool.bridge) throw new Error('The imported tool schema cannot be represented by this runtime.');
        return { name, description: tool.description, inputSchema: { type: 'object' as const } };
      }
    }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const entry = entries.find(({ name }) => name === request.params.name);
    if (!entry) return { isError: true, content: [{ type: 'text', text: 'This turn does not expose that tool.' }] };
    const token = request.params._meta?.progressToken;
    return entry.call(request.params.arguments ?? {}, {
      signal: extra.signal,
      onProgress:
        token === undefined
          ? undefined
          : (progress) => {
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: {
                    progressToken: token,
                    progress: progress.progress ?? progress.bytesSeen,
                    total: progress.total,
                    message: progress.delta,
                  },
                })
                .catch(() => {});
            },
    });
  });
}
