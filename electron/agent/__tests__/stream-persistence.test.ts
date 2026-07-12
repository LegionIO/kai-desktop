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
const feedWithParent = (e: Partial<StreamEvent>, parentId?: string): void =>
  accumulateForPersistence(APP_HOME, e as StreamEvent, parentId);

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

  it('preserves compaction metadata on a compacted tool result', () => {
    feed({ conversationId: 'cc', type: 'tool-call', toolCallId: 't1', toolName: 'read_file', args: { path: 'big' } });
    feed({
      conversationId: 'cc',
      type: 'tool-result',
      toolCallId: 't1',
      result: 'SUMMARY',
      durationMs: 10,
      compaction: { originalContent: 'FULL ORIGINAL OUTPUT', wasCompacted: true, extractionDurationMs: 5 },
    });
    feed({ conversationId: 'cc', type: 'done' });

    const [, , msgs] = appendMock.mock.calls[0];
    const part = msgs[0].content[0];
    expect(part.result).toBe('SUMMARY');
    expect(part.originalResult).toBe('FULL ORIGINAL OUTPUT');
    expect(part.compactionMeta).toEqual({ wasCompacted: true, extractionDurationMs: 5 });
    expect(part.compactionPhase).toBe('complete');
  });

  it('flags tool errors with isError and preserves the error payload', () => {
    feed({ conversationId: 'c3', type: 'tool-call', toolCallId: 't1', toolName: 'run', args: {} });
    feed({ conversationId: 'c3', type: 'tool-error', toolCallId: 't1', error: 'boom' });
    feed({ conversationId: 'c3', type: 'done' });

    const [, , msgs] = appendMock.mock.calls[0];
    const part = msgs[0].content[0] as { isError?: boolean; result?: { isError?: boolean; error?: string } };
    expect(part.isError).toBe(true);
    expect(part.result).toEqual({ isError: true, error: 'boom' });
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

  it('parents the persisted reply on the submit-time head, captured at first event', () => {
    // parentId is bound on the FIRST accumulation and is immune to a later
    // head change (rewind/edit/variant) — a subsequent event omitting it, or
    // passing a different one, must not move the reply off its answered turn.
    feedWithParent({ conversationId: 'p1', type: 'text-delta', text: 'hi' }, 'user-node-42');
    feedWithParent({ conversationId: 'p1', type: 'text-delta', text: '!' }, 'stale-head-99');
    feedWithParent({ conversationId: 'p1', type: 'done' }, 'stale-head-99');

    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, , , options] = appendMock.mock.calls[0];
    expect(options).toEqual({ runStatus: 'idle', parentId: 'user-node-42' });
  });

  it('omits parentId (but still resets runStatus) when no submit-time head was captured', () => {
    feed({ conversationId: 'p2', type: 'text-delta', text: 'x' });
    feed({ conversationId: 'p2', type: 'done' });
    const [, , , options] = appendMock.mock.calls[0];
    expect(options).toEqual({ runStatus: 'idle' });
    expect(options.parentId).toBeUndefined();
  });

  it('appends an error note to the turn but only persists once, on the trailing done', () => {
    feed({ conversationId: 'e1', type: 'text-delta', text: 'partial' });
    feed({ conversationId: 'e1', type: 'error', error: 'boom' });
    // error does NOT persist (it may be mid-stream); the turn persists on done.
    expect(appendMock).not.toHaveBeenCalled();
    feed({ conversationId: 'e1', type: 'done' });
    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, , msgs] = appendMock.mock.calls[0];
    const text = (msgs[0].content as Array<{ type: string; text?: string }>).find((p) => p.type === 'text')?.text;
    expect(text).toContain('partial');
    expect(text).toContain('**Error:** boom');
  });

  it('does not double-persist when a mid-stream error is followed by more content + done', () => {
    feed({ conversationId: 'e2', type: 'text-delta', text: 'a' });
    feed({ conversationId: 'e2', type: 'error', error: 'transient' });
    feed({ conversationId: 'e2', type: 'text-delta', text: 'b' }); // stream continued
    feed({ conversationId: 'e2', type: 'done' });
    expect(appendMock).toHaveBeenCalledTimes(1); // single persist, no premature write on error
    const [, , msgs] = appendMock.mock.calls[0];
    const text = (msgs[0].content as Array<{ type: string; text?: string }>).find((p) => p.type === 'text')?.text;
    expect(text).toContain('a');
    expect(text).toContain('b'); // content after the error is preserved
  });

  it('discardPersistenceAccumulator releases an accumulator with no trailing done (no leak)', () => {
    feed({ conversationId: 'e3', type: 'text-delta', text: 'orphan' });
    feed({ conversationId: 'e3', type: 'error', error: 'fatal, no done follows' });
    // Simulate the stream loop's finally cleanup on an abnormal (done-less) end.
    discardPersistenceAccumulator('e3');
    // A late/duplicate done now finds nothing → no persist (accumulator was released).
    feed({ conversationId: 'e3', type: 'done' });
    expect(appendMock).not.toHaveBeenCalled();
  });
});
