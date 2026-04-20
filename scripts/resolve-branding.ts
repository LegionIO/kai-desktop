/**
 * Resolves `{{key}}` token references within branding string values.
 *
 * Runs multiple passes to support transitive references (e.g. a → b → c).
 * Non-string values (arrays, numbers, etc.) are passed through unchanged.
 * Single-brace tokens like `{productToken}` are intentionally ignored.
 */
export function resolveBranding<T extends Record<string, unknown>>(raw: T): T {
  const maxPasses = 5;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    result[key] = value;
  }

  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (const [key, value] of Object.entries(result)) {
      if (typeof value !== 'string') continue;
      const resolved = value.replace(/\{\{(\w+)\}\}/g, (_match, ref: string) => {
        const replacement = result[ref];
        if (replacement === undefined) return _match;
        return String(replacement);
      });
      if (resolved !== value) {
        result[key] = resolved;
        changed = true;
      }
    }
    if (!changed) break;
  }

  return result as T;
}
