import { describe, expect, it } from 'vitest';
import { sanitizedMessageDisplayText, buildSubAgentTaskMessage } from '../sub-agent-runner.js';

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
