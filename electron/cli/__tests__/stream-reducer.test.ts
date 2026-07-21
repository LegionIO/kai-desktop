/**
 * Tests for the pure CLI stream reducer (electron/cli/stream-reducer.ts).
 *
 * These reproduce the peer-turn sequences behind the open regressions:
 *   #217 — a GUI-driven (peer) turn's response should stream + finalize on a
 *          co-viewing CLI (user prompt shows but response didn't).
 *   #218 — a peer turn's tool row should not stay "running" forever.
 * The reducer mirrors app.tsx's inline switch; if the fold were wrong, these
 * would catch it. (They currently PASS — confirming the transcript fold itself
 * is correct, which points the live bug at the React/Ink render layer rather
 * than the state logic. See memory: cli_stream_reducer_untestable.)
 */
import { describe, it, expect } from 'vitest';
import {
  reduceCliStreamEvent,
  initialCliStreamState,
  toolTurnOpensAssistantTurn,
  assistantBlockNeedsHeader,
  formatSubAgentStatusNote,
  type CliStreamState,
  type CliStreamEvent,
  type CliTurn,
} from '../stream-reducer.js';

function run(events: CliStreamEvent[], start?: CliStreamState): CliStreamState {
  return events.reduce((s, e) => reduceCliStreamEvent(s, e), start ?? initialCliStreamState());
}

describe('reduceCliStreamEvent — own-echo dedup', () => {
  it('skips our own user-message echo (matching nonce) and consumes the nonce', () => {
    const start: CliStreamState = { ...initialCliStreamState(), ownNonces: new Set(['n1']) };
    const s = reduceCliStreamEvent(start, { type: 'user-message', text: 'hi', data: { submitNonce: 'n1' } });
    // No user turn added (we already showed it optimistically), nonce consumed.
    expect(s.turns).toHaveLength(0);
    expect(s.ownNonces.has('n1')).toBe(false);
  });

  it('renders a PEER user-message (no matching nonce) as a user turn + goes running', () => {
    const s = reduceCliStreamEvent(initialCliStreamState(), { type: 'user-message', text: 'how are you?' });
    expect(s.turns).toEqual([{ kind: 'user', text: 'how are you?' }]);
    expect(s.status).toBe('running');
    expect(s.turnSettled).toBe(false);
  });

  it('re-arms a drain-at-end continuation without duplicating the persisted user turn', () => {
    const start: CliStreamState = {
      ...initialCliStreamState(),
      turns: [{ kind: 'user', text: 'late follow-up' }],
      status: 'idle',
      turnSettled: true,
    };
    const s = reduceCliStreamEvent(start, {
      type: 'user-message',
      text: 'late follow-up',
      data: { continuation: true },
    });
    expect(s.turns).toEqual([{ kind: 'user', text: 'late follow-up' }]);
    expect(s.status).toBe('running');
    expect(s.turnSettled).toBe(false);
  });
});

describe('reduceCliStreamEvent — peer-turn response streaming (#217)', () => {
  it('streams text-deltas into `streaming` and finalizes to an assistant turn on done', () => {
    const s = run([
      { type: 'user-message', text: 'hello' },
      { type: 'text-delta', text: 'Hi ' },
      { type: 'text-delta', text: 'there!' },
    ]);
    // Live streaming text accumulates (this is what the CLI renders live).
    expect(s.streaming).toBe('Hi there!');
    expect(s.turns).toEqual([{ kind: 'user', text: 'hello' }]);

    const done = reduceCliStreamEvent(s, { type: 'done' });
    expect(done.streaming).toBe('');
    expect(done.turns).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'Hi there!' },
    ]);
    // `status` is left to the caller (queue-drain vs idle); the reducer only
    // flips turnSettled on the terminal event.
    expect(done.turnSettled).toBe(true);
  });

  it('a peer turn following a prior turn flushes stale streaming into its own turn first', () => {
    // Simulate leftover streaming from an interrupted prior turn, then a new peer turn.
    const dirty: CliStreamState = { ...initialCliStreamState(), streaming: 'leftover' };
    const s = reduceCliStreamEvent(dirty, { type: 'user-message', text: 'next' });
    // The leftover is flushed to an assistant turn, then the new user turn is appended.
    expect(s.turns).toEqual([
      { kind: 'assistant', text: 'leftover' },
      { kind: 'user', text: 'next' },
    ]);
    expect(s.streaming).toBe('');
  });

  it('does not emit an empty assistant turn when there was no streaming text', () => {
    const s = run([{ type: 'user-message', text: 'q' }, { type: 'done' }]);
    expect(s.turns).toEqual([{ kind: 'user', text: 'q' }]);
    expect(s.turns.some((t) => t.kind === 'assistant')).toBe(false);
  });
});

