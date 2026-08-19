import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ChatsListPage } from '../ChatsListPage';

const activeChat = {
  id: 'chat-1',
  title: 'Active chat',
  fallbackTitle: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastMessageAt: '2026-01-01T00:00:00.000Z',
  messageCount: 1,
  userMessageCount: 1,
  runStatus: 'idle',
  hasUnread: false,
  lastAssistantUpdateAt: null,
  archived: false,
};

afterEach(() => {
  uninstallAppBridgeStub();
});

function installDeletedChatBridge() {
  const remove = vi.fn(async () => ({ ok: true }));
  const removeMany = vi.fn(async () => ({ ok: true, deleted: 1, removedIds: ['chat-1'] }));
  installAppBridgeStub({
    conversations: {
      list: async () => [activeChat],
      delete: remove,
      deleteMany: removeMany,
    },
  });
  return { remove, removeMany };
}

describe('ChatsListPage deletion delegation', () => {
  it('delegates context-menu deletion to the App lifecycle owner', async () => {
    const { remove } = installDeletedChatBridge();
    const onNewConversation = vi.fn(async () => undefined);
    const onDeleteConversation = vi.fn(async () => ({ ok: true }));
    render(
      <TooltipProvider>
        <ChatsListPage
          activeConversationId="chat-1"
          onNewConversation={onNewConversation}
          onDeleteConversation={onDeleteConversation}
          onDeleteConversations={vi.fn()}
          onOpenConversation={vi.fn()}
        />
      </TooltipProvider>,
    );

    const title = await screen.findByText('Active chat');
    fireEvent.contextMenu(title.closest('[role="button"]')!, { clientX: 10, clientY: 20 });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onDeleteConversation).toHaveBeenCalledWith('chat-1', ['chat-1']));
    expect(remove).not.toHaveBeenCalled();
    expect(onNewConversation).not.toHaveBeenCalled();
  });

  it('delegates delete-view cleanup as one App-owned bulk operation', async () => {
    const { removeMany } = installDeletedChatBridge();
    const onNewConversation = vi.fn(async () => undefined);
    const onDeleteConversations = vi.fn(async () => ({ ok: true, deleted: 1, removedIds: ['chat-1'] }));
    render(
      <TooltipProvider>
        <ChatsListPage
          activeConversationId="chat-1"
          onNewConversation={onNewConversation}
          onDeleteConversation={vi.fn()}
          onDeleteConversations={onDeleteConversations}
          onOpenConversation={vi.fn()}
        />
      </TooltipProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Delete all' }));
    const dialog = await screen.findByText('Delete all chats');
    fireEvent.click(within(dialog.parentElement!).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onDeleteConversations).toHaveBeenCalledWith(['chat-1'], ['chat-1']));
    expect(removeMany).not.toHaveBeenCalled();
    expect(onNewConversation).not.toHaveBeenCalled();
  });

  it('keeps a selected chat selected when its delegated deletion fails', async () => {
    installDeletedChatBridge();
    const onDeleteConversation = vi.fn(async () => ({ ok: false, error: 'delete-failed' as const }));
    render(
      <TooltipProvider>
        <ChatsListPage
          activeConversationId="chat-1"
          onNewConversation={vi.fn()}
          onDeleteConversation={onDeleteConversation}
          onDeleteConversations={vi.fn(async () => ({ ok: true, deleted: 0, removedIds: [] }))}
          onOpenConversation={vi.fn()}
        />
      </TooltipProvider>,
    );

    const title = await screen.findByText('Active chat');
    const row = title.closest('[role="button"]')!;
    fireEvent.click(row.previousElementSibling!);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onDeleteConversation).toHaveBeenCalledWith('chat-1', ['chat-1']));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('keeps rejected archive selections and rename UI pending', async () => {
    const put = vi.fn(async () => ({ rejected: 'native-browser-authority-required' }));
    installAppBridgeStub({
      conversations: {
        list: async () => [activeChat],
        get: async () => activeChat,
        put,
      },
    });
    render(
      <TooltipProvider>
        <ChatsListPage
          activeConversationId="chat-1"
          onNewConversation={vi.fn()}
          onDeleteConversation={vi.fn()}
          onDeleteConversations={vi.fn()}
          onOpenConversation={vi.fn()}
        />
      </TooltipProvider>,
    );

    const title = await screen.findByText('Active chat');
    const row = title.closest('[role="button"]')!;
    fireEvent.click(row.previousElementSibling!);
    const selectionToolbar = screen.getByText('1 selected').parentElement!;
    fireEvent.click(within(selectionToolbar).getAllByRole('button')[1]);
    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ archived: true })));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const input = screen.getByDisplayValue('Active chat');
    fireEvent.change(input, { target: { value: 'Rejected rename' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ title: 'Rejected rename' })));
    expect(screen.getByDisplayValue('Rejected rename')).toBeInTheDocument();
  });
});
