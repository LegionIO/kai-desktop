import { describe, expect, it } from 'vitest';
import {
  buildScopedToolName,
  MAX_TOOL_NAME_LENGTH,
  isValidToolName,
  dedupeToolNames,
  findToolByName,
  makeSafeToolName,
} from '../naming';
import type { ToolDefinition } from '../types';

describe('buildScopedToolName', () => {
  it('keeps short names intact', () => {
    const name = buildScopedToolName('mcp', 'server', 'do_thing');
    expect(name).toBe('mcp__server__do_thing');
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
  });

  it('truncated names stay within the length limit and remain valid', () => {
    const long = 'a'.repeat(80);
    const name = buildScopedToolName('mcp', 'server', long);
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    expect(isValidToolName(name)).toBe(true);
  });

  it('distinct long names sharing a prefix do NOT collide after truncation', () => {
    const base = 'x'.repeat(70);
    const a = buildScopedToolName('mcp', 'server', base + 'AAAA');
    const b = buildScopedToolName('mcp', 'server', base + 'BBBB');
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    expect(b.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
  });

  it('is deterministic — same input yields the same truncated name', () => {
    const long = 'z'.repeat(90);
    expect(buildScopedToolName('plugin', 'p', long)).toBe(buildScopedToolName('plugin', 'p', long));
  });

  it('keeps a short skill scope intact', () => {
    const name = buildScopedToolName('skill', 'my-skill');
    expect(name).toBe('skill__my-skill');
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
  });

  it('caps a long SKILL name to the length limit (regression: skill branch used to skip the cap)', () => {
    const name = buildScopedToolName('skill', 'a'.repeat(80));
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    expect(isValidToolName(name)).toBe(true);
  });

  it('distinct long skill names sharing a prefix do NOT collide after truncation', () => {
    const base = 'y'.repeat(70);
    const a = buildScopedToolName('skill', base + 'AAAA');
    const b = buildScopedToolName('skill', base + 'BBBB');
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    expect(b.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
  });
});

describe('dedupeToolNames', () => {
  const mk = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition =>
    ({
      name,
      description: 'd',
      inputSchema: undefined as never,
      execute: async () => ({}),
      ...extra,
    }) as ToolDefinition;

  it('leaves distinct names untouched', () => {
    const out = dedupeToolNames([mk('a'), mk('b')]);
    expect(out.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('keeps the first occurrence and disambiguates later collisions', () => {
    const out = dedupeToolNames([
      mk('mcp__foo_bar__x', { source: 'mcp', sourceId: 'foo bar', originalName: 'x' }),
      mk('mcp__foo_bar__x', { source: 'mcp', sourceId: 'foo@bar', originalName: 'x' }),
    ]);
    expect(out[0].name).toBe('mcp__foo_bar__x'); // first keeps the name
    expect(out[1].name).not.toBe('mcp__foo_bar__x'); // second disambiguated
    expect(out[1].aliases).toContain('mcp__foo_bar__x'); // collision preserved as alias
    // All final names are unique.
    expect(new Set(out.map((t) => t.name)).size).toBe(2);
  });

  it('is deterministic for the same colliding input', () => {
    const build = () =>
      dedupeToolNames([
        mk('dup', { source: 'skill', sourceId: 's1', originalName: 'x' }),
        mk('dup', { source: 'skill', sourceId: 's2', originalName: 'y' }),
      ])[1].name;
    expect(build()).toBe(build());
  });

  it('disambiguated names stay within the length limit', () => {
    const long = 'mcp__' + 'a'.repeat(MAX_TOOL_NAME_LENGTH);
    const out = dedupeToolNames([mk(long.slice(0, MAX_TOOL_NAME_LENGTH)), mk(long.slice(0, MAX_TOOL_NAME_LENGTH))]);
    expect(out[1].name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
  });

  it('THREE maxed-out collisions all get unique names within the limit (retry re-fits)', () => {
    const n = 'z'.repeat(MAX_TOOL_NAME_LENGTH);
    const out = dedupeToolNames([mk(n), mk(n), mk(n)]);
    expect(new Set(out.map((t) => t.name)).size).toBe(3); // all unique
    for (const t of out) expect(t.name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
  });
});

describe('makeSafeToolName length enforcement', () => {
  it('caps a charset-valid but overlong name to the API limit', () => {
    const longValid = 'a'.repeat(MAX_TOOL_NAME_LENGTH + 20); // valid chars, too long
    expect(isValidToolName(longValid)).toBe(true);
    const safe = makeSafeToolName(longValid);
    expect(safe.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
  });

  it('sanitizes AND length-caps an invalid overlong name; never returns empty', () => {
    const safe = makeSafeToolName('!'.repeat(80) + ' bad name ' + 'x'.repeat(80));
    expect(safe.length).toBeGreaterThan(0);
    expect(safe.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    expect(isValidToolName(safe)).toBe(true);
  });
});

describe('findToolByName exact-over-alias', () => {
  const mk = (name: string, aliases?: string[]): ToolDefinition =>
    ({ name, aliases, description: 'd', inputSchema: undefined as never, execute: async () => ({}) }) as ToolDefinition;

  it('an exact NAME match wins over an earlier tool that has it as an alias', () => {
    const aliasHolder = mk('tool_a', ['shared']);
    const realOwner = mk('shared'); // its real name IS the queried name
    const found = findToolByName([aliasHolder, realOwner], 'shared');
    expect(found).toBe(realOwner); // dispatch to the real owner, not the alias holder
  });

  it('still falls back to an alias when no exact name matches', () => {
    const t = mk('tool_b', ['nickname']);
    expect(findToolByName([t], 'nickname')).toBe(t);
  });
});
