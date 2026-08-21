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
const getToolApprovalPrivateDetails = vi.fn();
beforeEach(() => {
  requestCb = null;
  getToolApprovalPrivateDetails.mockReset().mockResolvedValue(null);
  (window as unknown as { app: unknown }).app = {
    notification: {
      onRequest: (cb: (item: unknown) => void) => {
        requestCb = cb;
        return () => {};
      },
      get: vi.fn().mockResolvedValue(null),
      close: vi.fn(),
      reportSize: vi.fn(),
    },
    agent: {
      answerToolQuestion: vi.fn(),
      approveToolCall: vi.fn(),
      rejectToolCall: vi.fn(),
      getToolApprovalPrivateDetails,
    },
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

  it('shows redacted event details plus exact transient Browser input before approval', async () => {
    getToolApprovalPrivateDetails.mockResolvedValue({
      browserInput: { script: 'document.querySelector("button").click()' },
    });
    render(<NotificationShell id="browser-1" />);
    act(() => {
      requestCb?.({
        source: 'tool-approval',
        id: 'browser-1',
        conversationId: 'c1',
        toolName: 'browser_evaluate',
        args: {
          script: '[redacted browser script: 42 characters]',
          target: {
            tabId: '00000000-0000-0000-0000-000000000001',
            origin: 'https://example.com',
          },
          approvalKind: 'browser-control',
          reason: 'Run JavaScript in the current web page',
        },
      });
    });

    expect(screen.getByText('Run JavaScript in the current web page')).toBeInTheDocument();
    const details = screen.getByTestId('browser-approval-details');
    expect(details).toHaveTextContent('redacted browser script');
    expect(details).toHaveTextContent('https://example.com');
    expect(details).toHaveTextContent('00000000-0000-0000-0000-000000000001');
    expect(details).not.toHaveTextContent('approvalKind');
    const exactInput = await screen.findByTestId('browser-private-approval-input');
    expect(exactInput).toHaveTextContent('document.querySelector("button").click()');
    expect(getToolApprovalPrivateDetails).toHaveBeenCalledWith('browser-1', 'c1');
  });

  it('bounds cyclic and oversized Browser approval details in the notification renderer', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    render(<NotificationShell id="browser-bounded" />);
    act(() => {
      requestCb?.({
        source: 'tool-approval',
        id: 'browser-bounded',
        conversationId: 'c1',
        toolName: 'browser_evaluate',
        args: {
          approvalKind: 'browser-control',
          reason: 'Run a bounded operation',
          script: 'x'.repeat(50_000),
          cyclic,
        },
      });
    });

    const details = screen.getByTestId('browser-approval-details');
    expect(details.textContent?.length).toBeLessThanOrEqual(8_220);
    expect(details).toHaveTextContent(/truncated/i);
    expect(details).toHaveTextContent(/circular/i);
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
