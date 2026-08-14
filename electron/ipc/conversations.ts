import type { IpcMain } from 'electron';
import { BrowserWindow, dialog } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import { stripRemoteMediaDeep, newRemoteBudget } from '../agent/remote-frame-cap.js';
import { isAbsolute, resolve, extname } from 'path';
import { existsSync } from 'fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { randomUUID, createHash } from 'crypto';
import type { AppConfig } from '../config/schema.js';
import type { ExecutionMode } from '../config/schema.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import { eventBus } from '../automations/event-bus.js';
import { matchConversation } from './conversation-search.js';
import { hookDispatcher } from '../agent/hooks/dispatcher.js';
import { clearAllDiffs, clearConversationDiffs } from '../tools/diff-tracker.js';
import { resolveStreamConfig } from '../agent/model-catalog.js';
import { resolveRuntimeForStream } from '../agent/runtime/index.js';
import { gateMessagesThroughUserPromptSubmit } from '../agent/hooks/prompt-submit-gate.js';
import {
  compactConversationPrefix,
  isStrictPrefix,
  shouldCompactBranchMediaAware,
  selectProtectedTail,
  messageContentSignature,
} from '../agent/compaction.js';
import { stripBranchMediaForCount, DEFAULT_MAX_TOTAL_MEDIA_BYTES } from '../agent/media-fit.js';
import { normalizeAgentCwd, buildAgentInstructions } from '../agent/mastra-agent.js';
import { withWorkingDirectoryPrompt } from '../agent/instructions.js';
import {
  estimateStaticRequestTokens,
  WORKSPACE_TOOL_SCHEMA_TOKENS_ALLOWANCE,
  serializeToolSchemasForStatic,
} from '../agent/static-tokens.js';
import { getRegisteredTools, whenToolsReady, cancelConversationStream } from './agent.js';
import { resolveHeaderTemplates } from '../agent/header-templates.js';
import { stripDisplayOnlyParts } from '../agent/message-sanitizer.js';
import { markCompacting, clearCompacting, isCompacting } from '../agent/compaction-lock.js';
import { COMPACTION_SYSTEM_PROMPT } from '../agent/prompts.js';
import { computeMessageCount } from '../agent/tokenization.js';
import { resolveConversationTokenization } from '../agent/tokenization.js';
import { getComputerUseManager } from '../computer-use/service.js';
import type { ConversationRecord, ConversationIndexEntry } from './conversation-store.js';
import {
  readIndex,
  readConversation,
  writeConversation,
  sanitizeMessageTree,
  deleteConversation,
  deleteConversations,
  clearAllConversations,
  getActiveConversationId,
  setActiveConversationId,
  nextCompactionRevision,
  isRecentlyDeleted,
  isWriteTombstoned,
} from './conversation-store.js';

export type { ConversationRecord } from './conversation-store.js';

// ── incremental broadcast ──────────────────────────────────────────────────
// The store no longer ships the whole conversation set on every change. Each
// mutation broadcasts only what changed so IPC + renderer cost is O(1 change),
// not O(total history).

/** Tagged `conversations:changed` payloads consumed by the renderer. */
export type ConversationChange =
  | { kind: 'upsert'; conversation: ConversationRecord; activeConversationId: string | null }
  | { kind: 'delete'; id: string; activeConversationId: string | null }
  | { kind: 'reset'; activeConversationId: string | null }
  | { kind: 'active'; activeConversationId: string | null };

// Strip heavy base64 media (image/file data URLs, _modelContent parts) from an upsert-broadcast
// conversation, replacing each with a tiny placeholder that keeps the part's TYPE + the message
// ids/structure. An upsert only SIGNALS "changed" + carries metadata + a tree the client uses to
// DECIDE whether to reload (length + tail id/content) — every client re-fetches the full content
// via conversations:get on demand. Sending the raw media tree (retained media up to ~20 MiB)
// over the frame-capped remote transports (web WS 4 MiB, CLI local-bridge 8 MiB) DISCONNECTS the
// socket on media-heavy conversations; /compact can't help (it leaves the raw tree). Cheap
// synchronous structural strip — NOT the async token-aware stripMediaForSerialization.
//
// Media is not only at the top level of a content part: a tool-result part carries it under
// `part.result` (and the canonical model view under `part.result._modelContent`), and a compacted
// part keeps the pre-compaction copy under `part.originalResult`; a tool result can also put
// multi-MiB text under an arbitrary key (output/stdout/content). This delegates to the SHARED
// remote frame-cap (stripRemoteMediaDeep) — the same depth-bounded strip used for stream/sub-agent
// broadcasts — which caps media, pre-compaction backups, AND any oversized string, so a media- or
// text-heavy tool result can't blow the remote frame limit on an upsert.
function stripBroadcastMedia(conv: ConversationRecord): ConversationRecord {
  // ONE shared budget across the whole upsert (both trees, all parts): a per-part budget would let
  // N parts each spend the full cap (N × budget total, over-frame). The cumulative budget bounds the
  // entire serialized upsert frame; once spent, remaining parts are omitted (clients re-fetch full
  // content via conversations:get).
  const budget = newRemoteBudget();
  // Deep-strip each WHOLE node through the shared cap (under the one shared budget): this caps a
  // large STRING `content` (a legacy/plugin message can carry a multi-MiB string, which the old
  // array-only path passed through unchanged and blew the frame) as well as media inside an array
  // content, and bounds the cumulative frame across all nodes.
  const stripTree = (nodes: unknown): unknown =>
    Array.isArray(nodes) ? nodes.map((n) => stripRemoteMediaDeep(n, budget)) : nodes;
  const out: ConversationRecord = {
    ...conv,
    ...(conv.messageTree !== undefined ? { messageTree: stripTree(conv.messageTree) as unknown[] } : {}),
    ...(Array.isArray(conv.messages) ? { messages: stripTree(conv.messages) as unknown[] } : {}),
  };
  // pendingDrafts is a PRIVATE per-conversation stash (the /compact-busy rollback drafts, with
  // possibly multi-MiB attachments) managed exclusively via conversations:set-pending-drafts /
  // claim-pending-draft — no client uses it from an upsert broadcast, and its attachments would
  // blow the remote frame cap. Omit it from the broadcast entirely (each client hydrates it from
  // its own conversations:get / delta channel).
  if ((out as { pendingDrafts?: unknown }).pendingDrafts !== undefined) {
    delete (out as { pendingDrafts?: unknown }).pendingDrafts;
  }
  return out;
}

function broadcastChange(change: ConversationChange): void {
  // Strip heavy base64 media from an upsert payload before sending: remote transports are
  // frame-capped (web WS 4 MiB / CLI 8 MiB) and a media-heavy raw tree would disconnect them;
  // every client re-fetches full content via conversations:get on demand, so the broadcast only
  // needs metadata + a media-light tree for the reload decision. (Electron windows have no frame
  // cap but also re-fetch, so stripping uniformly is safe + simplest.)
  const outgoing: ConversationChange =
    change.kind === 'upsert' ? { ...change, conversation: stripBroadcastMedia(change.conversation) } : change;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('conversations:changed', outgoing);
  }
  broadcastToWebClients('conversations:changed', outgoing);
}

export function broadcastUpsert(appHome: string, conversation: ConversationRecord): void {
  // A suppressed (tombstoned) writeConversation returns the record it was ASKED to write
  // unchanged — nothing landed on disk. Broadcasting it would make clients recreate a phantom
  // deleted conversation absent from disk. Guard the single upsert chokepoint: if this id was
  // recently deleted AND is not in the index (the same condition that suppressed the write),
  // don't broadcast. A legitimate recreate re-adds the index entry, so this only drops phantoms.
  if (isRecentlyDeleted(conversation.id) && !readIndex(appHome).conversations[conversation.id]) {
    return;
  }
  broadcastChange({ kind: 'upsert', conversation, activeConversationId: getActiveConversationId(appHome) });
}
function broadcastDelete(appHome: string, id: string): void {
  broadcastChange({ kind: 'delete', id, activeConversationId: getActiveConversationId(appHome) });
}

// Standalone automations run their agent turns via a SEPARATE registry (automations/actions.ts
// abortAutomationRun) — not the agent:stream activeStreams that cancelConversationStream aborts.
// actions.ts imports THIS module, so it registers its aborter here (avoiding an import cycle);
// the delete handlers call it so deleting a conversation mid-automation stops its tools too.
let automationAborter: ((conversationId: string) => boolean) | null = null;
export function registerAutomationAborter(fn: (conversationId: string) => boolean): void {
  automationAborter = fn;
}
function abortAutomationForConversation(id: string): void {
  try {
    automationAborter?.(id);
  } catch {
    /* best-effort */
  }
}
// Active /compact summarizer AbortControllers, keyed by conversation. A running /compact holds
// its own AbortController (deadline timeout) but is NOT in activeStreams or the automation
// registry, so deleting the conversation mid-summarization would otherwise let the summarizer
// keep billing until its ~285s deadline. Deleting aborts it immediately.
const activeCompactAborters = new Map<string, AbortController>();
// Count of /compact hook awaits that were ABANDONED on the deadline (raceAbort won, but the
// underlying trusted-plugin callback promise stays pending and pins its transcript — we can't
// force-cancel a callback protocol). Bounded so repeated /compacts against hung hooks can't
// accumulate transcripts and exhaust memory: over the cap, runCompactInner bails (no compaction)
// rather than start another abandonable hook. Decremented when each raced promise finally settles.
let outstandingAbandonedCompactionHooks = 0;
const MAX_ABANDONED_COMPACTION_HOOKS = 8;
function abortActiveCompact(id: string): void {
  const ac = activeCompactAborters.get(id);
  if (ac) {
    try {
      ac.abort();
    } catch {
      /* best-effort */
    }
  }
}
function broadcastReset(appHome: string): void {
  broadcastChange({ kind: 'reset', activeConversationId: getActiveConversationId(appHome) });
}
export function broadcastActive(appHome: string): void {
  broadcastChange({ kind: 'active', activeConversationId: getActiveConversationId(appHome) });
}

/**
 * Pre-flight gate for `/compact`: would summarizing the leading prefix `[0,
 * boundaryIndex)` of the (post-hook) message list produce a REUSABLE record?
 *
 * Compaction summarizes that leading prefix and every prefix message's id becomes
 * part of compactedMessageIds; the next-turn reuse gate requires those ids to be a
 * strict prefix of the stored disk branch. So each prefix id MUST be a non-empty
 * string equal to the disk id at the same index. A pre-send/DLP hook can (a)
 * strip/reorder an id inside the prefix OR (b) append/insert a message with no id
 * (or a new id absent from disk) that — with a small/zero protected tail — lands
 * inside the summarized prefix. A plain `min(msgIds,diskIds)` overlap misses case
 * (b): a tail append past diskIds.length is never inspected. Bounding the scan by
 * the real summarizable boundary catches both, so `/compact` can skip BEFORE paying
 * for a summary that would be discarded as non-reusable.
 */
export function summarizablePrefixMatchesDisk(
  msgIds: readonly unknown[],
  diskIds: readonly string[],
  boundaryIndex: number,
): boolean {
  if (msgIds.length === 0 || diskIds.length === 0) return false;
  const prefixLen = Math.max(0, Math.min(boundaryIndex, msgIds.length));
  if (prefixLen === 0) return false; // nothing summarizable
  for (let i = 0; i < prefixLen; i++) {
    const id = msgIds[i];
    if (typeof id !== 'string' || id.length === 0 || i >= diskIds.length || id !== diskIds[i]) {
      return false;
    }
  }
  return true;
}

// ── messageTree helpers (main-process append) ──────────────────────────────

export type StoredTreeMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  parentId: string | null;
  createdAt: string;
  /**
   * Cached exact token count of this single message (JSON.stringify(msg) through
   * tiktoken), computed once at creation. Tree nodes are immutable, so this never
   * needs invalidation. Summed over the active branch to gate compaction WITHOUT
   * re-encoding the whole history every turn (the cause of the main-thread
   * freeze). Optional: older messages and untrusted persisted trees may lack it,
   * and `sumBranchTokenCounts` falls back to a cheap over-biased estimate.
   */
  tokenCount?: number;
  /**
   * Collision-resistant content signature captured when `tokenCount` was computed
   * (see `messageContentSig`). WRITE-side bookkeeping: the store recomputes the
   * count when a node's content no longer matches this signature (a same-id
   * rewrite by a hook/redaction/plugin upsert). Not read on the hot summing path
   * — `sumBranchTokenCounts` trusts the stored count directly and the write
   * boundary keeps it honest.
   */
  tokenCountSig?: number;
};

export function ensureConversationTree(conv: ConversationRecord): {
  tree: StoredTreeMessage[];
  headId: string | null;
} {
  const rawTree = Array.isArray(conv.messageTree) ? (conv.messageTree as StoredTreeMessage[]) : null;
  if (rawTree && rawTree.length > 0) {
    return { tree: rawTree, headId: conv.headId ?? rawTree[rawTree.length - 1]?.id ?? null };
  }
  let parentId: string | null = null;
  const tree = (Array.isArray(conv.messages) ? conv.messages : []).map((m, i) => {
    const raw = m as Partial<StoredTreeMessage> & Record<string, unknown>;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : `msg-${Date.now()}-${i}`;
    const node = {
      ...raw,
      id,
      role: raw.role === 'user' || raw.role === 'system' || raw.role === 'tool' ? raw.role : 'assistant',
      content: raw.content ?? '',
      parentId,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    } as StoredTreeMessage;
    parentId = id;
    return node;
  });
  return { tree, headId: tree[tree.length - 1]?.id ?? null };
}

/** Walk from a node down its most-recently-created child chain to the leaf. */
function findDeepestDescendant(tree: StoredTreeMessage[], startId: string): string {
  let head = startId;
  // Guard against cyclic/malformed persisted trees (put/switch-variant accept
  // untrusted messageTree data) — stop if we revisit a node.
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(head)) return head;
    seen.add(head);
    const children = tree.filter((m) => m.parentId === head);
    if (children.length === 0) return head;
    head = children[children.length - 1].id;
  }
}

export function getConversationBranch(tree: StoredTreeMessage[], headId: string | null): StoredTreeMessage[] {
  if (!headId) return [];
  const byId = new Map(tree.map((m) => [m.id, m] as const));
  const branch: StoredTreeMessage[] = [];
  const seen = new Set<string>();
  let cur: string | null = headId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) break;
    branch.push(node);
    cur = node.parentId;
  }
  return branch.reverse();
}

