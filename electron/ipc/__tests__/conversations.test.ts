import { beforeAll, describe, expect, it, vi } from 'vitest';

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
};

type ConversationsModule = typeof import('../conversations.js');

let conversationsModule: ConversationsModule;

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock('../../web-server/web-clients.js', () => ({
  broadcastToWebClients: () => {},
}));

vi.mock('../../computer-use/service.js', () => ({
  getComputerUseManager: () => ({
    deleteSessionsForConversation: async () => {},
    archiveSessionsForConversation: async () => {},
  }),
}));

beforeAll(async () => {
  Object.assign(globalThis, { __BRAND_APP_SLUG: 'kai' });
  conversationsModule = await import('../conversations.js');
});

function makeConversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conv-1',
    title: null,
    fallbackTitle: null,
    messages: [],
    messageTree: [],
    headId: null,
    conversationCompaction: null,
    lastContextUsage: null,
    createdAt: '2026-05-22T10:48:00.000Z',
    updatedAt: '2026-05-22T10:52:54.451Z',
    lastMessageAt: '2026-05-22T10:52:54.451Z',
    titleStatus: 'idle',
    titleUpdatedAt: null,
    messageCount: 6,
    userMessageCount: 3,
    runStatus: 'idle',
    hasUnread: false,
    lastAssistantUpdateAt: '2026-05-22T10:52:54.451Z',
    selectedModelKey: 'claude-sonnet-4-6',
    ...overrides,
  };
}

describe('conversation activity reconciliation', () => {
  it('keeps the latest assistant timestamp when a stale full-record write lands later', () => {
    const prev = makeConversation();
    const next = makeConversation({
      updatedAt: '2026-05-22T10:55:16.514Z',
      lastMessageAt: '2026-05-22T10:55:16.514Z',
      lastAssistantUpdateAt: '2026-05-22T10:50:26.268Z',
      messages: [
        { role: 'user', createdAt: '2026-05-22T10:48:01.414Z' },
        { role: 'assistant', createdAt: '2026-05-22T10:48:07.746Z' },
        { role: 'user', createdAt: '2026-05-22T10:50:19.074Z' },
        { role: 'assistant', createdAt: '2026-05-22T10:50:25.349Z' },
        { role: 'user', createdAt: '2026-05-22T10:52:48.333Z' },
        { role: 'assistant', createdAt: '2026-05-22T10:52:54.300Z' },
      ],
    });

    const reconciled = conversationsModule.reconcileConversationActivity(prev, next);

    expect(reconciled.lastAssistantUpdateAt).toBe('2026-05-22T10:52:54.451Z');
    expect(reconciled.messageCount).toBe(6);
    expect(reconciled.userMessageCount).toBe(3);
  });

  it('flags a stale running write even when it has a newer updatedAt', () => {
    const prev = makeConversation();
    const next = conversationsModule.reconcileConversationActivity(prev, makeConversation({
      runStatus: 'running',
      updatedAt: '2026-05-22T10:55:16.514Z',
      lastAssistantUpdateAt: '2026-05-22T10:50:26.268Z',
      headId: prev.headId,
      messages: [
        { role: 'user', createdAt: '2026-05-22T10:48:01.414Z' },
        { role: 'assistant', createdAt: '2026-05-22T10:48:07.746Z' },
        { role: 'user', createdAt: '2026-05-22T10:50:19.074Z' },
        { role: 'assistant', createdAt: '2026-05-22T10:50:25.349Z' },
        { role: 'user', createdAt: '2026-05-22T10:52:48.333Z' },
        { role: 'assistant', createdAt: '2026-05-22T10:52:54.300Z' },
      ],
    }));

    expect(conversationsModule.isStaleRunningWrite(prev, next)).toBe(true);
  });

  it('allows a real new user turn to move an idle conversation back to running', () => {
    const prev = makeConversation();
    const next = conversationsModule.reconcileConversationActivity(prev, makeConversation({
      runStatus: 'running',
      updatedAt: '2026-05-22T10:56:10.000Z',
      lastMessageAt: '2026-05-22T10:56:10.000Z',
      messages: [
        { role: 'user', createdAt: '2026-05-22T10:48:01.414Z' },
        { role: 'assistant', createdAt: '2026-05-22T10:48:07.746Z' },
        { role: 'user', createdAt: '2026-05-22T10:50:19.074Z' },
        { role: 'assistant', createdAt: '2026-05-22T10:50:25.349Z' },
        { role: 'user', createdAt: '2026-05-22T10:52:48.333Z' },
        { role: 'assistant', createdAt: '2026-05-22T10:52:54.300Z' },
        { role: 'user', createdAt: '2026-05-22T10:56:10.000Z' },
      ],
      messageCount: 7,
      userMessageCount: 4,
      headId: 'msg-new-user',
    }));

    expect(conversationsModule.isStaleRunningWrite(prev, next)).toBe(false);
  });

  it('allows a regenerate/restart write when the active branch changes', () => {
    const prev = makeConversation({ headId: 'assistant-latest' });
    const next = conversationsModule.reconcileConversationActivity(prev, makeConversation({
      runStatus: 'running',
      headId: 'user-before-retry',
      messages: [
        { role: 'user', createdAt: '2026-05-22T10:48:01.414Z' },
        { role: 'assistant', createdAt: '2026-05-22T10:48:07.746Z' },
        { role: 'user', createdAt: '2026-05-22T10:50:19.074Z' },
        { role: 'assistant', createdAt: '2026-05-22T10:50:25.349Z' },
        { role: 'user', createdAt: '2026-05-22T10:52:48.333Z' },
      ],
      messageCount: 5,
      userMessageCount: 3,
      lastMessageAt: '2026-05-22T10:52:48.333Z',
    }));

    expect(conversationsModule.isStaleRunningWrite(prev, next)).toBe(false);
  });
});
