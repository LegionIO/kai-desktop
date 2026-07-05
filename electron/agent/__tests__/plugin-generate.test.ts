import { describe, expect, it } from 'vitest';
import { sanitizePluginMessages } from '../plugin-message-sanitizer.js';

describe('sanitizePluginMessages', () => {
  it('preserves native tool-call and tool-result history in sequence', () => {
    const messages = sanitizePluginMessages([
      { role: 'user', content: 'Can you find xyz? yes/no only' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'search-1',
            toolName: 'search',
            args: { query: 'xyz' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'search-1',
            toolName: 'search',
            result: { found: true, location: 'spot A' },
          },
        ],
      },
      { role: 'assistant', content: 'yes' },
      { role: 'user', content: 'Where?' },
    ]);

    expect(messages).toEqual([
      { role: 'user', content: 'Can you find xyz? yes/no only' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'search-1',
            toolName: 'search',
            args: { query: 'xyz' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'search-1',
            toolName: 'search',
            result: { found: true, location: 'spot A' },
          },
        ],
      },
      { role: 'assistant', content: 'yes' },
      { role: 'user', content: 'Where?' },
    ]);
  });

  it('splits regular stored tool-call parts containing results', () => {
    const messages = sanitizePluginMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'search-1',
            toolName: 'search',
            args: { query: 'xyz' },
            result: { found: true, location: 'spot A' },
          },
          { type: 'text', text: 'yes' },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'search-1',
            toolName: 'search',
            args: { query: 'xyz' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'search-1',
            toolName: 'search',
            result: { found: true, location: 'spot A' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'yes' }],
      },
    ]);
  });
});
