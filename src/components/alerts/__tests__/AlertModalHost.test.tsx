/**
 * Component test — AlertModalHost surface-suppression gating.
 *
 * A modal-surface alert must show UNLESS the user can already see the alert's
 * own inline card. The main process sets `suppressSurface` when the GUI is
 * focused, but focus alone isn't enough — if the user is on Settings, the
 * Alerts tab, or a DIFFERENT conversation, the inline card isn't visible and
 * the modal is the only signal, so it must still open. Suppress only when the
 * alert's originating conversation is the one currently displayed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { Alert, AlertsChangedPayload } from '@/lib/ipc-client';

// Capture the onChanged handler so tests can drive alert events.
let changedHandler: ((p: AlertsChangedPayload) => void) | null = null;
vi.mock('@/lib/ipc-client', () => ({
  app: {
    alerts: {
      onChanged: (cb: (p: AlertsChangedPayload) => void) => {
        changedHandler = cb;
        return () => {
          changedHandler = null;
        };
      },
    },
  },
}));

// Force the modal surface on.
vi.mock('@/providers/ConfigProvider', () => ({
  useConfig: () => ({ config: { automations: { alertSurface: 'modal' } } }),
}));

// Sub-agent view state — default: no sub-agent overlaid. Overridable per test.
let mockSubAgentView: string | null = null;
vi.mock('@/providers/RuntimeProvider', () => ({
  useSubAgents: () => ({ activeSubAgentView: mockSubAgentView }),
}));

import { AlertModalHost } from '../AlertModalHost';

const alert: Alert = {
  id: 'a1',
  kind: 'question',
  status: 'open',
  title: 'Needs a decision',
  body: 'body',
  conversationId: 'conv-1',
  createdAt: new Date().toISOString(),
} as unknown as Alert;

function emit(payload: Partial<AlertsChangedPayload>): void {
  act(() => {
    changedHandler?.({ reason: 'created', alert, ...payload } as AlertsChangedPayload);
  });
}

describe('AlertModalHost surface suppression', () => {
  beforeEach(() => {
    changedHandler = null;
    mockSubAgentView = null;
  });

  it('shows the modal when the user is NOT present (no suppressSurface)', () => {
    render(<AlertModalHost activeConversationId="conv-1" chatViewActive threadMode="chat" />);
    emit({ suppressSurface: false });
    expect(screen.getByText('Needs your input')).toBeTruthy();
  });

  it('suppresses the modal when present AND the alert’s transcript is visible', () => {
    render(<AlertModalHost activeConversationId="conv-1" chatViewActive threadMode="chat" />);
    emit({ suppressSurface: true });
    expect(screen.queryByText('Needs your input')).toBeNull();
  });

  it('suppresses the modal when present on the Alerts view (card shown there)', () => {
    render(<AlertModalHost activeConversationId="conv-2" chatViewActive={false} alertsViewActive />);
    emit({ suppressSurface: true });
    expect(screen.queryByText('Needs your input')).toBeNull();
  });

  it('still shows the modal when present but viewing a DIFFERENT conversation', () => {
    render(<AlertModalHost activeConversationId="conv-2" chatViewActive threadMode="chat" />);
    emit({ suppressSurface: true });
    expect(screen.getByText('Needs your input')).toBeTruthy();
  });

  it('still shows the modal when present but on a non-chat view (e.g. Settings)', () => {
    render(<AlertModalHost activeConversationId="conv-1" chatViewActive={false} />);
    emit({ suppressSurface: true });
    expect(screen.getByText('Needs your input')).toBeTruthy();
  });

  it('still shows the modal in Computer mode (transcript hidden despite chat view)', () => {
    render(<AlertModalHost activeConversationId="conv-1" chatViewActive threadMode="computer" />);
    emit({ suppressSurface: true });
    expect(screen.getByText('Needs your input')).toBeTruthy();
  });

  it('still shows the modal when a sub-agent view is overlaid on the chat', () => {
    mockSubAgentView = 'sub-1';
    render(<AlertModalHost activeConversationId="conv-1" chatViewActive threadMode="chat" />);
    emit({ suppressSurface: true });
    expect(screen.getByText('Needs your input')).toBeTruthy();
  });

  it('never shows a modal for an fyi', () => {
    render(<AlertModalHost activeConversationId="conv-2" chatViewActive={false} />);
    emit({ suppressSurface: false, alert: { ...alert, kind: 'fyi' } as Alert });
    expect(screen.queryByText('Needs your input')).toBeNull();
  });
});
