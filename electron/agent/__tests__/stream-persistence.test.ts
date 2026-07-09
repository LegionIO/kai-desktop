/**
 * Server-side stream → assistant-message persistence.
 *
 * The CLI/headless client doesn't persist the assistant reply itself, so the
 * main process accumulates the stream and writes the turn on `done`. This
 * verifies text + tool parts merge correctly and that persistence only fires
 * once, with content, on completion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const appendMock = vi.fn();
vi.mock('../../ipc/conversations.js', () => ({
  appendConversationMessages: (...args: unknown[]) => appendMock(...args),
}));

import { accumulateForPersistence, discardPersistenceAccumulator } from '../stream-persistence.js';
import type { StreamEvent } from '../mastra-agent.js';

const APP_HOME = '/tmp/fake-home';
const feed = (e: Partial<StreamEvent>): void => accumulateForPersistence(APP_HOME, e as StreamEvent);

describe('stream persistence accumulator', () => {
  beforeEach(() => appendMock.mockReset());

  it('merges text deltas into one assistant text part on done', () => {
    feed({ conversationId: 'c1', type: 'text-delta', text: 'Hello ' });
    feed({ conversationId: 'c1', type: 'text-delta', text: 'world' });
    feed({ conversationId: 'c1', type: 'done' });

    expect(appendMock).toHaveBeenCalledTimes(1);
    const [home, id, msgs] = appendMock.mock.calls[0];
    expect(home).toBe(APP_HOME);
    expect(id).toBe('c1');
    expect(msgs).toEqual([
      { role: 'assistant', content: [{ type: 'text', source: 'assistant', text: 'Hello world' }] },
    ]);
  });

  it('merges a tool-call and its result into one tool part', () => {
    feed({ conversationId: 'c2', type: 'tool-call', toolCallId: 't1', toolName: 'read_file', args: { path: 'a' } });
    feed({ conversationId: 'c2', type: 'tool-result', toolCallId: 't1', result: 'contents', durationMs: 42 });
    feed({ conversationId: 'c2', type: 'done' });

    const [, , msgs] = appendMock.mock.calls[0];
    expect(msgs[0].content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 't1',
        toolName: 'read_file',
        args: { path: 'a' },
        result: 'contents',
        isError: undefined,
        durationMs: 42,
      },
    ]);
  });

  it('flags tool errors with isError', () => {
    feed({ conversationId: 'c3', type: 'tool-call', toolCallId: 't1', toolName: 'run', args: {} });
    feed({ conversationId: 'c3', type: 'tool-error', toolCallId: 't1', error: 'boom' });
    feed({ conversationId: 'c3', type: 'done' });

    const [, , msgs] = appendMock.mock.calls[0];
    expect((msgs[0].content[0] as { isError?: boolean }).isError).toBe(true);
  });

  it('does not persist an empty turn', () => {
    feed({ conversationId: 'c4', type: 'done' });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('discards a partial accumulation on cancel', () => {
    feed({ conversationId: 'c5', type: 'text-delta', text: 'partial' });
    discardPersistenceAccumulator('c5');
    feed({ conversationId: 'c5', type: 'done' });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('keeps conversations independent', () => {
    feed({ conversationId: 'a', type: 'text-delta', text: 'A' });
    feed({ conversationId: 'b', type: 'text-delta', text: 'B' });
    feed({ conversationId: 'a', type: 'done' });
    feed({ conversationId: 'b', type: 'done' });
    expect(appendMock).toHaveBeenCalledTimes(2);
    expect(appendMock.mock.calls[0][1]).toBe('a');
    expect(appendMock.mock.calls[1][1]).toBe('b');
  });
});