describe('reduceCliStreamEvent — tool lifecycle + stuck-row backstop (#218)', () => {
  it('opens a tool row on tool-call and closes it on a matching tool-result', () => {
    const s = run([
      { type: 'user-message', text: 'do it' },
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'sh', args: { cmd: 'ls' } },
    ]);
    expect(s.tools).toEqual([{ id: 'tc1', name: 'sh', status: 'running', args: { cmd: 'ls' } }]);
    // A new tool call also drops an inline `tool` marker in the transcript.
    expect(s.turns).toContainEqual({ kind: 'tool', id: 'tc1' });

    const done = reduceCliStreamEvent(s, {
      type: 'tool-result',
      toolCallId: 'tc1',
      result: { ok: true },
      durationMs: 12,
    });
    expect(done.tools[0].status).toBe('done');
    expect(done.tools[0].durationMs).toBe(12);
  });

  it('interleaves tool markers in occurrence order (text → tool → text), matching the GUI', () => {
    const s = run([
      { type: 'user-message', text: 'time?' },
      { type: 'text-delta', text: 'I will grab it from the shell.' },
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'sh' },
      { type: 'tool-result', toolCallId: 'tc1', result: { ok: true } },
      { type: 'text-delta', text: "It's Monday." },
      { type: 'done' },
    ]);
    // Transcript order: user, assistant(intro), tool marker, assistant(result).
    expect(s.turns).toEqual([
      { kind: 'user', text: 'time?' },
      { kind: 'assistant', text: 'I will grab it from the shell.' },
      { kind: 'tool', id: 'tc1' },
      { kind: 'assistant', text: "It's Monday." },
    ]);
  });

  it('marks a tool-result with isError as error', () => {
    const s = run([
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'sh' },
      { type: 'tool-result', toolCallId: 'tc1', result: { isError: true, error: 'boom' } },
    ]);
    expect(s.tools[0].status).toBe('error');
    expect(s.tools[0].error).toBe('boom');
  });

  it('BACKSTOP: settles a still-running row on done when no matching tool-result arrived (the stuck-row bug)', () => {
    // Peer turn: tool-call arrives, but the tool-result never matched the row
    // (the id-space mismatch symptom). done must not leave it spinning.
    const s = run([
      { type: 'user-message', text: 'go' },
      { type: 'tool-call', toolCallId: 'stream-id', toolName: 'sh' },
      // result arrives under a DIFFERENT id (simulating execute-vs-stream mismatch)
      { type: 'tool-result', toolCallId: 'execute-id', result: { ok: true } },
      { type: 'done' },
    ]);
    // The row keyed 'stream-id' never got its result, but done settled it.
    const row = s.tools.find((t) => t.id === 'stream-id');
    expect(row?.status).toBe('done');
  });

  it('does NOT force an awaiting row to done on turn end (keeps its picker lifecycle)', () => {
    const s = run([
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'sh' },
      { type: 'tool-approval-required', toolCallId: 'tc1', toolName: 'sh' },
      { type: 'done' },
    ]);
    // awaiting is preserved; only running rows are settled by the backstop.
    expect(s.tools[0].status).toBe('awaiting');
  });
});

