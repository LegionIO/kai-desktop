import { describe, expect, it } from 'vitest';
import { buildScopedToolName, MAX_TOOL_NAME_LENGTH, isValidToolName } from '../naming';

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
});
