export type SanitizedPluginContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: unknown; mimeType?: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown; isError?: boolean };

export type SanitizedPluginMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | SanitizedPluginContentPart[];
};

function cleanToolResult(
  part: Record<string, unknown>,
): Extract<SanitizedPluginContentPart, { type: 'tool-result' }> | null {
  if (
    typeof part.toolCallId !== 'string'
    || !part.toolCallId
    || typeof part.toolName !== 'string'
    || !part.toolName
  ) {
    return null;
  }
  return {
    type: 'tool-result',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    result: part.result !== undefined ? part.result : 'Tool execution did not complete.',
    ...(part.isError === true ? { isError: true } : {}),
  };
}

/**
 * Validate plugin-provided history without flattening its native tool messages.
 * Combined renderer-style tool-call parts that include a result are split into
 * the same assistant/tool sequence accepted by the regular conversation path.
 */
export function sanitizePluginMessages(
  messages: Array<{ role: string; content: unknown }>,
): SanitizedPluginMessage[] {
  const clean: SanitizedPluginMessage[] = [];

  for (const msg of messages) {
    const role = msg.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') continue;

    if (Array.isArray(msg.content)) {
      const parts = msg.content as Array<Record<string, unknown>>;
      if (role === 'tool') {
        const toolResults = parts
          .filter((part) => part?.type === 'tool-result')
          .map(cleanToolResult)
          .filter((
            part,
          ): part is Extract<SanitizedPluginContentPart, { type: 'tool-result' }> => part !== null);
        if (toolResults.length > 0) clean.push({ role, content: toolResults });
        continue;
      }

      if (role === 'system') {
        const text = parts
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text as string)
          .join('\n')
          .trim();
        if (text) clean.push({ role, content: text });
        continue;
      }

      let messageParts: SanitizedPluginContentPart[] = [];
      const flushMessageParts = () => {
        if (messageParts.length === 0) return;
        clean.push({ role, content: messageParts });
        messageParts = [];
      };

      for (const part of parts) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
          messageParts.push({ type: 'text', text: part.text });
          continue;
        }
        if (part?.type === 'image' && part.image != null) {
          messageParts.push({
            type: 'image',
            image: part.image,
            ...(typeof part.mimeType === 'string' ? { mimeType: part.mimeType } : {}),
          });
          continue;
        }
        if (
          role === 'assistant'
          && part?.type === 'tool-call'
          && typeof part.toolCallId === 'string'
          && part.toolCallId
          && typeof part.toolName === 'string'
          && part.toolName
        ) {
          messageParts.push({
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.args ?? {},
          });

          // Regular stored conversations keep the result on the tool-call
          // content part. Split that representation into native API messages.
          if (Object.prototype.hasOwnProperty.call(part, 'result')) {
            flushMessageParts();
            const toolResult = cleanToolResult({
              ...part,
              type: 'tool-result',
            });
            if (toolResult) clean.push({ role: 'tool', content: [toolResult] });
          }
        }
      }
      flushMessageParts();
      continue;
    }

    if (typeof msg.content !== 'string') continue;
    if (!msg.content.trim()) continue;
    if (role === 'tool') continue;

    clean.push({ role, content: msg.content });
  }

  return clean;
}
