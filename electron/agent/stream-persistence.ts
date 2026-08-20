import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  appendConversationMessages,
  broadcastUpsert,
  ensureConversationTree,
  getConversationBranch,
} from '../ipc/conversations.js';
import type { StoredTreeMessage } from '../ipc/conversations.js';
import { readConversation, writeConversation, nextCompactionRevision } from '../ipc/conversation-store.js';
import { getAppHome } from '../local-bridge/paths.js';
import { isStrictPrefix, messageContentSignature } from './compaction.js';
import type { StreamEvent } from './mastra-agent.js';
import { redactBrowserToolArgsForExposure } from '../../shared/browser.js';

// Re-exported from ./compaction (single canonical home, cycle-free for the agent /
// conversations / stream-persistence trio). See its definition for why it hashes.
export { messageContentSignature };

// ---------------------------------------------------------------------------
// Tree-corruption diagnostics (gated by KAI_DEBUG_STREAM).
//
// Investigating a mid-turn-inject case where a truncated partial assistant was
// persisted with parentId:null (a detached second root), severing the injected
// follow-ups from the original user ask. These logs capture the exact store
// state at each persist/inject boundary so the real write path can be proven
// from evidence before any fix. See ~/.kai/debug-logs/tree-corruption.log.
// ---------------------------------------------------------------------------
const TREE_DEBUG_ENABLED = !!process.env.KAI_DEBUG_STREAM;
const TREE_DEBUG_DIR = join(getAppHome(), 'debug-logs');
const TREE_DEBUG_LOG = join(TREE_DEBUG_DIR, 'tree-corruption.log');
function treeDebugLog(msg: string): void {
  if (!TREE_DEBUG_ENABLED) return;
  try {
    mkdirSync(TREE_DEBUG_DIR, { recursive: true });
    appendFileSync(TREE_DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

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
  /** Shared Kai/Mastra response id captured from stream events. */
  responseMessageId?: string;
};

const accumulators = new Map<string, Accumulator>();

/**
 * Response ids already persisted as an assistant node for a conversation, so a
 * second finalize of the SAME logical reply (the inject-consumed handler, the
 * stop/cancel path, and the terminal drain can all reach a finalize) does not
 * append a duplicate node. Bounded per conversation; cleared when a conversation's
 * turn fully settles (`done`) via clearFinalizedResponseIds. Belt-and-suspenders
 * with sanitizeMessageTree, which repairs a dup if one still slips through.
 */
const finalizedResponseIds = new Map<string, Set<string>>();

function markResponseFinalized(conversationId: string, responseMessageId: string | undefined): void {
  if (!responseMessageId) return;
  let set = finalizedResponseIds.get(conversationId);
  if (!set) {
    set = new Set();
    finalizedResponseIds.set(conversationId, set);
  }
  set.add(responseMessageId);
  // Bound growth on a pathological long-lived conversation.
  if (set.size > 64) {
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
}

function isResponseAlreadyFinalized(conversationId: string, responseMessageId: string | undefined): boolean {
  if (!responseMessageId) return false;
  return finalizedResponseIds.get(conversationId)?.has(responseMessageId) ?? false;
}

/** Clear finalized-response tracking for a conversation (call on terminal `done`
 *  / cancel so a genuinely new turn reusing an id space starts clean). */
export function clearFinalizedResponseIds(conversationId: string): void {
  finalizedResponseIds.delete(conversationId);
}

function ensureAcc(conversationId: string, parentId?: string, responseMessageId?: string): Accumulator {
  let acc = accumulators.get(conversationId);
  if (!acc) {
    acc = { parts: [], toolIndex: new Map(), sawContent: false, parentId, responseMessageId };
    accumulators.set(conversationId, acc);
  } else if (acc.parentId === undefined && parentId !== undefined) {
    // First event that knew the parent — record it (later events may omit it).
    acc.parentId = parentId;
  }
  if (acc.responseMessageId === undefined && responseMessageId !== undefined) {
    acc.responseMessageId = responseMessageId;
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
export function accumulateForPersistence(
  appHome: string,
  event: StreamEvent,
  parentId?: string,
): 'done' | 'failed' | undefined {
  const conversationId = event.conversationId;
  if (!conversationId) return undefined;

  switch (event.type) {
    case 'text-delta': {
      if (event.text) appendText(ensureAcc(conversationId, parentId, event.responseMessageId), event.text);
      break;
    }
    case 'tool-call': {
      if (!event.toolCallId) break;
      const exposedArgs = redactBrowserToolArgsForExposure(event.toolName, event.args);
      const acc = ensureAcc(conversationId, parentId, event.responseMessageId);
      const idx = acc.toolIndex.get(event.toolCallId);
      if (idx === undefined) {
        acc.parts.push({
          type: 'tool-call',
          toolCallId: event.toolCallId,
          toolName: event.toolName ?? 'tool',
          args: exposedArgs,
        });
        acc.toolIndex.set(event.toolCallId, acc.parts.length - 1);
      } else {
        const part = acc.parts[idx] as ToolPart;
        part.args = exposedArgs ?? part.args;
        part.toolName = event.toolName ?? part.toolName;
      }
      acc.sawContent = true;
      break;
    }
    case 'tool-result':
    case 'tool-error': {
      if (!event.toolCallId) break;
      const acc = ensureAcc(conversationId, parentId, event.responseMessageId);
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
    case 'compaction': {
      // Persist a conversation-compaction record for CLI/headless (server-owned)
      // turns. The GUI renderer persists this itself from the `compaction` stream
      // event; without this case a server-owned turn's successful compaction
      // (e.g. from reactive overflow recovery) is lost, so the next turn reloads
      // the original branch and re-overflows / re-summarizes. Written immediately
      // (not batched to `done`) since the turn may not reach `done`.
      const data = event.data as
        | {
            compactionId?: string;
            summaryText?: string;
            compactedMessageIds?: string[];
            coveredContentSig?: Record<string, string>;
          }
        | undefined;
      if (
        data?.compactionId &&
        typeof data.summaryText === 'string' &&
        Array.isArray(data.compactedMessageIds) &&
        data.compactedMessageIds.length > 0
      ) {
        try {
          const conv = readConversation(appHome, conversationId);
          if (conv) {
            // Validate against the FRESH disk branch before stamping: a concurrent
            // conversations:put (or a mid-turn edit) may have changed the tree while the
            // (awaited) summarizer ran. Only persist a record whose covered ids are still
            // an ordered prefix of the current branch — else next turn's reuse would
            // reject it anyway, and a diverged branch could reuse a stale summary. (Same
            // strict-prefix gate the GUI conversations:put + agent.ts recovery apply.)
            const { tree, headId: freshHead } = ensureConversationTree(conv);
            const branch = getConversationBranch(tree, freshHead);
            const branchIds = branch.map((m) => m.id);
            if (!isStrictPrefix(data.compactedMessageIds, branchIds)) {
              break; // stale/diverged — skip persisting (reuse fail-safes on mismatch)
            }
            // Beyond id-prefix: if the emitter signed the covered ids' CONTENT, verify
            // that content is unchanged on disk. A concurrent same-id edit (e.g. a
            // mid-turn rewrite that keeps ids but changes a tool payload) would leave
            // the id-prefix intact yet make the summary describe stale content.
            if (data.coveredContentSig) {
              const byId = new Map(branch.map((m) => [m.id, m]));
              const drifted = data.compactedMessageIds.some((id) => {
                const expected = data.coveredContentSig?.[id];
                if (expected === undefined) return false; // not signed → nothing to check
                return messageContentSignature(byId.get(id)) !== expected;
              });
              if (drifted) break; // covered content changed under us — skip persisting
            }
            const headId = conv.headId ?? null;
            conv.conversationCompaction = {
              compactionId: data.compactionId,
              summaryText: data.summaryText,
              compactedMessageIds: data.compactedMessageIds,
              boundaryHeadId: headId,
              createdAt: new Date().toISOString(),
              // Persist the covered-id baseline signatures so a LATER same-turn recovery
              // that expands this record's synthetic summary can re-verify the underlying
              // ids against fresh disk before persisting over them.
              ...(data.coveredContentSig ? { coveredContentSig: data.coveredContentSig } : {}),
              // Main-authoritative monotonic freshness (see nextCompactionRevision) so a
              // clock-skewed client's createdAt can't cause a newer summary to be dropped.
              compactionRevision: nextCompactionRevision(),
            } as typeof conv.conversationCompaction;
            conv.updatedAt = new Date().toISOString();
            writeConversation(appHome, conv);
          }
        } catch {
          // best-effort — reuse fail-safes on any mismatch
        }
      }
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
        const acc = ensureAcc(conversationId, parentId, event.responseMessageId);
        const originalParentId = acc.parentId;
        appendText(acc, `\n\n**Error:** ${data.error ?? event.error ?? 'model error — retrying'}`);
        // persistAccumulatedReturningHead deletes the accumulator + writes the
        // sibling with parentId = acc.parentId (the submit head), so this variant
        // is a sibling of the eventual success rather than its ancestor.
        // keepRunning: the retry is still in flight — don't flip the conversation
        // to 'idle' or a concurrent automation could fork the branch mid-fallback.
        const variantHead = persistAccumulatedReturningHead(appHome, conversationId, { keepRunning: true });
        // Re-seed for the retry, KEEPING the original parent so the next attempt is a sibling — but
        // ONLY if the errored-variant persist SUCCEEDED (R169 f-3). If it FAILED, R168 f-2 RETAINED
        // the accumulator (still holding this variant's content); unconditionally overwriting it here
        // would permanently lose Model A's partial/errored variant. On failure, leave the retained
        // accumulator so a later finalize can still persist it (the next attempt appends to it — a
        // degraded merge, but no data loss).
        if (variantHead !== null || !accumulators.has(conversationId)) {
          accumulators.set(conversationId, {
            parts: [],
            toolIndex: new Map(),
            sawContent: false,
            parentId: originalParentId,
          });
        }
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
      const acc = ensureAcc(conversationId, parentId, event.responseMessageId);
      appendText(acc, `\n\n**Error:** ${event.error ?? 'unknown error'}`);
      break;
    }
    case 'done': {
      return finalizeTurn(appHome, conversationId);
    }
  }
  return undefined;
}

/**
 * Persist the accumulated assistant turn for a server-persisted stream and clear
 * its accumulator (idempotent — safe to call more than once per conversation).
 * If there's nothing to persist, still reset a lingering `running` runStatus so
 * the conversation doesn't look stuck busy. Persistence is best-effort.
 *
 * Returns `'failed'` when there WAS content but the write did NOT succeed (the
 * accumulator was RETAINED for a retry, so the caller MUST NOT clear persistence
 * ownership — R169 f-1). Returns `'done'` when the turn was persisted OR there was
 * genuinely nothing to persist (ownership is safe to clear either way).
 */
function finalizeTurn(appHome: string, conversationId: string): 'done' | 'failed' {
  const hadContent = Boolean(accumulators.get(conversationId)?.sawContent);
  persistAccumulated(appHome, conversationId);
  // If content existed and the accumulator is STILL present, persist failed and retained it (R168 f-2).
  if (hadContent && accumulators.has(conversationId)) return 'failed';
  return 'done';
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

// Like finalizeInterruptedTurn but for a REMOTE-originated turn: the web client already persisted a
// frame-capped assistant node under the same responseMessageId, so REPLACE that node's content with
// main's full copy (upsert by id) rather than appending a duplicate sibling variant.
export function finalizeInterruptedTurnReplacing(appHome: string, conversationId: string): string | null {
  return persistAccumulatedReturningHead(appHome, conversationId, { replaceById: true });
}

// Terminal finalize for a LOCAL-originated GUI turn whose main-side fallback accumulator must be
// flushed. Uses the SAME upsert-by-id semantics as the remote path: the local originator's renderer
// runs a ~300ms debounced stream-persist, so by the time a passive client wins continuation and
// triggers this flush, disk may ALREADY carry the assistant node under this run's responseMessageId
// (even though runStatus is still 'running'). A plain append would id-collision-rename it to a bogus
// `auto-msg-*` duplicate sibling; replaceById upserts the existing node in place (and falls through
// to a normal append when no such node exists yet).
export function finalizeInterruptedTurnUpsert(appHome: string, conversationId: string): string | null {
  return persistAccumulatedReturningHead(appHome, conversationId, { replaceById: true });
}

export type PersistedInjectedUserTurn = {
  /** Stable id of the user node appended to the authoritative conversation tree. */
  messageId: string;
  /** The node the injected user turn was parented on (usually the partial assistant). */
  parentId: string | null;
  createdAt?: string;
};

/**
 * Persist the branch boundary for a cooperative mid-turn inject on a
 * server-persisted (CLI/headless-owned) run:
 *
 *   original user → partial assistant → injected user → continuation assistant
 *
 * Without this split, the running persistence accumulator remains parented on
 * the ORIGINAL user. The injected user is appended as one child of that node,
 * then `done` appends the accumulated assistant as another child and makes it
 * the head — turning the injected message into an inactive sibling. The model
 * still saw the inject via prepareStep, but the GUI loses it when it reloads the
 * authoritative branch. Finalize the partial first, append the injected user on
 * top of it, and return that user's id so the caller can rebind subsequent
 * assistant persistence to the new head.
 */
export function persistCooperativeInjectedUserTurn(
  appHome: string,
  conversationId: string,
  userText: string,
  requestedMessageId?: string,
  opts?: {
    // Parent to pin the inject on when there is NO accumulated assistant prefix to
    // finalize (finalizeInterruptedTurn returns null). Without this, the inject falls
    // back to the store's CURRENT head — which, when a newer prompt has already
    // superseded this run and become the disk head, mis-orders the (older) inject
    // AFTER the newer prompt. Pass the superseded run's own branch point (the node it
    // was streaming under) so an empty-prefix inject lands where it chronologically
    // belongs — before any superseding prompt — and the caller can then reparent that
    // prompt onto the inject. Ignored when a partial prefix exists (pin to the prefix).
    noPrefixParentId?: string | null;
  },
): PersistedInjectedUserTurn | null {
  if (!conversationId || !userText) return null;
  const partialAssistantHead = finalizeInterruptedTurn(appHome, conversationId);
  // R229/R230: finalizeInterruptedTurn returns null in TWO distinct situations: (a) genuinely nothing to persist
  // (no prefix), and (b) there WAS a partial prefix but its persist FAILED and R168 RETAINED the accumulator.
  // Treating (b) as "no prefix" would pin the injected user on the live head, leaving the continuation parented
  // BEFORE the inject (off-branch sibling). R229 tried DEFERRING (return null) but callers have already drained
  // the inject and a later supersession discards the retained accumulator — so a transient write failure lost the
  // inject entirely. R230: instead PERSIST the inject pinned on the accumulator's OWN parent (the pre-inject head)
  // — the prefix, when a later finalize recovers it, and the inject are then both children of the pre-inject head
  // in the right chronological order, and the inject is never lost. Falls through to normal resolution if the
  // accumulator's parent is unknown.
  const retainedPrefixParent =
    partialAssistantHead === null && persistenceAccumulatorHasContent(conversationId)
      ? getPersistenceAccumulatorParentId(conversationId)
      : undefined;
  const current = readConversation(appHome, conversationId);
  if (!current) return null;
  // Resolve the parent to pin the inject on:
  //   • a finalized partial prefix → pin on it (the normal cooperative-inject case);
  //   • else (R230) the retained-prefix's OWN parent when the prefix persist FAILED but held content — the
  //     pre-inject head, still-on-disk-validated — so the inject is chronologically correct and never lost;
  //   • else the caller-supplied superseded branch point (noPrefixParentId), when it
  //     still names a real node on disk — chronologically correct vs. the live head;
  //   • else the store's current head (first-turn / no-supersession fallback).
  const nodeExistsOnDisk = (id: string): boolean =>
    Array.isArray(current.messageTree) && (current.messageTree as Array<{ id?: unknown }>).some((m) => m?.id === id);
  const retainedPrefixParentValid =
    typeof retainedPrefixParent === 'string' && retainedPrefixParent && nodeExistsOnDisk(retainedPrefixParent)
      ? retainedPrefixParent
      : null;
  const noPrefixParent =
    opts && 'noPrefixParentId' in opts && typeof opts.noPrefixParentId === 'string' && opts.noPrefixParentId
      ? nodeExistsOnDisk(opts.noPrefixParentId)
        ? opts.noPrefixParentId
        : null
      : null;
  const explicitParent = partialAssistantHead ?? retainedPrefixParentValid ?? noPrefixParent ?? null;
  const parentId = explicitParent ?? current.headId ?? null;
  treeDebugLog(
    `[INJECT-BOUNDARY] conv=${conversationId} partialAssistantHead=${JSON.stringify(partialAssistantHead)} ` +
      `noPrefixParent=${JSON.stringify(noPrefixParent)} ` +
      `storeHeadId=${JSON.stringify(current.headId)} pinnedParent=${JSON.stringify(parentId)} ` +
      `treeLen=${Array.isArray(current.messageTree) ? current.messageTree.length : -1} ` +
      `willPassParentId=${explicitParent !== null}`,
  );
  const messageId = requestedMessageId || `inject-msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const createdAt = new Date().toISOString();
  const updated = appendConversationMessages(
    appHome,
    conversationId,
    [{ id: messageId, role: 'user', content: [{ type: 'text', text: userText }], createdAt }],
    {
      runStatus: 'running',
      // Pin to the partial assistant we just persisted, else the superseded run's
      // branch point (noPrefixParentId). If neither is available, omit parentId so
      // appendConversationMessages uses the store's current head.
      ...(explicitParent !== null ? { parentId: explicitParent } : {}),
    },
  );
  if (!updated?.headId) return null;
  // R231: when the prefix persist FAILED and its content is still held in the retained accumulator, that same
  // accumulator will keep accumulating the CONTINUATION — but its parentId is still the PRE-INJECT head, so the
  // continuation would persist as a sibling of the inject and the head would move back OVER the inject (leaving
  // the accepted user off-branch). Rebind the retained accumulator's parent onto the just-persisted injected user
  // so continuation flows `…pre → inject → continuation`. (The retained prefix, if a later finalize recovers it,
  // lands as a sibling under the pre-inject head — branch selection handles that; the ACTIVE chain is correct.)
  if (retainedPrefixParent !== undefined) {
    rebindPersistenceAccumulatorParent(conversationId, messageId);
  }
  return { messageId, parentId, createdAt };
}

/**
 * GUI cooperative-inject boundary handling for main's FALLBACK accumulator (the
 * crash-backstop copy; the renderer owns the authoritative persist). Called at
 * the prepareStep CONSUMPTION boundary (after prior-step tool RESULTS, so the
 * accumulator's toolIndex is intact — NOT at enqueue time). Finalizes the
 * accumulated assistant PREFIX as a fallback node (parented on its current
 * parent, keepRunning), then re-seeds a FRESH continuation accumulator parented
 * on `injectedUserId` (the already-persisted injected user node). Returns the
 * finalized prefix's id (so the caller can reparent the injected user ONTO it,
 * yielding correct chronology on a crash finalize), or null when there was no
 * prefix content (nothing to attach the user under — the caller then leaves the
 * user where it is and just rebinds the continuation).
 */
export function finalizeGuiFallbackPrefixAtInject(
  appHome: string,
  conversationId: string,
  injectedUserId: string,
): string | null {
  if (!conversationId || !injectedUserId) return null;
  const acc = accumulators.get(conversationId);
  const hasPrefix = !!acc && acc.sawContent && acc.parts.length > 0;
  // replaceById: the RENDERER (authoritative) may have already persisted this
  // prefix assistant under the same responseMessageId via its debounce. Appending
  // would id-collision-rename into a bogus duplicate variant that conversations:put
  // union-merge then preserves. Upsert the existing node in place instead (falls
  // through to a normal append when no such node exists yet). keepRunning: the
  // turn is still live.
  const prefixHead = hasPrefix
    ? persistAccumulatedReturningHead(appHome, conversationId, {
        keepRunning: true,
        replaceById: true,
        // Restore the prefix's parent from the accumulator (the pre-inject head) in
        // case the renderer debounce persisted it temporarily under the injected
        // user — otherwise reparenting the user onto it below would be a cycle.
        restoreParentFromAcc: true,
      })
    : null;
  // R229/R230: we ALWAYS re-seed the continuation accumulator below, even when the prefix persist returned null
  // (had content but the write failed, R168-retained). Earlier (R229) this path returned WITHOUT re-seeding to
  // avoid clobbering the retained prefix, but that broke the GUI multi-inject batch loop (agent.ts) which
  // depends on the continuation being re-seeded under en.id — a null return was read as "no prefix, proceed" and
  // the next entry's continuation then accumulated under the wrong parent. Here the MAIN-side accumulator is a
  // FALLBACK: the GUI renderer runs its own authoritative debounced persist under the same responseMessageId, so
  // even if this main-side prefix copy is lost on re-seed, the renderer's copy (or its crash-fallback upsert)
  // carries it. So re-seed unconditionally to keep the live turn's continuation correctly parented.
  // Re-seed a fresh continuation accumulator parented on the injected user, with
  // a DETERMINISTIC responseMessageId derived from the injected user id
  // (`${injectedUserId}-cont`). The RENDERER derives the identical id for its
  // authoritative continuation node, so a renderer-crash fallback finalize (which
  // upserts by responseMessageId) targets the SAME node instead of appending a
  // duplicate sibling variant. Unique per boundary (distinct injected user id),
  // so a second inject in the same run doesn't collide with the first.
  accumulators.set(conversationId, {
    parts: [],
    toolIndex: new Map(),
    sawContent: false,
    parentId: injectedUserId,
    responseMessageId: `${injectedUserId}-cont`,
  });
  return prefixHead;
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
function persistAccumulatedReturningHead(
  appHome: string,
  conversationId: string,
  opts?: { keepRunning?: boolean; replaceById?: boolean; restoreParentFromAcc?: boolean },
): string | null {
  const acc = accumulators.get(conversationId);
  // Do NOT delete the accumulator eagerly (R168): deleting it before persistence SUCCEEDS meant a
  // transient null read or a write throw below permanently LOST the accumulated (CLI/headless or
  // partial-prefix) response. Delete only on a confirmed-success or genuinely-nothing-to-persist
  // return; the catch/failure paths leave it intact so a later finalize retry can recover it.
  if (!acc || !acc.sawContent || acc.parts.length === 0) {
    accumulators.delete(conversationId); // nothing to lose — clear it
    treeDebugLog(
      `[PERSIST-EMPTY] conv=${conversationId} hasAcc=${!!acc} sawContent=${acc?.sawContent ?? 'n/a'} ` +
        `parts=${acc?.parts.length ?? 0} accParent=${JSON.stringify(acc?.parentId)} keepRunning=${!!opts?.keepRunning}`,
    );
    // Nothing to persist, but agent:submit marked the conversation 'running' for
    // this turn — reset it so it doesn't look stuck busy, and broadcast so
    // non-active GUI/web clients drop the running indicator too. (Unless the
    // caller says the turn is still running — a mid-stream fallback variant save.)
    if (opts?.keepRunning) return null;
    try {
      const conv = readConversation(appHome, conversationId);
      if (conv && conv.runStatus === 'running') {
        conv.runStatus = 'idle';
        const written = writeConversation(appHome, conv);
        broadcastUpsert(appHome, written);
      }
    } catch {
      // best-effort
    }
    return null;
  }
  // Idempotence vs. continuation after a cooperative inject:
  //
  // Mastra reuses the SAME responseMessageId across steps of one run. After a
  // mid-turn inject we finalize the partial assistant under that id (marking it
  // finalized), then the run CONTINUES streaming new content under the same id.
  // So "id already finalized" does NOT mean "duplicate" — it can mean "this is a
  // legitimate continuation segment." We must:
  //   • drop a true duplicate (same id, nothing new persisted since — the
  //     stop/drain/inject-consumed paths racing on the same partial), but
  //   • KEEP a continuation segment (new content), persisting it as its own node.
  // Since the id is already taken by the partial, a continuation cannot reuse it
  // (appendConversationMessages would collision-rename anyway); give it a fresh id
  // so the segment is preserved as a distinct assistant node on the branch.
  const alreadyFinalized = acc.responseMessageId
    ? isResponseAlreadyFinalized(conversationId, acc.responseMessageId)
    : false;
  let effectiveId = acc.responseMessageId;
  if (alreadyFinalized) {
    // A duplicate finalize with no genuinely-new content is a no-op (return the
    // existing node id so a caller's parent-rebind still points at a real node).
    // We can't cheaply diff content, so treat the presence of an inject boundary
    // (the continuation is a fresh accumulator built after the partial was
    // deleted) as "continuation": persist under a fresh id. A pure re-finalize of
    // the SAME in-memory accumulator can't happen — finalize deletes it above —
    // so any accumulator we see here with content is new content to keep.
    effectiveId = `${acc.responseMessageId}-cont-${Date.now().toString(36)}`;
  }
  try {
    // Diagnostics: capture the exact parent-resolution state at persist time.
    // appendConversationMessages resolves parent = (acc.parentId !== undefined)
    //   ? acc.parentId : store.headId. An orphan root is created when that
    // resolves to null while the tree already has nodes — log that condition
    // so the real write path is provable from evidence.
    if (TREE_DEBUG_ENABLED) {
      let storeHeadId: string | null | undefined;
      let treeLen = -1;
      try {
        const snap = readConversation(appHome, conversationId);
        storeHeadId = snap?.headId;
        treeLen = Array.isArray(snap?.messageTree) ? snap!.messageTree.length : -1;
      } catch {
        /* best-effort snapshot */
      }
      const resolvedParent = acc.parentId !== undefined ? acc.parentId : storeHeadId;
      const orphanRisk = (resolvedParent === null || resolvedParent === undefined) && treeLen > 0;
      treeDebugLog(
        `[PERSIST-ASSISTANT] conv=${conversationId} effectiveId=${effectiveId ?? '(auto)'} ` +
          `accParent=${JSON.stringify(acc.parentId)} storeHeadId=${JSON.stringify(storeHeadId)} ` +
          `treeLen=${treeLen} resolvedParent=${JSON.stringify(resolvedParent)} ` +
          `alreadyFinalized=${alreadyFinalized} keepRunning=${!!opts?.keepRunning} ` +
          `parts=${acc.parts.length}${orphanRisk ? ' ORPHAN_RISK=true' : ''}`,
      );
    }
    // REMOTE-origin upsert (replaceById): a web client already persisted a FRAME-CAPPED assistant
    // node under this same responseMessageId; appending would collision-rename to a bogus sibling
    // variant. Instead, REPLACE that node's content in place with main's FULL parts. Only when a
    // node with that id actually exists on disk; else fall through to the normal append.
    if (opts?.replaceById && effectiveId) {
      try {
        const conv = readConversation(appHome, conversationId);
        const treeArr = conv && Array.isArray(conv.messageTree) ? (conv.messageTree as StoredTreeMessage[]) : null;
        const nodeIdx = treeArr ? treeArr.findIndex((m) => m.id === effectiveId && m.role === 'assistant') : -1;
        if (conv && treeArr && nodeIdx >= 0) {
          const nextTree = treeArr.slice();
          // Overwrite content; drop the cached token count/sig so writeConversation's backfill
          // recomputes them for the new (full) content.
          const replaced = { ...nextTree[nodeIdx], content: acc.parts };
          delete (replaced as { tokenCount?: unknown }).tokenCount;
          delete (replaced as { tokenCountSig?: unknown }).tokenCountSig;
          // restoreParentFromAcc: at a cooperative-inject boundary the renderer's
          // debounce may have TEMPORARILY persisted this prefix parented UNDER the
          // injected user (before inject-consumed reordered it). Replacing only the
          // content would keep that wrong parent, and the caller's later attempt to
          // parent the user ONTO the prefix would be a cycle. Restore the prefix's
          // parent to the accumulator's (the pre-inject head) so the boundary tree
          // is `pre → prefix → user`.
          if (opts?.restoreParentFromAcc && acc.parentId !== undefined) {
            (replaced as { parentId?: string | null }).parentId = acc.parentId;
          }
          nextTree[nodeIdx] = replaced;
          // Also refresh the LEGACY FLAT `messages` array's matching node — search + Markdown export
          // read from `messages`, so leaving the web client's frame-capped copy there would make
          // them permanently show truncated output. Overwrite its content with main's full parts.
          const nextMessages = Array.isArray(conv.messages)
            ? (conv.messages as Array<Record<string, unknown>>).map((m) =>
                m && typeof m === 'object' && m.id === effectiveId ? { ...m, content: acc.parts } : m,
              )
            : conv.messages;
          // Preserve the CURRENT head + runStatus if they've moved PAST this node — a newer user
          // turn / branch-nav / replacement run may have advanced the head and set 'running' since
          // this (now-superseded) turn ended. Only when the head still points AT this node (the
          // normal terminal case) do we finalize it to idle. Never rewind the head to this node or
          // force 'idle' over a live newer turn.
          const headStillHere = conv.headId === effectiveId || conv.headId == null;
          const nextConv = {
            ...conv,
            messageTree: nextTree,
            messages: nextMessages,
            headId: headStillHere && !opts?.keepRunning ? effectiveId : conv.headId,
            runStatus: headStillHere && !opts?.keepRunning ? 'idle' : conv.runStatus,
          } as typeof conv;
          const written = writeConversation(appHome, nextConv);
          markResponseFinalized(conversationId, acc.responseMessageId);
          broadcastUpsert(appHome, written);
          accumulators.delete(conversationId); // persisted — safe to clear (R168)
          return effectiveId;
        }
      } catch {
        // Fall through to the normal append on any read/write failure.
      }
    }
    // Parent on the head captured at submit so a mid-run branch change
    // (rewind/edit/variant) can't reparent the reply. `parentId: undefined`
    // runStatus: keep 'running' when the caller is saving an intermediate
    // errored variant mid-fallback (the retry is still in flight) — otherwise a
    // concurrent automation could see 'idle' and fork the branch; else 'idle'.
    const updated = appendConversationMessages(
      appHome,
      conversationId,
      [
        {
          ...(effectiveId ? { id: effectiveId } : {}),
          role: 'assistant',
          content: acc.parts,
        },
      ],
      {
        runStatus: opts?.keepRunning ? 'running' : 'idle',
        ...(acc.parentId !== undefined ? { parentId: acc.parentId } : {}),
      },
    );
    if (updated?.headId) markResponseFinalized(conversationId, acc.responseMessageId);
    // Clear the accumulator only on a CONFIRMED persist (a headId came back). If the append
    // silently produced no head (shouldn't happen, but treat as not-persisted), leave the acc so a
    // retry can recover it rather than losing the response (R168).
    if (updated?.headId) accumulators.delete(conversationId);
    if (TREE_DEBUG_ENABLED) {
      const persistedNode = (
        updated?.messageTree as Array<{ id?: string; parentId?: string | null }> | undefined
      )?.find((m) => m.id === updated?.headId);
      treeDebugLog(
        `[PERSIST-RESULT] conv=${conversationId} newHeadId=${JSON.stringify(updated?.headId)} ` +
          `persistedParentId=${JSON.stringify(persistedNode?.parentId)}`,
      );
    }
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

/** Whether main is currently holding a persistence accumulator for a conversation (a live GUI-turn
 *  fallback or server-persisted accumulation). Used to decide if an on-demand finalize can flush a
 *  full copy to disk. */
export function hasPersistenceAccumulator(conversationId: string): boolean {
  return accumulators.has(conversationId);
}

/** The pre-inject parent the held accumulator is streaming under (its `parentId`), or undefined if there
 *  is no accumulator. R230: on a prefix-persist FAILURE the inject boundary pins the injected user on THIS
 *  (the pre-inject head) instead of the live head, so the inject is preserved AND chronologically correct
 *  even though the prefix hasn't reached disk — no data-loss "defer", no mis-parent. */
export function getPersistenceAccumulatorParentId(conversationId: string): string | null | undefined {
  const acc = accumulators.get(conversationId);
  return acc ? (acc.parentId ?? null) : undefined;
}

/** R231: repoint the held accumulator's parent (used when a failed-prefix inject boundary must make the
 *  RETAINED accumulator's continuation flow under the newly-persisted injected user instead of the stale
 *  pre-inject head). No-op if there is no accumulator. */
export function rebindPersistenceAccumulatorParent(conversationId: string, parentId: string | null): void {
  const acc = accumulators.get(conversationId);
  if (acc) acc.parentId = parentId ?? undefined;
}

/** Whether the held accumulator (if any) has non-empty content to persist. Lets an on-demand
 *  finalize distinguish "nothing to write" (head null is fine) from "had content but the write
 *  failed" (head null is a data-loss signal). */
export function persistenceAccumulatorHasContent(conversationId: string): boolean {
  const acc = accumulators.get(conversationId);
  return !!acc && acc.sawContent && acc.parts.length > 0;
}
