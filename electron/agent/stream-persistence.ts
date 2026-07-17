import { appendConversationMessages, broadcastUpsert } from '../ipc/conversations.js';
import { readConversation, writeConversation } from '../ipc/conversation-store.js';
import type { StreamEvent } from './mastra-agent.js';

/**
 * Server-side accumulation of assistant stream events into a stored assistant
 * message, persisted on `done`. This makes assistant replies (and tool calls)
 * survive for clients that don't own persistence themselves — notably the
 * `kai` CLI and any headless run, where there is no renderer to write the turn
 * back. The GUI renderer still renders live from the same stream; the store is
 * refreshed via the `conversations:changed` broadcast that
 * `appendConversationMessages` emits.
 *
 * Content shape mirrors what the renderer persists (see RuntimeProvider
 * ContentPart): text parts `{type:'text', source:'assistant', text}` and merged
 * tool parts `{type:'tool-call', toolCallId, toolName, args, result?, isError?}`.
 */

type TextPart = { type: 'text'; source: 'assistant'; text: string };
type ToolPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  // Compaction metadata — mirrors what RuntimeProvider persists for interactive
  // streams, so a compacted large tool result stays recoverable after reload on
  // server-persisted (CLI/headless) streams too.
  originalResult?: unknown;
  compactionMeta?: { wasCompacted: boolean; extractionDurationMs: number };
  compactionPhase?: 'start' | 'complete' | null;
};
type ContentPart = TextPart | ToolPart;

type Accumulator = {
  parts: ContentPart[];
  toolIndex: Map<string, number>; // toolCallId → index in parts
  sawContent: boolean;
  /** Head captured at submit (the user node this reply answers). Undefined ⇒
   *  fall back to the store's current head. Set on first accumulation. */
  parentId?: string;
};

const accumulators = new Map<string, Accumulator>();

function ensureAcc(conversationId: string, parentId?: string): Accumulator {
  let acc = accumulators.get(conversationId);
  if (!acc) {
    acc = { parts: [], toolIndex: new Map(), sawContent: false, parentId };
    accumulators.set(conversationId, acc);
  } else if (acc.parentId === undefined && parentId !== undefined) {
    // First event that knew the parent — record it (later events may omit it).
    acc.parentId = parentId;
  }
  return acc;
}

function appendText(acc: Accumulator, text: string): void {
  const last = acc.parts[acc.parts.length - 1];
  if (last && last.type === 'text') {
    last.text += text;
  } else {
    acc.parts.push({ type: 'text', source: 'assistant', text });
  }
  acc.sawContent = true;
}

/**
 * Feed one stream event into the per-conversation accumulator. On `done`,
 * persist the accumulated assistant turn (if any) and clear state. Returns
 * nothing — invoked for side effects from broadcastStreamEvent.
 */