describe('reduceCliStreamEvent — terminal + misc', () => {
  it('error finalizes streaming, appends an error turn, and settles', () => {
    const s = run([
      { type: 'user-message', text: 'q' },
      { type: 'text-delta', text: 'partial' },
      { type: 'error', error: 'stream failed' },
    ]);
    expect(s.turns).toEqual([
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: 'partial' },
      { kind: 'error', text: 'stream failed' },
    ]);
    // Terminal event flips turnSettled; status is the caller's concern.
    expect(s.turnSettled).toBe(true);
  });

  it('model-fallback clears the superseded streaming text (leaving other state intact)', () => {
    const start = run([
      { type: 'user-message', text: 'q' },
      { type: 'text-delta', text: 'x' },
    ]);
    const after = reduceCliStreamEvent(start, { type: 'model-fallback', data: { toModel: 'gpt-5.6' } });
    // Only the in-progress streaming buffer is dropped; the rest of state matches.
    expect(after.streaming).toBe('');
    expect({ ...after, streaming: start.streaming }).toEqual(start);
  });

  it('model-fallback clears the superseded streaming text regardless of the discardPartialAssistant flag', () => {
    const start = run([
      { type: 'user-message', text: 'q' },
      { type: 'text-delta', text: 'superseded partial' },
    ]);
    expect(start.streaming).toBe('superseded partial');
    // Even WITHOUT discardPartialAssistant (e.g. preserveErroredVariant), the CLI
    // must not concatenate the failed partial with the retry.
    const after = reduceCliStreamEvent(start, {
      type: 'model-fallback',
      data: { toModel: 'gpt-5.6' },
    });
    expect(after.streaming).toBe('');
  });

  it('is pure — does not mutate the input state', () => {
    const start = initialCliStreamState();
    const snapshotTurns = start.turns;
    reduceCliStreamEvent(start, { type: 'user-message', text: 'q' });
    expect(start.turns).toBe(snapshotTurns);
    expect(start.turns).toHaveLength(0);
  });

  it("leaves `status` unchanged on done (queue-drain vs idle is the caller's side effect)", () => {
    // Faithful to app.tsx: settleTurn() drains a queued message (stays running)
    // OR goes idle — a queue-dependent decision the reducer does not own. The
    // reducer only flips turnSettled; the caller sets status.
    const s = run([
      { type: 'user-message', text: 'q' },
      { type: 'text-delta', text: 'a' },
    ]);
    expect(s.status).toBe('running');
    const done = reduceCliStreamEvent(s, { type: 'done' });
    expect(done.status).toBe('running'); // unchanged — caller decides idle/next
    expect(done.turnSettled).toBe(true);
  });

  it('coalesces a second terminal event (turnSettled guard) — tool rows settle once', () => {
    const afterCall = run([
      { type: 'user-message', text: 'q' },
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'sh' },
      { type: 'done' },
    ]);
    expect(afterCall.tools[0].status).toBe('done');
    expect(afterCall.turnSettled).toBe(true);
    // A stray second done must be a no-op (already settled).
    const again = reduceCliStreamEvent(afterCall, { type: 'done' });
    expect(again.tools).toEqual(afterCall.tools);
    expect(again.turns).toEqual(afterCall.turns);
    expect(again.turnSettled).toBe(true);
  });
});

describe('toolTurnOpensAssistantTurn — kai header placement (#221)', () => {
  it('is true when a tool turn is the first turn', () => {
    const turns: CliTurn[] = [{ kind: 'tool', id: 'tc1' }];
    expect(toolTurnOpensAssistantTurn(turns, 0)).toBe(true);
  });

  it('is true when a tool turn immediately follows the user turn (opens the reply)', () => {
    const turns: CliTurn[] = [
      { kind: 'user', text: 'what time is it?' },
      { kind: 'tool', id: 'tc1' },
    ];
    expect(toolTurnOpensAssistantTurn(turns, 1)).toBe(true);
  });

  it('is false when a tool turn follows assistant text (continuation, header already shown)', () => {
    const turns: CliTurn[] = [
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: 'let me check' },
      { kind: 'tool', id: 'tc1' },
    ];
    expect(toolTurnOpensAssistantTurn(turns, 2)).toBe(false);
  });

  it('is false for a second back-to-back tool (same assistant turn)', () => {
    const turns: CliTurn[] = [
      { kind: 'user', text: 'q' },
      { kind: 'tool', id: 'tc1' },
      { kind: 'tool', id: 'tc2' },
    ];
    expect(toolTurnOpensAssistantTurn(turns, 2)).toBe(false);
  });

  it('is false for a non-tool turn at the index', () => {
    const turns: CliTurn[] = [{ kind: 'assistant', text: 'hi' }];
    expect(toolTurnOpensAssistantTurn(turns, 0)).toBe(false);
  });
});

