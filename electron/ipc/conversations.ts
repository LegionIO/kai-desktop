import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { AppConfig } from '../config/schema.js';
import { getComputerUseManager } from '../computer-use/service.js';

type ChatRecord = {
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
  runStatus: 'idle' | 'running' | 'error';
  hasUnread: boolean;
  lastAssistantUpdateAt: string | null;
  selectedModelKey: string | null;
  selectedProfileKey?: string | null;
  fallbackEnabled?: boolean;
  profilePrimaryModelKey?: string | null;
  currentWorkingDirectory?: string | null;
  metadata?: Record<string, unknown>;
};

type ChatsStore = {
  conversations: Record<string, ChatRecord>;
  activeConversationId: string | null;
  settings: Record<string, unknown>;
};

function getStorePath(appHome: string): string {
  return join(appHome, 'data', 'conversations.json');
}

export function readChatStore(appHome: string): ChatsStore {
  const storePath = getStorePath(appHome);
  if (!existsSync(storePath)) {
    return { conversations: {}, activeConversationId: null, settings: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(storePath, 'utf-8'));
    return raw;
  } catch {
    return { conversations: {}, activeConversationId: null, settings: {} };
  }
}

export function writeChatStore(appHome: string, store: ChatsStore): void {
  const storePath = getStorePath(appHome);
  const dir = join(appHome, 'data');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
}

export function broadcastChatChange(store: ChatsStore): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('conversations:changed', store);
  }
  broadcastToWebClients('conversations:changed', store);
}

export function registerConversationHandlers(ipcMain: IpcMain, appHome: string, getConfig?: () => AppConfig): void {
  ipcMain.handle('conversations:list', () => {
    const store = readChatStore(appHome);
    const chats = Object.values(store.conversations);
    // Sort by most recent activity
    chats.sort((a, b) => {
      const aAt = a.lastAssistantUpdateAt ?? a.lastMessageAt ?? a.updatedAt ?? a.createdAt;
      const bAt = b.lastAssistantUpdateAt ?? b.lastMessageAt ?? b.updatedAt ?? b.createdAt;
      return bAt.localeCompare(aAt);
    });
    // Add computed metadata for client-side filtering
    return chats.map((chat) => ({
      ...chat,
      hasToolCalls: Array.isArray(chat.messages) && chat.messages.some(
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
    const store = readChatStore(appHome);
    return store.conversations[id] ?? null;
  });

  ipcMain.handle('conversations:put', (_event, chat: ChatRecord) => {
    const store = readChatStore(appHome);
    const tree = Array.isArray(chat.messageTree) ? chat.messageTree : [];
    const prev = store.conversations[chat.id];
    const prevTreeLen = prev && Array.isArray(prev.messageTree) ? prev.messageTree.length : 0;

    // Guard: never allow a write that would lose messages compared to what's on disk.
    // If the incoming tree is shorter than the stored tree, preserve the stored message data
    // and only apply non-message field updates. This protects against stale-closure races
    // where title generation, settings persistence, or debounced persists write back
    // an older snapshot of the chat.
    if (prev && prevTreeLen > 0 && tree.length < prevTreeLen) {
      const guarded = {
        ...chat,
        messages: prev.messages,
        messageTree: prev.messageTree,
        headId: prev.headId,
        messageCount: prev.messageCount,
        userMessageCount: prev.userMessageCount,
      };
      store.conversations[chat.id] = guarded;
      writeChatStore(appHome, store);
      broadcastChatChange(store);
      return { ok: true };
    }

    store.conversations[chat.id] = chat;
    writeChatStore(appHome, store);
    broadcastChatChange(store);
    return { ok: true };
  });

  ipcMain.handle('conversations:delete', (_event, id: string) => {
    const store = readChatStore(appHome);
    delete store.conversations[id];
    if (store.activeConversationId === id) {
      store.activeConversationId = null;
    }
    writeChatStore(appHome, store);
    broadcastChatChange(store);

    // Clean up associated computer-use sessions
    if (getConfig) {
      try {
        const manager = getComputerUseManager(appHome, getConfig);
        manager.removeSessionsByChat(id);
      } catch {
        // Computer-use module may not be initialized yet — safe to ignore
      }
    }

    return { ok: true };
  });

  ipcMain.handle('conversations:clear', () => {
    const store = readChatStore(appHome);

    // Clean up all computer-use sessions
    if (getConfig) {
      try {
        const manager = getComputerUseManager(appHome, getConfig);
        for (const chatId of Object.keys(store.conversations)) {
          manager.removeSessionsByChat(chatId);
        }
      } catch {
        // Safe to ignore
      }
    }

    store.conversations = {};
    store.activeConversationId = null;
    writeChatStore(appHome, store);
    broadcastChatChange(store);
    return { ok: true };
  });

  ipcMain.handle('conversations:get-active-id', () => {
    const store = readChatStore(appHome);
    return store.activeConversationId;
  });

  ipcMain.handle('conversations:set-active-id', (_event, id: string) => {
    const store = readChatStore(appHome);
    store.activeConversationId = id;
    writeChatStore(appHome, store);
    broadcastChatChange(store);
    return { ok: true };
  });
}
