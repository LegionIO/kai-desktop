import { describe, expect, it } from 'vitest';
import { normalizeMessagesForApi } from '../normalize-messages.js';

describe('normalizeMessagesForApi', () => {
  it('preserves image parts with their MIME type', () => {
    const normalized = normalizeMessagesForApi([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Can you read this?' },
          { type: 'image', image: 'data:image/png;base64,abc123', mimeType: 'image/png' },
        ],
      },
    ]);

    expect(normalized).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Can you read this?' },
          { type: 'image', image: 'data:image/png;base64,abc123', mimeType: 'image/png' },
        ],
      },
    ]);
  });

  it('infers missing image MIME types from data URLs', () => {
    const normalized = normalizeMessagesForApi([
      {
        role: 'user',
        content: [
          { type: 'image', image: 'data:image/jpeg;base64,abc123' },
        ],
      },
    ]);

    expect(normalized).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', image: 'data:image/jpeg;base64,abc123', mimeType: 'image/jpeg' },
        ],
      },
    ]);
  });
});
