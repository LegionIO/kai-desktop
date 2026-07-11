/**
 * Tests for message-sanitizer.ts — strips provider-specific metadata that would
 * otherwise leak across a model switch and get rejected by the next provider.
 * The reference-identity no-op contract matters: callers use `result === input`
 * to skip re-persisting / re-streaming, so each function MUST return the same
 * array (and same message objects) when nothing changed.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeMessagesForModel, stripDisplayOnlyParts, deepSanitizeMessages } from '../message-sanitizer.js';

describe('sanitizeMessagesForModel', () => {
  const target = 'model-B';

  it('leaves user messages untouched even when they carry provider metadata', () => {
    const msgs = [{ role: 'user', content: 'hi', providerOptions: { anthropic: { x: 1 } } }];
    const out = sanitizeMessagesForModel(msgs, target);
    expect(out).toBe(msgs); // same array
    expect(out[0]).toBe(msgs[0]); // same message
  });

  it('keeps assistant metadata when sourceModel matches the target', () => {
    const msgs = [
      {
        role: 'assistant',
        content: 'a',
        providerMetadata: { anthropic: { cacheCreation: 1 } },
        messageMeta: { sourceModel: target },
      },
    ];
    const out = sanitizeMessagesForModel(msgs, target);
    expect(out).toBe(msgs);
    expect(out[0]).toBe(msgs[0]);
  });

  it('strips message-level provider metadata from a mismatched-source assistant message', () => {
    const msgs = [
      {
        role: 'assistant',
        content: 'a',
        providerMetadata: { openai: { y: 2 } },
        providerOptions: { openai: { z: 3 } },
        experimental_providerMetadata: { foo: 1 },
        messageMeta: { sourceModel: 'model-A' },
      },
    ];
    const out = sanitizeMessagesForModel(msgs, target) as Array<Record<string, unknown>>;
    expect(out).not.toBe(msgs); // changed → new array
    expect(out[0].providerMetadata).toBeUndefined();
    expect(out[0].providerOptions).toBeUndefined();
    expect(out[0].experimental_providerMetadata).toBeUndefined();
    expect(out[0].content).toBe('a');
    expect(out[0].messageMeta).toEqual({ sourceModel: 'model-A' }); // messageMeta itself is preserved
    // Original was not mutated.
    expect((msgs[0] as Record<string, unknown>).providerMetadata).toEqual({ openai: { y: 2 } });
  });

  it('strips defensively from an assistant message with no sourceModel tag', () => {
    const msgs = [{ role: 'assistant', content: 'a', providerOptions: { p: 1 } }];
    const out = sanitizeMessagesForModel(msgs, target) as Array<Record<string, unknown>>;
    expect(out).not.toBe(msgs);
    expect(out[0].providerOptions).toBeUndefined();
  });

  it('strips provider metadata nested inside content parts', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi', providerOptions: { a: 1 } },
          { type: 'text', text: 'bye' },
        ],
        messageMeta: { sourceModel: 'model-A' },
      },
    ];
    const out = sanitizeMessagesForModel(msgs, target) as Array<Record<string, unknown>>;
    const parts = out[0].content as Array<Record<string, unknown>>;
    expect(parts[0].providerOptions).toBeUndefined();
    expect(parts[0].text).toBe('hi');
    expect(parts[1]).toEqual({ type: 'text', text: 'bye' });
  });

  it('returns the same array when no assistant message needs cleaning', () => {
    const msgs = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', messageMeta: { sourceModel: target } },
    ];
    expect(sanitizeMessagesForModel(msgs, target)).toBe(msgs);
  });
});

describe('stripDisplayOnlyParts', () => {
  it('drops user file parts flagged displayOnly and keeps the rest', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see attached' },
          { type: 'file', mediaType: 'application/json', displayOnly: true, data: '...' },
          { type: 'file', mediaType: 'image/png', data: 'img' },
        ],
      },
    ];
    const out = stripDisplayOnlyParts(msgs) as Array<Record<string, unknown>>;
    const parts = out[0].content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts.some((p) => p.displayOnly === true)).toBe(false);
    expect(parts[0]).toEqual({ type: 'text', text: 'see attached' });
  });

  it('leaves messages with no displayOnly parts as the same reference', () => {
    const msgs = [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: 'img' }] }];
    expect(stripDisplayOnlyParts(msgs)).toBe(msgs);
  });

  it('ignores non-user messages and non-array content', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'file', displayOnly: true }] },
      { role: 'user', content: 'plain string' },
    ];
    expect(stripDisplayOnlyParts(msgs)).toBe(msgs);
  });

  it('does not mutate the original message', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'file', displayOnly: true },
          { type: 'text', text: 'x' },
        ],
      },
    ];
    stripDisplayOnlyParts(msgs);
    expect((msgs[0].content as unknown[]).length).toBe(2); // original untouched
  });
});

describe('deepSanitizeMessages', () => {
  it('strips provider metadata from every role regardless of source', () => {
    const msgs = [
      { role: 'user', content: 'q', providerOptions: { p: 1 } },
      { role: 'assistant', content: 'a', providerMetadata: { m: 2 }, messageMeta: { sourceModel: 'anything' } },
      { role: 'system', content: 's', experimental_providerMetadata: { e: 3 } },
    ];
    const out = deepSanitizeMessages(msgs) as Array<Record<string, unknown>>;
    expect(out).not.toBe(msgs);
    expect(out[0].providerOptions).toBeUndefined();
    expect(out[1].providerMetadata).toBeUndefined();
    expect(out[1].messageMeta).toEqual({ sourceModel: 'anything' }); // messageMeta not a provider-meta key
    expect(out[2].experimental_providerMetadata).toBeUndefined();
  });

  it('returns the same array when no message carries provider metadata', () => {
    const msgs = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ];
    expect(deepSanitizeMessages(msgs)).toBe(msgs);
  });
});
