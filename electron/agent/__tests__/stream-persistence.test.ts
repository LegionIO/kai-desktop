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
const readMock = vi.fn((_appHome?: string, _conversationId?: string) => null as { headId?: string | null } | null);
vi.mock('../../ipc/conversations.js', () => ({
  // Return a minimal record whose headId is the id of the appended assistant
  // message, so finalizeInterruptedTurn's "return the new head" contract can be
  // asserted. Real appendConversationMessages sets headId to the last node.
  appendConversationMessages: (...args: unknown[]) => {
    const customResult = appendMock(...args);
    return customResult ?? { headId: 'persisted-head' };
  },
  broadcastUpsert: vi.fn(),
}));
vi.mock('../../ipc/conversation-store.js', () => ({
  readConversation: (appHome: string, conversationId: string) => readMock(appHome, conversationId),
  writeConversation: vi.fn(),
}));

import {
  accumulateForPersistence,
  discardPersistenceAccumulator,
  finalizeInterruptedTurn,
  persistCooperativeInjectedUserTurn,
} from '../stream-persistence.js';
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

  it('persists the shared Kai/Mastra response id when the stream provides it', () => {
    feed({ conversationId: 'shared-id', type: 'text-delta', text: 'Hello', responseMessageId: 'msg-shared-1' });
    feed({ conversationId: 'shared-id', type: 'done', responseMessageId: 'msg-shared-1' });

    const [, , msgs] = appendMock.mock.calls[0];
    expect(msgs).toEqual([
      {
        id: 'msg-shared-1',
        role: 'assistant',
        content: [{ type: 'text', source: 'assistant', text: 'Hello' }],
      },
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

  it('model-fallback with preserveErroredVariant commits the partial as a sibling and re-seeds under the same parent', () => {
    // Attempt 1 streams partial content, then a transient mid-stream fallback.
    feedWithParent(
      {
        conversationId: 'v1',
        type: 'text-delta',
        text: 'partial from model A',
        responseMessageId: 'msg-failed-variant',
      },
      'user-node',
    );
    feedWithParent(
      {
        conversationId: 'v1',
        type: 'model-fallback',
        error: 'internal server error',
        responseMessageId: 'msg-failed-variant',
        data: { preserveErroredVariant: true, error: 'internal server error' },
      },
      'user-node',
    );
    // The errored partial was committed as its own sibling right away.
    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, , firstMsgs, firstOpts] = appendMock.mock.calls[0];
    expect(firstMsgs[0].id).toBe('msg-failed-variant');
    const firstText = (firstMsgs[0].content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(firstText).toContain('partial from model A');
    expect(firstText).toContain('internal server error'); // error annotation preserved
    expect(firstOpts.parentId).toBe('user-node');
    // The retry is still in flight — the intermediate variant must stay 'running'
    // so a concurrent automation can't fork the branch mid-fallback.
    expect(firstOpts.runStatus).toBe('running');

    // Attempt 2 (retry on model B) streams the successful reply + done.
    feedWithParent(
      {
        conversationId: 'v1',
        type: 'text-delta',
        text: 'full reply from model B',
        responseMessageId: 'msg-success-variant',
      },
      'user-node',
    );
    feedWithParent({ conversationId: 'v1', type: 'done', responseMessageId: 'msg-success-variant' }, 'user-node');

    expect(appendMock).toHaveBeenCalledTimes(2);
    const [, , secondMsgs, secondOpts] = appendMock.mock.calls[1];
    expect(secondMsgs[0].id).toBe('msg-success-variant');
    const secondText = (secondMsgs[0].content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(secondText).toContain('full reply from model B');
    expect(secondText).not.toContain('partial from model A'); // fresh accumulator
    // Both variants are siblings under the SAME parent.
    expect(secondOpts.parentId).toBe('user-node');
    // The successful final turn resets to idle (retry finished).
    expect(secondOpts.runStatus).toBe('idle');
  });

  it('model-fallback with discardPartialAssistant drops the partial (no sibling persisted)', () => {
    feedWithParent({ conversationId: 'v2', type: 'text-delta', text: 'to be discarded' }, 'user-node');
    feedWithParent(
      { conversationId: 'v2', type: 'model-fallback', data: { discardPartialAssistant: true } },
      'user-node',
    );
    // Nothing persisted yet (partial dropped, not committed as a sibling).
    expect(appendMock).not.toHaveBeenCalled();
    feedWithParent({ conversationId: 'v2', type: 'text-delta', text: 'clean retry' }, 'user-node');
    feedWithParent({ conversationId: 'v2', type: 'done' }, 'user-node');
    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, , msgs] = appendMock.mock.calls[0];
    const text = (msgs[0].content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text).toBe('clean retry');
  });
});

describe('finalizeInterruptedTurn (mid-turn follow-up injection)', () => {
  beforeEach(() => appendMock.mockReset());

  it('persists the in-progress partial (text + tools) and returns the new head id', () => {
    feedWithParent({ conversationId: 'i1', type: 'text-delta', text: 'thinking…' }, 'user-1');
    feed({ conversationId: 'i1', type: 'tool-call', toolCallId: 't1', toolName: 'read_file', args: { path: 'a' } });
    feed({ conversationId: 'i1', type: 'tool-result', toolCallId: 't1', result: 'contents' });

    const head = finalizeInterruptedTurn(APP_HOME, 'i1');

    expect(head).toBe('persisted-head');
    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, id, msgs, options] = appendMock.mock.calls[0];
    expect(id).toBe('i1');
    // Both the partial text AND the tool call are preserved (not discarded).
    expect(msgs[0].content).toEqual([
      { type: 'text', source: 'assistant', text: 'thinking…' },
      {
        type: 'tool-call',
        toolCallId: 't1',
        toolName: 'read_file',
        args: { path: 'a' },
        result: 'contents',
        isError: undefined,
        durationMs: undefined,
      },
    ]);
    // Parented on the submit-time head, runStatus reset.
    expect(options).toEqual({ runStatus: 'idle', parentId: 'user-1' });
  });

  it('clears the accumulator so a later done cannot double-persist', () => {
    feed({ conversationId: 'i2', type: 'text-delta', text: 'partial' });
    finalizeInterruptedTurn(APP_HOME, 'i2');
    expect(appendMock).toHaveBeenCalledTimes(1);
    // The superseded run's trailing done (or the fresh run's discard) finds nothing.
    feed({ conversationId: 'i2', type: 'done' });
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('returns null and persists nothing when there is no accumulated content', () => {
    const head = finalizeInterruptedTurn(APP_HOME, 'i3-never-started');
    expect(head).toBeNull();
    expect(appendMock).not.toHaveBeenCalled();
  });
});

describe('persistCooperativeInjectedUserTurn (CLI/server-persisted cooperative inject)', () => {
  beforeEach(() => {
    appendMock.mockReset();
    readMock.mockReset();
    readMock.mockReturnValue({ headId: 'original-user' });
  });

  it('persists partial assistant first, then parents injected user on that partial', () => {
    // A CLI-owned turn is accumulating under the original user prompt.
    feedWithParent({ conversationId: 'ci1', type: 'text-delta', text: 'partial work' }, 'original-user');

    appendMock
      // finalizeInterruptedTurn writes the partial assistant and returns its id.
      .mockReturnValueOnce({ headId: 'partial-assistant' })
      // injected-user append succeeded (the helper supplies its own stable id).
      .mockReturnValueOnce({ headId: 'stored-injected-head' });

    const result = persistCooperativeInjectedUserTurn(APP_HOME, 'ci1', 'my follow up');

    expect(result?.messageId).toMatch(/^inject-msg-/);
    expect(result?.parentId).toBe('partial-assistant');
    expect(typeof result?.createdAt).toBe('string');
    expect(appendMock).toHaveBeenCalledTimes(2);

    const [, , partialMsgs, partialOpts] = appendMock.mock.calls[0];
    expect(partialMsgs).toEqual([
      { role: 'assistant', content: [{ type: 'text', source: 'assistant', text: 'partial work' }] },
    ]);
    expect(partialOpts).toEqual({ runStatus: 'idle', parentId: 'original-user' });

    const [, , injectedMsgs, injectedOpts] = appendMock.mock.calls[1];
    expect(injectedMsgs).toHaveLength(1);
    expect(injectedMsgs[0]).toMatchObject({
      id: result?.messageId,
      role: 'user',
      content: [{ type: 'text', text: 'my follow up' }],
      createdAt: result?.createdAt,
    });
    expect(injectedOpts).toEqual({ runStatus: 'running', parentId: 'partial-assistant' });

    // The running turn continues after prepareStep consumed the inject. A fresh
    // accumulator is seeded with the injected USER as its parent, so final done
    // appends the continuation assistant after the user — not as a sibling.
    feedWithParent({ conversationId: 'ci1', type: 'text-delta', text: 'addressed follow up' }, result!.messageId);
    feedWithParent({ conversationId: 'ci1', type: 'done' }, result!.messageId);
    expect(appendMock).toHaveBeenCalledTimes(3);
    const [, , continuationMsgs, continuationOpts] = appendMock.mock.calls[2];
    expect(continuationMsgs).toEqual([
      { role: 'assistant', content: [{ type: 'text', source: 'assistant', text: 'addressed follow up' }] },
    ]);
    expect(continuationOpts).toEqual({ runStatus: 'idle', parentId: result!.messageId });
  });

  it('uses the current store head when no partial assistant was accumulated', () => {
    appendMock.mockReturnValueOnce({ headId: 'stored-injected-head' });

    const result = persistCooperativeInjectedUserTurn(APP_HOME, 'ci2', 'late follow up');

    expect(result?.messageId).toMatch(/^inject-msg-/);
    expect(result?.parentId).toBe('original-user');
    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, , , options] = appendMock.mock.calls[0];
    expect(options).toEqual({ runStatus: 'running' });
  });
});
