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

function inferMimeTypeFromDataUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^data:([^;,]+)(?:;[^,]*)?,/);
  return match?.[1];
}

/** True if a message's content carries nothing the provider can use — an empty
 *  string, whitespace, null/undefined, or an empty array. Such messages are
 *  invalid and some providers reject them, so they're dropped. */
function isEmptyContent(content: unknown): boolean {
  if (content == null) return true;
  if (typeof content === 'string') return content.trim().length === 0;
  if (Array.isArray(content)) return content.length === 0;
  return false;
}

function normalizeImagePart(part: RendererContentPart): { type: 'image'; image: unknown; mimeType?: string } {
  const mimeType = typeof part.mimeType === 'string' ? part.mimeType : inferMimeTypeFromDataUrl(part.image);

  return {
    type: 'image',
    image: part.image,
    ...(mimeType ? { mimeType } : {}),
  };
}

function normalizeFilePart(part: RendererContentPart): {
  type: 'file';
  data: unknown;
  mimeType?: unknown;
  filename?: unknown;
} {
  const mimeType = typeof part.mimeType === 'string' ? part.mimeType : inferMimeTypeFromDataUrl(part.data);

  return {
    type: 'file',
    data: part.data,
    ...(mimeType ? { mimeType } : {}),
    ...(part.filename ? { filename: part.filename } : {}),
  };
}

export function normalizeMessagesForApi(messages: unknown[]): Array<{ role: string; content: unknown }> {
  const result: Array<{ role: string; content: unknown }> = [];
  // Track tool-call ids across the whole history: a duplicate id makes call/
  // result pairing ambiguous and some providers reject it. Keep the first, drop
  // later duplicate pairs.
  const seenToolCallIds = new Set<string>();

  for (const raw of messages) {
    const msg = raw as { role?: string; content?: unknown };
    if (!msg || typeof msg !== 'object' || !msg.role) continue;

    const { role } = msg;

    // Pass through system and tool messages unchanged (but drop empty ones —
    // an empty tool/system message is invalid and some providers reject it).
    if (role === 'system' || role === 'tool') {
      if (isEmptyContent(msg.content)) continue;
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
        .filter((p) => p.type === 'text' || p.type === 'image' || (p.type === 'file' && p.displayOnly !== true))
        .map((p) => {
          if (p.type === 'text') return { type: 'text' as const, text: p.text };
          if (p.type === 'image') return normalizeImagePart(p);
          return normalizeFilePart(p);
        });
      if (cleanParts.length > 0) {
        result.push({ role, content: cleanParts });
      }
      continue;
    }

    // Assistant messages: split tool-call+result into assistant + tool messages
    if (role === 'assistant') {
      if (!Array.isArray(msg.content)) {
        if (isEmptyContent(msg.content)) continue; // drop empty assistant turns
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
          // A tool-call MUST have a string toolCallId + toolName, or the emitted
          // assistant tool-call / tool-result pair is ambiguous and the provider
          // rejects it (400). Skip a malformed part rather than emit `undefined`
          // ids — dropping the pair entirely keeps the request well-formed.
          const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : null;
          const toolName = typeof part.toolName === 'string' ? part.toolName : null;
          if (!toolCallId || !toolName) {
            continue;
          }
          // Drop a later duplicate id (ambiguous pairing → provider may reject).
          if (seenToolCallIds.has(toolCallId)) {
            continue;
          }
          seenToolCallIds.add(toolCallId);

          // Emit clean tool-call in the assistant message
          assistantParts.push({
            type: 'tool-call',
            toolCallId,
            toolName,
            args: part.args ?? {},
          });

          // Collect matching tool-result for the follow-up tool message
          toolResults.push({
            type: 'tool-result',
            toolCallId,
            toolName,
            result: part.result !== undefined ? part.result : 'Tool execution did not complete.',
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
