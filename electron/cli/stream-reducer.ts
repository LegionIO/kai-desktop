/**
 * Pure reducer for the `kai` CLI's live stream-event handling.
 *
 * The CLI subscribes to `agent:stream-event` and folds each event into its
 * transcript/tool/status state. That logic currently lives inline in a React
 * effect in app.tsx (mutating refs + calling setState), which makes it
 * impossible to unit-test — and that untestability is why the peer-turn
 * regressions (#217 response-not-streaming, #218 stuck-tool-row) could not be
 * reproduced by inspection. See memory: cli_stream_reducer_untestable.
 *
 * This module extracts the fold into a pure `(state, event) => state` function
 * so the peer-turn sequence (user-message → text-delta* → tool-call →
 * tool-result → done) can be exercised deterministically. It mirrors the
 * app.tsx switch EXACTLY (including the own-echo nonce dedup and the peer-turn
 * "flush + fresh slate" behavior) so it can eventually replace the inline logic
 * with no behavior change. It is intentionally NOT wired into app.tsx yet —
 * that swap should happen with the live KAI_DEBUG_STREAM trace in hand.
 *
 * Notes on the model vs. app.tsx today:
 * - `streaming` is state here (app.tsx uses a mutable `streamingRef` + a
 *   `setTurns([...prev])` poke to force a re-render); functionally identical —
 *   the live "kai" block renders `streaming` when non-empty.
 * - `finalizeAssistant` (flush streaming into an assistant turn if non-blank)
 *   is applied on peer user-message, done, and error, matching app.tsx.
 * - Approval pickers, banner/model-fallback side effects, and IPC calls are NOT
 *   modelled — those are genuine side effects, not transcript state. The
 *   reducer covers the transcript/tool/status fold that the regressions live in.
 */

export type CliTurn =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'note'; text: string; id?: string; loading?: boolean }
  | { kind: 'tool'; id: string }
  | { kind: 'error'; text: string };

export type CliToolStatus = 'running' | 'awaiting' | 'done' | 'error';

export type CliToolEntry = {
  id: string;
  name: string;
  status: CliToolStatus;
  durationMs?: number;
  error?: string;
  args?: unknown;
  result?: unknown;
};

export type CliStatus = 'idle' | 'running' | 'awaiting-approval';

export interface CliStreamState {
  turns: CliTurn[];
  /** In-progress assistant text for the current turn (rendered live when non-empty). */
  streaming: string;
  tools: CliToolEntry[];
  status: CliStatus;
  /** Coalesces the done/error terminal handling so a turn settles once. */
  turnSettled: boolean;
  /** Nonces of user turns THIS client submitted, to skip our own broadcast echo. */
  ownNonces: Set<string>;
}

/** A minimal shape of the StreamEvent fields the reducer reads. */
export interface CliStreamEvent {
  type?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
  data?: unknown;
}

export function initialCliStreamState(): CliStreamState {
  return {
    turns: [],
    streaming: '',
    tools: [],
    status: 'idle',
    turnSettled: true,
    ownNonces: new Set<string>(),
  };
}

/** Flush any in-progress streaming text into its own assistant turn (if non-blank). */
function finalizeAssistant(state: CliStreamState): CliStreamState {
  const text = state.streaming;
  if (!text.trim()) return { ...state, streaming: '' };
  return { ...state, streaming: '', turns: [...state.turns, { kind: 'assistant', text }] };
}

/**
 * On turn completion, settle any tool row still "running" — a turn cannot
 * finish with a tool mid-execution. "awaiting" rows are left alone (they have a
 * live approval picker with their own resolve path). Mirrors settleOpenToolRows.
 */
function settleOpenToolRows(tools: CliToolEntry[]): CliToolEntry[] {
  if (!tools.some((t) => t.status === 'running')) return tools;
  return tools.map((t) => (t.status === 'running' ? { ...t, status: 'done' } : t));
}

/**
 * Fold one stream event into the CLI transcript/tool/status state. Pure: returns
 * a new state (never mutates the input). Events not affecting transcript state
 * (model-fallback banner, context-usage, etc.) return the state unchanged.
 */
