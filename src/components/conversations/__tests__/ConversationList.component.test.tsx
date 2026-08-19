import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { ConversationList } from '../ConversationList';

vi.mock('@/providers/ComputerUseProvider', () => ({
  useComputerUse: () => ({ sessionsByConversation: new Map() }),
}));

vi.mock('@/providers/RuntimeProvider', () => ({
  useAssistantResponseTiming: () => ({ activeRunStartedAt: null }),
  useRuntimeConversationId: () => null,
}));

const unreadChat = {
  id: 'chat-unread',
  title: 'Unread chat',
  fallbackTitle: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastMessageAt: '2026-01-01T00:00:00.000Z',
  messageCount: 1,
  userMessageCount: 1,
  runStatus: 'running',
  hasUnread: true,
  lastAssistantUpdateAt: null,
  archived: false,
};

afterEach(() => {
  uninstallAppBridgeStub();
});

describe('ConversationList navigation', () => {
  it('opens an unread chat when Browser authority rejects the marker write', async () => {
    const put = vi.fn(async () => ({ rejected: 'native-browser-authority-required' }));
    const onSwitchConversation = vi.fn();
    installAppBridgeStub({
      conversations: {
        list: async () => [unreadChat],
        get: async () => unreadChat,
        put,
      },
    });

    render(
      <TooltipProvider>
        <ConversationList
          activeConversationId="chat-active"
          onSwitchConversation={onSwitchConversation}
          onNewConversation={vi.fn()}
          onDeleteConversation={vi.fn(async () => ({ ok: true }))}
          onDeleteConversations={vi.fn(async () => ({ ok: true, deleted: 0, removedIds: [] }))}
        />
      </TooltipProvider>,
    );

    fireEvent.click((await screen.findByText('Unread chat')).closest('[role="button"]')!);

    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ hasUnread: false })));
    expect(onSwitchConversation).toHaveBeenCalledWith('chat-unread');
  });
});
