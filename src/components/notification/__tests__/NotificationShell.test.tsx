/**
 * Component test — NotificationShell renders the right UI per item source.
 * The dedicated pop-out window handles any notification-tab item: an ask_user
 * tool-approval must show the QUESTION FORM (not generic approve/reject), and an
 * automation alert must show the AlertCard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { NotificationShell } from '../NotificationShell';

// Capture the notif:request callback so the test can push an item like main does.
let requestCb: ((item: unknown) => void) | null = null;
beforeEach(() => {
  requestCb = null;
  (window as unknown as { app: unknown }).app = {
    notification: {
      onRequest: (cb: (item: unknown) => void) => {
        requestCb = cb;
        return () => {};
      },
      close: vi.fn(),
    },
    agent: { answerToolQuestion: vi.fn(), approveToolCall: vi.fn(), rejectToolCall: vi.fn() },
    alerts: { answer: vi.fn(), decide: vi.fn(), dismiss: vi.fn() },
  };
});

describe('NotificationShell', () => {
  it('shows a loading state until the item arrives', () => {
    render(<NotificationShell id="x1" />);
    // No item yet → spinner, no question/approval text.
    expect(screen.queryByText(/Submit answer/i)).toBeNull();
  });

  it('renders the ask_user QUESTION FORM for a tool-approval item', () => {
    render(<NotificationShell id="ta1" />);
    act(() => {
      requestCb?.({
        source: 'tool-approval',
        id: 'ta1',
        conversationId: 'c1',
        toolName: 'ask_user',
        args: {
          questions: [{ question: 'Pick a color', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] }],
        },
      });
    });
    expect(screen.getByText('Pick a color')).toBeInTheDocument();
    expect(screen.getByText('Red')).toBeInTheDocument();
    // NOT the generic approve/reject shell.
    expect(screen.queryByText('Approval required')).toBeNull();
  });

  it('renders generic Approve/Reject for a non-ask_user tool-approval', () => {
    render(<NotificationShell id="pl1" />);
    act(() => {
      requestCb?.({ source: 'tool-approval', id: 'pl1', conversationId: 'c1', toolName: 'exit_plan_mode', args: {} });
    });
    expect(screen.getByText('Approval required')).toBeInTheDocument();
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Reject')).toBeInTheDocument();
  });

  it('renders the AlertCard for an alert item', () => {
    render(<NotificationShell id="al1" />);
    act(() => {
      requestCb?.({
        source: 'alert',
        id: 'al1',
        alert: {
          id: 'al1',
          kind: 'approval',
          status: 'open',
          title: 'Deploy?',
          body: 'Deploy to prod',
          approvalAction: 'deploy prod',
          conversationId: 'c2',
          createdAt: new Date().toISOString(),
        },
      });
    });
    expect(screen.getByText('Deploy?')).toBeInTheDocument();
    expect(screen.getByText('Approve')).toBeInTheDocument();
  });
});
