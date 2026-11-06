/** Remote chat tools accept either plain text or structured content parts. */
export function mcpChatTool(
  contentSchema: Record<string, unknown> = {
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object', additionalProperties: true } }],
  },
) {
  return {
    name: 'chat',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
              content: contentSchema,
            },
            required: ['role', 'content'],
          },
        },
      },
      required: ['messages'],
    },
  };
}
