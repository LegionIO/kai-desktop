/**
 * Resolve `{placeholder}` templates in a provider's `extraHeaders` with runtime
 * values. Templates use `{key}` where key is a supported runtime variable
 * (conversationId, cwd, modelKey, modelName). Returns the original object when no
 * template is present (avoids allocation). Pure — shared by the turn path
 * (ipc/agent.ts) and the on-demand `/compact` path (ipc/conversations.ts) so both
 * send a gateway the same resolved headers.
 */
export function resolveHeaderTemplates(
  headers: Record<string, string>,
  vars: Record<string, string>,
): Record<string, string> {
  let changed = false;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value.includes('{')) {
      const resolved = value.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
      result[key] = resolved;
      if (resolved !== value) changed = true;
    } else {
      result[key] = value;
    }
  }
  return changed ? result : headers;
}
