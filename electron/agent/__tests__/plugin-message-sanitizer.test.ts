/**
 * Tests for plugin-message-sanitizer.ts — validates + normalizes plugin-provided
 * conversation history into the shape the agent path accepts, without flattening
 * native tool messages. Plugin content is a trust boundary: a bug here either
 * drops valid history or lets a malformed part reach the provider. Pure function.
 */
import { describe, it, expect } from 'vitest';
import { sanitizePluginMessages } from '../plugin-message-sanitizer.js';

describe('sanitizePluginMessages', () => {
  it('drops messages with an unrecognized role', () => {
    const out = sanitizePluginMessages([
      { role: 'developer', content: 'x' },
      { role: 'user', content: 'keep' },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'keep' }]);
  });

  describe('string content', () => {
    it('keeps non-empty user/assistant/system strings', () => {
      const out = sanitizePluginMessages([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
        { role: 'system', content: 'sys' },
      ]);
      expect(out).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
        { role: 'system', content: 'sys' },
      ]);
    });

    it('drops blank strings and a string-content tool message', () => {
      const out = sanitizePluginMessages([
        { role: 'user', content: '   ' },
        { role: 'tool', content: 'orphan result string' },
        { role: 'assistant', content: 'kept' },
      ]);
      expect(out).toEqual([{ role: 'assistant', content: 'kept' }]);
    });

    it('drops non-string, non-array content', () => {
      const out = sanitizePluginMessages([
        { role: 'user', content: 42 },
        { role: 'user', content: null },
      ]);
      expect(out).toEqual([]);
    });
  });

  describe('tool role (array content)', () => {
    it('keeps valid tool-result parts and drops those missing toolCallId/toolName', () => {
      const out = sanitizePluginMessages([
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c1', toolName: 't', result: 'ok' },
            { type: 'tool-result', toolCallId: '', toolName: 't', result: 'bad' }, // empty id → dropped
            { type: 'tool-result', toolName: 't', result: 'bad' }, // no id → dropped
            { type: 'text', text: 'not a tool-result' }, // wrong type → filtered out
          ],
        },
      ]);
      expect(out).toEqual([
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 't', result: 'ok' }] },
      ]);
    });

    it('substitutes a default string when result is undefined and preserves isError', () => {
      const out = sanitizePluginMessages([
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 't', isError: true }],
        },
      ]);
      expect(out).toEqual([
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 't',
              result: 'Tool execution did not complete.',
              isError: true,
            },
          ],
        },
      ]);
    });

    it('emits nothing when a tool message has no valid results', () => {
      const out = sanitizePluginMessages([{ role: 'tool', content: [{ type: 'text', text: 'x' }] }]);
      expect(out).toEqual([]);
    });
  });

  describe('system role (array content)', () => {
    it('joins text parts with newlines and trims', () => {
      const out = sanitizePluginMessages([
        {
          role: 'system',
          content: [
            { type: 'text', text: 'line1' },
            { type: 'image', image: 'ignored' },
            { type: 'text', text: 'line2' },
          ],
        },
      ]);
      expect(out).toEqual([{ role: 'system', content: 'line1\nline2' }]);
    });

    it('drops a system message whose text parts are all empty', () => {
      const out = sanitizePluginMessages([{ role: 'system', content: [{ type: 'image', image: 'x' }] }]);
      expect(out).toEqual([]);
    });
  });

  describe('user/assistant array content', () => {
    it('collects text and image parts, dropping empty text and attaching mimeType when present', () => {
      const out = sanitizePluginMessages([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: '' }, // empty → dropped
            { type: 'image', image: 'data', mimeType: 'image/png' },
            { type: 'image', image: 'nomime' },
          ],
        },
      ]);
      expect(out).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', image: 'data', mimeType: 'image/png' },
            { type: 'image', image: 'nomime' },
          ],
        },
      ]);
    });

    it('ignores a tool-call part on a user message (only assistant may carry tool-calls)', () => {
      const out = sanitizePluginMessages([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'q' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 't', args: {} },
          ],
        },
      ]);
      expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'q' }] }]);
    });

    it('keeps an assistant tool-call and defaults args to {}', () => {
      const out = sanitizePluginMessages([
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 't' }],
        },
      ]);
      expect(out).toEqual([
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 't', args: {} }] },
      ]);
    });

    it('splits an assistant tool-call carrying an inline result into assistant + tool messages in order', () => {
      const out = sanitizePluginMessages([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 't', args: { q: 1 }, result: 'the answer' },
          ],
        },
      ]);
      // text + tool-call flush as one assistant message, then the extracted result
      // becomes a separate tool message immediately after.
      expect(out).toEqual([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 't', args: { q: 1 } },
          ],
        },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 't', result: 'the answer' }] },
      ]);
    });

    it('drops an assistant tool-call missing its toolName', () => {
      const out = sanitizePluginMessages([
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', args: {} }],
        },
      ]);
      expect(out).toEqual([]);
    });

    it('emits nothing when an array message yields no usable parts', () => {
      const out = sanitizePluginMessages([{ role: 'user', content: [{ type: 'unknown' }] }]);
      expect(out).toEqual([]);
    });
  });
});
