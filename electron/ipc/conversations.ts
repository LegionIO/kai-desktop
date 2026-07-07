import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { AppConfig } from '../config/schema.js';
import { eventBus } from '../automations/event-bus.js';
import { getComputerUseManager } from '../computer-use/service.js';

type ConversationRecord = {
  id: string;
  title: string | null;
  fallbackTitle: string | null;
  messages: unknown[];
  messageTree?: unknown[];
  headId?: string | null;
  conversationCompaction: unknown | null;
  lastContextUsage: unknown | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  titleStatus: 'idle' | 'generating' | 'ready' | 'error';
  titleUpdatedAt: string | null;
  messageCount: number;
  userMessageCount: number;
  runStatus: 'idle' | 'running' | 'awaiting-approval' | 'error';
  hasUnread: boolean;
  lastAssistantUpdateAt: string | null;
  selectedModelKey: string | null;
  selectedProfileKey?: string | null;
  fallbackEnabled?: boolean;
  profilePrimaryModelKey?: string | null;
  currentWorkingDirectory?: string | null;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
};

type ConversationsStore = {
  conversations: Record<string, ConversationRecord>;
  activeConversationId: string | null;
  settings: Record<string, unknown>;
};

function getStorePath(appHome: string): string {
  return join(appHome, 'data', 'conversations.json');
}

export function readConversationStore(appHome: string): ConversationsStore {
  const storePath = getStorePath(appHome);
  if (!existsSync(storePath)) {
    return { conversations: {}, activeConversationId: null, settings: {} };
  }
  try {
    return JSON.parse(readFileSync(storePath, 'utf-8'));
  } catch {
    return { conversations: {}, activeConversationId: null, settings: {} };
  }
}

export function writeConversationStore(appHome: string, store: ConversationsStore): void {
  const storePath = getStorePath(appHome);
  const dir = join(appHome, 'data');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
}

export function broadcastConversationChange(store: ConversationsStore): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('conversations:changed', store);
  }
  broadcastToWebClients('conversations:changed', store);
}

// ── messageTree helpers (main-process append) ──────────────────────────────

export type StoredTreeMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  parentId: string | null;
  createdAt: string;
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
  messages: Array<{ role: StoredTreeMessage['role']; content: unknown; createdAt?: string }>,
  options: { skipIfBusy?: boolean; parentId?: string | null } = {},
): ConversationRecord | null {
  const store = readConversationStore(appHome);
  const conv = store.conversations[conversationId];
  if (!conv) return null;
  if (options.skipIfBusy && (conv.runStatus === 'running' || conv.runStatus === 'awaiting-approval')) {
    return null;
  }

  const { tree, headId } = ensureConversationTree(conv);
  let parentId = options.parentId !== undefined ? options.parentId : headId;
  const now = new Date().toISOString();
  const appended: StoredTreeMessage[] = messages.map((m, i) => {
    const node: StoredTreeMessage = {
      id: `auto-msg-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      role: m.role,
      content: m.content,
      parentId,
      createdAt: m.createdAt ?? now,
    };
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
  };

  store.conversations[conversationId] = next;
  writeConversationStore(appHome, store);
  broadcastConversationChange(store);
  return next;
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

  return {
    ...next,
    runStatus: prev.runStatus,
    hasUnread: prev.hasUnread,
    lastAssistantUpdateAt: prev.lastAssistantUpdateAt,
    lastMessageAt: prev.lastMessageAt,
    updatedAt: timestampMs(prev.updatedAt) >= timestampMs(next.updatedAt) ? prev.updatedAt : next.updatedAt,
  };
}

export function registerConversationHandlers(ipcMain: IpcMain, appHome: string, getConfig?: () => AppConfig): void {
  ipcMain.handle('conversations:list', () => {
    const store = readConversationStore(appHome);
    const conversations = Object.values(store.conversations);
    // Sort by most recent activity
    conversations.sort((a, b) => {
      const aAt = a.lastAssistantUpdateAt ?? a.lastMessageAt ?? a.updatedAt ?? a.createdAt;
      const bAt = b.lastAssistantUpdateAt ?? b.lastMessageAt ?? b.updatedAt ?? b.createdAt;
      return bAt.localeCompare(aAt);
    });
    // Add computed metadata for client-side filtering
    return conversations.map((conv) => ({
      ...conv,
      hasToolCalls:
        Array.isArray(conv.messages) &&
        conv.messages.some((msg: unknown) => {
          const m = msg as Record<string, unknown>;
          return (
            Array.isArray(m.content) &&
            (m.content as Array<Record<string, unknown>>).some((part) => part?.type === 'tool-call')
          );
        }),
    }));
  });

  ipcMain.handle('conversations:get', (_event, id: string) => {
    const store = readConversationStore(appHome);
    return store.conversations[id] ?? null;
  });

  ipcMain.handle('conversations:put', (_event, conversation: ConversationRecord) => {
    const store = readConversationStore(appHome);
    const tree = Array.isArray(conversation.messageTree) ? conversation.messageTree : [];
    const prev = store.conversations[conversation.id];
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
    } else {
      nextConversation = reconcileConversationActivity(undefined, nextConversation);
    }

    store.conversations[conversation.id] = nextConversation;
    writeConversationStore(appHome, store);
    broadcastConversationChange(store);
    if (!prev) {
      eventBus.emit('conversation', 'created', { id: conversation.id, title: nextConversation.title });
    }
    return { ok: true };
  });

  ipcMain.handle('conversations:delete', (_event, id: string) => {
    const store = readConversationStore(appHome);
    delete store.conversations[id];
    if (store.activeConversationId === id) {
      store.activeConversationId = null;
    }
    writeConversationStore(appHome, store);
    broadcastConversationChange(store);

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
    const store = readConversationStore(appHome);

    // Clean up all computer-use sessions
    if (getConfig) {
      try {
        const manager = getComputerUseManager(appHome, getConfig);
        for (const conversationId of Object.keys(store.conversations)) {
          manager.removeSessionsByConversation(conversationId);
        }
      } catch {
        // Safe to ignore
      }
    }

    store.conversations = {};
    store.activeConversationId = null;
    writeConversationStore(appHome, store);
    broadcastConversationChange(store);
    return { ok: true };
  });

  ipcMain.handle('conversations:get-active-id', () => {
    const store = readConversationStore(appHome);
    return store.activeConversationId;
  });

  ipcMain.handle('conversations:set-active-id', (_event, id: string) => {
    const store = readConversationStore(appHome);
    store.activeConversationId = id;
    writeConversationStore(appHome, store);
    broadcastConversationChange(store);
    return { ok: true };
  });
}
