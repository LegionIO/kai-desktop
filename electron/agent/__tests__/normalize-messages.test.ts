/**
 * Tests for normalizeMessagesForApi (electron/agent/normalize-messages.ts) —
 * converts renderer StoredMessages into AI SDK V4 CoreMessage format before the
 * model call. A bug here produces malformed provider requests (orphaned
 * tool_use blocks, undefined ids) that the API rejects with 400s. The
 * highest-stakes rule locked here: a tool-call missing its toolCallId/toolName
 * is dropped ENTIRELY (call + result) rather than emitted with undefined ids.
 */
import { describe, it, expect } from 'vitest';
import { normalizeMessagesForApi } from '../normalize-messages.js';

describe('normalizeMessagesForApi — role handling', () => {
  it('drops entries with no role or non-object shape', () => {
    const out = normalizeMessagesForApi([null, undefined, 42, { content: 'x' }, { role: 'user', content: 'keep' }]);
    expect(out).toEqual([{ role: 'user', content: 'keep' }]);
  });

  it('passes system and tool messages through unchanged', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 't', result: 'r' }] },
    ];
    expect(normalizeMessagesForApi(msgs)).toEqual(msgs);
  });

  it('passes an unknown role through unchanged', () => {
    expect(normalizeMessagesForApi([{ role: 'developer', content: 'x' }])).toEqual([
      { role: 'developer', content: 'x' },
    ]);
  });
});

describe('normalizeMessagesForApi — user messages', () => {
  it('passes string content through', () => {
    expect(normalizeMessagesForApi([{ role: 'user', content: 'hi' }])).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('keeps text/image/file parts and drops displayOnly files + renderer-only types', () => {
    const out = normalizeMessagesForApi([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'q' },
          { type: 'image', image: 'img', mimeType: 'image/png' },
          { type: 'file', data: 'd', mimeType: 'application/pdf' },
          { type: 'file', data: 'j', mimeType: 'application/json', displayOnly: true }, // dropped
          { type: 'enrichment', foo: 1 }, // renderer-only → dropped
        ],
      },
    ]);
    const parts = out[0].content as Array<Record<string, unknown>>;
    expect(parts).toEqual([
      { type: 'text', text: 'q' },
      { type: 'image', image: 'img', mimeType: 'image/png' },
      { type: 'file', data: 'd', mimeType: 'application/pdf' },
    ]);
  });

  it('drops a user message whose parts all filter out (empty content)', () => {
    const out = normalizeMessagesForApi([
      { role: 'user', content: [{ type: 'enrichment' }, { type: 'file', data: 'x', displayOnly: true }] },
    ]);
    expect(out).toEqual([]);
  });

  it('infers image mimeType from a data: URL when not provided', () => {
    const out = normalizeMessagesForApi([
      { role: 'user', content: [{ type: 'image', image: 'data:image/gif;base64,AAAA' }] },
    ]);
    const parts = out[0].content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'image', image: 'data:image/gif;base64,AAAA', mimeType: 'image/gif' });
  });
});

describe('normalizeMessagesForApi — assistant tool-call splitting', () => {
  it('splits a tool-call+result into an assistant tool-call and a separate tool message', () => {
    const out = normalizeMessagesForApi([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search', args: { q: 'x' }, result: 'found' },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search', args: { q: 'x' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'search', result: 'found' }],
      },
    ]);
  });

  it('defaults args to {} and substitutes a placeholder for a missing result', () => {
    const out = normalizeMessagesForApi([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 't' }] },
    ]);
    const asst = out[0].content as Array<Record<string, unknown>>;
    expect(asst[0]).toEqual({ type: 'tool-call', toolCallId: 'c1', toolName: 't', args: {} });
    const tool = out[1].content as Array<Record<string, unknown>>;
    expect(tool[0].result).toBe('Tool execution did not complete.');
  });

  it('SKIPS a tool-call missing toolCallId or toolName (drops the whole pair, no undefined ids)', () => {
    const out = normalizeMessagesForApi([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolName: 't', result: 'r' }, // no toolCallId
          { type: 'tool-call', toolCallId: 'c2', result: 'r' }, // no toolName
        ],
      },
    ]);
    // Both malformed → no assistant tool-call parts, no tool message at all.
    expect(out).toEqual([]);
  });

  it('emits only the tool message when the assistant has no text and one valid tool-call', () => {
    const out = normalizeMessagesForApi([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 't', result: 'r' }] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('assistant'); // the tool-call part
    expect(out[1].role).toBe('tool');
  });

  it('drops empty assistant text and passes string content through', () => {
    expect(normalizeMessagesForApi([{ role: 'assistant', content: 'plain answer' }])).toEqual([
      { role: 'assistant', content: 'plain answer' },
    ]);
    // An assistant array with only an empty-text part yields no message.
    expect(normalizeMessagesForApi([{ role: 'assistant', content: [{ type: 'text', text: '' }] }])).toEqual([]);
  });

  it('preserves image/file parts on an assistant message', () => {
    const out = normalizeMessagesForApi([
      {
        role: 'assistant',
        content: [
          { type: 'image', image: 'x' },
          { type: 'text', text: 'see' },
        ],
      },
    ]);
    const parts = out[0].content as Array<Record<string, unknown>>;
    expect(parts.some((p) => p.type === 'image')).toBe(true);
    expect(parts.some((p) => p.type === 'text')).toBe(true);
  });
});
