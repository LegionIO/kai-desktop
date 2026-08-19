import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolDefinition } from '../../tools/types.js';
import {
  sanitizedMessageDisplayText,
  buildSubAgentTaskMessage,
  validateSubAgentToolInput,
} from '../sub-agent-runner.js';

describe('sanitizedMessageDisplayText', () => {
  it('returns a string message as-is', () => {
    expect(sanitizedMessageDisplayText('hello')).toBe('hello');
  });

  it('extracts text from content-part arrays (DLP redaction shape)', () => {
    expect(sanitizedMessageDisplayText([{ type: 'text', text: '[redacted]' }])).toBe('[redacted]');
    expect(
      sanitizedMessageDisplayText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });

  it('ignores non-text parts', () => {
    expect(
      sanitizedMessageDisplayText([
        { type: 'image', url: 'x' },
        { type: 'text', text: 'ok' },
      ]),
    ).toBe('ok');
  });

  it('fails closed (empty) when no sanitized text can be derived', () => {
    // A hook that removed the message / returned no usable content must NOT
    // fall back to raw text — the caller broadcasts nothing instead.
    expect(sanitizedMessageDisplayText(undefined)).toBe('');
    expect(sanitizedMessageDisplayText(null)).toBe('');
    expect(sanitizedMessageDisplayText([])).toBe('');
    expect(sanitizedMessageDisplayText([{ type: 'image', url: 'x' }])).toBe('');
    expect(sanitizedMessageDisplayText(42)).toBe('');
  });
});

describe('buildSubAgentTaskMessage', () => {
  it('embeds the task', () => {
    expect(buildSubAgentTaskMessage('do X')).toContain('do X');
  });

  it('appends parent context when present', () => {
    const msg = buildSubAgentTaskMessage('do X', 'ctx here');
    expect(msg).toContain('do X');
    expect(msg).toContain('ctx here');
  });
});

describe('validateSubAgentToolInput', () => {
  const tool = {
    name: 'safe_tool',
    description: 'safe',
    inputSchema: z
      .object({ value: z.string().max(5), count: z.number().default(1) })
      .transform(({ value, count }) => ({ value: value.trim(), count })),
    execute: vi.fn(async () => null),
  } satisfies ToolDefinition;

  it('rejects invalid hook replacements and returns schema-transformed arguments', () => {
    expect(() => validateSubAgentToolInput([tool], 'safe_tool', { value: 'too-long' })).toThrow(
      'Invalid arguments for tool "safe_tool".',
    );
    expect(validateSubAgentToolInput([tool], 'safe_tool', { value: ' ok ' })).toEqual({
      value: 'ok',
      count: 1,
    });
    expect(() => validateSubAgentToolInput([tool], 'missing_tool', { value: 'ok' })).toThrow(
      'Invalid arguments for tool "missing_tool".',
    );
  });
});