export function reduceCliStreamEvent(state: CliStreamState, event: CliStreamEvent): CliStreamState {
  switch (event.type) {
    case 'user-message': {
      // Skip our OWN optimistic echo, identified by a nonce the backend echoes.
      const nonce = (event.data as { submitNonce?: string } | undefined)?.submitNonce;
      if (nonce && state.ownNonces.has(nonce)) {
        const ownNonces = new Set(state.ownNonces);
        ownNonces.delete(nonce);
        return { ...state, ownNonces };
      }
      // A PEER-driven turn: flush any in-progress assistant text, then open a
      // clean slate (empty streaming, re-armed terminal guard) before this
      // turn's deltas arrive.
      const flushed = finalizeAssistant(state);
      const turns = event.text ? [...flushed.turns, { kind: 'user' as const, text: event.text }] : flushed.turns;
      return { ...flushed, turns, streaming: '', turnSettled: false, status: 'running' };
    }

    case 'text-delta': {
      if (!event.text) return state;
      return { ...state, streaming: state.streaming + event.text };
    }

    case 'tool-call': {
      if (!event.toolCallId) return state;
      const id = event.toolCallId;
      const name = event.toolName ?? 'tool';
      const args = event.args;
      const exists = state.tools.some((t) => t.id === id);
      const tools = exists
        ? state.tools.map((t) => (t.id === id ? { ...t, name, status: 'running' as const, args } : t))
        : [...state.tools, { id, name, status: 'running' as const, args }];
      if (exists) return { ...state, tools };
      // A NEW tool call: flush any streamed assistant text into its own turn,
      // then drop an inline `tool` marker so the transcript renders in occurrence
      // order (text → tool → text), matching the GUI. Mirrors app.tsx.
      const flushed = finalizeAssistant(state);
      return { ...flushed, tools, turns: [...flushed.turns, { kind: 'tool', id }] };
    }

    case 'tool-result': {
      const res = event.result as { isError?: boolean; error?: string } | undefined;
      const failed = !!res?.isError || typeof res?.error === 'string';
      const tools = state.tools.map((t) =>
        t.id === event.toolCallId
          ? {
              ...t,
              status: (failed ? 'error' : 'done') as CliToolStatus,
              durationMs: event.durationMs,
              result: event.result,
              ...(failed ? { error: res?.error ?? 'tool failed' } : {}),
            }
          : t,
      );
      return { ...state, tools };
    }

    case 'tool-error': {
      const tools = state.tools.map((t) =>
        t.id === event.toolCallId ? { ...t, status: 'error' as const, error: event.error } : t,
      );
      return { ...state, tools };
    }

    case 'tool-approval-required': {
      const tools = event.toolCallId
        ? state.tools.map((t) => (t.id === event.toolCallId ? { ...t, status: 'awaiting' as const } : t))
        : state.tools;
      return { ...state, status: 'awaiting-approval', tools };
    }

    case 'error': {
      const flushed = finalizeAssistant(state);
      const turns = [...flushed.turns, { kind: 'error' as const, text: event.error ?? 'unknown error' }];
      // The error turn is always appended (app.tsx appends unconditionally).
      // Settling is coalesced by turnSettled: flip it and settle open tool rows
      // only on the first terminal event. `status` is deliberately NOT set here —
      // in app.tsx settleTurn() either drains a queued message (staying
      // effectively running) or goes idle, a queue-dependent SIDE EFFECT the
      // caller owns (the reducer doesn't model the input queue). The caller
      // reacts to turnSettled flipping true.
      if (flushed.turnSettled) return { ...flushed, turns };
      return { ...flushed, turns, turnSettled: true, tools: settleOpenToolRows(flushed.tools) };
    }

    case 'done': {
      const flushed = finalizeAssistant(state);
      // Coalesced settle; `status` left to the caller (queue-drain vs idle). See
      // the note in the 'error' case above.
      if (flushed.turnSettled) return flushed;
      return { ...flushed, turnSettled: true, tools: settleOpenToolRows(flushed.tools) };
    }

    case 'model-fallback': {
      // If the runtime discarded the partial output before failing over, drop
      // what we've streamed so a superseded fragment doesn't render. (The banner
      // model-label update is a side effect the caller handles.) Mirrors app.tsx.
      const fb = event.data as { discardPartialAssistant?: boolean } | undefined;
      if (fb?.discardPartialAssistant) return { ...state, streaming: '' };
      return state;
    }

    default:
      // context-usage and other non-transcript events: no change.
      return state;
  }
}

/**
 * Whether the `tool` turn at `index` OPENS the assistant's turn — i.e. nothing
 * from the assistant precedes it (the previous turn is the user's, or it's the
 * first turn). The CLI renders a `kai` header above such a tool row so a tool
 * call that runs before any assistant text isn't mistaken for part of the
 * user's message. Continuation tools (previous turn is assistant/tool) get no
 * header so a multi-step reply isn't littered with repeated headers. Mirrors the
 * inline decision in app.tsx's transcript render.
 */
export function toolTurnOpensAssistantTurn(turns: CliTurn[], index: number): boolean {
  if (turns[index]?.kind !== 'tool') return false;
  const prev = turns[index - 1];
  return !prev || prev.kind === 'user';
}
