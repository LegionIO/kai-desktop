import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { AppConfig } from '../config/schema.js';
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
  const messages = Array.isArray(next.messages) ? next.messages as ConversationMessageLike[] : [];
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
  if ((prev.runStatus !== 'idle' && prev.runStatus !== 'awaiting-approval') || next.runStatus !== 'running') return false;

  // A new user turn is allowed to move an idle conversation back to running.
  if (next.userMessageCount > prev.userMessageCount) return false;

  // Regenerate / restart flows legitimately move the active branch or head
  // without adding a new user message.
  if (next.headId !== prev.headId || next.messageCount !== prev.messageCount) return false;

  // A legitimate restart will usually change the active branch or head.
  const sameBranch = next.headId === prev.headId
    && next.messageCount === prev.messageCount
    && next.userMessageCount === prev.userMessageCount;
  const noFreshActivity = timestampMs(next.lastAssistantUpdateAt) <= timestampMs(prev.lastAssistantUpdateAt)
    && timestampMs(next.lastMessageAt) <= timestampMs(prev.lastMessageAt);
  if (sameBranch && noFreshActivity) return true;

  // Stale async writes often carry an older updatedAt, or they were read before
  // the done handler populated lastAssistantUpdateAt.
  return timestampMs(next.updatedAt) <= timestampMs(prev.updatedAt)
    || Boolean(prev.lastAssistantUpdateAt && !next.lastAssistantUpdateAt)
    || timestampMs(next.lastAssistantUpdateAt) < timestampMs(prev.lastAssistantUpdateAt)
    || timestampMs(next.lastMessageAt) < timestampMs(prev.lastMessageAt);
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
      hasToolCalls: Array.isArray(conv.messages) && conv.messages.some(
        (msg: unknown) => {
          const m = msg as Record<string, unknown>;
          return Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some(
            (part) => part?.type === 'tool-call',
          );
        },
      ),
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
    // If the incoming tree is shorter than the stored tree, preserve the stored message data
    // and only apply non-message field updates. This protects against stale-closure races
    // where title generation, settings persistence, or debounced persists write back
    // an older snapshot of the conversation.
    let nextConversation = conversation;

    if (prev && prevTreeLen > 0 && tree.length < prevTreeLen) {
      nextConversation = {
        ...conversation,
        messages: prev.messages,
        messageTree: prev.messageTree,
        headId: prev.headId,
        messageCount: prev.messageCount,
        userMessageCount: prev.userMessageCount,
      };
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
