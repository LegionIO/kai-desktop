import { MessageList, type MastraDBMessage } from '@mastra/core/agent';
import { describe, expect, it } from 'vitest';
import {
  createRecentHistoryReconciler,
  findDuplicateRememberedMessageIds,
  recentHistoryFingerprint,
} from '../recent-history-reconciler.js';

function dbMessage(options: {
  id: string;
  role?: 'user' | 'assistant';
  text?: string;
  at?: string;
  parts?: MastraDBMessage['content']['parts'];
}): MastraDBMessage {
  return {
    id: options.id,
    role: options.role ?? 'assistant',
    createdAt: new Date(options.at ?? '2026-07-20T12:00:00.000Z'),
    content: {
      format: 2,
      parts: options.parts ?? [{ type: 'text', text: options.text ?? '' }],
    },
  };
}

describe('recent history reconciler', () => {
  it('ignores provider bookkeeping while fingerprinting meaningful content', () => {
    const remembered = dbMessage({
      id: 'mastra-output',
      text: 'Hello',
      parts: [
        {
          type: 'text',
          text: 'Hello',
          providerMetadata: { openai: { itemId: 'provider-item' } },
          createdAt: 123,
        },
      ],
    });
    const input = dbMessage({ id: 'kai-output', text: 'Hello' });

    expect(recentHistoryFingerprint(remembered)).toBe(recentHistoryFingerprint(input));
  });

  it('removes a legacy assistant copy with a different id when timestamps corroborate it', () => {
    const remembered = dbMessage({ id: 'mastra-output', text: 'Hello', at: '2026-07-20T12:00:02.000Z' });
    const input = dbMessage({ id: 'kai-output', text: 'Hello', at: '2026-07-20T12:00:01.000Z' });

    expect(findDuplicateRememberedMessageIds([remembered], [input])).toEqual(['mastra-output']);
  });

  it('retains an isolated content coincidence without a nearby timestamp or stable alias', () => {
    const remembered = dbMessage({ id: 'memory-only', text: 'OK', at: '2026-07-19T12:00:00.000Z' });
    const input = dbMessage({ id: 'new-turn', text: 'OK', at: '2026-07-20T12:00:00.000Z' });

    expect(findDuplicateRememberedMessageIds([remembered], [input])).toEqual([]);
  });

  it('uses ordered overlap to reconcile legacy sequences even when persisted timestamps drifted', () => {
    const remembered = [
      dbMessage({ id: 'm1', text: 'First distinct answer', at: '2026-07-18T12:00:00.000Z' }),
      dbMessage({ id: 'm2', text: 'Second distinct answer', at: '2026-07-18T12:01:00.000Z' }),
    ];
    const input = [
      dbMessage({ id: 'k1', text: 'First distinct answer', at: '2026-07-20T12:00:00.000Z' }),
      dbMessage({ id: 'k2', text: 'Second distinct answer', at: '2026-07-20T12:01:00.000Z' }),
    ];

    expect(findDuplicateRememberedMessageIds(remembered, input)).toEqual(['m1', 'm2']);
  });

  it('counts repeated replies instead of globally collapsing every equal string', () => {
    const remembered = [
      dbMessage({ id: 'm1', text: 'You are welcome', at: '2026-07-20T12:00:01.000Z' }),
      dbMessage({ id: 'm2', text: 'You are welcome', at: '2026-07-20T12:01:01.000Z' }),
      dbMessage({ id: 'memory-only-extra', text: 'You are welcome', at: '2026-07-18T12:02:01.000Z' }),
    ];
    const input = [
      dbMessage({ id: 'k1', text: 'You are welcome', at: '2026-07-20T12:00:00.000Z' }),
      dbMessage({ id: 'k2', text: 'You are welcome', at: '2026-07-20T12:01:00.000Z' }),
    ];

    const duplicates = findDuplicateRememberedMessageIds(remembered, input);
    expect(duplicates).toHaveLength(2);
    expect(new Set(remembered.map((message) => message.id).filter((id) => !duplicates.includes(id))).size).toBe(1);
  });

  it('treats a shared tool-call id as a stable duplicate alias despite presentation differences', () => {
    const remembered = dbMessage({
      id: 'mastra-tool-output',
      at: '2026-07-18T12:00:00.000Z',
      parts: [
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'result',
            toolCallId: 'call-42',
            toolName: 'shell',
            args: { command: 'pwd' },
            result: '/tmp',
          },
        },
      ],
    });
    const input = dbMessage({
      id: 'kai-tool-output',
      at: '2026-07-20T12:00:00.000Z',
      parts: [
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'call',
            toolCallId: 'call-42',
            toolName: 'shell',
            args: { command: 'pwd' },
          },
        },
      ],
    });

    expect(findDuplicateRememberedMessageIds([remembered], [input])).toEqual(['mastra-tool-output']);
  });

  it('removes only remembered copies from the MessageList processor', () => {
    const remembered = dbMessage({
      id: 'mastra-output',
      at: '2026-07-20T12:00:02.000Z',
      parts: [
        {
          type: 'text',
          text: 'Hello',
          providerMetadata: { openai: { itemId: 'provider-output-id' } },
        },
      ],
    });
    const input = dbMessage({ id: 'kai-output', text: 'Hello', at: '2026-07-20T12:00:01.000Z' });
    const memoryOnly = dbMessage({ id: 'memory-only', text: 'Different message', at: '2026-07-20T11:59:00.000Z' });
    // Mastra starts with caller input, then its memory processor appends recalled
    // rows before Kai's configured reconciler runs.
    const messageList = new MessageList().add(input, 'input').add([remembered, memoryOnly], 'memory');
    const processor = createRecentHistoryReconciler();

    processor.processInput!({ messageList } as never);

    expect(messageList.get.remembered.db().map((message) => message.id)).toEqual(['memory-only']);
    expect(messageList.get.input.db().map((message) => message.id)).toEqual(['kai-output']);
  });
});
