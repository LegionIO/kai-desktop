// @vitest-environment jsdom
/**
 * Tests for `applyNoticeMessage` — the accumulator half of the retry-notice surface.
 *
 * A retry notice is Kai's own bookkeeping about the request, not model output. Two
 * invariants keep it from being mistaken for the assistant's words downstream:
 *   • it lands as a `text` part tagged `source: 'notice'` (NOT plain assistant text).
 *     A bespoke part type is not an option — assistant-ui's converter throws on an
 *     unrecognized part type, whereas extra fields on a text part pass through.
 *   • repeated identical notices collapse, so all four retries of one transient
 *     failure don't stack the same sentence four times.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/ipc-client', () => ({
  app: new Proxy({}, { get: () => () => undefined }),
}));

import { applyNoticeMessage } from '../RuntimeProvider';

type Acc = Parameters<typeof applyNoticeMessage>[0];

function accWithAssistant(): Acc {
  return {
    messages: [
      { id: 'a1', parentId: null, role: 'assistant', content: [] },
    ] as unknown as Acc['messages'],
    headId: 'a1',
  } as Acc;
}

function partsOf(acc: Acc): Array<{ type: string; text?: string; source?: string; noticeDetail?: string }> {
  const msg = acc.messages[acc.messages.length - 1] as unknown as {
    content: Array<{ type: string; text?: string; source?: string; noticeDetail?: string }>;
  };
  return msg.content;
}

describe('applyNoticeMessage', () => {
  it('appends a text part tagged as a notice, carrying the detail', () => {
    const acc = accWithAssistant();
    applyNoticeMessage(acc, 'Kai re-sent the request without temperature.', "Unsupported parameter: 'temperature'");

    const parts = partsOf(acc);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('text');
    expect(parts[0].source).toBe('notice');
    expect(parts[0].text).toBe('Kai re-sent the request without temperature.');
    expect(parts[0].noticeDetail).toBe("Unsupported parameter: 'temperature'");
  });

  it('omits noticeDetail entirely when no detail is supplied', () => {
    const acc = accWithAssistant();
    applyNoticeMessage(acc, 'The request exceeded the context window.');
    expect(partsOf(acc)[0]).not.toHaveProperty('noticeDetail');
  });

  it('ignores a blank or whitespace-only title', () => {
    const acc = accWithAssistant();
    applyNoticeMessage(acc, '   ');
    expect(partsOf(acc)).toHaveLength(0);
  });

  it('collapses a consecutive duplicate notice', () => {
    const acc = accWithAssistant();
    applyNoticeMessage(acc, 'The request failed — retrying in 2s.');
    applyNoticeMessage(acc, 'The request failed — retrying in 2s.');
    applyNoticeMessage(acc, 'The request failed — retrying in 2s.');
    expect(partsOf(acc)).toHaveLength(1);
  });

  it('keeps a DIFFERENT notice that follows one', () => {
    const acc = accWithAssistant();
    applyNoticeMessage(acc, 'The request failed — retrying in 2s.');
    applyNoticeMessage(acc, 'The request exceeded the context window.');
    expect(partsOf(acc)).toHaveLength(2);
  });

  it('does not collapse across intervening assistant text', () => {
    const acc = accWithAssistant();
    applyNoticeMessage(acc, 'Same notice.');
    partsOf(acc).push({ type: 'text', source: 'assistant', text: 'Here is the answer.' });
    applyNoticeMessage(acc, 'Same notice.');
    // The notice is genuinely recurring around real output — keep both.
    expect(partsOf(acc).filter((p) => p.source === 'notice')).toHaveLength(2);
  });

  it('leaves preceding assistant text untouched', () => {
    const acc = accWithAssistant();
    partsOf(acc).push({ type: 'text', source: 'assistant', text: 'Partial answer' });
    applyNoticeMessage(acc, 'Kai re-sent the request.');

    const parts = partsOf(acc);
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe('Partial answer');
    expect(parts[0].source).toBe('assistant');
    // No blank-line padding baked into the notice text — the chip supplies its own spacing.
    expect(parts[1].text).toBe('Kai re-sent the request.');
  });
});
