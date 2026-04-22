/**
 * Convert renderer StoredMessages into AI SDK V4 CoreMessage format.
 *
 * The renderer stores tool calls and their results as a single ContentPart:
 *   { type: 'tool-call', toolCallId, toolName, args, result?, isHung?, ... }
 *
 * The AI SDK V4 CoreMessage format requires these to be split:
 *   assistant message: { type: 'tool-call', toolCallId, toolName, args }
 *   tool message:      { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, result }] }
 *
 * Without this normalization, Mastra's AIV4Adapter.fromCoreMessage() sees
 * type: 'tool-call' and creates a tool-invocation with state: 'call' (no result),
 * which then gets stripped by sanitization — causing orphaned tool_use blocks
 * that the API rejects with "Expected toolResult blocks".
 */

type RendererContentPart = {
  type: string;
  [key: string]: unknown;
};

export function normalizeMessagesForApi(
  messages: unknown[],
): Array<{ role: string; content: unknown }> {
  const result: Array<{ role: string; content: unknown }> = [];

  for (const raw of messages) {
    const msg = raw as { role?: string; content?: unknown };
    if (!msg || typeof msg !== 'object' || !msg.role) continue;

    const { role } = msg;

    // Pass through system and tool messages unchanged
    if (role === 'system' || role === 'tool') {
      result.push({ role, content: msg.content });
      continue;
    }

    // User messages: keep text, image, file parts; strip renderer-only types
    if (role === 'user') {
      if (!Array.isArray(msg.content)) {
        result.push({ role, content: msg.content });
        continue;
      }
      const cleanParts = (msg.content as RendererContentPart[])
        .filter(p => p.type === 'text' || p.type === 'image' || p.type === 'file')
        .map(p => {
          if (p.type === 'text') return { type: 'text' as const, text: p.text };
          if (p.type === 'image') return { type: 'image' as const, image: p.image };
          return {
            type: 'file' as const,
            data: p.data,
            mimeType: p.mimeType,
            ...(p.filename ? { filename: p.filename } : {}),
          };
        });
      if (cleanParts.length > 0) {
        result.push({ role, content: cleanParts });
      }
      continue;
    }

    // Assistant messages: split tool-call+result into assistant + tool messages
    if (role === 'assistant') {
      if (!Array.isArray(msg.content)) {
        result.push({ role, content: msg.content });
        continue;
      }

      const assistantParts: Array<Record<string, unknown>> = [];
      const toolResults: Array<{
        type: 'tool-result';
        toolCallId: string;
        toolName: string;
        result: unknown;
      }> = [];

      for (const part of msg.content as RendererContentPart[]) {
        if (part.type === 'text') {
          const text = typeof part.text === 'string' ? part.text : '';
          if (text) {
            assistantParts.push({ type: 'text', text });
          }
          continue;
        }

        if (part.type === 'tool-call') {
          // Emit clean tool-call in the assistant message
          assistantParts.push({
            type: 'tool-call',
            toolCallId: part.toolCallId as string,
            toolName: part.toolName as string,
            args: part.args ?? {},
          });

          // Collect matching tool-result for the follow-up tool message
          toolResults.push({
            type: 'tool-result',
            toolCallId: part.toolCallId as string,
            toolName: part.toolName as string,
            result: part.result !== undefined
              ? part.result
              : 'Tool execution did not complete.',
          });
          continue;
        }

        // Preserve image/file parts if present on assistant messages
        if (part.type === 'image' || part.type === 'file') {
          assistantParts.push(part);
        }
        // Strip enrichments and other renderer-only types
      }

      if (assistantParts.length > 0) {
        result.push({ role: 'assistant', content: assistantParts });
      }

      if (toolResults.length > 0) {
        result.push({ role: 'tool', content: toolResults });
      }

      continue;
    }

    // Unknown roles: pass through
    result.push({ role, content: msg.content });
  }

  return result;
}