export function accumulateForPersistence(appHome: string, event: StreamEvent, parentId?: string): void {
  const conversationId = event.conversationId;
  if (!conversationId) return;

  switch (event.type) {
    case 'text-delta': {
      if (event.text) appendText(ensureAcc(conversationId, parentId), event.text);
      break;
    }
    case 'tool-call': {
      if (!event.toolCallId) break;
      const acc = ensureAcc(conversationId, parentId);
      const idx = acc.toolIndex.get(event.toolCallId);
      if (idx === undefined) {
        acc.parts.push({
          type: 'tool-call',
          toolCallId: event.toolCallId,
          toolName: event.toolName ?? 'tool',
          args: event.args,
        });
        acc.toolIndex.set(event.toolCallId, acc.parts.length - 1);
      } else {
        const part = acc.parts[idx] as ToolPart;
        part.args = event.args ?? part.args;
        part.toolName = event.toolName ?? part.toolName;
      }
      acc.sawContent = true;
      break;
    }
    case 'tool-result':
    case 'tool-error': {
      if (!event.toolCallId) break;
      const acc = ensureAcc(conversationId, parentId);
      const idx = acc.toolIndex.get(event.toolCallId);
      if (idx !== undefined) {
        const part = acc.parts[idx] as ToolPart;
        // A direct `tool-error` carries `error` (not `result`); synthesize an
        // error result so the payload isn't lost. `tool-result` uses `result`.
        part.result =
          event.type === 'tool-error' ? { isError: true, error: event.error ?? 'Tool execution failed' } : event.result;
        part.isError = event.type === 'tool-error' || undefined;
        part.durationMs = event.durationMs ?? part.durationMs;
        // Preserve compaction metadata so a compacted large tool result stays
        // recoverable after reload (mirrors RuntimeProvider.applyToolResult).
        if (event.compaction) {
          part.originalResult = part.originalResult ?? event.compaction.originalContent;
          part.compactionMeta = {
            wasCompacted: event.compaction.wasCompacted,
            extractionDurationMs: event.compaction.extractionDurationMs,
          };
          part.compactionPhase = 'complete';
        }
      }
      acc.sawContent = true;
      break;
    }
    case 'enrichment': {
      // Persist runtime session IDs into conversation metadata so multi-turn
      // resume works for Claude/Codex runtimes (mirrors RuntimeProvider). Done
      // immediately (not batched to `done`) since a turn may not reach `done`.
      const data = event.data as { claudeSdkSessionId?: string; codexSdkThreadId?: string } | undefined;
      const claudeSdkSessionId = data?.claudeSdkSessionId;
      const codexSdkThreadId = data?.codexSdkThreadId;
      if (claudeSdkSessionId || codexSdkThreadId) {
        try {
          const conv = readConversation(appHome, conversationId);
          if (conv) {
            conv.metadata = {
              ...(conv.metadata ?? {}),
              ...(claudeSdkSessionId ? { claudeSdkSessionId } : {}),
              ...(codexSdkThreadId ? { codexSdkThreadId } : {}),
            };
            writeConversation(appHome, conv);
          }
        } catch {
          // best-effort
        }
      }
      break;
    }
    case 'model-fallback': {
      // If the runtime discarded the partial assistant output before failing
      // over, drop what we've accumulated so we don't persist/replay a partial
      // that the fresh attempt supersedes.
      const data = event.data as
        | { discardPartialAssistant?: boolean; preserveErroredVariant?: boolean; error?: string }
        | undefined;
      if (data?.discardPartialAssistant) {
        const acc = accumulators.get(conversationId);
        if (acc) {
          acc.parts = [];
          acc.toolIndex.clear();
          acc.sawContent = false;
        }
        break;
      }
      if (data?.preserveErroredVariant) {
        // A transient error hit AFTER content streamed. Commit the partial as its
        // OWN variant (sibling assistant message), annotated with the error, then
        // re-seed a fresh accumulator under the SAME parent so the next attempt
        // persists as a sibling too — the user gets "k / N variants" with the
        // failed partials selectable.
        const acc = ensureAcc(conversationId, parentId);
        const originalParentId = acc.parentId;
        appendText(acc, `\n\n**Error:** ${data.error ?? event.error ?? 'model error — retrying'}`);
        // persistAccumulatedReturningHead deletes the accumulator + writes the
        // sibling with parentId = acc.parentId (the submit head), so this variant
        // is a sibling of the eventual success rather than its ancestor.
        persistAccumulatedReturningHead(appHome, conversationId);
        // Re-seed for the retry, KEEPING the original parent so the next attempt
        // is a sibling (not chained after this errored one).
        accumulators.set(conversationId, {
          parts: [],
          toolIndex: new Map(),
          sawContent: false,
          parentId: originalParentId,
        });
      }
      break;
    }
    case 'error': {
      // Annotate the accumulated turn with the error, but do NOT finalize here:
      // `error` is not always terminal (a mid-stream tool error can be followed
      // by more content + a closing `done`), so persisting now could truncate the
      // turn. The turn is persisted on `done`; the accumulator is guaranteed to
      // be released even on an abnormal (done-less) termination by the stream
      // loop's finally → discardPersistenceAccumulator (ipc/agent.ts), so it
      // cannot leak.
      const acc = ensureAcc(conversationId, parentId);
      appendText(acc, `\n\n**Error:** ${event.error ?? 'unknown error'}`);
      break;
    }
    case 'done': {
      finalizeTurn(appHome, conversationId);
      break;
    }
  }
}