describe('assistantBlockNeedsHeader — one `kai` header per reply (text → tool → text)', () => {
  it('shows the header on the first assistant/tool turn of a reply', () => {
    // user, [assistant] → the assistant block opens here.
    const turns: CliTurn[] = [
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: 'joke' },
    ];
    expect(assistantBlockNeedsHeader(turns, 1)).toBe(true);
  });

  it('SUPPRESSES the header on assistant text that CONTINUES after a tool (the reported dup)', () => {
    // user, assistant(joke), tool, assistant(count) — one reply, header only on index 1.
    const turns: CliTurn[] = [
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: 'joke' },
      { kind: 'tool', id: 'tc1' },
      { kind: 'assistant', text: 'here you go' },
    ];
    expect(assistantBlockNeedsHeader(turns, 1)).toBe(true); // opens the reply
    expect(assistantBlockNeedsHeader(turns, 2)).toBe(false); // tool continues
    expect(assistantBlockNeedsHeader(turns, 3)).toBe(false); // post-tool text continues
  });

  it('shows the header on a tool that opens the reply (no text first)', () => {
    const turns: CliTurn[] = [
      { kind: 'user', text: 'count files' },
      { kind: 'tool', id: 'tc1' },
    ];
    expect(assistantBlockNeedsHeader(turns, 1)).toBe(true);
  });

  it('re-shows the header for a NEW reply after a user turn interleaves', () => {
    const turns: CliTurn[] = [
      { kind: 'assistant', text: 'first reply' },
      { kind: 'user', text: 'follow-up' },
      { kind: 'assistant', text: 'second reply' },
    ];
    expect(assistantBlockNeedsHeader(turns, 0)).toBe(true); // first (index 0, no prev)
    expect(assistantBlockNeedsHeader(turns, 2)).toBe(true); // new reply after the user turn
  });

  it('is false for non-assistant-side turns (user/error/note)', () => {
    const turns: CliTurn[] = [
      { kind: 'user', text: 'q' },
      { kind: 'error', text: 'boom' },
    ];
    expect(assistantBlockNeedsHeader(turns, 0)).toBe(false);
    expect(assistantBlockNeedsHeader(turns, 1)).toBe(false);
  });
});

describe('formatSubAgentStatusNote — surface sub-agent lifecycle to the parent (#226)', () => {
  const PARENT = 'parent-conv-id';

  it('formats a status note when the event is sub-agent-status for THIS parent', () => {
    const note = formatSubAgentStatusNote(
      {
        type: 'sub-agent-status',
        parentConversationId: PARENT,
        subAgentConversationId: 'subabc12345',
        status: 'running',
      },
      PARENT,
    );
    expect(note).toBe('↳ sub-agent subabc12 running');
  });

  it('includes the summary when present', () => {
    const note = formatSubAgentStatusNote(
      {
        type: 'sub-agent-status',
        parentConversationId: PARENT,
        subAgentConversationId: 'sub99999999',
        status: 'completed',
        summary: 'found 3 files',
      },
      PARENT,
    );
    expect(note).toBe('↳ sub-agent sub99999 completed — found 3 files');
  });

  it('returns null for a sub-agent-status of a DIFFERENT parent (not ours)', () => {
    expect(
      formatSubAgentStatusNote(
        { type: 'sub-agent-status', parentConversationId: 'other', subAgentConversationId: 'x', status: 'running' },
        PARENT,
      ),
    ).toBeNull();
  });

  it('returns null for non-status sub-agent events (so they fall through to the guard, not surfaced)', () => {
    expect(
      formatSubAgentStatusNote({ type: 'sub-agent-user-message', parentConversationId: PARENT, text: 'hi' }, PARENT),
    ).toBeNull();
    expect(formatSubAgentStatusNote({ type: 'text-delta', text: 'x' }, PARENT)).toBeNull();
  });

  it('defaults status to running and tolerates a missing sub-agent id', () => {
    expect(formatSubAgentStatusNote({ type: 'sub-agent-status', parentConversationId: PARENT }, PARENT)).toBe(
      '↳ sub-agent  running',
    );
  });
});
