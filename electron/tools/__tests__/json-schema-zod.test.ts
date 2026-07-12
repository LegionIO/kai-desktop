/**
 * Tests for convertJsonSchemaToZod (electron/tools/json-schema-zod.ts) — turns a
 * tool's JSON-Schema args spec into a Zod validator, run on every MCP/plugin
 * tool call. A bug accepts a wrong-typed arg (unsafe) or rejects a valid one
 * (breaks the tool). Behavior is asserted via .safeParse on the produced schema.
 */
import { describe, it, expect } from 'vitest';
import { convertJsonSchemaToZod } from '../json-schema-zod.js';

const ok = (schema: Record<string, unknown>, value: unknown) => convertJsonSchemaToZod(schema).safeParse(value).success;

describe('convertJsonSchemaToZod — primitives', () => {
  it('string accepts strings, rejects non-strings', () => {
    expect(ok({ type: 'string' }, 'hi')).toBe(true);
    expect(ok({ type: 'string' }, 42)).toBe(false);
  });

  it('string enum accepts members, rejects non-members', () => {
    const s = { type: 'string', enum: ['a', 'b'] };
    expect(ok(s, 'a')).toBe(true);
    expect(ok(s, 'c')).toBe(false);
  });

  it('number/integer enforce minimum/maximum bounds', () => {
    const n = { type: 'number', minimum: 1, maximum: 10 };
    expect(ok(n, 5)).toBe(true);
    expect(ok(n, 0)).toBe(false);
    expect(ok(n, 11)).toBe(false);
    expect(ok({ type: 'integer' }, 3)).toBe(true);
    expect(ok({ type: 'integer' }, 'x')).toBe(false);
  });

  it('boolean accepts booleans, rejects others', () => {
    expect(ok({ type: 'boolean' }, true)).toBe(true);
    expect(ok({ type: 'boolean' }, 'true')).toBe(false);
  });
});

describe('convertJsonSchemaToZod — array', () => {
  it('validates element type via items recursion', () => {
    const s = { type: 'array', items: { type: 'number' } };
    expect(ok(s, [1, 2, 3])).toBe(true);
    expect(ok(s, [1, 'two'])).toBe(false);
  });

  it('accepts any element when items is absent', () => {
    const s = { type: 'array' };
    expect(ok(s, [1, 'a', true, null])).toBe(true);
    expect(ok(s, 'not-an-array')).toBe(false);
  });
});

describe('convertJsonSchemaToZod — object', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'number' } },
    required: ['name'],
  };

  it('enforces required properties and their types', () => {
    expect(ok(schema, { name: 'x', age: 5 })).toBe(true);
    expect(ok(schema, { age: 5 })).toBe(false); // missing required 'name'
    expect(ok(schema, { name: 42 })).toBe(false); // wrong type
  });

  it('allows a non-required property to be omitted', () => {
    expect(ok(schema, { name: 'x' })).toBe(true); // age optional/nullish
  });

  it('passes through extra keys not in the schema', () => {
    expect(ok(schema, { name: 'x', extra: 'kept' })).toBe(true);
  });

  it('with no properties, accepts an arbitrary object (record)', () => {
    const s = { type: 'object' };
    expect(ok(s, { anything: 1, else: 'ok' })).toBe(true);
  });
});

describe('convertJsonSchemaToZod — nullable + default + fallbacks', () => {
  it('accepts null when type is a ["string","null"] union', () => {
    const s = { type: ['string', 'null'] };
    expect(ok(s, null)).toBe(true);
    expect(ok(s, 'x')).toBe(true);
  });

  it('accepts null when nullable:true', () => {
    const s = { type: 'string', nullable: true };
    expect(ok(s, null)).toBe(true);
  });

  it('applies a default when the value is undefined', () => {
    const parsed = convertJsonSchemaToZod({ type: 'string', default: 'fallback' }).safeParse(undefined);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe('fallback');
  });

  it('falls back to z.any() for a non-object schema or unknown type', () => {
    expect(ok(null as unknown as Record<string, unknown>, { whatever: 1 })).toBe(true);
    expect(ok({ type: 'weird-type' }, 'anything')).toBe(true);
    expect(ok({}, 12345)).toBe(true); // no type → any
  });

  it('carries the description onto the produced schema', () => {
    const zType = convertJsonSchemaToZod({ type: 'string', description: 'the name' });
    expect(zType.description).toBe('the name');
  });
});