/**
 * Persist the accumulated assistant turn for a server-persisted stream and clear
 * its accumulator (idempotent — safe to call more than once per conversation).
 * If there's nothing to persist, still reset a lingering `running` runStatus so
 * the conversation doesn't look stuck busy. Persistence is best-effort.
 */
function finalizeTurn(appHome: string, conversationId: string): void {
  persistAccumulated(appHome, conversationId);
}

/**
 * Persist whatever the accumulator holds RIGHT NOW as an assistant turn, without
 * waiting for `done`, then clear the accumulator. Used when a follow-up message
 * is injected mid-turn (automation back-to-back messages): the in-progress reply
 * is preserved as its own turn (text + any tool calls kept intact) rather than
 * discarded, so the next turn — and the model — can see it. Returns true if an
 * assistant message was actually written.
 *
 * The accumulator is deleted either way, so the superseding run's
 * `discardPersistenceAccumulator` becomes a no-op and cannot merge this partial
 * into the fresh turn.
 *
 * Returns the persisted assistant message's id (the new conversation head) so
 * the caller can parent the injected follow-up user turn on it — or null if
 * there was nothing to persist.
 */
export function finalizeInterruptedTurn(appHome: string, conversationId: string): string | null {
  return persistAccumulatedReturningHead(appHome, conversationId);
}

/**
 * Shared persist body for both the normal `done` finalize and the mid-turn
 * interrupt finalize. Deletes the accumulator, then persists its parts as an
 * assistant message if there's content; otherwise just clears a lingering
 * `running` runStatus. Returns whether an assistant message was persisted.
 */
function persistAccumulated(appHome: string, conversationId: string): boolean {
  return persistAccumulatedReturningHead(appHome, conversationId) !== null;
}

/**
 * Core persist logic. Returns the new conversation head id (the persisted
 * assistant message) when content was written, else null.
 */
function persistAccumulatedReturningHead(appHome: string, conversationId: string): string | null {
  const acc = accumulators.get(conversationId);
  accumulators.delete(conversationId);
  if (!acc || !acc.sawContent || acc.parts.length === 0) {
    // Nothing to persist, but agent:submit marked the conversation 'running' for
    // this turn — reset it so it doesn't look stuck busy, and broadcast so
    // non-active GUI/web clients drop the running indicator too.
    try {
      const conv = readConversation(appHome, conversationId);
      if (conv && conv.runStatus === 'running') {
        conv.runStatus = 'idle';
        writeConversation(appHome, conv);
        broadcastUpsert(appHome, conv);
      }
    } catch {
      // best-effort
    }
    return null;
  }
  try {
    // Parent on the head captured at submit so a mid-run branch change
    // (rewind/edit/variant) can't reparent the reply. `parentId: undefined`
    // in options falls back to the current head, so only pass it when known.
    // Reset runStatus to idle: agent:submit set it 'running' for the turn.
    const updated = appendConversationMessages(appHome, conversationId, [{ role: 'assistant', content: acc.parts }], {
      runStatus: 'idle',
      ...(acc.parentId !== undefined ? { parentId: acc.parentId } : {}),
    });
    return updated?.headId ?? null;
  } catch {
    // Persistence is best-effort; a failure must not break the stream.
    return null;
  }
}

/** Drop any partial accumulation for a conversation (e.g. on cancel). */
export function discardPersistenceAccumulator(conversationId: string): void {
  accumulators.delete(conversationId);
}
