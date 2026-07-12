/**
 * Tests for two small src/lib pure helpers (component-gated via 178f07b):
 *  - formatModelDisplayName: turns a raw model id into a display label.
 *  - flattenJsonSchema: flattens a JSON schema into dotted paths (drives the
 *    settings-search jump-to-field navigation).
 */
import { describe, it, expect } from 'vitest';
import { formatModelDisplayName } from '../model-display';
import { flattenJsonSchema } from '../schema-paths';

describe('formatModelDisplayName', () => {
  it('normalizes separators and title-cases tokens', () => {
    expect(formatModelDisplayName('claude-3-5-sonnet')).toBe('Claude-3-5-Sonnet');
    expect(formatModelDisplayName('my_model:v2')).toBe('My-Model-V2');
    expect(formatModelDisplayName('o1-preview')).toBe('O1-Preview');
  });

  it('uppercases known acronym tokens', () => {
    expect(formatModelDisplayName('gpt-4o')).toBe('GPT-4o');
    expect(formatModelDisplayName('aws-bedrock')).toBe('AWS-Bedrock');
  });

  it('joins a split version-number pair (4 1 → 4.1)', () => {
    expect(formatModelDisplayName('gpt 4 1')).toBe('GPT-4.1');
  });

  it('preserves version-number tokens as-is', () => {
    expect(formatModelDisplayName('model 3.5 turbo')).toBe('Model-3.5-Turbo');
  });

  it('falls back to the raw value when the cleaned string is empty', () => {
    expect(formatModelDisplayName('')).toBe('');
    expect(formatModelDisplayName('   ')).toBe('   ');
  });
});

describe('flattenJsonSchema', () => {
  it('returns [] for an undefined / non-object schema', () => {
    expect(flattenJsonSchema(undefined)).toEqual([]);
    expect(flattenJsonSchema({})).toEqual([]);
  });

  it('lists top-level property paths', () => {
    expect(flattenJsonSchema({ properties: { a: { type: 'string' }, b: { type: 'number' } } })).toEqual(['a', 'b']);
  });

  it('recurses into nested object properties', () => {
    const schema = {
      properties: {
        a: { type: 'string' },
        b: { type: 'object', properties: { c: { type: 'number' } } },
      },
    };
    expect(flattenJsonSchema(schema)).toEqual(['a', 'b', 'b.c']);
  });

  it('descends array items with a [0] index segment', () => {
    const schema = {
      properties: {
        d: { type: 'array', items: { type: 'object', properties: { e: {} } } },
      },
    };
    expect(flattenJsonSchema(schema)).toEqual(['d', 'd[0].e']);
  });

  it('honors a prefix and returns [prefix] for a leaf schema with no properties', () => {
    expect(flattenJsonSchema({ type: 'string' }, 'root.leaf')).toEqual(['root.leaf']);
  });

  it('handles a mixed schema (object + array-of-object siblings)', () => {
    const schema = {
      properties: {
        a: { type: 'string' },
        b: { type: 'object', properties: { c: { type: 'number' } } },
        d: { type: 'array', items: { type: 'object', properties: { e: {} } } },
      },
    };
    expect(flattenJsonSchema(schema)).toEqual(['a', 'b', 'b.c', 'd', 'd[0].e']);
  });
});
