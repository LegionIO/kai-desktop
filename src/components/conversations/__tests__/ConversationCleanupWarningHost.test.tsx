import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationCleanupWarningHost } from '../ConversationCleanupWarningHost';
import { surfaceConversationCleanupWarnings } from '@/lib/conversation-delete-warnings';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import type { BrowserEvent } from '../../../../shared/browser';

afterEach(() => uninstallAppBridgeStub());

describe('ConversationCleanupWarningHost', () => {
  it('visibly reports and deduplicates browser cleanup failures', () => {
    render(<ConversationCleanupWarningHost />);

    let surfaced = false;
    act(() => {
      surfaced = surfaceConversationCleanupWarnings({
        warnings: [
          {
            code: 'browser-cleanup-failed',
            conversationIds: ['chat-1', 'chat-1'],
            browserScopeKeys: ['conversation-aaaaaaaaaaaaaaaaaaaaaaaa'],
          },
          {
            code: 'browser-cleanup-failed',
            conversationIds: ['chat-2'],
            browserScopeKeys: ['conversation-bbbbbbbbbbbbbbbbbbbbbbbb'],
          },
        ],
      });
    });
    expect(surfaced).toBe(true);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('2 chats were deleted');
    expect(alert).toHaveTextContent('conversation-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(alert).toHaveTextContent('conversation-bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(alert).toHaveClass('max-h-[calc(100vh-2.5rem)]', 'overflow-hidden');
    expect(alert.querySelector('.overflow-y-auto')).toHaveClass('max-h-40');
    fireEvent.click(screen.getByLabelText('Dismiss browser cleanup warning'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not surface a warning for a clean deletion', () => {
    render(<ConversationCleanupWarningHost />);
    expect(surfaceConversationCleanupWarnings({})).toBe(false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('removes only scope keys that are successfully cleared later', () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<ConversationCleanupWarningHost />);
    act(() => {
      surfaceConversationCleanupWarnings({
        warnings: [
          {
            code: 'browser-cleanup-failed',
            conversationIds: ['chat-1', 'chat-2'],
            browserScopeKeys: ['conversation-aaaaaaaaaaaaaaaaaaaaaaaa', 'conversation-bbbbbbbbbbbbbbbbbbbbbbbb'],
          },
        ],
      });
    });

    act(() => {
      emit?.({
        type: 'profile-data-cleared',
        conversationId: 'chat-1',
        scopeKeys: ['conversation-aaaaaaaaaaaaaaaaaaaaaaaa'],
      });
    });
    expect(screen.getByRole('alert')).not.toHaveTextContent('conversation-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(screen.getByRole('alert')).toHaveTextContent('conversation-bbbbbbbbbbbbbbbbbbbbbbbb');

    act(() => {
      emit?.({
        type: 'profile-data-cleared',
        conversationId: 'chat-2',
        scopeKeys: ['conversation-bbbbbbbbbbbbbbbbbbbbbbbb'],
      });
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
