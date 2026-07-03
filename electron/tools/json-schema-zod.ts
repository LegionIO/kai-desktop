import { z } from 'zod';

export function convertJsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.any();

  const rawType = schema.type as string | string[] | undefined;
  const typeList = Array.isArray(rawType) ? rawType : rawType ? [rawType] : [];
  const type = typeList.find((candidate) => candidate !== 'null');
  const description = schema.description as string | undefined;
  const hasNull = typeList.includes('null') || schema.nullable === true;
  const hasDefault = Object.prototype.hasOwnProperty.call(schema, 'default');
  const defaultValue = schema.default;

  const applyDesc = <T extends z.ZodTypeAny>(zType: T): T => {
    return description ? (zType.describe(description) as T) : zType;
  };

  const finalize = <T extends z.ZodTypeAny>(zType: T): z.ZodTypeAny => {
    let next: z.ZodTypeAny = zType;
    if (hasNull) {
      next = next.nullable();
    }
    if (hasDefault) {
      next = next.default(defaultValue);
    }
    return applyDesc(next);
  };

  switch (type) {
    case 'string': {
      const enumVals = schema.enum as string[] | undefined;
      if (enumVals && enumVals.length > 0) {
        return finalize(z.enum(enumVals as [string, ...string[]]));
      }
      return finalize(z.string());
    }
    case 'number':
    case 'integer': {
      let n = z.number();
      if (typeof schema.minimum === 'number') n = n.min(schema.minimum);
      if (typeof schema.maximum === 'number') n = n.max(schema.maximum);
      return finalize(n);
    }
    case 'boolean':
      return finalize(z.boolean());
    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      return finalize(z.array(items ? convertJsonSchemaToZod(items) : z.any()));
    }
    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const required = schema.required as string[] | undefined;
      if (!properties) return finalize(z.record(z.string(), z.any()));

      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        let fieldType = convertJsonSchemaToZod(propSchema);
        if (!required?.includes(key)) {
          fieldType = fieldType.nullish();
        }
        shape[key] = fieldType;
      }
      return finalize(z.object(shape).passthrough());
    }
    default:
      return finalize(z.any());
  }
}
