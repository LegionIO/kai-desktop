import type { IpcMain } from 'electron';
import { BrowserWindow, dialog } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import { isAbsolute, resolve, extname } from 'path';
import { existsSync } from 'fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { randomUUID } from 'crypto';
import type { AppConfig } from '../config/schema.js';
import { eventBus } from '../automations/event-bus.js';
import { matchConversation } from './conversation-search.js';
import { hookDispatcher } from '../agent/hooks/dispatcher.js';
import { clearAllDiffs, clearConversationDiffs } from '../tools/diff-tracker.js';
import { resolveStreamConfig } from '../agent/model-catalog.js';
import { compactConversationPrefix } from '../agent/compaction.js';
import { computeMessageCount } from '../agent/tokenization.js';
import { getComputerUseManager } from '../computer-use/service.js';
import type { ConversationRecord, ConversationIndexEntry } from './conversation-store.js';
import {
  readIndex,
  readConversation,
  writeConversation,
  deleteConversation,
  clearAllConversations,
  getActiveConversationId,
  setActiveConversationId,
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

function broadcastChange(change: ConversationChange): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('conversations:changed', change);
  }
  broadcastToWebClients('conversations:changed', change);
}

export function broadcastUpsert(appHome: string, conversation: ConversationRecord): void {
  broadcastChange({ kind: 'upsert', conversation, activeConversationId: getActiveConversationId(appHome) });
}
function broadcastDelete(appHome: string, id: string): void {
  broadcastChange({ kind: 'delete', id, activeConversationId: getActiveConversationId(appHome) });
}
function broadcastReset(appHome: string): void {
  broadcastChange({ kind: 'reset', activeConversationId: getActiveConversationId(appHome) });
}
export function broadcastActive(appHome: string): void {
  broadcastChange({ kind: 'active', activeConversationId: getActiveConversationId(appHome) });
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

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

export function registerConversationHandlers(ipcMain: IpcMain, appHome: string, getConfig?: () => AppConfig): void {
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
      // DLP: a UserPromptSubmit modify hook may have redacted a user turn on
      // disk (flagged redactedByHook). The renderer's stream-done write carries
      // the same node id with the RAW user text, which the merge above would
      // otherwise re-persist. Force the stored redacted content back onto any
      // shared node so the redaction survives.
      const prevTreeArr = Array.isArray(prev.messageTree) ? (prev.messageTree as StoredTreeMessage[]) : [];
      const redacted = new Map(
        prevTreeArr.filter((m) => (m as { redactedByHook?: boolean }).redactedByHook).map((m) => [m.id, m] as const),
      );
      if (redacted.size > 0 && Array.isArray(nextConversation.messageTree)) {
        const nextTree = (nextConversation.messageTree as StoredTreeMessage[]).map((m) => {
          const r = redacted.get(m.id);
          // Replacing content invalidates any cached count. Drop count + signature
          // so the write chokepoint's backfill recomputes both for the redacted
          // content (and so a mismatched signature can't linger).
          return r
            ? { ...m, content: r.content, redactedByHook: true, tokenCount: undefined, tokenCountSig: undefined }
            : m;
        });
        const nextBranch = getConversationBranch(nextTree, nextConversation.headId ?? null);
        nextConversation = { ...nextConversation, messageTree: nextTree, messages: nextBranch };
      }
    } else {
      nextConversation = reconcileConversationActivity(undefined, nextConversation);
    }

    const written = writeConversation(appHome, nextConversation);
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
    deleteConversation(appHome, id);
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

  ipcMain.handle('conversations:clear', () => {
    // Clean up all computer-use sessions
    if (getConfig) {
      try {
        const manager = getComputerUseManager(appHome, getConfig);
        for (const conversationId of Object.keys(readIndex(appHome).conversations)) {
          manager.removeSessionsByConversation(conversationId);
        }
      } catch {
        // Safe to ignore
      }
    }

    clearAllConversations(appHome);
    clearAllDiffs();
    broadcastReset(appHome);
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

  // On-demand compaction (the CLI /compact command). Summarizes the branch
  // prefix and PERSISTS the compaction record (conversationCompaction) so the
  // next turn reuses it — matching the metadata-only, non-destructive design of
  // the automatic mid-turn path (the message tree is NOT mutated). No renderer
  // is involved, so unlike the auto path (which emits a `compaction` event the
  // renderer persists), this writes the record directly.
  ipcMain.handle('conversations:compact', async (_event, conversationId: string) => {
    if (typeof conversationId !== 'string' || !conversationId) return { ok: false, error: 'invalid-id' };
    const config = getConfig?.();
    if (!config) return { ok: false, error: 'config-unavailable' };
    if (!config.compaction?.conversation?.enabled) return { ok: false, error: 'compaction-disabled' };

    const conv = readConversation(appHome, conversationId);
    if (!conv) return { ok: false, error: 'conversation-not-found' };
    if (conv.runStatus === 'running' || conv.runStatus === 'awaiting-approval') {
      return { ok: false, error: 'conversation-busy' };
    }

    // Resolve the model the same way a turn would (thread model → default),
    // so token windows + tokenization match what the auto path uses.
    const streamConfig = resolveStreamConfig(config, {
      threadModelKey: conv.selectedModelKey ?? null,
      threadProfileKey: null,
      fallbackEnabled: false,
    });
    const modelEntry = streamConfig?.primaryModel;
    if (!modelEntry) return { ok: false, error: 'no-model' };

    const { tree, headId } = ensureConversationTree(conv);
    const branch = getConversationBranch(tree, headId);
    const messages = branch.map((m) => ({ id: m.id, role: m.role, content: m.content }));

    let result;
    try {
      result = await compactConversationPrefix(
        messages as Parameters<typeof compactConversationPrefix>[0],
        modelEntry.modelConfig,
        config.compaction.conversation,
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // A null result means "nothing safe to compact" (prefix empty / would drop a
    // message / summary still over budget) — the auto path treats this the same.
    if (!result || !result.compactedMessages || !result.summaryText || !result.compactionId) {
      return { ok: false, error: 'nothing-to-compact' };
    }

    // Persist the record only (tree untouched). Re-read to avoid clobbering a
    // concurrent write, then merge just the compaction field.
    const fresh = readConversation(appHome, conversationId);
    if (!fresh) return { ok: false, error: 'conversation-not-found' };
    // A turn may have started during the (async) summary generation. If so, skip
    // persisting — that turn will compute its own record, and stamping one now
    // could race its terminal write. (Even if it slipped through, the agent
    // reuse path fails-safe on a prefix mismatch, so this is belt-and-braces.)
    if (fresh.runStatus === 'running' || fresh.runStatus === 'awaiting-approval') {
      return { ok: false, error: 'conversation-busy' };
    }
    fresh.conversationCompaction = {
      compactionId: result.compactionId,
      summaryText: result.summaryText,
      compactedMessageIds: result.compactedMessageIds,
      boundaryHeadId: headId,
      createdAt: new Date().toISOString(),
    } as ConversationRecord['conversationCompaction'];
    fresh.updatedAt = new Date().toISOString();
    writeConversation(appHome, fresh);
    return { ok: true, summarizedCount: result.compactedMessageIds.length };
  });

  ipcMain.handle('conversations:switch-variant', (_event, conversationId: string, variantId: string) => {
    const conv = readConversation(appHome, conversationId);
    if (!conv) return { ok: false, error: 'conversation-not-found' };

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
