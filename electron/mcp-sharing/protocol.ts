import { z } from 'zod';
import { CallToolResultSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../tools/types.js';
import { buildMcpToolContent } from '../agent/tool-model-content.js';
import type { ModelContentPart } from '../agent/tool-model-content.js';

export function exportedSchema(tool: ToolDefinition): Tool {
  const input = tool.jsonInputSchema ?? z.toJSONSchema(tool.inputSchema, { io: 'input' });
  if (input.type !== 'object') throw new Error('MCP tools require an object input schema.');
  return {
    ...tool.mcpDescriptor,
    name: tool.name,
    description: tool.description,
    inputSchema: input as Tool['inputSchema'],
    ...(tool.jsonOutputSchema ? { outputSchema: tool.jsonOutputSchema as Tool['outputSchema'] } : {}),
    ...(tool.bridge
      ? {
          _meta: {
            ...tool.mcpDescriptor?._meta,
            'kai.origin': tool.bridge.origin,
            'kai.source': tool.bridge.componentId,
          },
        }
      : {}),
  };
}
export function exportedResult(result: unknown): CallToolResult {
  if (Buffer.byteLength(JSON.stringify(result) ?? '') > 8 * 1024 * 1024 - 1024)
    throw new Error('MCP result exceeds the 8 MiB connector message limit. Request a smaller result.');
  // Already-MCP results retain structuredContent, resource links, images and
  // error status. Native Kai results use the existing model-content adapter.
  if (result && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)) {
    return CallToolResultSchema.parse(result);
  }
  const value = result as { isError?: unknown; error?: unknown } | null;
  return CallToolResultSchema.parse({
    content: buildMcpToolContent(result),
    ...(result && typeof result === 'object' && !Array.isArray(result) ? { structuredContent: result } : {}),
    isError: value?.isError === true || (typeof value?.error === 'string' && value.error.length > 0),
  });
}

/** Mastra uses Kai's native media convention. Convert only imported MCP
 * results at that adapter, leaving the original envelope available to hooks,
 * the renderer and connector clients. Existing media limits still apply. */
export function importedResultForModel(result: unknown): unknown {
  const parsed = CallToolResultSchema.safeParse(result);
  if (!parsed.success) return result;
  const { content, ...rest } = parsed.data;
  const parts: ModelContentPart[] = content.map((part): ModelContentPart => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') return { type: 'image', data: part.data, mediaType: part.mimeType };
    if (part.type === 'audio') return { type: 'file', data: part.data, mediaType: part.mimeType };
    if (part.type === 'resource' && 'blob' in part.resource)
      return {
        type: 'file',
        data: part.resource.blob,
        mediaType: part.resource.mimeType ?? 'application/octet-stream',
        filename: part.resource.uri,
      };
    if (part.type === 'resource' && 'text' in part.resource) return { type: 'text', text: part.resource.text };
    return { type: 'text', text: JSON.stringify(part) };
  });
  return { ...rest, _modelContent: parts };
}
