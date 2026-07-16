/**
 * Component test — AlertCard "View conversation" deep-link.
 *
 * An alert is raised from a conversation; clicking "View conversation" must
 * invoke onOpenConversation with that alert's conversationId so the app can
 * switch to the originating chat. The link only appears when a handler is
 * provided AND the alert carries a conversationId.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AlertCard } from '../AlertCard';
import type { Alert } from '@/lib/ipc-client';

const baseAlert: Alert = {
  id: 'a1',
  kind: 'fyi',
  status: 'open',
  title: 'Something happened',
  body: 'details',
  conversationId: 'conv-42',
  createdAt: new Date().toISOString(),
} as unknown as Alert;

describe('AlertCard deep-link to conversation', () => {
  it('calls onOpenConversation with the alert conversationId when clicked', () => {
    const onOpenConversation = vi.fn();
    render(<AlertCard alert={baseAlert} onOpenConversation={onOpenConversation} />);
    fireEvent.click(screen.getByText('View conversation'));
    expect(onOpenConversation).toHaveBeenCalledWith('conv-42');
  });

  it('hides the link when no handler is provided', () => {
    render(<AlertCard alert={baseAlert} />);
    expect(screen.queryByText('View conversation')).toBeNull();
  });

  it('hides the link when the alert has no conversationId', () => {
    const onOpenConversation = vi.fn();
    render(<AlertCard alert={{ ...baseAlert, conversationId: '' }} onOpenConversation={onOpenConversation} />);
    expect(screen.queryByText('View conversation')).toBeNull();
  });
});