export function appendConversationMessages(
  appHome: string,
  conversationId: string,
  messages: Array<{ id?: string; role: StoredTreeMessage['role']; content: unknown; createdAt?: string }>,
  options: { skipIfBusy?: boolean; parentId?: string | null; runStatus?: ConversationRecord['runStatus'] } = {},
): ConversationRecord | null {
  const conv = readConversation(appHome, conversationId);
  if (!conv) return null;
  if (options.skipIfBusy && (conv.runStatus === 'running' || conv.runStatus === 'awaiting-approval')) {
    return null;
  }
  // Treat an in-flight /compact as busy for any append that would START a turn (skipIfBusy
  // set, or an explicit running/awaiting-approval status — e.g. an automation targeting an
  // idle-but-compacting conversation). Appending + launching concurrently would make
  // /compact discard its paid summary as busy/drift; the automation diverts/retries after
  // unlock (its own busy handling). A stream's own message appends (no such status/flag)
  // are unaffected — turn admission already can't coexist with /compact.
  if (
    isCompacting(conversationId) &&
    (options.skipIfBusy || options.runStatus === 'running' || options.runStatus === 'awaiting-approval')
  ) {
    return null;
  }

  const { tree, headId } = ensureConversationTree(conv);
  let parentId = options.parentId !== undefined ? options.parentId : headId;
  const now = new Date().toISOString();
  const usedIds = new Set(tree.map((message) => message.id));
  const appended: StoredTreeMessage[] = messages.map((m, i) => {
    const requestedId = typeof m.id === 'string' && m.id.length > 0 && !usedIds.has(m.id) ? m.id : undefined;
    const { count, sig } = computeMessageCount(m);
    const node: StoredTreeMessage = {
      id: requestedId ?? `auto-msg-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      role: m.role,
      content: m.content,
      parentId,
      createdAt: m.createdAt ?? now,
      // Cache the exact per-message token count + its content signature at
      // creation (cheap — one small message). Summed over the branch to gate
      // compaction without re-encoding the whole history each turn; the signature
      // lets a later content rewrite invalidate the count. undefined count when no
      // encoding is available → sumBranchTokenCounts falls back to the estimate.
      tokenCount: count,
      tokenCountSig: sig,
    };
    usedIds.add(node.id);
    parentId = node.id;
    return node;
  });

  const nextTree = [...tree, ...appended];
  const nextHeadId = parentId;
  const branch = getConversationBranch(nextTree, nextHeadId);
  const lastAssistantAt = [...appended].reverse().find((m) => m.role === 'assistant')?.createdAt;

  const next: ConversationRecord = {
    ...conv,
    messageTree: nextTree,
    messages: branch,
    headId: nextHeadId,
    updatedAt: now,
    lastMessageAt: appended[appended.length - 1]?.createdAt ?? now,
    lastAssistantUpdateAt: lastAssistantAt ?? conv.lastAssistantUpdateAt,
    messageCount: branch.length,
    userMessageCount: branch.filter((m) => m.role === 'user').length,
    hasUnread: true,
    ...(options.runStatus !== undefined ? { runStatus: options.runStatus } : {}),
  };

  const written = writeConversation(appHome, next);
  broadcastUpsert(appHome, written);
  return written;
}

/**
 * Remove the given message IDs from a conversation's tree (used to roll back
 * assistant segments persisted at a mid-turn inject boundary when the model then
 * falls back and the whole response is regenerated). Children of a removed node
 * are re-parented to the removed node's parent so the branch stays connected; the
 * head is repointed to the deepest surviving node on the prior branch. No-op if
 * none of the ids are present.
 */
export function dropConversationMessages(
  appHome: string,
  conversationId: string,
  ids: string[],
  options: { runStatus?: ConversationRecord['runStatus'] } = {},
): ConversationRecord | null {
  if (ids.length === 0) return null;
  const conv = readConversation(appHome, conversationId);
  if (!conv) return null;
  const { tree, headId } = ensureConversationTree(conv);
  const dropping = new Set(ids);
  if (![...dropping].some((id) => tree.some((m) => m.id === id))) return null;

  // Re-parent survivors: walk each dropped node to its nearest surviving ancestor.
  const byId = new Map(tree.map((m) => [m.id, m] as const));
  const survivingParent = (parentId: string | null): string | null => {
    let p = parentId;
    while (p && dropping.has(p)) p = byId.get(p)?.parentId ?? null;
    return p;
  };
  const nextTree = tree
    .filter((m) => !dropping.has(m.id))
    .map((m) => ({ ...m, parentId: survivingParent(m.parentId) }));

  // Repoint head: if the current head was dropped, use its nearest survivor.
  let nextHeadId: string | null = headId && dropping.has(headId) ? survivingParent(headId) : headId;
  if (nextHeadId && !nextTree.some((m) => m.id === nextHeadId)) nextHeadId = null;

  const branch = getConversationBranch(nextTree, nextHeadId);
  const now = new Date().toISOString();
  const next: ConversationRecord = {
    ...conv,
    messageTree: nextTree,
    messages: branch,
    headId: nextHeadId,
    updatedAt: now,
    messageCount: branch.length,
    userMessageCount: branch.filter((m) => m.role === 'user').length,
    ...(options.runStatus !== undefined ? { runStatus: options.runStatus } : {}),
  };
  const written = writeConversation(appHome, next);
  broadcastUpsert(appHome, written);
  return written;
}

/**
 * Insert a new message as the PARENT of an existing node (reparenting that node
 * and any of its children-by-position onto the new node). Used to recover an
 * injected user turn that the model already answered but whose persistence failed
 * at the boundary: the terminal assistant is already on disk, so insert the user
 * BEFORE it to restore `… → user → assistant` order. No-op if `beforeId` is absent
 * or the new id already exists.
 */
export function insertConversationMessageBefore(
  appHome: string,
  conversationId: string,
  message: { id?: string; role: StoredTreeMessage['role']; content: unknown; createdAt?: string },
  beforeId: string,
  options: { runStatus?: ConversationRecord['runStatus'] } = {},
): ConversationRecord | null {
  const conv = readConversation(appHome, conversationId);
  if (!conv) return null;
  const { tree, headId } = ensureConversationTree(conv);
  const target = tree.find((m) => m.id === beforeId);
  if (!target) return null;
  const usedIds = new Set(tree.map((m) => m.id));
  const newId =
    typeof message.id === 'string' && message.id.length > 0 && !usedIds.has(message.id)
      ? message.id
      : `auto-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (usedIds.has(newId)) return conv; // already present — no-op
  const now = new Date().toISOString();
  const { count: insCount, sig: insSig } = computeMessageCount(message);
  const node: StoredTreeMessage = {
    id: newId,
    role: message.role,
    content: message.content,
    parentId: target.parentId,
    createdAt: message.createdAt ?? now,
    tokenCount: insCount,
    tokenCountSig: insSig,
  };
  const nextTree = tree.map((m) => (m.id === beforeId ? { ...m, parentId: newId } : m));
  nextTree.push(node);
  const branch = getConversationBranch(nextTree, headId);
  const next: ConversationRecord = {
    ...conv,
    messageTree: nextTree,
    messages: branch,
    updatedAt: now,
    messageCount: branch.length,
    userMessageCount: branch.filter((m) => m.role === 'user').length,
    ...(options.runStatus !== undefined ? { runStatus: options.runStatus } : {}),
  };
  const written = writeConversation(appHome, next);
  broadcastUpsert(appHome, written);
  return written;
}

/**
 * Repoint an EXISTING node's parent to `newParentId` (a sibling-level reparent).
 * Used at the GUI cooperative-inject boundary: the injected user node was
 * pre-persisted parented on the pre-inject head, and main then finalizes its
 * fallback assistant PREFIX under that same head — leaving the two as siblings.
 * Reparent the injected user ONTO the finalized prefix so a renderer-crash
 * fallback finalize yields the correct chronology
 *   … → prefix-assistant → injected-user → continuation.
 * With `makeHead: true`, also advance the head to the reparented node — the
 * injected user is the active tail until a continuation assistant appends onto
 * it, so a crash before any continuation content still reloads WITH the injected
 * user on the active branch (else the head would sit on the prefix and hide it).
 * No-op if either id is absent, they're equal, already parented, or newParentId
 * is a descendant of messageId (would create a cycle).
 */
export function reparentConversationMessage(
  appHome: string,
  conversationId: string,
  messageId: string,
  newParentId: string,
  options: { makeHead?: boolean } = {},
): ConversationRecord | null {
  if (!messageId || !newParentId || messageId === newParentId) return null;
  const conv = readConversation(appHome, conversationId);
  if (!conv) return null;
  const { tree, headId } = ensureConversationTree(conv);
  const node = tree.find((m) => m.id === messageId);
  const newParent = tree.find((m) => m.id === newParentId);
  if (!node || !newParent) return null;
  const alreadyParented = node.parentId === newParentId;
  // Cycle guard: walk up from newParentId; if we reach messageId, reparenting
  // would form a loop. Bounded by tree size.
  const byId = new Map(tree.map((m) => [m.id, m] as const));
  let cursor: string | null = newParentId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === messageId) return conv; // would cycle — refuse (no-op)
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  const now = new Date().toISOString();
  const nextTree = alreadyParented ? tree : tree.map((m) => (m.id === messageId ? { ...m, parentId: newParentId } : m));
  const nextHead = options.makeHead ? messageId : headId;
  if (alreadyParented && nextHead === headId) return conv; // nothing to change
  const branch = getConversationBranch(nextTree, nextHead);
  const next: ConversationRecord = {
    ...conv,
    messageTree: nextTree,
    messages: branch,
    headId: nextHead,
    updatedAt: now,
    messageCount: branch.length,
    userMessageCount: branch.filter((m) => m.role === 'user').length,
  };
  const written = writeConversation(appHome, next);
  broadcastUpsert(appHome, written);
  return written;
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * On-disk mirror of the renderer's reorderPrefixBeforeInjectedUserChain repair,
 * for the GUI terminal-drain case: one or more cooperative injects arrived after
 * the final prepareStep, so no `inject-consumed` fired and the renderer persisted
 * the turn's assistant reply UNDER the LAST injected user, making that assistant
 * the disk head. The model produced that assistant BEFORE seeing any inject, so it
 * belongs BEFORE the whole injected-user chain. If exactly one assistant node is
 * parented on any of `injectedUserIds`, move it to that user's parent and reparent
 * the FIRST injected user onto it — yielding `pre → assistant → u1 → u2 …` — and
 * make the LAST injected user the head. `injectedUserIds` is in FIFO (chain) order.
 * Returns the id that is (now) the head (the last injected user when a repair or
 * chain exists), else the current head. No-op when no injected user is present.
 */
export function reorderInjectPrefixOnDisk(
  appHome: string,
  conversationId: string,
  injectedUserIds: string[],
): string | null {
  if (injectedUserIds.length === 0) return null;
  const conv = readConversation(appHome, conversationId);
  if (!conv) return null;
  const { tree, headId } = ensureConversationTree(conv);
  const present = injectedUserIds.filter((id) => tree.some((m) => m.id === id));
  if (present.length === 0) return headId;
  const lastInjected = present[present.length - 1];
  const idSet = new Set(present);
  // The misplaced prefix: a lone assistant whose parent is one of the injected users.
  const prefixes = tree.filter(
    (m) => m.role === 'assistant' && typeof m.parentId === 'string' && idSet.has(m.parentId),
  );
  if (prefixes.length !== 1) {
    // No assistant is parented UNDER an injected user. Two sub-cases:
    //   (a) main's crash-backstop fallback finalized the turn's assistant as a
    //       SIBLING of the first injected user (a child of the pre-inject head P,
    //       because the fallback accumulator was still parented on P). That reply
    //       exists but sits OFF the injected-user branch — thread it in as
    //       `P → assistant → u1 … uN` so the continuation launches WITH it.
    //   (b) genuinely no assistant yet (not persisted) or already correctly
    //       ordered — just make the last injected user the head.
    const firstInjected = present[0];
    const firstUser = tree.find((m) => m.id === firstInjected);
    const preInjectHead = firstUser?.parentId ?? null;
    const siblingAssistants =
      preInjectHead !== null
        ? tree.filter((m) => m.role === 'assistant' && m.parentId === preInjectHead && !idSet.has(m.id))
        : [];
    if (firstUser && siblingAssistants.length === 1) {
      // (a) Reparent: assistant keeps P as parent; first injected user reparents onto it.
      const sib = siblingAssistants[0];
      const nextTree = tree.map((m) => (m.id === firstInjected ? { ...m, parentId: sib.id } : m));
      const branch = getConversationBranch(nextTree, lastInjected);
      const next: ConversationRecord = {
        ...conv,
        messageTree: nextTree,
        messages: branch,
        headId: lastInjected,
        updatedAt: new Date().toISOString(),
        messageCount: branch.length,
        userMessageCount: branch.filter((m) => m.role === 'user').length,
      };
      broadcastUpsert(appHome, writeConversation(appHome, next));
      return lastInjected;
    }
    // (b) The last injected user should be the head so the continuation launches on
    // the full chain; advance it only if it isn't already.
    if (headId === lastInjected) return headId;
    const branch = getConversationBranch(tree, lastInjected);
    const next: ConversationRecord = {
      ...conv,
      messageTree: tree,
      messages: branch,
      headId: lastInjected,
      updatedAt: new Date().toISOString(),
      messageCount: branch.length,
      userMessageCount: branch.filter((m) => m.role === 'user').length,
    };
    broadcastUpsert(appHome, writeConversation(appHome, next));
    return lastInjected;
  }
  const prefix = prefixes[0];
  const firstInjected = present[0];
  const firstUser = tree.find((m) => m.id === firstInjected)!;
  const chainParent = firstUser.parentId; // the pre-inject head
  const nextTree = tree.map((m) => {
    if (m.id === prefix.id) return { ...m, parentId: chainParent };
    if (m.id === firstInjected) return { ...m, parentId: prefix.id };
    return m;
  });
  const branch = getConversationBranch(nextTree, lastInjected);
  const next: ConversationRecord = {
    ...conv,
    messageTree: nextTree,
    messages: branch,
    headId: lastInjected,
    updatedAt: new Date().toISOString(),
    messageCount: branch.length,
    userMessageCount: branch.filter((m) => m.role === 'user').length,
  };
  const written = writeConversation(appHome, next);
  broadcastUpsert(appHome, written);
  return lastInjected;
}

type ConversationMessageLike = {
  role?: unknown;
  createdAt?: unknown;
};

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

function latestTimestamp(...values: Array<string | null | undefined>): string | null {
  let latestValue: string | null = null;
  let latestMs = 0;
  for (const value of values) {
    const parsed = timestampMs(value);
    if (parsed > latestMs) {
      latestMs = parsed;
      latestValue = value ?? null;
    }
  }
  return latestValue;
}

/** Derive lastMessageAt / lastAssistantUpdateAt purely from a committed branch.
 *  Used by tree mutations (edit / regenerate / rewind / switch-variant / fork)
 *  so the activity timestamps reflect the ACTIVE branch, not stale values
 *  inherited from a source conversation or a pre-edit head. */
function deriveBranchActivity(branch: ConversationMessageLike[]): {
  lastMessageAt: string | null;
  lastAssistantUpdateAt: string | null;
} {
  let lastMessageAt: string | null = null;
  let lastAssistantUpdateAt: string | null = null;
  for (const message of branch) {
    const createdAt = toIsoTimestamp(message.createdAt);
    if (!createdAt) continue;
    lastMessageAt = latestTimestamp(lastMessageAt, createdAt);
    if (message.role === 'assistant') {
      lastAssistantUpdateAt = latestTimestamp(lastAssistantUpdateAt, createdAt);
    }
  }
  return { lastMessageAt, lastAssistantUpdateAt };
}

export function reconcileConversationActivity(
  prev: ConversationRecord | undefined,
  next: ConversationRecord,
): ConversationRecord {
  const messages = Array.isArray(next.messages) ? (next.messages as ConversationMessageLike[]) : [];
  let derivedLastMessageAt: string | null = null;
  let derivedLastAssistantUpdateAt: string | null = null;
  let derivedUserMessageCount = 0;

  for (const message of messages) {
    const createdAt = toIsoTimestamp(message.createdAt);
    if (message.role === 'user') {
      derivedUserMessageCount++;
    }
    if (createdAt) {
      derivedLastMessageAt = latestTimestamp(derivedLastMessageAt, createdAt);
      if (message.role === 'assistant') {
        derivedLastAssistantUpdateAt = latestTimestamp(derivedLastAssistantUpdateAt, createdAt);
      }
    }
  }

  return {
    ...next,
    messageCount: messages.length,
    userMessageCount: derivedUserMessageCount,
    lastMessageAt: latestTimestamp(prev?.lastMessageAt, next.lastMessageAt, derivedLastMessageAt),
    lastAssistantUpdateAt: latestTimestamp(
      prev?.lastAssistantUpdateAt,
      next.lastAssistantUpdateAt,
      derivedLastAssistantUpdateAt,
    ),
  };
}

export function isStaleRunningWrite(prev: ConversationRecord, next: ConversationRecord): boolean {
  // Protect both terminal states ('idle' and 'awaiting-approval') from being
  // clobbered by a stale debounced write that still carries runStatus:'running'.
  if ((prev.runStatus !== 'idle' && prev.runStatus !== 'awaiting-approval') || next.runStatus !== 'running')
    return false;

  // A new user turn is allowed to move an idle conversation back to running.
  if (next.userMessageCount > prev.userMessageCount) return false;

  // Regenerate / restart flows legitimately move the active branch or head
  // without adding a new user message.
  if (next.headId !== prev.headId || next.messageCount !== prev.messageCount) return false;

  // A legitimate restart will usually change the active branch or head.
  const sameBranch =
    next.headId === prev.headId &&
    next.messageCount === prev.messageCount &&
    next.userMessageCount === prev.userMessageCount;
  const noFreshActivity =
    timestampMs(next.lastAssistantUpdateAt) <= timestampMs(prev.lastAssistantUpdateAt) &&
    timestampMs(next.lastMessageAt) <= timestampMs(prev.lastMessageAt);
  if (sameBranch && noFreshActivity) return true;

  // Stale async writes often carry an older updatedAt, or they were read before
  // the done handler populated lastAssistantUpdateAt.
  return (
    timestampMs(next.updatedAt) <= timestampMs(prev.updatedAt) ||
    Boolean(prev.lastAssistantUpdateAt && !next.lastAssistantUpdateAt) ||
    timestampMs(next.lastAssistantUpdateAt) < timestampMs(prev.lastAssistantUpdateAt) ||
    timestampMs(next.lastMessageAt) < timestampMs(prev.lastMessageAt)
  );
}

export function preserveTerminalRunFields(prev: ConversationRecord, next: ConversationRecord): ConversationRecord {
  if (!isStaleRunningWrite(prev, next)) return next;

  // A write detected as stale-running must not be allowed to mutate the message
  // tree at all: it may carry the SAME node ids as disk but with older partial
  // content (e.g. an assistant node captured mid-stream), which the id-union
  // merge above does NOT catch (nothing is "missing"), so the final assistant
  // body would be replaced by the stale partial. Restore the stored tree/branch/
  // head/counts and keep only the benign non-tree metadata from `next`.
  return {
    ...next,
    messageTree: prev.messageTree,
    messages: prev.messages,
    headId: prev.headId,
    messageCount: prev.messageCount,
    userMessageCount: prev.userMessageCount,
    runStatus: prev.runStatus,
    hasUnread: prev.hasUnread,
    lastAssistantUpdateAt: prev.lastAssistantUpdateAt,
    lastMessageAt: prev.lastMessageAt,
    updatedAt: timestampMs(prev.updatedAt) >= timestampMs(next.updatedAt) ? prev.updatedAt : next.updatedAt,
  };
}

export function registerConversationHandlers(
  ipcMain: IpcMain,
  appHome: string,
  getConfig?: () => AppConfig,
  getPluginManager?: () => PluginManager | null,
  isTurnActive?: (conversationId: string) => boolean,
): void {
  // In-flight guard for on-demand `/compact`: a summarization is an async PAID
  // model call, and the idle checks (runStatus) don't cover a second concurrent
  // `/compact` for the same conversation. Without this, two commands both pass the
  // checks, each bill a summary, and race to persist — wasting money and clobbering.
  const compactInFlight = new Set<string>();
  ipcMain.handle('conversations:list', () => {
    // Reads only the lightweight index — no message bodies loaded.
    const index = readIndex(appHome);
    const entries: ConversationIndexEntry[] = Object.values(index.conversations);
    entries.sort((a, b) => {
      const aAt = a.lastAssistantUpdateAt ?? a.lastMessageAt ?? a.updatedAt ?? a.createdAt;
      const bAt = b.lastAssistantUpdateAt ?? b.lastMessageAt ?? b.updatedAt ?? b.createdAt;
      return bAt.localeCompare(aAt);
    });
    return entries;
  });

  // Content search: match a term against title/fallbackTitle AND message bodies.
  // conversations:list reads only the lightweight index (no bodies), so search
  // reads each conversation file. Results keep the index's recency order and
  // carry a snippet of the match. Bounded: empty term returns []; a hard result
  // cap protects the caller from a huge store.
  ipcMain.handle('conversations:search', (_event, term: unknown) => {
    // Cap the term length: a search term longer than this is never meaningful and
    // just makes every per-conversation includes() scan more work.
    const MAX_TERM_LEN = 200;
    const raw = typeof term === 'string' ? term.trim() : '';
    const q = raw.length > MAX_TERM_LEN ? raw.slice(0, MAX_TERM_LEN) : raw;
    if (!q) return [];
    const MAX_RESULTS = 100;
    const index = readIndex(appHome);
    const ordered = Object.values(index.conversations).sort((a, b) => {
      const aAt = a.lastAssistantUpdateAt ?? a.lastMessageAt ?? a.updatedAt ?? a.createdAt;
      const bAt = b.lastAssistantUpdateAt ?? b.lastMessageAt ?? b.updatedAt ?? b.createdAt;
      return bAt.localeCompare(aAt);
    });
    const results: Array<ConversationIndexEntry & { matchedIn: 'title' | 'content'; snippet: string }> = [];
    for (const entry of ordered) {
      if (results.length >= MAX_RESULTS) break;
      const record = readConversation(appHome, entry.id);
      if (!record) continue;
      const hit = matchConversation(record, q);
      if (hit) results.push({ ...entry, matchedIn: hit.matchedIn, snippet: hit.snippet });
    }
    return results;
  });

  ipcMain.handle('conversations:get', (_event, id: string) => {
    return readConversation(appHome, id) ?? null;
  });

  ipcMain.handle('conversations:put', (_event, conversation: ConversationRecord) => {
    const tree = Array.isArray(conversation.messageTree) ? conversation.messageTree : [];
    const prev = readConversation(appHome, conversation.id);
    const prevTreeLen = prev && Array.isArray(prev.messageTree) ? prev.messageTree.length : 0;

    // Resurrection guard: this conversation was DELETED and is not on disk (prev null). A stale
    // in-flight optimistic put must NOT recreate it — writeConversation would skip the write but
    // still return a record, so broadcasting an upsert + returning ok here would make the renderer
    // launch an agent run against a deleted chat. Reject so the renderer rolls back instead
    // (matches the compacting-busy rejection contract). isWriteTombstoned covers BOTH the in-memory
    // TTL tombstone AND the durable index ring (survives restart / TTL expiry).
    if (!prev && isWriteTombstoned(appHome, conversation.id)) {
      return { rejected: 'conversation-deleted' as const };
    }

    // A `/compact` is summarizing this conversation right now. Admission for a new turn
    // (or any tree/head mutation) isn't atomic with the renderer's OPTIMISTIC put — a
    // send/edit/regenerate/rewind that races the `conversations:compacting` broadcast
    // would mutate disk under the summarizer and then either be rejected as busy (leaving
    // an orphaned optimistic change) or force the paid summary's final CAS to fail. So
    // reject ANY message-tree OR head mutation while compacting: novel ids, dropped ids,
    // a head change, OR a same-id content edit. Metadata-only puts (rename / settings /
    // archive — identical tree + head + per-message content) proceed normally. Signal
    // busy so the renderer rolls back its optimistic change. (The ComposerInput + the
    // cross-client store already block sends while compacting; this closes the broadcast-
    // in-flight race authoritatively on the main side.)
    if (prev && isCompacting(conversation.id)) {
      const prevTreeArr2 = (prev.messageTree as Array<{ id?: unknown }> | undefined) ?? [];
      const incomingTreeArr = tree as Array<{ id?: unknown }>;
      const treeSig = (nodes: Array<{ id?: unknown }>): string =>
        nodes
          .map((m) =>
            typeof m?.id === 'string'
              ? `${m.id}:${messageContentSignature(m as Parameters<typeof messageContentSignature>[0])}`
              : '',
          )
          .join('|');
      const headChanged = (conversation.headId ?? null) !== (prev.headId ?? null);
      const treeChanged = treeSig(prevTreeArr2) !== treeSig(incomingTreeArr);
      // Also reject a put that STARTS a turn via a runStatus transition to running /
      // awaiting-approval, even when tree+head are unchanged (e.g. a plan-mode auto-restart
      // persists the same tree as `running`). Launching that turn would be rejected as busy
      // and the restart lost; reject the put so the caller retries after compaction.
      const startsTurn =
        (conversation.runStatus === 'running' || conversation.runStatus === 'awaiting-approval') &&
        prev.runStatus !== conversation.runStatus;
      if (headChanged || treeChanged || startsTurn) {
        return { ...prev, rejected: 'conversation-busy' as const };
      }
    }

    // Guard: never allow a write that would lose messages compared to what's on disk.
    // If the stored tree contains message ids the incoming tree lacks, the incoming
    // write is stale or concurrent — union the missing stored messages back in and
    // keep the stored headId so the on-disk branch stays reachable. Any incoming
    // messages not already on disk are also unioned in as sibling branches so a
    // concurrent writer's additions survive.
    let nextConversation = conversation;

    if (prev && prevTreeLen > 0) {
      const prevTree = prev.messageTree as Array<{ id?: unknown }>;
      const incomingIds = new Set(
        (tree as Array<{ id?: unknown }>).map((m) => (typeof m?.id === 'string' ? m.id : null)),
      );
      const missingFromIncoming = prevTree.filter((m) => typeof m?.id === 'string' && !incomingIds.has(m.id as string));
      if (missingFromIncoming.length > 0) {
        const prevIds = new Set(prevTree.map((m) => (typeof m?.id === 'string' ? m.id : null)));
        const novel = (tree as Array<{ id?: unknown }>).filter(
          (m) => typeof m?.id === 'string' && !prevIds.has(m.id as string),
        );
        // Take incoming's version of every shared id (so same-id content updates like a
        // stream's partial→final assistant text are preserved) and union in the stored
        // ids the incoming write is missing. Stale writers (title-gen, settings persist)
        // never add messages, so novel.length === 0 → keep prev's head. Concurrent
        // writers have novel messages → keep the incoming head so the caller's active
        // branch stays reachable.
        const mergedTree = [...tree, ...missingFromIncoming];
        const mergedHead = novel.length > 0 ? (conversation.headId ?? prev.headId) : prev.headId;
        const branch = getConversationBranch(mergedTree as StoredTreeMessage[], mergedHead ?? null);
        nextConversation = {
          ...conversation,
          messages: branch,
          messageTree: mergedTree,
          headId: mergedHead,
          messageCount: branch.length,
          userMessageCount: branch.filter((m) => m.role === 'user').length,
          hasUnread: conversation.hasUnread || prev.hasUnread,
        };
      }
    }

    if (prev) {
      nextConversation = reconcileConversationActivity(prev, nextConversation);
      nextConversation = preserveTerminalRunFields(prev, nextConversation);
      // DLP: a UserPromptSubmit modify hook may have redacted a user turn on disk
      // (flagged redactedByHook). The renderer's stream-done write carries the same node
      // id with the RAW user text. Restore the stored redacted content onto any shared
      // node NOW — BEFORE the compaction-preservation covered-sig check below — else that
      // check would compare the raw incoming content against the (redacted) covered sig,
      // decide "changed", and drop a valid paid summary.
      {
        const prevTreeArr0 = Array.isArray(prev.messageTree) ? (prev.messageTree as StoredTreeMessage[]) : [];
        const redacted0 = new Map(
          prevTreeArr0.filter((m) => (m as { redactedByHook?: boolean }).redactedByHook).map((m) => [m.id, m] as const),
        );
        if (redacted0.size > 0 && Array.isArray(nextConversation.messageTree)) {
          const nextTree = (nextConversation.messageTree as StoredTreeMessage[]).map((m) => {
            const r = redacted0.get(m.id);
            return r
              ? { ...m, content: r.content, redactedByHook: true, tokenCount: undefined, tokenCountSig: undefined }
              : m;
          });
          const nextBranch = getConversationBranch(nextTree, nextConversation.headId ?? null);
          nextConversation = { ...nextConversation, messageTree: nextTree, messages: nextBranch };
        }
      }
      // Preserve the NEWER compaction record against a stale concurrent METADATA
      // write. `/compact` persists conversationCompaction out-of-band (tree untouched);
      // a rename/settings/archive flow does a separate get-then-put, so its put can
      // carry a record read BEFORE a newer summary committed — a plain id-equality
      // guard misses this (incoming A ≠ stored B, so B would be overwritten). On a
      // tree-UNCHANGED write, keep whichever record has the newer createdAt (real
      // clears — fork/edit/regenerate — go through commitTreeUpdate, not put, so a
      // metadata put never legitimately clears the record).
      {
        const prevComp = prev.conversationCompaction as
          | { compactionId?: string; createdAt?: string; compactedMessageIds?: string[] }
          | null
          | undefined;
        const nextComp = nextConversation.conversationCompaction as
          | { compactionId?: string; createdAt?: string }
          | null
          | undefined;
        // "Tree unchanged" must mean the COVERED (summarized) messages are unchanged,
        // compared against the FINAL tree that will actually be persisted
        // (nextConversation.messageTree — which may be the MERGED tree when a stale
        // shorter incoming write had missing nodes restored above), NOT the raw incoming
        // `tree`. Using the raw incoming length/content here would skip preservation
        // after a merge and let a stale/null incoming record overwrite the newer stored
        // summary. A same-length put that genuinely EDITS a covered message (not a
        // partial→final restore) still correctly fails this and lets the clear stand.
        const finalTree = (nextConversation.messageTree ?? tree) as Array<{ id?: unknown }>;
        const coveredIds = new Set(prevComp?.compactedMessageIds ?? []);
        const sigOf = (nodes: Array<{ id?: unknown; content?: unknown; role?: unknown }>): string => {
          const parts: string[] = [];
          for (const n of nodes) {
            if (typeof n?.id !== 'string' || !coveredIds.has(n.id)) continue;
            // Per-message BOUNDED hash (not raw content): a media-heavy covered branch
            // would otherwise concatenate history-sized base64 strings on every
            // conversations:put and risk OOMing the main process.
            parts.push(`${n.id}:${messageContentSignature(n)}`);
          }
          return parts.join(' ');
        };
        // The stored summary stays valid as long as its COVERED prefix is intact on the
        // final active branch — SUFFIX growth (a stale client appending one more message)
        // must NOT invalidate it. So: (a) the covered ids are still an ordered strict
        // prefix of the final active branch, AND (b) their content signatures are
        // unchanged. (The old `finalTree.length === prevTreeLen` gate let any suffix
        // append bypass preservation, dropping a freshly-committed record for a stale one.)
        const finalActiveBranchIds = getConversationBranch(
          finalTree as unknown as StoredTreeMessage[],
          nextConversation.headId ?? prev.headId ?? null,
        ).map((m) => m.id);
        const coveredPrefixIntact =
          coveredIds.size === 0 ||
          (isStrictPrefix(prevComp?.compactedMessageIds ?? [], finalActiveBranchIds) &&
            sigOf(prev.messageTree as Array<{ id?: unknown }>) === sigOf(finalTree));
        const coveredUnchanged = coveredPrefixIntact;
        if (coveredUnchanged && prevComp) {
          // Freshness must be decided by MAIN-authoritative monotonic revisions, NEVER by
          // renderer wall-clock `createdAt` (a clock-skewed client could otherwise drop a
          // genuinely-newer summary). Crucially we must not compare a createdAt against a
          // revision (different clocks). Rules for a DIFFERENT-id incoming record:
          //   - both have a revision → newer iff incomingRev >= storedRev
          //   - incoming has NONE (a fresh GUI/web production main hasn't stamped yet) →
          //     treat as newer and STAMP it on accept (main becomes authoritative)
          //   - stored has NONE but incoming HAS one → incoming is main-stamped, newer
          //   - neither has one (legacy) → fall back to createdAt (same clock domain)
          const prevRev = (prevComp as { compactionRevision?: number }).compactionRevision;
          const nextRev = nextComp ? (nextComp as { compactionRevision?: number }).compactionRevision : undefined;
          const sameRecord = !!nextComp && nextComp.compactionId === prevComp.compactionId;
          const incomingIsNewer = (() => {
            if (!nextComp || sameRecord) return false;
            if (typeof prevRev === 'number' && typeof nextRev === 'number') return nextRev >= prevRev;
            if (typeof nextRev === 'number') return true; // incoming main-stamped, stored legacy
            if (typeof prevRev === 'number') {
              // Incoming is UNSTAMPED but the stored record IS main-stamped. Compaction
              // events now stamp a revision at emit time, so a legitimate fresh production
              // arrives stamped — an unstamped incoming is a STALE / non-authoritative write
              // (e.g. a reconnected web client's Stop persisting an old accumulator). Do NOT
              // let it overwrite the newer stamped record.
              return false;
            }
            // Neither stamped (legacy): fall back to createdAt (same renderer clock domain).
            const p = Date.parse(prevComp.createdAt ?? '') || 0;
            const n = Date.parse((nextComp as { createdAt?: string }).createdAt ?? '') || 0;
            return n >= p;
          })();
          if (!incomingIsNewer) {
            nextConversation = {
              ...nextConversation,
              conversationCompaction: prev.conversationCompaction,
            };
          } else if (typeof nextRev !== 'number') {
            // Accepting a fresh (unstamped) incoming record — stamp a main revision so
            // FUTURE comparisons are ordering-correct regardless of the renderer's clock.
            nextConversation = {
              ...nextConversation,
              conversationCompaction: {
                ...(nextConversation.conversationCompaction as object),
                compactionRevision: nextCompactionRevision(),
              } as ConversationRecord['conversationCompaction'],
            };
          }
        }
        // Validate the INCOMING compaction record (whichever one we end up keeping)
        // against the FINAL merged tree: a full-record writer can commit same-id content
        // B while this record summarized content A. IDs alone (checked at reuse) can't
        // catch that. If the kept record carries coveredContentSig, require each covered
        // id to (a) exist in the final tree and (b) match the recorded signature; drop the
        // record otherwise so a stale summary can't hide B on the next turn's reuse.
        {
          // Sanitize the tree/head NOW — the SAME dedup/merge/parent-repair/head-repoint
          // writeConversation will apply — BEFORE validating the compaction record against
          // it. Otherwise validation runs on the pre-sanitize tree while the DIFFERENT
          // sanitized tree is written, so the stored coveredContentSig could describe
          // content that wasn't persisted (reuse then rejects + re-compacts). Idempotent
          // (writeConversation sanitizes again harmlessly).
          if (Array.isArray(nextConversation.messageTree)) {
            const s = sanitizeMessageTree(
              nextConversation.messageTree as Parameters<typeof sanitizeMessageTree>[0],
              nextConversation.headId ?? null,
            );
            const sBranch = getConversationBranch(s.tree as StoredTreeMessage[], s.headId ?? null);
            nextConversation = { ...nextConversation, messageTree: s.tree, headId: s.headId, messages: sBranch };
          }
          const keptComp = nextConversation.conversationCompaction as
            | { compactedMessageIds?: string[]; coveredContentSig?: Record<string, string> }
            | null
            | undefined;
          if (keptComp?.coveredContentSig && Array.isArray(keptComp.compactedMessageIds)) {
            const finalById = new Map(
              (nextConversation.messageTree as Array<{ id?: unknown }> | undefined)?.map((n) => [
                typeof n?.id === 'string' ? n.id : '',
                n,
              ]) ?? [],
            );
            // The record is only reusable next turn if its covered ids form an ordered
            // STRICT PREFIX of the final active branch (a hook can insert/replace an id
            // inside the prefix, breaking that) AND every covered id is signed + matches
            // (an unsigned covered id is unverifiable → can't trust it). Mirrors the
            // server-owned recovery/`/compact` persist gate; otherwise next-turn reuse
            // rejects the record and re-summarizes/rebills every turn.
            const finalActiveIds = getConversationBranch(
              (nextConversation.messageTree ?? []) as StoredTreeMessage[],
              nextConversation.headId ?? prev.headId ?? null,
            ).map((m) => m.id);
            const prefixOk = isStrictPrefix(keptComp.compactedMessageIds, finalActiveIds);
            const drifted =
              !prefixOk ||
              keptComp.compactedMessageIds.some((id) => {
                const expected = keptComp.coveredContentSig?.[id];
                if (expected === undefined) return true; // unsigned covered id → unverifiable, drop
                const node = finalById.get(id);
                if (!node) return true; // covered id no longer on disk → stale
                return messageContentSignature(node as Parameters<typeof messageContentSignature>[0]) !== expected;
              });
            if (drifted) {
              nextConversation = { ...nextConversation, conversationCompaction: null };
            }
          }
        }
      }
    } else {
      nextConversation = reconcileConversationActivity(undefined, nextConversation);
    }

    // Stamp a main-authoritative compactionRevision on ANY compaction record about to be
    // written that lacks one — including the FIRST GUI/web compaction (no prevComp, so the
    // preservation block above never ran). Without this, two successive unstamped records
    // fall back to renderer createdAt in the freshness compare, where clock skew can drop a
    // genuinely-newer paid summary. (An already-stamped record — e.g. preserved prev, or a
    // record main just stamped — is left as-is.)
    {
      const comp = nextConversation.conversationCompaction as { compactionRevision?: number } | null | undefined;
      if (comp && typeof comp.compactionRevision !== 'number') {
        nextConversation = {
          ...nextConversation,
          conversationCompaction: {
            ...(comp as object),
            compactionRevision: nextCompactionRevision(),
          } as ConversationRecord['conversationCompaction'],
        };
      }
    }

    // Durable pendingDrafts (the /compact-busy rollback stash) is owned EXCLUSIVELY by
    // conversations:set-pending-drafts (an add/remove delta on the current disk record). A
    // generic put must NEVER write it: the renderer's persistConversation does `{...conv, ...}`
    // from a conversations.get snapshot, so it carries whatever pendingDrafts was on disk at
    // get-time — a STALE value that would clobber a concurrently-stashed draft (data loss before
    // crash recovery). Always take the CURRENT disk value (prev), ignoring the incoming record's.
    {
      const prevDrafts = prev
        ? (prev as { pendingDrafts?: ConversationRecord['pendingDrafts'] }).pendingDrafts
        : undefined;
      if (prevDrafts !== undefined) {
        nextConversation = { ...nextConversation, pendingDrafts: prevDrafts };
      } else if ((nextConversation as { pendingDrafts?: unknown }).pendingDrafts !== undefined) {
        // Prev has none — drop any (stale) drafts the incoming record carried.
        nextConversation = { ...nextConversation };
        delete (nextConversation as { pendingDrafts?: unknown }).pendingDrafts;
      }
    }

    const written = writeConversation(appHome, nextConversation);
    // If the id is tombstoned (deleted), writeConversation SUPPRESSES the write (returns the record
    // unchanged, nothing hits disk). Do NOT broadcast a phantom upsert or emit ConversationStart or
    // report success in that case — signal conversation-deleted so the client rolls back its
    // optimistic state (matching the renderer's persistConversation deleted-rollback contract).
    if (isWriteTombstoned(appHome, conversation.id)) {
      return { rejected: 'conversation-deleted' as const };
    }
    broadcastUpsert(appHome, written);
    if (!prev) {
      eventBus.emit('conversation', 'created', { id: conversation.id, title: nextConversation.title });
      void hookDispatcher.dispatch('ConversationStart', {
        conversationId: conversation.id,
        title: nextConversation.title,
      });
    }
    return { ok: true };
  });

  ipcMain.handle('conversations:delete', (_event, id: string) => {
    // Delete FIRST (synchronous), then act on the result. deleteConversation now preserves
    // the conversation if its file rm fails — cancelling/broadcasting before confirming
    // would abort a valid run + broadcast a deletion for a conversation still on disk.
    const removed = deleteConversation(appHome, id);
    if (!removed) return { ok: false, error: 'delete-failed' };
    // Abort any live stream/submit for the (now-deleted) conversation so its tools and
    // side effects don't keep running. No await between delete and cancel, so no tool runs.
    cancelConversationStream(id);
    abortAutomationForConversation(id); // standalone automations use a separate abort registry
    abortActiveCompact(id); // stop a running /compact summarizer (not in activeStreams)
    broadcastDelete(appHome, id);
    clearConversationDiffs(id);

    // Clean up associated computer-use sessions
    if (getConfig) {
      try {
        const manager = getComputerUseManager(appHome, getConfig);
        manager.removeSessionsByConversation(id);
      } catch {
        // Computer-use module may not be initialized yet — safe to ignore
      }
    }

    return { ok: true };
  });

  ipcMain.handle('conversations:deleteMany', (_event, ids: unknown) => {
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
    if (list.length === 0) return { ok: true, deleted: 0 };
    const removed = deleteConversations(appHome, list);
    // Abort live streams ONLY for conversations that were ACTUALLY removed. deleteConversations
    // is synchronous (rmSync) with no await, so no tool can execute between the delete and this
    // cancel; cancelling before the delete would irreversibly stop a run whose file rm FAILED
    // (deleteConversations preserves such a conversation) — a surviving chat with a dead run.
    for (const id of removed) {
      cancelConversationStream(id);
      abortAutomationForConversation(id);
      abortActiveCompact(id);
    }
    // Broadcast a delete per removed id so each renderer/web client prunes O(1),
    // matching the single-delete path (there is no batched change kind).
    for (const id of removed) {
      broadcastDelete(appHome, id);
      clearConversationDiffs(id);
    }
    // Clean up associated computer-use sessions ONLY for conversations that were actually
    // removed (deleteConversations returns the successfully-deleted ids). Using the full
    // requested `list` would destroy sessions for a conversation whose file rm FAILED —
    // leaving the conversation intact but its sessions gone.
    if (getConfig) {
      try {
        const manager = getComputerUseManager(appHome, getConfig);
        for (const id of removed) manager.removeSessionsByConversation(id);
      } catch {
        // Computer-use module may not be initialized yet — safe to ignore
      }
    }
    return { ok: true, deleted: removed.length, removedIds: removed };
  });

  ipcMain.handle('conversations:clear', () => {
    // clearAllConversations is synchronous (rmSync) with no await, so no tool can execute between
    // the wipe and the teardown below — same ordering guarantee as deleteMany. It returns the UNION
    // of indexed ids AND on-disk record files, so an ORPHAN record (file present, no index entry)
    // is torn down + tombstoned too (else its live stream keeps running / a stale persist recreates
    // it). Abort each cleared conversation's live agent stream, automation, and compaction.
    const { cleared, fullyCleared } = clearAllConversations(appHome);
    for (const conversationId of cleared) {
      cancelConversationStream(conversationId);
      abortAutomationForConversation(conversationId);
      abortActiveCompact(conversationId);
    }
    // Clean up computer-use sessions for every cleared conversation.
    if (getConfig) {
      try {
        const manager = getComputerUseManager(appHome, getConfig);
        for (const conversationId of cleared) {
          manager.removeSessionsByConversation(conversationId);
        }
      } catch {
        // Safe to ignore
      }
    }

    // A FULL reset tells clients to discard EVERY accumulator + supersede their generations. That's
    // correct only when EVERYTHING was actually removed. If ANY record's rm FAILED (an indexed OR an
    // orphan file survived), clearAllConversations reports fullyCleared=false and left that record +
    // its live stream intact — a full reset would then drop that surviving run's accumulator on
    // clients (its tools keep executing, output ignored). So: reset only when fully cleared;
    // otherwise clear diffs + broadcast a per-id DELETE for each successfully-cleared id.
    if (fullyCleared) {
      clearAllDiffs();
      broadcastReset(appHome);
    } else {
      for (const conversationId of cleared) {
        clearConversationDiffs(conversationId);
        broadcastDelete(appHome, conversationId);
      }
    }
    return { ok: true };
  });

  // ── edit / regenerate / variant navigation ────────────────────────────────
  // The renderer normally drives these via local tree state + `conversations:put`,
  // but exposing them as IPC lets plugins, automations, and the web bridge
  // perform the same operations without duplicating tree logic.

  const commitTreeUpdate = (
    conv: ConversationRecord,
    tree: StoredTreeMessage[],
    headId: string | null,
    extra: Partial<ConversationRecord> = {},
  ): ConversationRecord => {
    const branch = getConversationBranch(tree, headId);
    const now = new Date().toISOString();
    const activity = deriveBranchActivity(branch as ConversationMessageLike[]);
    const next: ConversationRecord = {
      ...conv,
      messageTree: tree,
      messages: branch,
      headId,
      updatedAt: now,
      messageCount: branch.length,
      userMessageCount: branch.filter((m) => m.role === 'user').length,
      lastMessageAt: activity.lastMessageAt,
      lastAssistantUpdateAt: activity.lastAssistantUpdateAt,
      ...extra,
    };
    const written = writeConversation(appHome, next);
    broadcastUpsert(appHome, written);
    return written;
  };

  ipcMain.handle(
    'conversations:edit-message',
    (_event, conversationId: string, messageId: string, newContent: unknown) => {
      const conv = readConversation(appHome, conversationId);
      if (!conv) return { ok: false, error: 'conversation-not-found' };
      // A tree mutation during /compact would break the summary's final CAS (or leave a
      // half-applied edit). Reject while compacting; the client retries after it finishes.
      if (isCompacting(conversationId)) return { ok: false, error: 'conversation-busy' };

      const { tree } = ensureConversationTree(conv);
      const source = tree.find((m) => m.id === messageId);
      if (!source) return { ok: false, error: 'message-not-found' };

      // Shelve the current tail by leaving it in the tree; create a sibling with
      // the edited content anchored at the same parent. headId moves to the new
      // sibling so a fresh assistant run can append underneath it.
      const content = Array.isArray(newContent)
        ? newContent
        : [{ type: 'text', text: typeof newContent === 'string' ? newContent : String(newContent ?? '') }];
      const editedCount = computeMessageCount({ role: source.role, content });
      const edited: StoredTreeMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: source.role,
        content,
        parentId: source.parentId,
        createdAt: new Date().toISOString(),
        tokenCount: editedCount.count,
        tokenCountSig: editedCount.sig,
      };
      const nextTree = [...tree, edited];
      return { ok: true, conversation: commitTreeUpdate(conv, nextTree, edited.id) };
    },
  );

  ipcMain.handle('conversations:regenerate', (_event, conversationId: string, assistantMessageId: string) => {
    const conv = readConversation(appHome, conversationId);
    if (!conv) return { ok: false, error: 'conversation-not-found' };
    // A head-moving mutation during /compact would break the summary's final CAS or leave
    // a half-applied regenerate. Reject while compacting (parity with edit/rewind/variant).
    if (isCompacting(conversationId)) return { ok: false, error: 'conversation-busy' };

    const { tree, headId } = ensureConversationTree(conv);
    const target = tree.find((m) => m.id === assistantMessageId);
    if (!target) return { ok: false, error: 'message-not-found' };

    // Move head to the preceding user turn; the old assistant tail remains in
    // the tree as a sibling variant the user can flip back to.
    const nextHead = target.role === 'assistant' ? target.parentId : (target.id ?? headId);
    return { ok: true, conversation: commitTreeUpdate(conv, tree, nextHead) };
  });

  // Rewind the active branch back by N complete turns (default 1): move headId
  // to the message before the Nth-from-last USER turn, undoing the most recent
  // exchange(s). The shelved tail stays in the tree as a branch, so nothing is
  // lost. Refused if the conversation has been compacted (summary nodes make
  // "a turn" ambiguous and reviving pre-summary messages could double content).
  ipcMain.handle('conversations:rewind', (_event, conversationId: string, steps = 1) => {
    const conv = readConversation(appHome, conversationId);
    if (!conv) return { ok: false, error: 'conversation-not-found' };
    if (isCompacting(conversationId)) return { ok: false, error: 'conversation-busy' };
    if (conv.conversationCompaction) return { ok: false, error: 'compacted' };

    const { tree, headId } = ensureConversationTree(conv);
    const branch = getConversationBranch(tree, headId);
    // Indices of user turns along the active branch, oldest→newest.
    const userIdx = branch.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
    if (userIdx.length === 0) return { ok: false, error: 'nothing-to-rewind' };

    // Normalize steps to a finite positive integer — a NaN/negative/fractional
    // value from the wire would make `target` NaN and null the head.
    const n = Number(steps);
    const safeSteps = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
    const target = Math.max(0, userIdx.length - safeSteps);
    const cutIndex = userIdx[target]; // this user turn (and everything after) is removed from the active branch
    const nextHead = cutIndex > 0 ? branch[cutIndex - 1].id : null;
    const removed = branch.length - cutIndex;
    return { ok: true, removed, conversation: commitTreeUpdate(conv, tree, nextHead) };
  });

  // Apply a DELTA to the `pendingDrafts` field (durable copy of a /compact-busy rollback's
  // unsent input): ADD these drafts, REMOVE these ids. A DELTA (not a wholesale replace of one
  // client's local queue) so two clients concurrently stashing/restoring drafts for the SAME
  // conversation MERGE instead of last-writer-wins-erasing each other. Read-modify-write on the
  // CURRENT disk record here on main — NOT a renderer get-then-put-whole-record, which would
  // clobber concurrent streamed/final assistant content / settings / runStatus with the stale
  // snapshot. Field-only: everything else on the record is preserved as-is.
  ipcMain.handle(
    'conversations:set-pending-drafts',
    (
      _event,
      conversationId: string,
      delta: {
        add?: Array<{ id: string; text: string; attachments: unknown[]; stashedAt: number }>;
        removeIds?: string[];
      },
    ) => {
      const conv = readConversation(appHome, conversationId);
      if (!conv) return { ok: false };
      const isValid = (d: { id?: unknown; text?: unknown; attachments?: unknown; stashedAt?: unknown }): boolean => {
        if (!d || typeof d.id !== 'string' || d.id.length === 0 || typeof d.stashedAt !== 'number') return false;
        const hasText = typeof d.text === 'string' && d.text.trim().length > 0;
        const hasAttachments = Array.isArray(d.attachments) && d.attachments.length > 0;
        return hasText || hasAttachments;
      };
      const existing = ((conv as { pendingDrafts?: unknown }).pendingDrafts ?? []) as Array<{
        id?: unknown;
        text?: unknown;
        attachments?: unknown;
        stashedAt?: unknown;
      }>;
      const removeIds = new Set(Array.isArray(delta?.removeIds) ? delta.removeIds : []);
      const addList = (Array.isArray(delta?.add) ? delta.add : []).filter(isValid);
      const addIds = new Set(addList.map((d) => d.id));
      // Keep existing entries that are (a) still valid, (b) not removed, (c) not superseded by an
      // add with the same id (an add replaces its own id); then append the adds. Bound to the
      // per-conversation cap (oldest first) as a pathological safety valve.
      const kept = existing.filter((d) => isValid(d) && !removeIds.has(String(d.id)) && !addIds.has(String(d.id)));
      let merged = [...kept, ...addList] as Array<{
        id: string;
        text: string;
        attachments: unknown[];
        stashedAt: number;
      }>;
      const CAP = 200;
      if (merged.length > CAP) merged = merged.slice(merged.length - CAP);
      const existingLen = existing.length;
      // No-op write avoidance: nothing changed (empty delta, nothing stored).
      if (merged.length === 0 && existingLen === 0) return { ok: true };
      const updated: ConversationRecord = { ...conv };
      if (merged.length === 0) delete (updated as { pendingDrafts?: unknown }).pendingDrafts;
      else (updated as { pendingDrafts?: unknown }).pendingDrafts = merged;
      // Metadata-only change (tree/head/runStatus untouched) — its resurrection + tree-
      // preservation guards still apply. Not broadcast — this is a private draft cache.
      writeConversation(appHome, updated);
      return { ok: true };
    },
  );

  // Soft-RESERVE + return ONE pending draft on main (lease+ACK), so that when multiple clients have
  // hydrated the same durable pendingDrafts, only ONE restores it. Unlike a remove-and-return, the
  // draft is NOT deleted here — it's marked claimedBy/claimedAt and RETAINED, so a renderer that
  // crashes/reloads between claiming and restoring does NOT lose the input (the reservation expires
  // and the draft is re-claimable). The renderer sends conversations:ack-pending-draft after it
  // actually restores (→ hard-remove) or fails (→ release the reservation). `id` reserves that
  // specific draft; omitting it reserves the OLDEST unreserved one.
  const DRAFT_RESERVATION_TTL_MS = 30_000;
  const isLiveReservation = (d: { claimedAt?: unknown; claimedBy?: unknown }, byClient?: string): boolean => {
    if (typeof d?.claimedBy !== 'string' || typeof d?.claimedAt !== 'number') return false;
    if (Date.now() - d.claimedAt > DRAFT_RESERVATION_TTL_MS) return false; // expired → not live
    return byClient ? d.claimedBy !== byClient : true; // "reserved by ANOTHER client" when byClient given
  };
  ipcMain.handle(
    'conversations:claim-pending-draft',
    (_event, conversationId: string, id?: string, clientId?: string) => {
      if (typeof conversationId !== 'string' || !conversationId) return { ok: false, draft: null };
      const conv = readConversation(appHome, conversationId);
      if (!conv) return { ok: false, draft: null };
      const existing = ((conv as { pendingDrafts?: unknown }).pendingDrafts ?? []) as Array<{
        id?: unknown;
        text?: unknown;
        attachments?: unknown;
        stashedAt?: unknown;
        claimedAt?: unknown;
        claimedBy?: unknown;
      }>;
      if (!Array.isArray(existing) || existing.length === 0) return { ok: true, draft: null };
      // Reserve a SPECIFIC id (only if not live-reserved by another client), or the OLDEST draft
      // that is not currently live-reserved by another client.
      const idx =
        typeof id === 'string' && id.length > 0
          ? existing.findIndex((d) => String(d?.id) === id && !isLiveReservation(d, clientId))
          : existing.findIndex((d) => !isLiveReservation(d, clientId));
      if (idx === -1) {
        // Distinguish "reserved by another live client (retry after its lease expires)" from
        // "genuinely none". A renderer that sees `reserved` must KEEP its local marker and retry,
        // not drop it — otherwise a crashed claimant's draft is never reclaimed after expiry.
        const anyLiveReserved = existing.some((d) => isLiveReservation(d, clientId));
        return { ok: true, draft: null, reserved: anyLiveReserved };
      }
      const claimedRaw = existing[idx];
      const claimed = {
        id: typeof claimedRaw?.id === 'string' ? claimedRaw.id : '',
        text: typeof claimedRaw?.text === 'string' ? claimedRaw.text : '',
        attachments: Array.isArray(claimedRaw?.attachments) ? (claimedRaw.attachments as unknown[]) : [],
        stashedAt: typeof claimedRaw?.stashedAt === 'number' ? claimedRaw.stashedAt : Date.now(),
      };
      // RETAIN the draft, stamping the reservation (NOT a remove). A crash before ack leaves it on
      // disk; the reservation expires and it becomes re-claimable.
      const next = existing.map((d, i) =>
        i === idx ? { ...d, claimedAt: Date.now(), claimedBy: typeof clientId === 'string' ? clientId : 'unknown' } : d,
      );
      const updated: ConversationRecord = { ...conv };
      (updated as { pendingDrafts?: unknown }).pendingDrafts = next;
      writeConversation(appHome, updated);
      return { ok: true, draft: claimed };
    },
  );

  // ACK a prior claim: `restored: true` HARD-REMOVES the draft (it reached the composer);
  // `restored: false` RELEASES the reservation (restore failed / bailed) so it's re-claimable now
  // rather than after the TTL. Only affects a draft this client currently reserves.
  ipcMain.handle(
    'conversations:ack-pending-draft',
    (_event, conversationId: string, id: string, restored: boolean, clientId?: string) => {
      if (typeof conversationId !== 'string' || !conversationId || typeof id !== 'string' || !id) {
        return { ok: false };
      }
      const conv = readConversation(appHome, conversationId);
      if (!conv) return { ok: false };
      const existing = ((conv as { pendingDrafts?: unknown }).pendingDrafts ?? []) as Array<{
        id?: unknown;
        claimedBy?: unknown;
      }>;
      if (!Array.isArray(existing) || existing.length === 0) return { ok: true };
      const idx = existing.findIndex((d) => String(d?.id) === id);
      if (idx === -1) return { ok: true }; // already gone
      // Guard: only the reserving client may ack (a stale ack from another client is ignored).
      const holder = existing[idx].claimedBy;
      if (typeof clientId === 'string' && typeof holder === 'string' && holder !== clientId) {
        return { ok: true };
      }
      let next: unknown[];
      if (restored) {
        next = existing.filter((_, i) => i !== idx); // hard-remove — it reached the composer
      } else {
        next = existing.map((d, i) => {
          if (i !== idx) return d;
          const rest = { ...(d as Record<string, unknown>) };
          delete rest.claimedAt;
          delete rest.claimedBy; // release the reservation for re-claim
          return rest;
        });
      }
      const updated: ConversationRecord = { ...conv };
      if (next.length === 0) delete (updated as { pendingDrafts?: unknown }).pendingDrafts;
      else (updated as { pendingDrafts?: unknown }).pendingDrafts = next;
      writeConversation(appHome, updated);
      return { ok: true };
    },
  );

  // prefix and PERSISTS the compaction record (conversationCompaction) so the
  // next turn reuses it — matching the metadata-only, non-destructive design of
  // the automatic mid-turn path (the message tree is NOT mutated). No renderer
  // is involved, so unlike the auto path (which emits a `compaction` event the
  // renderer persists), this writes the record directly.
  ipcMain.handle('conversations:compact', async (_event, conversationId: string) => {
    if (typeof conversationId !== 'string' || !conversationId) return { ok: false, error: 'invalid-id' };
    // Reject a concurrent `/compact` for the same conversation (avoid a duplicate
    // paid summarization + persist race). Released in the finally below.
    if (compactInFlight.has(conversationId))
      return { ok: false, error: 'conversation-busy', busyKind: 'compaction' as const };
    compactInFlight.add(conversationId);
    try {
      return await runCompact(conversationId);
    } finally {
      compactInFlight.delete(conversationId);
    }
  });

  const runCompact = async (
    conversationId: string,
  ): Promise<{ ok: boolean; error?: string; summarizedCount?: number; busyKind?: string }> => {
    const config = getConfig?.();
    if (!config) return { ok: false, error: 'config-unavailable' };
    if (!config.compaction?.conversation?.enabled) return { ok: false, error: 'compaction-disabled' };

    const conv = readConversation(appHome, conversationId);
    if (!conv) return { ok: false, error: 'conversation-not-found' };
    if (conv.runStatus === 'running' || conv.runStatus === 'awaiting-approval') {
      return { ok: false, error: 'conversation-busy', busyKind: 'turn' as const };
    }
    // Disk `runStatus` is written AFTER a turn starts streaming, so a turn that just
    // began (or was submitted and is awaiting toolsReady) still looks idle on disk.
    // Consult the main-process in-memory turn registry too — otherwise `/compact`
    // could launch a paid summarizer alongside the live turn, then discard it as busy.
    if (isTurnActive?.(conversationId)) {
      return { ok: false, error: 'conversation-busy', busyKind: 'turn' as const };
    }
    // Memory backstop: too many prior /compact hook awaits are ABANDONED-but-pending (hung
    // trusted-plugin callbacks we can't force-cancel, each pinning a transcript). Don't start
    // another abandonable run — bail without compacting (the turn proceeds on full context; a
    // null-op is the compaction contract). Frees as the hung hooks eventually settle.
    if (outstandingAbandonedCompactionHooks >= MAX_ABANDONED_COMPACTION_HOOKS) {
      return { ok: false, error: 'compaction-hook-backlog' };
    }

    // Mark the conversation in the shared compaction lock for the DURATION of the
    // (paid, possibly slow) summarization so a concurrent agent turn (agent:submit
    // AND agent:stream) is rejected as busy instead of racing and forcing us to
    // discard the summary. A distinct in-memory marker (NOT runStatus:'running')
    // so the compactor's own pre-persist checks can't mistake it for a real turn.
    markCompacting(conversationId);
    // Server-side timeout so a summarizer request that never settles can't hold the
    // compaction lock forever (which would reject EVERY future turn until restart).
    // The client 300s timeout only unblocks the caller — it can't cancel this main-
    // process handler. The AbortController lets us both (a) cancel the summarizer
    // request (auxAgentGenerate forwards abortSignal) and (b) guarantee the lock's
    // finally runs by racing the inner call against the deadline. Must fire BEFORE the
    // client's 300s deadline (web/CLI use 300_000ms) — otherwise there's a window where
    // the client has given up and cleared its in-flight state (so the user can send)
    // but the server still holds isCompacting, rejecting that send as busy. 285s leaves
    // the lock released with ~15s of headroom before the client stops waiting.
    const COMPACT_TIMEOUT_MS = 285_000;
    const abort = new AbortController();
    // Register so deleting the conversation mid-summarization aborts the summarizer + stops
    // provider billing immediately (a delete otherwise wouldn't reach this controller).
    activeCompactAborters.set(conversationId, abort);
    const timer = setTimeout(() => abort.abort(), COMPACT_TIMEOUT_MS);
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
    // Attach a no-op catch to the inner promise so that if the TIMEOUT branch wins the
    // race and runCompactInner later REJECTS, the rejection is swallowed rather than
    // surfacing as an unhandledRejection (it already lost the race; its result is moot).
    const inner = runCompactInner(conversationId, config, conv, abort.signal);
    inner.catch(() => undefined);
    try {
      return await Promise.race([
        inner,
        new Promise<{ ok: boolean; error?: string; summarizedCount?: number; busyKind?: string }>((resolve) => {
          abort.signal.addEventListener('abort', () => resolve({ ok: false, error: 'compaction-timeout' }), {
            once: true,
          });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      // Only clear the registry slot if it's still OURS (a later /compact for the same
      // conversation would have replaced it; don't drop the newer controller).
      if (activeCompactAborters.get(conversationId) === abort) activeCompactAborters.delete(conversationId);
      clearCompacting(conversationId);
    }
  };

  const runCompactInner = async (
    conversationId: string,
    config: AppConfig,
    conv: ConversationRecord,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string; summarizedCount?: number; busyKind?: string }> => {
    // Stop AWAITING a hook call once the /compact deadline fires. Trusted plugin
    // pre-send hooks (and the DLP gate) run over a callback protocol we can't force-
    // cancel here, so a hung hook's underlying promise stays pending — but racing the
    // await against the abort signal lets runCompactInner's continuation release its
    // own references (the transcript) instead of pinning them until the hook settles.
    // Rejects with an Error on abort so the surrounding try/catch treats it as a hook
    // failure (fail closed). A no-op passthrough when there's no signal.
    const raceAbort = async <T>(p: Promise<T>): Promise<T> => {
      if (!signal) return p;
      if (signal.aborted) throw new Error('compaction-timeout');
      let onAbort: (() => void) | undefined;
      let aborted = false;
      const abortP = new Promise<never>((_, reject) => {
        onAbort = () => {
          aborted = true;
          reject(new Error('compaction-timeout'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([p, abortP]);
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        // If the deadline won the race, the underlying hook promise `p` is now ABANDONED but
        // still pending (it pins its transcript). Count it so repeated /compacts against hung
        // hooks can't accumulate unboundedly; decrement when `p` eventually settles (freeing its
        // references). A hook that settled normally (not aborted) isn't counted.
        if (aborted) {
          outstandingAbandonedCompactionHooks++;
          void p.then(
            () => {
              outstandingAbandonedCompactionHooks = Math.max(0, outstandingAbandonedCompactionHooks - 1);
            },
            () => {
              outstandingAbandonedCompactionHooks = Math.max(0, outstandingAbandonedCompactionHooks - 1);
            },
          );
        }
      }
    };
    // Bounded fingerprint of the routing/budget-affecting GLOBAL config sections. The
    // conversation-level routeFingerprint (below) catches per-conversation changes, but a
    // GLOBAL runtime/provider/model/compaction change (e.g. switching the default runtime
    // to an external one) during summarization would also make the persisted record wrong
    // for the next turn. Captured now, re-fetched + compared at the final CAS.
    const globalConfigFingerprint = (c: AppConfig | undefined): string => {
      if (!c) return '';
      try {
        const cc = c as unknown as Record<string, unknown>;
        return createHash('sha1')
          .update(
            JSON.stringify({
              models: c.models,
              tools: c.tools,
              compaction: c.compaction,
              agent: c.agent,
              // Everything else route/prompt resolution consumes: a profile switch, default
              // profile change, fallback toggle, or a base system-prompt edit during the
              // awaited summarizer all change the record's correct budget/route.
              profiles: cc.profiles ?? null,
              defaultProfileKey: cc.defaultProfileKey ?? null,
              fallback: cc.fallback ?? null,
              systemPrompt: c.systemPrompt ?? null,
              systemPrompts: c.systemPrompts ?? null,
            }),
          )
          .digest('hex');
      } catch {
        return '';
      }
    };
    const validatedGlobalConfigFingerprint = globalConfigFingerprint(config);
    // Resolve the model the same way a TURN would — including the conversation's
    // selected profile — so the token window, tokenizer, AND runtime/provider match
    // what the actual turn uses (a wrong provider is a data-exposure concern; wrong
    // window mis-sizes the summary or wrongly reports runtime-unsupported).
    const streamConfig = resolveStreamConfig(config, {
      threadModelKey: conv.selectedModelKey ?? null,
      threadProfileKey: conv.selectedProfileKey ?? null,
      fallbackEnabled: false,
      // Mirror a real turn's thread overrides so streamConfig.systemPrompt reflects
      // any per-conversation systemPromptOverride — the window-reduction below
      // budgets against the ACTUAL assembled prompt (a large thread-specific prompt
      // would otherwise be under-counted, and `/compact` could report success while
      // the next turn still overflows).
      threadOverrides: {
        temperature: (conv as { temperature?: number | null }).temperature ?? null,
        systemPromptOverride: (conv as { systemPromptOverride?: string | null }).systemPromptOverride ?? null,
        maxSteps: (conv as { maxSteps?: number | null }).maxSteps ?? null,
        maxRetries: (conv as { maxRetries?: number | null }).maxRetries ?? null,
        runtimeOverride: (conv as { runtimeOverride?: string | null }).runtimeOverride ?? null,
      },
    });
    let modelEntry = streamConfig?.primaryModel;
    if (!modelEntry) return { ok: false, error: 'no-model' };

    // True once a provider override has been folded into `modelEntry` — the
    // summarizer must then run that model ONLY (no ambient fallback that would
    // route the transcript back to the original provider).
    let providerOverrideApplied = false;
    // Only Kai-side (Mastra) compaction consumes the persisted record on the next
    // turn. External CLI runtimes (Claude/Codex/Pi/OpenCode) manage their own
    // context and IGNORE it, so persisting a record would silently do nothing —
    // report `runtime-unsupported` rather than a misleading success. Honor the
    // conversation's runtimeOverride the way a real turn does (it selects the
    // effective runtime via config.agent.runtime).
    try {
      const runtimeOverride = (conv as { runtimeOverride?: string | null }).runtimeOverride;
      const agentCfg = (config as { agent?: Record<string, unknown> }).agent ?? {};
      const configForRuntime = runtimeOverride
        ? ({ ...config, agent: { ...agentCfg, runtime: runtimeOverride } } as typeof config)
        : config;
      const { runtime, resolution } = await resolveRuntimeForStream(configForRuntime, modelEntry);
      if (!runtime.capabilities.compaction) return { ok: false, error: 'runtime-unsupported' };
      // A plugin INFERENCE provider (registered via registerInferenceProvider) runs
      // the turn OUTSIDE Kai's Mastra path and does NOT consume the persisted
      // compaction record — so persisting one would report success while the next
      // request ignores it and re-overflows. Detect it the same way agent.ts does
      // (an inferenceProviderRuntimeId, or a non-built-in resolved runtimeId) and
      // report unsupported instead of a misleading success.
      const isBuiltInRuntimeId = (id: string): boolean =>
        id === 'mastra' || id === 'claude-agent-sdk' || id === 'codex-sdk' || id === 'auto';
      const usesPluginInferenceProvider =
        !!(resolution as { inferenceProviderRuntimeId?: string }).inferenceProviderRuntimeId ||
        !isBuiltInRuntimeId(resolution.runtimeId);
      if (usesPluginInferenceProvider) return { ok: false, error: 'runtime-unsupported' };
      // Provider override: a plugin/gateway runtime was selected for a non-plugin
      // model. A normal turn re-points the model's provider/endpoint/apiKey through
      // that provider (agent.ts). The summarizer sends the FULL transcript to a
      // model, so it MUST honor the same override — otherwise `/compact` would leak
      // the transcript to the model's original (e.g. public) provider while normal
      // chat routes through the enterprise gateway. Best-effort: if the override
      // provider isn't configured, leave the model as-is (matches the turn path).
      if (resolution.providerOverride) {
        const overrideProviderConfig = config.models.providers[resolution.providerOverride];
        if (overrideProviderConfig) {
          modelEntry = {
            ...modelEntry,
            modelConfig: {
              ...modelEntry.modelConfig,
              provider: overrideProviderConfig.type as typeof modelEntry.modelConfig.provider,
              endpoint: overrideProviderConfig.endpoint ?? modelEntry.modelConfig.endpoint,
              apiKey: overrideProviderConfig.apiKey ?? modelEntry.modelConfig.apiKey,
              useResponsesApi: overrideProviderConfig.useResponsesApi ?? false,
            },
          };
          providerOverrideApplied = true;
        }
      }
    } catch {
      // FAIL CLOSED. A normal turn's route (provider override / enterprise gateway)
      // is decided by this same resolution; if it throws we don't know the correct
      // provider, and proceeding with the unresolved `modelEntry` could send the
      // full transcript to the model's ORIGINAL (e.g. public) provider — a data-
      // egress regression — or persist a record for an unsupported runtime. Abort.
      return { ok: false, error: 'runtime-resolution-failed' };
    }

    // Resolve {placeholder} templates in the model's extraHeaders the SAME way a
    // normal turn does (agent.ts) — a gateway that requires e.g. {conversationId}
    // in a header would otherwise receive the literal placeholder and reject the
    // summarizer request. cwd normalized to home (matches the turn path).
    if (modelEntry.modelConfig?.extraHeaders) {
      const resolved = resolveHeaderTemplates(modelEntry.modelConfig.extraHeaders, {
        conversationId,
        cwd: normalizeAgentCwd((conv as { currentWorkingDirectory?: string | null }).currentWorkingDirectory),
        modelKey: modelEntry.key ?? '',
        modelName: modelEntry.modelConfig.modelName ?? '',
      });
      if (resolved !== modelEntry.modelConfig.extraHeaders) {
        modelEntry = { ...modelEntry, modelConfig: { ...modelEntry.modelConfig, extraHeaders: resolved } };
      }
    }

    const { tree, headId } = ensureConversationTree(conv);
    const branch = getConversationBranch(tree, headId);
    // Snapshot each branch node's RAW content signature NOW, before any pre-send/DLP hook
    // runs — an in-place hook mutation of nested content would also mutate `branch` through
    // shared references, so re-signing `branch` after hooks for the post-summary disk-drift
    // check would falsely differ from disk and reject a valid paid compaction. Keyed by id;
    // the drift check reads the covered ids' PRE-hook sigs from here.
    const preHookBranchSigById = new Map<string, string>();
    for (const m of branch as Array<{ id?: unknown }>) {
      if (typeof m?.id === 'string') {
        preHookBranchSigById.set(m.id, messageContentSignature(m as Parameters<typeof messageContentSignature>[0]));
      }
    }
    // Fingerprint of the budget/route-affecting conversation fields as of NOW. All
    // validation below (model window, tokenizer, static input, budgets) is derived from
    // these; if a concurrent conversations:put changes the selected model/profile/runtime/
    // execution-mode/cwd/fallback during the awaited summarization, the persisted record
    // would describe the OLD route (e.g. an external runtime switch makes the record
    // useless to the new runtime). The final CAS re-reads and compares this — bail if it
    // drifted so the next turn recomputes against the current route. (Global `config` is a
    // snapshot for this handler; conversation-level route fields are the mutable surface.)
    const routeFingerprint = (c: ConversationRecord): string =>
      JSON.stringify({
        m: c.selectedModelKey ?? null,
        p: (c as { selectedProfileKey?: string | null }).selectedProfileKey ?? null,
        f: (c as { fallbackEnabled?: boolean }).fallbackEnabled ?? false,
        e: (c as { executionMode?: ExecutionMode | null }).executionMode ?? null,
        w: (c as { currentWorkingDirectory?: string | null }).currentWorkingDirectory ?? null,
        r: (c as { runtimeOverride?: string | null }).runtimeOverride ?? null,
        // Bounded hash of the system-prompt override — it feeds the static-input budget,
        // so a concurrent enlargement during summarization would leave the record sized
        // against the old budget. Hash (not raw) to keep the fingerprint small.
        s: createHash('sha1')
          .update(String((c as { systemPromptOverride?: string | null }).systemPromptOverride ?? ''))
          .digest('hex'),
      });
    const validatedRouteFingerprint = routeFingerprint(conv);
    // Full-branch content signature (id → bounded content hash for every message on a
    // branch). Used by both the stored-summary no-op re-verify and the final CAS to
    // detect any same-id content edit (covered OR suffix) during an awaited validation.
    const fullSigOf = (msgs: Array<{ id?: unknown; role?: unknown; content?: unknown }>): string => {
      const parts: string[] = [];
      for (const m of msgs) {
        if (typeof m?.id !== 'string') continue;
        parts.push(`${m.id}:${messageContentSignature(m as Parameters<typeof messageContentSignature>[0])}`);
      }
      return parts.join(' ');
    };
    // Preserve the FULL model-bearing projection — id/role/content PLUS tool_calls /
    // tool_call_id (legacy tool-message shape). Dropping them orphans a protected tool
    // result and omits large tool arguments from the summarizer + safety validation, so
    // /compact could persist a summary whose real next request overflows or is
    // provider-invalid. (displayOnly parts are still stripped.)
    // Project a branch to the MODEL-BEARING shape the summarizer/validation see: only
    // id/role/content (+ tool_calls/tool_call_id when present). Raw disk nodes also carry
    // parentId/createdAt/token caches/renderer metadata that the provider never receives —
    // counting those (exact serialization) would over-size a near-limit candidate and
    // reject it after paying. Reread suffixes MUST go through this too, not raw disk nodes.
    const projectForCompactionCandidate = (
      nodes: Array<{ id?: unknown; role?: unknown; content?: unknown }>,
    ): Array<{ id: string; role: string; content: unknown }> =>
      stripDisplayOnlyParts(
        nodes.map((m) => {
          const extra = m as unknown as { tool_calls?: unknown; tool_call_id?: unknown };
          return {
            id: m.id,
            role: m.role,
            content: m.content,
            ...(extra.tool_calls !== undefined ? { tool_calls: extra.tool_calls } : {}),
            ...(extra.tool_call_id !== undefined ? { tool_call_id: extra.tool_call_id } : {}),
          };
        }),
      ) as Array<{ id: string; role: string; content: unknown }>;
    let messages = projectForCompactionCandidate(branch as Array<{ id?: unknown; role?: unknown; content?: unknown }>);

    // Effective compaction window = base model/override window MINUS the assembled
    // system prompt's cost beyond the reserve (the same reduction the fresh-compaction
    // path applies below). Computed here so the reuse short-circuit budgets against
    // the REAL window a turn would use — not the raw model window — else enlarging
    // AGENTS.md could make reuse a false no-op that still overflows next turn.
    // Smallest ELIGIBLE model window (min across primary + fallbacks when fallback
    // is enabled; config override wins). Shared by the reuse short-circuit AND the
    // fresh-compaction window below so a stored/new summary is validated against the
    // window a turn could ACTUALLY run on (a 50K summary fits a 128K primary but can
    // overflow a 32K fallback).
    // Collect EVERY eligible model's {modelName, window} so the post-summary
    // validation (candidateSafeForAllModels) can check the compacted candidate against
    // EACH model's own tokenizer + window — a config window override makes all windows
    // equal, but models still tokenize the SAME text to different counts (o200k vs
    // cl100k), so a candidate safe on one can overflow a denser-tokenizing sibling.
    const eligibleValidationModels: Array<{ modelName: string; window: number }> = [];
    {
      const override = (config.compaction.conversation as { contextWindowTokens?: number }).contextWindowTokens;
      const hasOverride = typeof override === 'number' && override > 0;
      // A model's effective window is the config override (applies to all), else its
      // catalog maxInputTokens OR the window resolveConversationTokenization INFERS from
      // the model name (an entry with no explicit maxInputTokens must not be skipped, or
      // a smaller inferred-window fallback would be missed).
      const windowOf = (
        m: { modelConfig: { modelName: string; maxInputTokens?: number } } | undefined | null,
      ): number => {
        if (!m) return 0;
        if (hasOverride) return override as number;
        const explicit = m.modelConfig.maxInputTokens;
        if (typeof explicit === 'number' && explicit > 0) return explicit;
        try {
          return resolveConversationTokenization(m.modelConfig.modelName).contextWindowTokens ?? 0;
        } catch {
          return 0;
        }
      };
      const consider = (
        m: { modelConfig: { modelName: string; maxInputTokens?: number } } | undefined | null,
      ): void => {
        if (!m?.modelConfig.modelName) return;
        const mw = windowOf(m);
        if (mw > 0) eligibleValidationModels.push({ modelName: m.modelConfig.modelName, window: mw });
      };
      consider(modelEntry);
      if ((conv as { fallbackEnabled?: boolean }).fallbackEnabled) {
        try {
          const fb = resolveStreamConfig(config, {
            threadModelKey: conv.selectedModelKey ?? null,
            threadProfileKey: conv.selectedProfileKey ?? null,
            fallbackEnabled: true,
          });
          for (const m of [fb?.primaryModel, ...(fb?.fallbackModels ?? [])]) {
            if (m !== modelEntry) consider(m);
          }
        } catch {
          /* best-effort */
        }
      }
    }
    const convConfig = config.compaction.conversation as typeof config.compaction.conversation & {
      contextWindowTokens?: number;
    };
    // STATIC per-request input tokens for the NEXT real turn, per eligible model:
    // assembled chat system prompt + serialized tool schemas + workspace allowance —
    // the SAME estimate reactive recovery uses (agent.ts). Counting only the system
    // prompt (as before) under-budgeted a turn with many MCP tools whose schemas exceed
    // promptReserveTokens, letting /compact persist a summary that overflows next turn.
    // Precomputed once (async) so promptOverReserveFor stays synchronous in the loops.
    // The FULLY-BUILT instruction string the NEXT real turn sends: the override-
    // respecting resolved prompt (streamConfig.systemPrompt wins, like a turn) wrapped
    // by buildAgentInstructions (which adds the runtime-capability / plan-mode suffix)
    // for the conversation's execution mode. Seeding systemPrompts.chat/plan with the
    // resolved prompt forces resolveModeSystemPrompt to yield it (not the GLOBAL chat
    // prompt, which would discard a profile/thread override). Budgeting only — never sent.
    const compactExecMode = (conv as { executionMode?: ExecutionMode | null }).executionMode ?? undefined;
    const sendPrompt = streamConfig?.systemPrompt ?? config.systemPrompt ?? '';
    const chatBasePrompt = buildAgentInstructions(
      { ...config, systemPrompt: sendPrompt, systemPrompts: { ...config.systemPrompts, chat: sendPrompt } },
      compactExecMode,
    );
    const chatCwd = normalizeAgentCwd((conv as { currentWorkingDirectory?: string | null }).currentWorkingDirectory);
    // Wait for tool registration before snapshotting the registry: /compact can be
    // invoked during early startup (CLI/GUI) before MCP/plugin schemas register, and
    // estimating the next-turn static input against an EMPTY registry under-counts —
    // /compact would then persist a summary the first real turn (full schemas) rejects.
    // Raced against the deadline so a stuck tool init can't hold the lock past timeout.
    try {
      await raceAbort(whenToolsReady());
    } catch {
      if (signal?.aborted) return { ok: false, error: 'compaction-timeout' };
      // Non-abort rejection is not expected (whenToolsReady never rejects) — fall through
      // and estimate with whatever is registered rather than fail the /compact.
    }
    const registeredTools = getRegisteredTools();
    // Fingerprint the STATIC-input dependencies that feed the budget but aren't captured by
    // the conversation/global-config fingerprints: the FULLY-ASSEMBLED instructions
    // (base + system prompt + the EXPANDED cwd project-instruction file CONTENTS via
    // withWorkingDirectoryPrompt — not just the cwd path) and the registered tool SCHEMAS
    // (MCP / skills / plugin / CLI tools). A concurrent change to any of these during the
    // awaited summarizer would size the record against stale costs. Compared at the final CAS.
    // Snapshot the tool registry ONCE, AFTER whenToolsReady, and use it for BOTH the
    // fingerprint AND the token estimates below — so validation is internally consistent
    // (fingerprint registry === estimate registry; a mid-crawl reload can't make them
    // disagree). Drift SINCE validation is caught by the COMMIT-time fingerprint, which
    // reads getRegisteredTools() fresh.
    const staticInputFingerprint = async (
      baseInstr: string,
      cwd: string | undefined,
      tools: typeof registeredTools,
    ): Promise<string> => {
      try {
        // Expand project-instruction files (AGENTS.md/CLAUDE.md/etc.) so a file GROWING
        // mid-summarize is detected — the cwd PATH alone wouldn't change.
        const assembled = await withWorkingDirectoryPrompt(baseInstr, cwd);
        // Serialize schemas the EXACT way the estimator charges them (z.toJSONSchema).
        const toolSig = serializeToolSchemasForStatic(tools);
        return createHash('sha1').update(JSON.stringify({ assembled, toolSig })).digest('hex');
      } catch {
        return '';
      }
    };
    const validatedStaticInputFingerprint = await raceAbort(
      staticInputFingerprint(chatBasePrompt, chatCwd, registeredTools),
    );
    if (signal?.aborted) return { ok: false, error: 'compaction-timeout' };
    const staticTokensByModel = new Map<string, number>();
    for (const em of eligibleValidationModels) {
      if (staticTokensByModel.has(em.modelName)) continue;
      if (signal?.aborted) break; // deadline fired — stop estimating (lock released)
      try {
        staticTokensByModel.set(
          em.modelName,
          // Race the estimate against the deadline: withWorkingDirectoryPrompt reads the
          // cwd's project instructions from a possibly network-mounted FS, which can hang;
          // don't keep awaiting (and retaining the transcript) past the outer timeout.
          await raceAbort(
            estimateStaticRequestTokens(
              chatBasePrompt,
              chatCwd,
              registeredTools,
              WORKSPACE_TOOL_SCHEMA_TOKENS_ALLOWANCE,
              em.modelName,
            ),
          ),
        );
      } catch {
        /* best-effort — a failed/aborted estimate leaves this model out (treated as 0 excess) */
      }
    }
    // Per-model prompt-over-reserve: the amount that model's STATIC input (prompt +
    // schemas + allowance) exceeds promptReserveTokens. Reduces its effective budget.
    const promptOverReserveFor = (modelName: string): number => {
      const staticTokens = staticTokensByModel.get(modelName);
      if (staticTokens === undefined) return 0;
      return Math.max(0, staticTokens - Math.max(0, convConfig.promptReserveTokens));
    };
    // Shared validation: is `candidate` SAFE on EVERY eligible model? Safe = under the
    // compaction trigger (triggerPercent × the model's FULL window, its own tokenizer)
    // AND under the model's hard input budget (window − output − promptReserve − that
    // model's chat-prompt excess). Used by BOTH the stored-summary reuse short-circuit
    // and the fresh-candidate post-summary validation so they enforce identical bounds
    // (a config window override, custom reserves, or a denser-tokenizing equal-window
    // fallback are all handled the same way). Returns false if it trips on ANY model.
    const candidateSafeForAllModels = async (
      candidate: Parameters<typeof shouldCompactBranchMediaAware>[0],
    ): Promise<boolean> => {
      if (signal?.aborted) return false;
      // Model-independent: the compacted candidate's retained media BYTES (its protected
      // suffix can hold recent images compaction can't remove) must fit the whole-request
      // media ceiling — else the next real turn's outgoing media gate rejects it and
      // /compact would report a misleading success. Only when media fitting is enabled
      // (the gate that enforces the ceiling). Checked ONCE (bytes don't vary by model).
      if ((config.compaction.media as { enabled?: boolean } | undefined)?.enabled) {
        try {
          const { retainedMediaBytes } = await stripBranchMediaForCount(candidate as unknown[], signal);
          if (retainedMediaBytes > DEFAULT_MAX_TOTAL_MEDIA_BYTES) return false;
        } catch {
          /* best-effort — fall through to the per-model token checks */
        }
      }
      for (const em of eligibleValidationModels) {
        // Stop the per-model loop once the /compact deadline fires — otherwise stale
        // validation keeps running media probes + tokenizer-worker waits across every
        // fallback after the lock has already been released to a new turn. Treat an
        // aborted validation as UNSAFE (don't persist a half-validated record).
        if (signal?.aborted) return false;
        try {
          const check = await shouldCompactBranchMediaAware(
            candidate,
            em.modelName,
            config.compaction.conversation.triggerPercent,
            em.window, // RAW window: trigger = triggerPercent × window (not pre-reduced)
            signal,
          );
          const inputBudget =
            em.window -
            Math.max(0, convConfig.outputMaxTokens) -
            Math.max(0, convConfig.promptReserveTokens) -
            promptOverReserveFor(em.modelName);
          if (check.shouldCompact || check.usedTokens > inputBudget) return false;
        } catch {
          /* best-effort — a per-model check failure doesn't veto the others */
        }
      }
      return true;
    };

    // If a stored compaction record already covers EXACTLY the prefix a fresh
    // compaction would cover (no new messages have moved out of the protected tail)
    // AND applying it keeps the branch under the trigger, there's genuinely nothing
    // new to summarize — return without billing another summary. We compare against
    // the CURRENT protected-tail boundary (not just "under trigger") so an explicit
    // /compact still summarizes messages that became eligible since the last one.
    // The no-op short-circuit budgets with the PRE-HOOK messages/prompt. If an
    // enforcing UserPromptSubmit hook or a pre-send plugin is configured, it could
    // inject context / rewrite the prompt on the real turn and change the budget —
    // so DON'T take the shortcut when such hooks exist; fall through and let the
    // full path (which runs the hooks) decide. Otherwise the shortcut is safe.
    const hooksMayAlterBudget =
      hookDispatcher.hasEnforcingHooksFor('UserPromptSubmit') || (getPluginManager?.()?.hasPreSendHooks() ?? false);
    if (!hooksMayAlterBudget) {
      const stored = conv.conversationCompaction as
        | {
            compactionId?: string;
            summaryText?: string;
            compactedMessageIds?: string[];
            coveredContentSig?: Record<string, string>;
          }
        | null
        | undefined;
      if (
        stored &&
        typeof stored.compactionId === 'string' &&
        typeof stored.summaryText === 'string' &&
        Array.isArray(stored.compactedMessageIds) &&
        stored.compactedMessageIds.length > 0
      ) {
        const branchIds = messages.map((m) => m.id);
        const coveredCount = stored.compactedMessageIds.length;
        // Where would a FRESH compaction of the current branch draw the boundary?
        const { boundaryIndex } = selectProtectedTail(
          messages as unknown as Parameters<typeof selectProtectedTail>[0],
          config.compaction.conversation.ignoreRecentUserMessages,
          config.compaction.conversation.ignoreRecentAssistantMessages,
        );
        // Only a no-op when the stored record covers EXACTLY the fresh boundary
        // (coveredCount === boundaryIndex) AND it's a strict prefix AND applying it
        // stays under the trigger. `>` would mean the stored summary already
        // summarized messages that are NOW protected (e.g. ignoreRecent* was raised)
        // — recompute so those messages are restored to the protected tail. `<`
        // means new messages became eligible — recompute to summarize them.
        if (coveredCount === boundaryIndex && isStrictPrefix(stored.compactedMessageIds, branchIds)) {
          const candidate = [
            {
              id: `compaction-summary-${stored.compactionId}`,
              role: 'assistant' as const,
              content: stored.summaryText,
            },
            ...messages.slice(coveredCount),
          ];
          // Reuse the stored summary as a no-op ONLY if it's safe on EVERY eligible
          // model (same trigger + hard-input-budget checks as a fresh candidate) — a
          // stored summary under the primary but over a denser fallback's real budget
          // must recompute, not silently short-circuit into a next-turn overflow.
          if (await candidateSafeForAllModels(candidate as Parameters<typeof shouldCompactBranchMediaAware>[0])) {
            // candidateSafeForAllModels awaited the tokenizer; a concurrent edit during
            // that await could have CLEARED the stored summary or APPENDED newly-eligible
            // messages, making this "no-op" stale. Re-read and re-verify the same
            // predicate against fresh disk before claiming success; if anything changed,
            // fall through to the full recompute path (which re-summarizes correctly).
            if (signal?.aborted) return { ok: false, error: 'compaction-timeout' };
            const reread = readConversation(appHome, conversationId);
            const rstored = reread?.conversationCompaction as
              | { compactionId?: string; compactedMessageIds?: string[] }
              | null
              | undefined;
            if (reread && rstored && rstored.compactionId === stored.compactionId) {
              const { tree: rtree, headId: rhead } = ensureConversationTree(reread);
              const rBranch = getConversationBranch(rtree, rhead);
              const rBranchIds = rBranch.map((m) => m.id);
              const { boundaryIndex: rBoundary } = selectProtectedTail(
                rBranch as unknown as Parameters<typeof selectProtectedTail>[0],
                config.compaction.conversation.ignoreRecentUserMessages,
                config.compaction.conversation.ignoreRecentAssistantMessages,
              );
              // Rebuild the reuse candidate from the FRESH branch and re-validate its
              // budget — a concurrent metadata/full-record put can enlarge the protected
              // SUFFIX under the same ids while candidateSafeForAllModels awaited, so
              // `[summary, ...freshSuffix]` may now exceed token/media budgets even though
              // the compactionId, boundary, and prefix ids are unchanged.
              const rCandidate = [
                {
                  id: `compaction-summary-${stored.compactionId}`,
                  role: 'assistant' as const,
                  content: stored.summaryText,
                },
                ...projectForCompactionCandidate(
                  rBranch.slice(coveredCount) as Array<{ id?: unknown; role?: unknown; content?: unknown }>,
                ),
              ];
              // Fingerprint the reread state BEFORE the (awaited) budget validation so a
              // change DURING that await is caught by a final synchronous reread — else
              // this re-verify just reopens the TOCTOU it was meant to close.
              const beforeAwaitSig = fullSigOf(rBranch as Array<{ id?: unknown }>);
              const beforeAwaitRoute = routeFingerprint(reread);
              // candidateSafeForAllModels validates against the ORIGINAL route's models /
              // windows / static budgets (eligibleValidationModels captured at handler
              // start). If a metadata put / set-selection switched the route while we
              // awaited, validating route A but persisting a record used on route B is
              // unsafe — bail and recompute against the current route.
              if (beforeAwaitRoute !== validatedRouteFingerprint) {
                // Route changed during the reuse validation. Don't fall through to a FRESH
                // compaction — it would summarize (PAY) against the original stale config
                // snapshot, then the fresh final CAS would necessarily reject it for the
                // same route drift. Return nothing-to-compact so the NEXT turn recomputes
                // against the current route without a wasted paid summarizer call.
                return { ok: false, error: 'nothing-to-compact' };
              } else if (
                coveredCount === rBoundary &&
                Array.isArray(rstored.compactedMessageIds) &&
                isStrictPrefix(rstored.compactedMessageIds, rBranchIds) &&
                (await candidateSafeForAllModels(rCandidate as Parameters<typeof shouldCompactBranchMediaAware>[0]))
              ) {
                if (signal?.aborted) return { ok: false, error: 'compaction-timeout' };
                // FINAL synchronous reread + CAS: a delete / edit / suffix change / route
                // change during the budget await must not slip through as a false success.
                // Do the ASYNC static-input check FIRST (before the reread) so the reread +
                // all CAS checks are synchronous — an await between them would reopen the
                // TOCTOU (a delete/selection during it observed against a stale finalConv).
                const staticStillValid =
                  (await raceAbort(staticInputFingerprint(chatBasePrompt, chatCwd, getRegisteredTools()))) ===
                  validatedStaticInputFingerprint;
                if (signal?.aborted) return { ok: false, error: 'compaction-timeout' };
                const finalConv = readConversation(appHome, conversationId);
                if (!finalConv) return { ok: false, error: 'conversation-not-found' };
                const fstored = finalConv.conversationCompaction as
                  | { compactionId?: string; coveredContentSig?: Record<string, string> }
                  | null
                  | undefined;
                const { tree: ftree, headId: fhead } = ensureConversationTree(finalConv);
                const fBranch = getConversationBranch(ftree, fhead);
                // The stored summary's COVERED content must still match its recorded
                // coveredContentSig — a trusted plugin can edit a covered message under the
                // same id (retaining conversationCompaction), which fullSigOf/route checks
                // (branch stability during THIS await) wouldn't catch. Reuse only if the
                // covered content is genuinely unchanged.
                const coveredContentMatches = (() => {
                  const sig = stored.coveredContentSig;
                  // Unsigned record (pre-upgrade / preserved without a baseline) can't be
                  // verified — a same-id content rewrite is undetectable, so don't reuse its
                  // summary as a no-op; recompute. Likewise a partially-signed covered id.
                  if (!sig) return false;
                  const byId = new Map(fBranch.map((m) => [m.id, m]));
                  return (stored.compactedMessageIds ?? []).every((id) => {
                    const expected = sig[id];
                    if (expected === undefined) return false;
                    const node = byId.get(id);
                    if (!node) return false;
                    return messageContentSignature(node as Parameters<typeof messageContentSignature>[0]) === expected;
                  });
                })();
                if (
                  fstored?.compactionId === stored.compactionId &&
                  fullSigOf(fBranch as Array<{ id?: unknown }>) === beforeAwaitSig &&
                  routeFingerprint(finalConv) === beforeAwaitRoute &&
                  coveredContentMatches &&
                  staticStillValid &&
                  // Global routing/limit config must also be unchanged since validation —
                  // a compaction-limits or runtime switch during the budget await would
                  // otherwise let /compact report a no-op success under stale limits.
                  (!getConfig || globalConfigFingerprint(getConfig()) === validatedGlobalConfigFingerprint)
                ) {
                  return { ok: true, summarizedCount: coveredCount };
                }
                // else: changed under us during the budget await — fall through to recompute.
              }
            }
            // else: changed under us — fall through and recompute below.
          }
        }
      }
    }

    // Inject the conversation's executionMode into the config the hooks see, the
    // SAME way a normal turn does (agent.ts) — a mode-aware DLP/plugin hook (e.g.
    // stricter redaction in plan-first mode) must observe the same mode it would on
    // a real turn, else it can behave differently for the summarizer request.
    const convExecutionMode = (conv as { executionMode?: ExecutionMode | null }).executionMode;
    const configForHooks: AppConfig = convExecutionMode
      ? { ...config, tools: { ...config.tools, executionMode: convExecutionMode } }
      : config;

    // Run plugin pre-send (`messages:hook`) middleware FIRST, then the enforcing
    // UserPromptSubmit DLP gate LAST — the SAME order a normal turn uses (agent.ts).
    // Order matters: a plugin can rewrite/inject content, and the DLP gate must be
    // the AUTHORITATIVE final check over whatever actually goes to the model (else a
    // plugin could re-introduce content the gate would have redacted).
    const pluginManager = getPluginManager?.() ?? null;
    // The window-reduction below budgets the NEXT real turn, so it tracks the chat
    // system prompt (which a pre-send plugin may rewrite). But the summarizer
    // REQUEST that these hooks gate uses COMPACTION_SYSTEM_PROMPT — pass THAT as the
    // hook `systemPrompt` so a system-prompt-conditioned DLP/redaction hook sees the
    // prompt actually sent to the summarizer, not the chat prompt.
    // The prompt actually sent to the summarizer. Starts as COMPACTION_SYSTEM_PROMPT;
    // a hook may rewrite it — we honor that rewrite in compactConversationPrefix. (The
    // NEXT turn's chat prompt is sized separately via assembledChatPrompt above.)
    let compactionSystemPrompt = COMPACTION_SYSTEM_PROMPT;
    if (pluginManager) {
      try {
        const hookResult = await raceAbort(
          pluginManager.runPreSendHooks({
            messages: messages as Parameters<typeof pluginManager.runPreSendHooks>[0]['messages'],
            modelKey: modelEntry.key,
            config: configForHooks,
            systemPrompt: compactionSystemPrompt,
          }),
        );
        if (hookResult.abort) return { ok: false, error: 'blocked-by-hook' };
        if (Array.isArray(hookResult.messages)) {
          messages = hookResult.messages as typeof messages;
        }
        // Honor a plugin rewrite of the COMPACTION prompt (what the summarizer sends).
        if (typeof hookResult.systemPrompt === 'string') compactionSystemPrompt = hookResult.systemPrompt;
      } catch {
        return { ok: false, error: 'hook-error' };
      }
    }

    // Enforcing UserPromptSubmit DLP gate LAST — authoritative over the plugin
    // output. Fails closed: a denying/suppressing hook aborts compaction rather than
    // leaking to the summarizer.
    try {
      const gated = await raceAbort(
        gateMessagesThroughUserPromptSubmit(
          messages,
          configForHooks,
          conversationId,
          modelEntry.key,
          'compaction',
          compactionSystemPrompt,
        ),
      );
      if (gated.suppressed) return { ok: false, error: 'blocked-by-hook' };
      messages = gated.messages as typeof messages;
      // Honor a DLP-gate rewrite of the COMPACTION prompt too.
      if (typeof gated.systemPrompt === 'string') compactionSystemPrompt = gated.systemPrompt;
    } catch {
      return { ok: false, error: 'hook-error' };
    }

    // BEFORE paying for a summary: verify the (post-hook) messages still carry
    // internal IDs that form a leading run matching the current disk branch. A
    // pre-send/DLP hook that reconstructs messages WITHOUT Kai's ids — or drops/
    // reorders the head — yields a record whose compactedMessageIds can't be a
    // strict disk-branch prefix, so the send-path reuse would reject it. Detect
    // that here and skip (report nothing-to-compact) rather than billing a summary
    // that can never be reused. (The post-summary strict-prefix check below stays as
    // belt-and-braces.)
    {
      const { tree: preTree, headId: preHead } = ensureConversationTree(conv);
      const diskIds = getConversationBranch(preTree, preHead).map((m) => m.id);
      const msgIds = messages.map((m) => (m as { id?: unknown }).id);
      const { boundaryIndex } = selectProtectedTail(
        messages as unknown as Parameters<typeof selectProtectedTail>[0],
        config.compaction.conversation.ignoreRecentUserMessages,
        config.compaction.conversation.ignoreRecentAssistantMessages,
      );
      if (!summarizablePrefixMatchesDisk(msgIds, diskIds, boundaryIndex)) {
        return { ok: false, error: 'nothing-to-compact' };
      }
    }

    let result;
    try {
      // The compaction budget is `window - outputMaxTokens - promptReserveTokens`.
      // A large ASSEMBLED system prompt (base + working-directory / project
      // instructions) can exceed promptReserveTokens, so a summary that "fits" the
      // raw window would still overflow the real request — `/compact` would report
      // success yet the next turn re-overflows. Reduce the effective window by the
      // amount the assembled system prompt exceeds the reserve. (Tool schemas are
      // the smaller static term and aren't built in this handler; the reserve
      // covers them, and reactive recovery — which DOES count schemas — backstops.)
      // Size the SUMMARIZER request against the SUMMARIZER model's OWN window (the
      // primary/config-override — the summarizer runs on modelEntry, not a fallback).
      // Using the fallback-min window here would reject a large prefix the primary
      // summarizer could handle. The compacted RESULT's fit on every eligible model
      // (incl. smaller fallbacks) is validated separately by candidateSafeForAllModels.
      const summarizerWindow =
        (config.compaction.conversation as { contextWindowTokens?: number }).contextWindowTokens ??
        modelEntry.modelConfig.maxInputTokens ??
        // Imported models often omit maxInputTokens but have an INFERRED window; use it
        // so externalOverReserve (the next-turn static excess) is still subtracted —
        // otherwise a large static input on such a model isn't budgeted and /compact
        // bills a summary that post-validation then rejects (repeated waste).
        (() => {
          try {
            return resolveConversationTokenization(modelEntry.modelConfig.modelName).contextWindowTokens ?? undefined;
          } catch {
            return undefined;
          }
        })();
      let compactConfig = config.compaction.conversation as Parameters<typeof compactConversationPrefix>[2];
      // The NEXT real turn's static input beyond the reserve, on the SUMMARIZER model
      // (its window is what we're reducing) — so the summary leaves room for that turn.
      let externalOverReserve = 0;
      if (typeof summarizerWindow === 'number' && summarizerWindow > 0) {
        externalOverReserve = promptOverReserveFor(modelEntry.modelConfig.modelName);
        compactConfig = { ...convConfig, contextWindowTokens: summarizerWindow };
      }
      result = await compactConversationPrefix(
        messages as Parameters<typeof compactConversationPrefix>[0],
        modelEntry.modelConfig,
        compactConfig,
        signal,
        {
          disableAmbientFallback: providerOverrideApplied,
          externalPromptOverReserve: externalOverReserve,
          // Honor a hook-rewritten compaction prompt (only when it actually changed).
          ...(compactionSystemPrompt !== COMPACTION_SYSTEM_PROMPT
            ? { systemPromptOverride: compactionSystemPrompt }
            : {}),
        },
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // A null result means "nothing safe to compact" (prefix empty / would drop a
    // message / summary still over budget) — the auto path treats this the same.
    // ALSO require a non-empty compactedMessageIds: the reuse path (next turn)
    // needs a stable id prefix, and an empty list (e.g. a modify hook stripped
    // Kai's internal ids) makes the persisted record non-reusable — reporting
    // success then would be misleading (the next turn silently ignores it).
    if (
      !result ||
      !result.compactedMessages ||
      !result.summaryText ||
      !result.compactionId ||
      result.compactedMessageIds.length === 0
    ) {
      return { ok: false, error: 'nothing-to-compact' };
    }

    // The compacted branch may FIT the prompt-input budget yet still be OVER the
    // compaction TRIGGER (a large protected recent tail), or exceed a denser-tokenizing
    // fallback's real input budget. The next turn's reuse gate would then reject the
    // record and re-summarize — so `/compact` would report success but change nothing
    // (and risk double-billing), or worse persist a record that overflows a fallback.
    // Validate the candidate against EVERY eligible model (trigger + hard input budget,
    // each model's own tokenizer) — the SAME check the stored-summary reuse short-circuit
    // uses. If it's unsafe on any model, report nothing-to-compact rather than persist.
    if (
      !(await candidateSafeForAllModels(
        result.compactedMessages as Parameters<typeof shouldCompactBranchMediaAware>[0],
      ))
    ) {
      return { ok: false, error: 'nothing-to-compact' };
    }

    // Persist the record only (tree untouched). Re-read to avoid clobbering a
    // concurrent write, then merge just the compaction field.
    const fresh = readConversation(appHome, conversationId);
    if (!fresh) return { ok: false, error: 'conversation-not-found' };
    // If the deadline already fired, the outer race resolved as `compaction-timeout`
    // and RELEASED the lock — a normal turn may now own the conversation. A late
    // persist here could race that turn's writes, so bail without writing. (Best-
    // effort: the strict-prefix check below would also reject a diverged branch.)
    if (signal?.aborted) return { ok: false, error: 'compaction-timeout' };
    // A turn may have started during the (async) summary generation. If so, skip
    // persisting — that turn will compute its own record, and stamping one now
    // could race its terminal write. (Even if it slipped through, the agent
    // reuse path fails-safe on a prefix mismatch, so this is belt-and-braces.)
    if (fresh.runStatus === 'running' || fresh.runStatus === 'awaiting-approval') {
      return { ok: false, error: 'conversation-busy' };
    }
    // The record is only REUSABLE next turn if its ids form an ordered prefix of
    // the current stored branch. A UserPromptSubmit modify hook can drop/reorder
    // history so the ids stay real yet aren't a strict prefix — persisting such a
    // record would report success while next turn's isStrictPrefix rejects it and
    // re-summarizes. Validate against the freshly-read branch and report
    // `nothing-to-compact` (the honest "no reusable record") if it won't reuse.
    let validatedHead: string | null = null;
    // FULL-branch content signature of what we validated. The final CAS also compares this
    // so a same-id content edit to a SUFFIX message (e.g. a partial→final finalize that
    // grows the last assistant) — which keeps the head AND leaves covered ids untouched,
    // yet can change the reused record's budget — is caught too. Deterministic (no new
    // await), so it doesn't open a fresh TOCTOU window.
    let validatedFullSig = '';
    const coveredIdSet = new Set(result.compactedMessageIds);
    {
      const { tree: freshTree, headId: freshHead } = ensureConversationTree(fresh);
      validatedHead = freshHead ?? null;
      const freshBranch = getConversationBranch(freshTree, freshHead);
      const freshBranchIds = freshBranch.map((m) => m.id);
      if (!isStrictPrefix(result.compactedMessageIds, freshBranchIds)) {
        return { ok: false, error: 'nothing-to-compact' };
      }
      // IDs match, but a concurrent conversations:put may have CHANGED a covered
      // message's CONTENT under the same id (e.g. a partial→final assistant finalize,
      // or an edit) while we were summarizing. The summary reflects the INITIAL content;
      // persisting it would hide the newer content on reuse. Compare covered-message
      // content signatures between the initial branch (what we summarized) and the
      // fresh disk read — if any covered message's content changed, the summary is
      // stale, so report nothing-to-compact rather than persist it.
      validatedFullSig = fullSigOf(freshBranch as Array<{ id?: unknown }>);
      // Compare the covered ids' PRE-HOOK raw sigs (captured before any in-place hook
      // mutation of `branch`) against fresh disk — NOT coveredSigOf(branch), which would
      // reflect a hook's in-place content mutation and falsely reject a valid compaction.
      const preHookCoveredSig = [...coveredIdSet]
        .filter((id) => preHookBranchSigById.has(id))
        .map((id) => `${id}:${preHookBranchSigById.get(id)}`)
        .join(' ');
      const freshCoveredById = new Map(
        (freshBranch as Array<{ id?: unknown }>).map((m) => [typeof m?.id === 'string' ? m.id : '', m]),
      );
      const freshCoveredSig = [...coveredIdSet]
        .filter((id) => preHookBranchSigById.has(id))
        .map((id) => {
          const node = freshCoveredById.get(id);
          return `${id}:${node ? messageContentSignature(node as Parameters<typeof messageContentSignature>[0]) : 'MISSING'}`;
        })
        .join(' ');
      if (preHookCoveredSig !== freshCoveredSig) {
        return { ok: false, error: 'nothing-to-compact' };
      }
      // The covered PREFIX is unchanged, but a concurrent client may have APPENDED new
      // messages to the suffix while we summarized. candidateSafeForAllModels (above)
      // validated `[summary, ...INITIAL suffix]`; the record we're about to persist will
      // be reused next turn as `[summary, ...FRESH suffix]`, which is larger and may now
      // bust the trigger / hard-input / media budgets on some eligible model. Re-validate
      // the RECOMPOSED candidate against fresh disk before writing — else /compact reports
      // success and stores a record the next turn immediately rejects or recomputes.
      const coveredCount = result.compactedMessageIds.length;
      const recomposedCandidate = [
        { id: `compaction-summary-${result.compactionId}`, role: 'assistant' as const, content: result.summaryText },
        // Strip displayOnly parts from the fresh suffix, exactly as the initial candidate
        // was stripped (line ~1067). freshBranch is RAW disk — project it through the same
        // model-bearing helper (drops displayOnly parts AND storage-only fields like
        // parentId/createdAt/token caches that exact counting would otherwise over-count).
        // (Drift checks above still use raw.)
        ...projectForCompactionCandidate(
          freshBranch.slice(coveredCount) as Array<{ id?: unknown; role?: unknown; content?: unknown }>,
        ),
      ];
      if (
        !(await candidateSafeForAllModels(recomposedCandidate as Parameters<typeof shouldCompactBranchMediaAware>[0]))
      ) {
        return { ok: false, error: 'nothing-to-compact' };
      }
    }
    // The recompose re-validation awaited the tokenizer; if the deadline fired during it
    // the lock was released and a turn may now own the conversation — don't race its write.
    if (signal?.aborted) return { ok: false, error: 'compaction-timeout' };
    // Compute the (ASYNC — reads instruction files) static-input drift check HERE, BEFORE
    // the final reread, so the reread→checks→write sequence below is fully SYNCHRONOUS.
    // Doing this await AFTER the reread would reopen the TOCTOU the final reread closes: a
    // concurrent delete / selection change during the await could be clobbered by the write.
    const staticInputStillValid =
      (await raceAbort(staticInputFingerprint(chatBasePrompt, chatCwd, getRegisteredTools()))) ===
      validatedStaticInputFingerprint;
    if (signal?.aborted) return { ok: false, error: 'compaction-timeout' };
    if (!staticInputStillValid) {
      // Tool schemas / expanded instructions changed during summarization — the record was
      // sized against stale static cost; recompute next turn.
      return { ok: false, error: 'nothing-to-compact' };
    }
    // FINAL re-read before writing. Everything above validated against `fresh` (read
    // before the awaited recompose-revalidation); a concurrent edit / append / metadata
    // write / DELETION during that await would be lost — or a deleted conversation
    // resurrected — if we wrote the stale `fresh`. Re-read now, bail if it vanished, and
    // bail if the branch head moved (our prefix/content/budget validation no longer holds
    // — report nothing-to-compact so the next turn recomputes). Merge the compaction field
    // into the LATEST record so we don't clobber a concurrent metadata change. NO awaits
    // between this reread and the write below.
    const latest = readConversation(appHome, conversationId);
    if (!latest) return { ok: false, error: 'conversation-not-found' };
    const { tree: latestTree, headId: latestHead } = ensureConversationTree(latest);
    if ((latestHead ?? null) !== validatedHead) {
      return { ok: false, error: 'nothing-to-compact' };
    }
    // Head-unchanged is NOT sufficient: a concurrent conversations:put can rewrite a
    // message's content under the same id (partial→final finalize, edit) without moving
    // the head — a COVERED edit makes the summary stale, a SUFFIX edit can bust the reused
    // record's budget. Re-compare the FULL-branch content signature against what we
    // validated; if anything drifted, bail so the next turn recomputes.
    if (fullSigOf(getConversationBranch(latestTree, latestHead) as Array<{ id?: unknown }>) !== validatedFullSig) {
      return { ok: false, error: 'nothing-to-compact' };
    }
    // Route/budget fingerprint must also be unchanged: if the selected model/profile/
    // runtime/execution-mode/cwd/fallback changed during summarization, everything we
    // validated (window, tokenizer, budgets, and whether the runtime even uses reuse
    // records) was for the OLD route. Bail so the next turn recomputes for the new one.
    if (routeFingerprint(latest) !== validatedRouteFingerprint) {
      return { ok: false, error: 'nothing-to-compact' };
    }
    // Also bail if the GLOBAL routing/budget config changed during summarization (e.g. the
    // default runtime switched to an external one that ignores reuse records) — the record
    // we validated is for the old global config; recompute next turn against the new one.
    if (getConfig && globalConfigFingerprint(getConfig()) !== validatedGlobalConfigFingerprint) {
      return { ok: false, error: 'nothing-to-compact' };
    }
    // (static-input drift was already validated synchronously BEFORE this reread.)
    // Baseline signatures for the covered ids, from the validated latest branch — so a
    // LATER reactive overflow recovery that reuses THIS summary then recompacts it can
    // verify the underlying ids (else its expansion guard finds no baseline and refuses
    // to persist, causing repeated recovery + rebilling). Parity with the agent-side
    // pre-stream / recovery emit sites.
    const latestBranch = getConversationBranch(latestTree, latestHead) as Array<{ id?: unknown }>;
    const compactCoveredSig: Record<string, string> = {};
    for (const m of latestBranch) {
      if (typeof m?.id === 'string' && coveredIdSet.has(m.id)) {
        compactCoveredSig[m.id] = messageContentSignature(m as Parameters<typeof messageContentSignature>[0]);
      }
    }
    latest.conversationCompaction = {
      compactionId: result.compactionId,
      summaryText: result.summaryText,
      compactedMessageIds: result.compactedMessageIds,
      boundaryHeadId: headId,
      createdAt: new Date().toISOString(),
      coveredContentSig: compactCoveredSig,
      compactionRevision: nextCompactionRevision(),
    } as ConversationRecord['conversationCompaction'];
    latest.updatedAt = new Date().toISOString();
    writeConversation(appHome, latest);
    // Broadcast the persisted record so the renderer's cached conversation matches
    // disk. Without this the renderer still holds the PRE-compaction record; a later
    // rename/archive/settings write would then send that stale full record through
    // `conversations:put` — its compactionId differs, so the put-preservation guard
    // won't retain the fresh one — silently overwriting the paid summary. (The tree
    // is unchanged; this upsert only refreshes metadata + conversationCompaction.)
    broadcastUpsert(appHome, latest);
    return { ok: true, summarizedCount: result.compactedMessageIds.length };
  };

  ipcMain.handle('conversations:switch-variant', (_event, conversationId: string, variantId: string) => {
    const conv = readConversation(appHome, conversationId);
    if (!conv) return { ok: false, error: 'conversation-not-found' };
    if (isCompacting(conversationId)) return { ok: false, error: 'conversation-busy' };

    const { tree } = ensureConversationTree(conv);
    if (!tree.some((m) => m.id === variantId)) return { ok: false, error: 'variant-not-found' };

    const nextHead = findDeepestDescendant(tree, variantId);
    return { ok: true, conversation: commitTreeUpdate(conv, tree, nextHead) };
  });

  ipcMain.handle('conversations:get-active-id', () => {
    return getActiveConversationId(appHome);
  });

  ipcMain.handle('conversations:set-active-id', (_event, id: string) => {
    setActiveConversationId(appHome, id);
    broadcastActive(appHome);
    return { ok: true };
  });

  // Fast single-round-trip selection change for the CLI: patch only the
  // selected model or profile on one conversation (one read + one write; no
  // full-record merge), and return the resolved effective-model display name so
  // the client can update its banner without extra catalog/get round-trips.
  ipcMain.handle(
    'conversations:set-selection',
    (_event, id: string, kind: 'model' | 'profile', value: string | null) => {
      const conv = readConversation(appHome, id);
      if (!conv) return { ok: false, error: 'conversation-not-found' };

      if (kind === 'model') conv.selectedModelKey = value;
      else conv.selectedProfileKey = value;
      conv.updatedAt = new Date().toISOString();
      const writtenConv = writeConversation(appHome, conv);
      broadcastUpsert(appHome, writtenConv);

      // Resolve the effective model display name for the banner.
      let modelLabel: string | null = null;
      let profileLabel: string | null = null;
      try {
        const config = getConfig?.();
        if (config) {
          const models = config.models?.catalog ?? [];
          const profiles = config.profiles ?? [];
          const profile = conv.selectedProfileKey ? profiles.find((p) => p.key === conv.selectedProfileKey) : undefined;
          profileLabel = profile ? (profile.name ?? profile.key) : null;
          const effectiveModelKey =
            profile?.primaryModelKey ?? conv.selectedModelKey ?? config.models?.defaultModelKey ?? null;
          const entry = models.find((m) => m.key === effectiveModelKey);
          modelLabel = entry?.displayName ?? effectiveModelKey ?? null;
        }
      } catch {
        // label resolution is best-effort
      }

      return { ok: true, modelLabel, profileLabel };
    },
  );

  ipcMain.handle('conversations:fork', (_event, id: string, upToMessageIndex?: number) => {
    const source = readConversation(appHome, id);
    if (!source) return { ok: false, error: 'Conversation not found' };

    // Deep-clone via JSON round-trip — the store is JSON-persisted so this is lossless.
    const clone = JSON.parse(JSON.stringify(source)) as ConversationRecord;
    const now = new Date().toISOString();

    // Normalize legacy conversations, then extract the ACTIVE branch (the
    // parent chain ending at headId) rather than the flat tree — after
    // edits/regenerations the tree contains sibling variants, and forking the
    // flat list would mix branches / fork the wrong one.
    const { tree: normalizedTree, headId: normalizedHead } = ensureConversationTree(clone);
    const allMessages = getConversationBranch(normalizedTree, normalizedHead);
    const sliced =
      typeof upToMessageIndex === 'number' && upToMessageIndex >= 0
        ? allMessages.slice(0, upToMessageIndex + 1)
        : allMessages;

    // The active branch is a linear parent chain, so the sliced flat list is a
    // valid messageTree on its own; headId is simply the last node's id.
    const lastId =
      sliced.length > 0 ? ((sliced[sliced.length - 1] as { id?: unknown }).id as string | undefined) : undefined;

    const baseTitle = clone.title ?? clone.fallbackTitle ?? 'Chat';
    // Derive activity timestamps from the SLICED branch, not the source — when
    // upToMessageIndex drops the tail, the source's lastMessageAt /
    // lastAssistantUpdateAt may point at messages not present in the fork.
    const forkActivity = deriveBranchActivity(sliced as ConversationMessageLike[]);
    const forked: ConversationRecord = {
      ...clone,
      id: randomUUID(),
      title: `${baseTitle} (fork)`,
      messages: sliced,
      messageTree: sliced,
      headId: lastId ?? null,
      messageCount: sliced.length,
      userMessageCount: sliced.filter((m) => (m as { role?: unknown }).role === 'user').length,
      lastMessageAt: forkActivity.lastMessageAt,
      lastAssistantUpdateAt: forkActivity.lastAssistantUpdateAt,
      // Drop compaction state when forking a partial prefix — the summary may
      // reference messages past the cut point.
      conversationCompaction: sliced.length === allMessages.length ? clone.conversationCompaction : null,
      createdAt: now,
      updatedAt: now,
      titleStatus: 'ready',
      titleUpdatedAt: now,
      runStatus: 'idle',
      hasUnread: false,
      // Strip SDK session/thread resume ids so the fork starts an isolated
      // session instead of resuming the original chat's Claude/Codex session.
      metadata: (() => {
        const meta = { ...((clone.metadata as Record<string, unknown> | undefined) ?? {}) };
        delete meta.claudeSdkSessionId;
        delete meta.codexSdkThreadId;
        return meta;
      })(),
    };

    const writtenFork = writeConversation(appHome, forked);
    broadcastUpsert(appHome, writtenFork);
    eventBus.emit('conversation', 'created', { id: forked.id, title: forked.title });
    void hookDispatcher.dispatch('ConversationStart', { conversationId: forked.id, title: forked.title });
    return { ok: true, conversation: writtenFork };
  });

  ipcMain.handle(
    'conversations:export',
    async (_event, id: string, format: 'markdown' | 'json', opts?: { targetPath?: string; overwrite?: boolean }) => {
      const conv = readConversation(appHome, id);
      if (!conv) return { ok: false, error: 'Conversation not found' };

      const ext = format === 'json' ? 'json' : 'md';
      const body = format === 'json' ? JSON.stringify(conv, null, 2) : conversationToMarkdown(conv);

      // Headless / CLI path: an explicit targetPath bypasses the native save
      // dialog (there's no window in a headless backend, and the CLI can't drive
      // a GUI picker). Resolve against cwd; append the format extension if the
      // caller gave a bare name without one.
      if (opts?.targetPath) {
        let dest = opts.targetPath;
        if (typeof dest !== 'string' || dest.trim() === '') return { ok: false, error: 'Invalid target path' };
        dest = isAbsolute(dest) ? dest : resolve(process.cwd(), dest);
        if (!extname(dest)) dest = `${dest}.${ext}`;
        // Don't silently clobber an existing file (e.g. a fat-fingered
        // `/export md ~/.zshrc`). Require an explicit overwrite flag; otherwise
        // return a clear error the CLI can surface.
        if (!opts.overwrite && existsSync(dest)) {
          return { ok: false, error: `file exists: ${dest} (pass overwrite to replace it)` };
        }
        try {
          atomicWriteFileSync(dest, body);
          return { ok: true, filePath: dest };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      const safeTitle = (conv.title ?? conv.fallbackTitle ?? 'chat')
        .replace(/[^a-zA-Z0-9-_ ]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 60);
      const defaultPath = `${safeTitle || 'chat'}.${ext}`;

      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      const saveOptions = {
        title: 'Export Chat',
        defaultPath,
        filters:
          format === 'json' ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'Markdown', extensions: ['md'] }],
      };
      const result = win ? await dialog.showSaveDialog(win, saveOptions) : await dialog.showSaveDialog(saveOptions);
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };

      atomicWriteFileSync(result.filePath, body);
      return { ok: true, filePath: result.filePath };
    },
  );
}

// ── export helpers ─────────────────────────────────────────────────────────

const TOOL_RESULT_TRUNCATE_BYTES = 10 * 1024;

type ExportContentPart = {
  type?: string;
  text?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
};

function roleLabel(role: unknown): string {
  switch (role) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
    case 'tool':
      return 'Tool';
    default:
      return typeof role === 'string' && role ? role : 'Message';
  }
}

function renderToolCallPart(part: ExportContentPart): string {
  const lines: string[] = [];
  const name = part.toolName ?? 'tool';
  lines.push(`#### Tool: \`${name}\``, '');
  if (part.args !== undefined) {
    lines.push('```json', JSON.stringify(part.args, null, 2), '```', '');
  }
  if (part.result !== undefined) {
    const raw = typeof part.result === 'string' ? part.result : JSON.stringify(part.result, null, 2);
    const bytes = Buffer.byteLength(raw, 'utf-8');
    if (bytes > TOOL_RESULT_TRUNCATE_BYTES) {
      lines.push(`_[tool result truncated, ${bytes} bytes]_`, '');
    } else {
      lines.push('```json', raw, '```', '');
    }
  }
  return lines.join('\n');
}

function conversationToMarkdown(conv: ConversationRecord): string {
  const title = conv.title ?? conv.fallbackTitle ?? 'Chat';
  const lines: string[] = [`# ${title}`, ''];
  if (conv.createdAt) lines.push(`_Exported ${new Date().toISOString()} · Created ${conv.createdAt}_`, '');

  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  for (const msg of messages) {
    const m = msg as { role?: unknown; content?: unknown };
    lines.push(`### ${roleLabel(m.role)}`, '');

    if (typeof m.content === 'string') {
      lines.push(m.content, '');
    } else if (Array.isArray(m.content)) {
      for (const part of m.content as ExportContentPart[]) {
        if (!part) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          lines.push(part.text, '');
        } else if (part.type === 'tool-call') {
          lines.push(renderToolCallPart(part));
        } else if (part.type === 'tool-result') {
          // Standalone tool-role messages (AI-SDK wire shape) — render like a tool call result.
          lines.push(renderToolCallPart({ toolName: part.toolName, args: undefined, result: part.result }));
        }
      }
    }
  }
  return lines.join('\n');
}
