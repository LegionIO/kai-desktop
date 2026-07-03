export function flattenJsonSchema(schema: Record<string, unknown> | undefined, prefix = ''): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const props = schema.properties;
  if (!props || typeof props !== 'object') return prefix ? [prefix] : [];

  const out: string[] = [];
  for (const [key, child] of Object.entries(props as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(path);
    if (child && typeof child === 'object') {
      const childSchema = child as Record<string, unknown>;
      if (childSchema.type === 'object' && childSchema.properties) {
        out.push(...flattenJsonSchema(childSchema, path));
      } else if (childSchema.type === 'array' && childSchema.items && typeof childSchema.items === 'object') {
        out.push(...flattenJsonSchema(childSchema.items as Record<string, unknown>, `${path}[0]`));
      }
    }
  }
  return out;
}
