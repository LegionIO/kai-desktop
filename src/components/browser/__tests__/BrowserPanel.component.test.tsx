import { Suspense, startTransition, useLayoutEffect, useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import type {
  BrowserActionEvent,
  BrowserAuthPrompt,
  BrowserBookmark,
  BrowserCredentialPrompt,
  BrowserEvent,
  BrowserHistoryEntry,
  BrowserPermissionPrompt,
  BrowserSitePermission,
  BrowserTab,
} from '../../../../shared/browser';
import { SidePanelHost, SidePanelProvider, useSidePanel } from '@/components/side-panel';
import { TooltipProvider } from '@/components/ui/Tooltip';
import {
  BrowserPanel,
  BrowserPanelAutoOpen,
  clearBrowserSnapshotDeltas,
  retainBrowserSnapshotDelta,
} from '../BrowserPanel';
import { ConfigProvider } from '@/providers/ConfigProvider';

const tab: BrowserTab = {
  id: '00000000-0000-0000-0000-000000000001',
  conversationId: 'chat-1',
  owner: 'assistant',
  keepOpen: false,
  title: 'Example',
  url: 'https://example.com',
  loading: false,
  audible: false,
  muted: false,
  discarded: false,
  reloadRequired: false,
  active: true,
  canGoBack: true,
  canGoForward: false,
  zoomLevel: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  security: 'secure',
  sensitive: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openBrowserMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTitle('Browser menu'));
  return await screen.findByRole('menu', { name: 'Browser menu' });
}

afterEach(() => uninstallAppBridgeStub());
beforeEach(() => vi.clearAllMocks());

describe('BrowserPanel', () => {
  it('retains live snapshot deltas only for the lifetime of an active hydration', () => {
    const actions = new Map<string, BrowserActionEvent>();
    const action: BrowserActionEvent = {
      id: 'action-1',
      tabId: tab.id,
      kind: 'scroll',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      summary: 'scrolling',
    };

    retainBrowserSnapshotDelta(null, actions, action.id, action);
    expect(actions.size).toBe(0);

    retainBrowserSnapshotDelta(7, actions, action.id, action);
    expect(actions.get(action.id)).toBe(action);

    clearBrowserSnapshotDeltas(actions);
    expect(actions.size).toBe(0);
  });

  it('hydrates retained Browser prompts after a renderer reload without opening the hidden panel', async () => {
    installAppBridgeStub({
      browser: {
        getAttentionState: async () => [{ conversationId: 'chat-1', promptIds: ['retained-prompt'] }],
      },
    });
    const State = () => {
      const panel = useSidePanel();
      return <span>{`${panel.state}:${panel.activeTabId ?? 'none'}`}</span>;
    };
    render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-1" />
        <State />
      </SidePanelProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('The Browser needs attention.');
    expect(screen.getByText('minimized:none')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(await screen.findByText('open:browser')).toBeInTheDocument();
  });

  it('keeps an assistant-triggered prompt in the background until the user opens it', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    const State = () => {
      const panel = useSidePanel();
      return <span>{`${panel.state}:${panel.activeTabId ?? 'none'}`}</span>;
    };
    render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-1" />
        <State />
      </SidePanelProvider>,
    );

    act(() => {
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'assistant-prompt',
          tabId: tab.id,
          origin: 'https://example.com',
          permission: 'camera',
          assistantTriggered: true,
        },
      });
    });

    expect(screen.getByRole('alert')).toHaveTextContent('The Browser needs attention.');
    expect(screen.getByText('minimized:none')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(await screen.findByText('open:browser')).toBeInTheDocument();
  });

  it('clears passive Browser attention when the user opens the panel directly', () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    const Controls = () => {
      const panel = useSidePanel();
      return (
        <>
          <span>{`${panel.state}:${panel.activeTabId ?? 'none'}`}</span>
          <button type="button" onClick={() => panel.openPanel('browser')}>
            Open Browser directly
          </button>
          <button type="button" onClick={panel.minimizePanel}>
            Collapse Browser directly
          </button>
        </>
      );
    };
    render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-1" />
        <Controls />
      </SidePanelProvider>,
    );

    act(() => emit?.({ type: 'open-panel', conversationId: 'chat-1', tabId: tab.id }));
    expect(screen.getByRole('alert')).toHaveTextContent('The Browser needs attention.');

    fireEvent.click(screen.getByText('Open Browser directly'));
    expect(screen.getByText('open:browser')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Collapse Browser directly'));
    expect(screen.getByText('minimized:browser')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not restart retained-prompt hydration for unrelated Browser activity', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const retained = deferred<Array<{ conversationId: string; promptIds: string[] }>>();
    const getAttentionState = vi.fn(() => retained.promise);
    installAppBridgeStub({
      browser: {
        getAttentionState,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-other" />
      </SidePanelProvider>,
    );
    await vi.waitFor(() => expect(getAttentionState).toHaveBeenCalledOnce());

    act(() => {
      emit?.({
        type: 'action',
        conversationId: 'chat-1',
        action: {
          id: 'action-1',
          tabId: tab.id,
          kind: 'scroll',
          status: 'running',
          startedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      emit?.({ type: 'download', conversationId: 'chat-1', download: { id: 'download-1' } as never });
    });
    retained.resolve([{ conversationId: 'chat-1', promptIds: ['retained-prompt'] }]);

    expect(await screen.findByRole('alert')).toHaveTextContent(/needs attention/i);
    expect(getAttentionState).toHaveBeenCalledOnce();
  });

  it('keeps all prompts attention-only and surfaces Browser work owned by another chat', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const setActiveId = vi.fn(async () => undefined);
    const onRevealChat = vi.fn();
    const onOpenConversation = vi.fn(async () => undefined);
    installAppBridgeStub({
      conversations: { setActiveId },
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    const State = () => {
      const panel = useSidePanel();
      return <span>{`${panel.state}:${panel.activeTabId ?? 'none'}`}</span>;
    };
    render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen
          conversationId="chat-1"
          onOpenConversation={onOpenConversation}
          onRevealChat={onRevealChat}
        />
        <State />
      </SidePanelProvider>,
    );

    act(() => {
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'prompt-1',
          tabId: tab.id,
          origin: 'https://example.com',
          permission: 'camera',
          assistantTriggered: false,
        },
      });
    });
    expect(screen.getByText('minimized:none')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/needs attention/i);

    act(() => {
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-1',
        promptId: 'prompt-1',
        promptKind: 'permission',
      });
    });

    act(() => {
      emit?.({
        type: 'open-panel',
        conversationId: 'chat-2',
        tabId: tab.id,
      });
    });
    expect(screen.getByRole('alert')).toHaveClass('left-5');
    expect(screen.getByRole('alert')).not.toHaveClass('right-5');
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => expect(onOpenConversation).toHaveBeenCalledWith('chat-2'));
    expect(setActiveId).not.toHaveBeenCalled();
    expect(onRevealChat).toHaveBeenCalledOnce();
  });

  it('retains an active prompt when the Browser panel is collapsed until the prompt is dismissed', () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    const Collapse = () => {
      const panel = useSidePanel();
      return <button onClick={panel.minimizePanel}>Collapse test panel</button>;
    };
    render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-1" />
        <Collapse />
      </SidePanelProvider>,
    );

    act(() => {
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'prompt-collapse',
          tabId: tab.id,
          origin: 'https://example.com',
          permission: 'camera',
          assistantTriggered: false,
        },
      });
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/needs attention/);

    fireEvent.click(screen.getByText('Collapse test panel'));
    expect(screen.getByRole('alert')).toHaveTextContent(/needs attention/);
    expect(screen.queryByLabelText('Dismiss Browser attention')).not.toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-1',
        promptId: 'prompt-collapse',
        promptKind: 'permission',
      });
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retains an active prompt when switching chats until the prompt is dismissed', () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    const { rerender } = render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-1" />
      </SidePanelProvider>,
    );

    act(() => {
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'prompt-switch',
          tabId: tab.id,
          origin: 'https://example.com',
          permission: 'camera',
          assistantTriggered: false,
        },
      });
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/needs attention/);

    rerender(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-2" />
      </SidePanelProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/needs attention/);

    act(() => {
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-1',
        promptId: 'prompt-switch',
        promptKind: 'permission',
      });
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps one attention listener and routes events with the latest chat props', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const onEvent = vi.fn((callback: (event: BrowserEvent) => void) => {
      emit = callback;
      return vi.fn();
    });
    installAppBridgeStub({ browser: { onEvent } });
    const State = () => {
      const panel = useSidePanel();
      return <span>{`${panel.state}:${panel.activeTabId ?? 'none'}`}</span>;
    };
    const rendered = render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-1" />
        <State />
      </SidePanelProvider>,
    );

    rendered.rerender(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-2" />
        <State />
      </SidePanelProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(onEvent).toHaveBeenCalledOnce();

    act(() => emit?.({ type: 'open-panel', conversationId: 'chat-1', tabId: tab.id }));
    expect(screen.getByRole('alert')).toHaveTextContent(/needs attention/i);
    expect(screen.getByText('minimized:none')).toBeInTheDocument();

    act(() => emit?.({ type: 'open-panel', conversationId: 'chat-2', tabId: tab.id }));
    expect(screen.getByText('minimized:none')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/needs attention/i);
  });

  it('routes Browser events with the committed chat while a later transition is suspended', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const attemptedChatSwitch = vi.fn();
    const suspended = new Promise<never>(() => undefined);
    installAppBridgeStub({
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    const State = () => {
      const panel = useSidePanel();
      return <span>{`${panel.state}:${panel.activeTabId ?? 'none'}`}</span>;
    };
    const SuspendedChat = ({ conversationId }: { conversationId: string }) => {
      if (conversationId === 'chat-2') {
        attemptedChatSwitch();
        throw suspended;
      }
      return null;
    };
    const Harness = () => {
      const [conversationId, setConversationId] = useState('chat-1');
      return (
        <>
          <button type="button" onClick={() => startTransition(() => setConversationId('chat-2'))}>
            Suspend chat switch
          </button>
          <BrowserPanelAutoOpen conversationId={conversationId} />
          <SuspendedChat conversationId={conversationId} />
        </>
      );
    };
    render(
      <SidePanelProvider>
        <Suspense fallback={<span>Loading chat</span>}>
          <Harness />
        </Suspense>
        <State />
      </SidePanelProvider>,
    );

    fireEvent.click(screen.getByText('Suspend chat switch'));
    await waitFor(() => expect(attemptedChatSwitch).toHaveBeenCalled());
    expect(screen.getByText('minimized:none')).toBeInTheDocument();

    act(() => emit?.({ type: 'open-panel', conversationId: 'chat-1', tabId: tab.id }));

    expect(screen.getByText('minimized:none')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/needs attention/i);
  });

  it('keeps cross-chat Browser attention when opening that chat fails', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const onRevealChat = vi.fn();
    const onOpenConversation = vi.fn().mockRejectedValue(new Error('Chat no longer exists'));
    installAppBridgeStub({
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen
          conversationId="chat-1"
          onOpenConversation={onOpenConversation}
          onRevealChat={onRevealChat}
        />
      </SidePanelProvider>,
    );

    act(() => emit?.({ type: 'open-panel', conversationId: 'chat-2', tabId: tab.id }));
    fireEvent.click(screen.getByText('Open'));

    await waitFor(() => expect(onOpenConversation).toHaveBeenCalledWith('chat-2'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(onRevealChat).not.toHaveBeenCalled();
  });

  it('keeps cross-chat Browser attention when conversation selection is superseded', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const onRevealChat = vi.fn();
    const onOpenConversation = vi.fn(async () => false);
    installAppBridgeStub({
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen
          conversationId="chat-1"
          onOpenConversation={onOpenConversation}
          onRevealChat={onRevealChat}
        />
      </SidePanelProvider>,
    );

    act(() => emit?.({ type: 'open-panel', conversationId: 'chat-2', tabId: tab.id }));
    fireEvent.click(screen.getByText('Open'));

    await waitFor(() => expect(onOpenConversation).toHaveBeenCalledWith('chat-2'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(onRevealChat).not.toHaveBeenCalled();
  });

  it('keeps attention visible until every pending prompt for that chat is dismissed', () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-1" chatViewActive={false} />
      </SidePanelProvider>,
    );

    act(() => {
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'prompt-1',
          tabId: tab.id,
          origin: 'https://one.example',
          permission: 'camera',
          assistantTriggered: false,
        },
      });
      emit?.({
        type: 'credential-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'prompt-2',
          tabId: tab.id,
          origin: 'https://two.example',
          username: 'alice',
          update: false,
        },
      });
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-1',
        promptId: 'prompt-1',
        promptKind: 'permission',
      });
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-1',
        promptId: 'prompt-2',
        promptKind: 'credential',
      });
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reconciles cross-chat attention when temporary Browser tabs are cleaned up', () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-1" />
      </SidePanelProvider>,
    );
    const secondTabId = '00000000-0000-0000-0000-000000000002';

    act(() => {
      emit?.({ type: 'open-panel', conversationId: 'chat-2', tabId: tab.id });
      emit?.({
        type: 'open-panel',
        conversationId: 'chat-2',
        tabId: secondTabId,
      });
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'tabs-changed',
        conversationId: 'chat-2',
        tabs: [{ ...tab, id: secondTabId, conversationId: 'chat-2' }],
      });
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    act(() => emit?.({ type: 'tabs-changed', conversationId: 'chat-2', tabs: [] }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps cross-chat attention after tab cleanup while a prompt is still pending', () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-1" />
      </SidePanelProvider>,
    );

    act(() => {
      emit?.({ type: 'open-panel', conversationId: 'chat-2', tabId: tab.id });
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-2',
        prompt: {
          id: 'prompt-after-cleanup',
          tabId: tab.id,
          origin: 'https://example.com',
          permission: 'camera',
          assistantTriggered: false,
        },
      });
      emit?.({ type: 'tabs-changed', conversationId: 'chat-2', tabs: [] });
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-2',
        promptId: 'prompt-after-cleanup',
        promptKind: 'permission',
      });
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps queued attention minimized until the user opens it', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    const State = () => {
      const panel = useSidePanel();
      return <span>{`${panel.state}:${panel.activeTabId ?? 'none'}`}</span>;
    };
    const { rerender } = render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-1" chatViewActive={false} />
        <State />
      </SidePanelProvider>,
    );

    act(() => {
      emit?.({ type: 'open-panel', conversationId: 'chat-2', tabId: tab.id });
      emit?.({ type: 'open-panel', conversationId: 'chat-1', tabId: tab.id });
    });
    expect(screen.getByText('minimized:none')).toBeInTheDocument();

    rerender(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-1" chatViewActive />
        <State />
      </SidePanelProvider>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('minimized:none')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => expect(screen.getByText('open:browser')).toBeInTheDocument());
  });

  it('surfaces same-chat prompts while another app view hides the browser surface', () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(
      <SidePanelProvider>
        <BrowserPanelAutoOpen conversationId="chat-1" chatViewActive={false} />
      </SidePanelProvider>,
    );

    act(() => {
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'prompt-1',
          tabId: tab.id,
          origin: 'https://example.com',
          permission: 'camera',
          assistantTriggered: false,
        },
      });
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/needs attention/);
  });

  it('shows a desktop-only unavailable state when the native bridge is absent', async () => {
    installAppBridgeStub({ browser: { available: async () => false } });
    render(<BrowserPanel conversationId="chat-1" />);
    expect(await screen.findByText('Desktop browser unavailable')).toBeInTheDocument();
  });

  it('shows disabled before native availability and refreshes availability when re-enabled', async () => {
    let enabled = false;
    let nativeAvailable = false;
    let configChanged: (() => void) | undefined;
    const available = vi.fn(async () => nativeAvailable);
    installAppBridgeStub({
      config: {
        get: async () => ({ browser: { enabled } }),
        onChanged: (callback: () => void) => {
          configChanged = callback;
          return vi.fn();
        },
      },
      browser: {
        available,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(
      <ConfigProvider>
        <BrowserPanel conversationId="chat-1" />
      </ConfigProvider>,
    );

    expect(await screen.findByText('Browser disabled')).toBeInTheDocument();
    expect(screen.queryByText('Desktop browser unavailable')).not.toBeInTheDocument();

    enabled = true;
    nativeAvailable = true;
    act(() => configChanged?.());
    expect(await screen.findByText('Example')).toBeInTheDocument();
    expect(available.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('retries a retained native tab when a queued Browser re-enable commits', async () => {
    let enabled = true;
    let nativeEnabled = true;
    let configChanged: (() => void) | undefined;
    let emit: ((event: BrowserEvent) => void) | undefined;
    const mount = vi.fn(async (_conversationId: string, bounds: unknown) => {
      if (bounds && !nativeEnabled) throw new Error('The in-app browser is disabled in Settings.');
    });
    const boundedMountCount = () => mount.mock.calls.filter(([, bounds]) => bounds !== null).length;
    installAppBridgeStub({
      config: {
        get: async () => ({ browser: { enabled, dataScope: 'global' } }),
        onChanged: (callback: () => void) => {
          configChanged = callback;
          return vi.fn();
        },
      },
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(
      <ConfigProvider>
        <BrowserPanel conversationId="chat-1" />
      </ConfigProvider>,
    );

    await screen.findByText('Example');
    await waitFor(() => expect(boundedMountCount()).toBe(1));

    enabled = false;
    nativeEnabled = false;
    await act(async () => {
      configChanged?.();
      await Promise.resolve();
    });
    expect(await screen.findByText('Browser disabled')).toBeInTheDocument();

    // Persistence reaches React before the manager's serialized profile queue
    // commits. The first bounds report is therefore rejected by native code.
    enabled = true;
    await act(async () => {
      configChanged?.();
      await Promise.resolve();
    });
    expect(await screen.findByText('The in-app browser is disabled in Settings.')).toBeInTheDocument();
    expect(boundedMountCount()).toBe(2);

    nativeEnabled = true;
    act(() => emit?.({ type: 'config-applied', enabled: true, dataScope: 'global' }));

    await waitFor(() => expect(boundedMountCount()).toBe(3));
    expect(screen.queryByText('The in-app browser is disabled in Settings.')).not.toBeInTheDocument();
  });

  it('renders full browser chrome and routes navigation/tab controls', async () => {
    const createTab = vi.fn().mockResolvedValue(tab);
    const commandTab = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn().mockResolvedValue(undefined);
    const mount = vi.fn().mockResolvedValue(undefined);
    const find = vi.fn().mockResolvedValue(undefined);
    const listHistory = vi.fn().mockResolvedValue([]);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        createTab,
        commandTab,
        navigate,
        mount,
        find,
        listBookmarks: async () => [],
        listHistory,
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    expect(await screen.findByText('Example')).toBeInTheDocument();
    const omnibox = screen.getByLabelText('Address and search bar');
    await waitFor(() => expect(omnibox).toHaveValue('https://example.com'));
    expect(screen.getByTitle('Back')).toBeEnabled();
    expect(screen.getByTitle('Forward')).toBeDisabled();

    fireEvent.click(screen.getByTitle('New tab (⌘/Ctrl+T)'));
    await waitFor(() =>
      expect(createTab).toHaveBeenCalledWith({
        conversationId: 'chat-1',
        url: undefined,
        owner: 'user',
      }),
    );

    fireEvent.change(screen.getByLabelText('Address and search bar'), {
      target: { value: 'openai.com' },
    });
    await waitFor(() => expect(listHistory).toHaveBeenCalledWith('chat-1', 'openai.com'));
    fireEvent.keyDown(screen.getByLabelText('Address and search bar'), {
      key: 'Enter',
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('chat-1', tab.id, 'openai.com'));

    fireEvent.click(screen.getByTitle('Back'));
    expect(commandTab).toHaveBeenCalledWith('chat-1', tab.id, 'back');

    fireEvent.keyDown(omnibox, { key: 'f', ctrlKey: true });
    const findInput = await screen.findByPlaceholderText('Find in page');
    expect(screen.getByTestId('browser-find-bar')).toHaveClass('flex-wrap');
    expect(findInput).toHaveClass('min-w-24', 'flex-1');
    fireEvent.change(findInput, { target: { value: 'needle' } });
    await waitFor(() => expect(find).toHaveBeenCalledWith('chat-1', tab.id, 'needle', true, false, expect.any(Number)));
    fireEvent.change(findInput, { target: { value: '' } });
    await waitFor(() => expect(find).toHaveBeenCalledWith('chat-1', tab.id, '', true, false, expect.any(Number)));
    expect(find.mock.calls[1][5]).toBeGreaterThan(find.mock.calls[0][5]);
    expect(screen.getByText('0/0')).toBeInTheDocument();
  });

  it('clears an omnibox navigation failure when the user retries', async () => {
    const retry = deferred<void>();
    const navigate = vi
      .fn()
      .mockRejectedValueOnce(new Error('First navigation failed'))
      .mockImplementationOnce(() => retry.promise);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        navigate,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText<HTMLInputElement>('Address and search bar');

    fireEvent.change(omnibox, { target: { value: 'first.example' } });
    fireEvent.keyDown(omnibox, { key: 'Enter' });
    expect(await screen.findByText(/First navigation failed/)).toBeInTheDocument();

    fireEvent.change(omnibox, { target: { value: 'retry.example' } });
    fireEvent.keyDown(omnibox, { key: 'Enter' });
    expect(screen.queryByText(/First navigation failed/)).not.toBeInTheDocument();

    await act(async () => retry.resolve());
  });

  it('ignores a stale omnibox failure after a newer navigation succeeds', async () => {
    const staleNavigation = deferred<void>();
    const navigate = vi
      .fn()
      .mockImplementationOnce(() => staleNavigation.promise)
      .mockResolvedValueOnce(undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        navigate,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText<HTMLInputElement>('Address and search bar');

    fireEvent.change(omnibox, { target: { value: 'slow.example' } });
    fireEvent.keyDown(omnibox, { key: 'Enter' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('chat-1', tab.id, 'slow.example'));

    fireEvent.change(omnibox, { target: { value: 'current.example' } });
    fireEvent.keyDown(omnibox, { key: 'Enter' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('chat-1', tab.id, 'current.example'));

    await act(async () => staleNavigation.reject(new Error('Stale navigation failed')));
    expect(screen.queryByText(/Stale navigation failed/)).not.toBeInTheDocument();
  });

  it('ignores a stale empty-state tab creation failure after a newer one succeeds', async () => {
    const staleCreation = deferred<BrowserTab>();
    const createTab = vi
      .fn()
      .mockImplementationOnce(() => staleCreation.promise)
      .mockResolvedValueOnce(tab);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [], activeTabId: null }),
        mount: async () => undefined,
        createTab,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText<HTMLInputElement>('Address and search bar');

    fireEvent.change(omnibox, { target: { value: 'slow.example' } });
    fireEvent.keyDown(omnibox, { key: 'Enter' });
    await waitFor(() => expect(createTab).toHaveBeenCalledTimes(1));

    fireEvent.change(omnibox, { target: { value: 'current.example' } });
    fireEvent.keyDown(omnibox, { key: 'Enter' });
    await waitFor(() => expect(createTab).toHaveBeenCalledTimes(2));

    await act(async () => staleCreation.reject(new Error('Stale tab creation failed')));
    expect(screen.queryByText(/Stale tab creation failed/)).not.toBeInTheDocument();
  });

  it('ignores a stale tab-command failure after a newer navigation starts', async () => {
    const staleCommand = deferred<void>();
    const commandTab = vi.fn(() => staleCommand.promise);
    const navigate = vi.fn().mockResolvedValue(undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        commandTab,
        navigate,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText<HTMLInputElement>('Address and search bar');

    fireEvent.click(screen.getByTitle('Back'));
    await waitFor(() => expect(commandTab).toHaveBeenCalledWith('chat-1', tab.id, 'back'));
    fireEvent.change(omnibox, { target: { value: 'current.example' } });
    fireEvent.keyDown(omnibox, { key: 'Enter' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('chat-1', tab.id, 'current.example'));

    await act(async () => staleCommand.reject(new Error('Stale command failed')));
    expect(screen.queryByText(/Stale command failed/)).not.toBeInTheDocument();
  });

  it('does not let a stale blank-tab completion steal omnibox focus', async () => {
    const pendingCreation = deferred<BrowserTab>();
    const createTab = vi.fn(() => pendingCreation.promise);
    const commandTab = vi.fn().mockResolvedValue(undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        createTab,
        commandTab,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText<HTMLInputElement>('Address and search bar');

    fireEvent.click(screen.getByTitle('New tab (⌘/Ctrl+T)'));
    await waitFor(() => expect(createTab).toHaveBeenCalledTimes(1));
    const back = screen.getByTitle('Back');
    back.focus();
    fireEvent.click(back);
    await waitFor(() => expect(commandTab).toHaveBeenCalledWith('chat-1', tab.id, 'back'));

    await act(async () => pendingCreation.resolve(tab));
    expect(back).toHaveFocus();
    expect(omnibox).not.toHaveFocus();
  });

  it('detaches a script-evaluated page behind a reload-required interstitial', async () => {
    const mount = vi.fn().mockResolvedValue(undefined);
    const commandTab = vi.fn().mockResolvedValue(undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [{ ...tab, reloadRequired: true }],
          activeTabId: tab.id,
        }),
        mount,
        commandTab,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);

    expect(await screen.findByText('Reload required')).toBeInTheDocument();
    expect(screen.getByText(/Kai ran JavaScript/)).toBeInTheDocument();
    await waitFor(() => expect(mount).toHaveBeenCalledWith('chat-1', null));

    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    expect(commandTab).toHaveBeenCalledWith('chat-1', tab.id, 'reload');

    fireEvent.click(screen.getByRole('button', { name: 'Enter another URL' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Address and search bar' })).toHaveFocus());
  });

  it('selects omnibox suggestions with arrows and dismisses them with Escape', async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    const listHistory = vi.fn().mockResolvedValue([
      {
        id: 'history-1',
        scopeKey: 'global',
        title: 'History result',
        url: 'https://history.example/result',
        visitedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        navigate,
        listBookmarks: async () => [],
        listHistory,
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText<HTMLInputElement>('Address and search bar');
    await waitFor(() => expect(omnibox).toHaveValue(tab.url));

    fireEvent.focus(omnibox);
    fireEvent.change(omnibox, { target: { value: 'history' } });
    const option = await screen.findByRole('option', {
      name: /History result/,
    });
    expect(option).toHaveAttribute('aria-selected', 'false');
    fireEvent.keyDown(omnibox, { key: 'ArrowDown' });
    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(omnibox).toHaveAttribute('aria-activedescendant', option.id);
    fireEvent.keyDown(omnibox, { key: 'Enter' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('chat-1', tab.id, 'https://history.example/result'));

    fireEvent.focus(omnibox);
    fireEvent.change(omnibox, { target: { value: 'again' } });
    await screen.findByRole('option', { name: /History result/ });
    fireEvent.keyDown(omnibox, { key: 'Escape' });
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(omnibox).toHaveFocus();
    fireEvent.keyDown(omnibox, { key: 'Escape' });
    expect(omnibox).toHaveValue(tab.url);
    expect(omnibox).not.toHaveFocus();
  });

  it('does not reopen omnibox suggestions when a lookup resolves after Escape', async () => {
    const pendingHistory = deferred<
      Array<{
        id: string;
        scopeKey: string;
        title: string;
        url: string;
        visitedAt: string;
      }>
    >();
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: vi.fn(() => pendingHistory.promise),
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText<HTMLInputElement>('Address and search bar');
    fireEvent.focus(omnibox);
    fireEvent.change(omnibox, { target: { value: 'delayed' } });
    fireEvent.keyDown(omnibox, { key: 'Escape' });

    await act(async () => {
      pendingHistory.resolve([
        {
          id: 'history-delayed',
          scopeKey: 'global',
          title: 'Delayed result',
          url: 'https://delayed.example',
          visitedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      await pendingHistory.promise;
    });

    expect(screen.queryByRole('option', { name: /Delayed result/ })).not.toBeInTheDocument();
  });

  it('ignores delayed find results from a tab that is no longer active', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const find = vi.fn().mockResolvedValue(undefined);
    const stopFind = vi.fn().mockResolvedValue(undefined);
    const second = {
      ...tab,
      id: '00000000-0000-0000-0000-000000000002',
      title: 'Second',
      active: false,
    };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab, second],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        find,
        stopFind,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText('Address and search bar');
    fireEvent.keyDown(omnibox, { key: 'f', ctrlKey: true });
    const findInput = await screen.findByPlaceholderText('Find in page');
    fireEvent.change(findInput, {
      target: { value: 'needle' },
    });
    await waitFor(() => expect(find).toHaveBeenCalledWith('chat-1', tab.id, 'needle', true, false, expect.any(Number)));
    const firstRequestId = find.mock.calls.at(-1)?.[5] as number;

    act(() => {
      emit?.({
        type: 'find-result',
        conversationId: 'chat-1',
        tabId: tab.id,
        result: { requestId: firstRequestId, activeMatchOrdinal: 1, matches: 3, finalUpdate: true },
      });
    });
    expect(screen.getByText('1/3')).toBeInTheDocument();

    fireEvent.change(findInput, { target: { value: 'newer needle' } });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    const secondRequestId = find.mock.calls.at(-1)?.[5] as number;
    act(() => {
      emit?.({
        type: 'find-result',
        conversationId: 'chat-1',
        tabId: tab.id,
        result: { requestId: secondRequestId, activeMatchOrdinal: 1, matches: 5, finalUpdate: true },
      });
      emit?.({
        type: 'find-result',
        conversationId: 'chat-1',
        tabId: tab.id,
        result: { requestId: firstRequestId, activeMatchOrdinal: 2, matches: 9, finalUpdate: true },
      });
    });
    expect(screen.getByText('1/5')).toBeInTheDocument();
    expect(screen.queryByText('2/9')).not.toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'tabs-changed',
        conversationId: 'chat-1',
        tabs: [
          { ...tab, active: false },
          { ...second, active: true },
        ],
      });
    });
    await waitFor(() => expect(screen.getByText('0/0')).toBeInTheDocument());
    await waitFor(() => expect(stopFind).toHaveBeenCalledWith('chat-1', tab.id));

    act(() => {
      emit?.({
        type: 'find-result',
        conversationId: 'chat-1',
        tabId: tab.id,
        result: { requestId: secondRequestId, activeMatchOrdinal: 2, matches: 9, finalUpdate: true },
      });
    });
    expect(screen.queryByText('2/9')).not.toBeInTheDocument();
    expect(screen.getByText('0/0')).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'find-result',
        conversationId: 'chat-1',
        tabId: second.id,
        result: { requestId: secondRequestId + 1, activeMatchOrdinal: 1, matches: 2, finalUpdate: true },
      });
    });
    expect(screen.queryByText('1/2')).not.toBeInTheDocument();
    expect(screen.getByText('0/0')).toBeInTheDocument();

    fireEvent.keyDown(findInput, { key: 'Enter' });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(3));
    const thirdRequestId = find.mock.calls.at(-1)?.[5] as number;
    act(() => {
      emit?.({
        type: 'find-result',
        conversationId: 'chat-1',
        tabId: second.id,
        result: { requestId: thirdRequestId, activeMatchOrdinal: 1, matches: 2, finalUpdate: true },
      });
    });
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('ignores superseded find rejections from typed searches and Browser shortcuts', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const requests: Array<ReturnType<typeof deferred<void>>> = [];
    const find = vi.fn(() => {
      const request = deferred<void>();
      requests.push(request);
      return request.promise;
    });
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        find,
        stopFind: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText('Address and search bar');
    fireEvent.keyDown(omnibox, { key: 'f', ctrlKey: true });
    const findInput = await screen.findByPlaceholderText('Find in page');

    fireEvent.change(findInput, { target: { value: 'first' } });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    fireEvent.change(findInput, { target: { value: 'second' } });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    await act(async () => requests[0]!.reject(new Error('Stale typed find failed')));
    expect(screen.queryByText('Stale typed find failed')).not.toBeInTheDocument();
    requests[1]!.resolve();

    act(() => emit?.({ type: 'shortcut', conversationId: 'chat-1', action: 'find-next' }));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(3));
    act(() => emit?.({ type: 'shortcut', conversationId: 'chat-1', action: 'find-next' }));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(4));
    await act(async () => requests[2]!.reject(new Error('Stale shortcut find failed')));
    expect(screen.queryByText('Stale shortcut find failed')).not.toBeInTheDocument();

    await act(async () => requests[3]!.reject(new Error('Current shortcut find failed')));
    expect(await screen.findByText('Current shortcut find failed')).toBeInTheDocument();
  });

  it('dismisses browser, site, and tab menus outside the popover or with Escape', async () => {
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const tabControl = await screen.findByRole('tab', { name: 'Example' });

    await openBrowserMenu();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    const siteInfoTrigger = screen.getByTitle('Site information');
    fireEvent.click(siteInfoTrigger);
    const siteDialog = screen.getByRole('dialog', { name: 'Site information' });
    expect(siteDialog).toBeInTheDocument();
    await waitFor(() => expect(siteDialog).toHaveFocus());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Site information' })).not.toBeInTheDocument();
    await waitFor(() => expect(siteInfoTrigger).toHaveFocus());

    fireEvent.contextMenu(tabControl, { clientX: 20, clientY: 30 });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps a protected viewport frame visible while the Browser menu covers the native page', async () => {
    const mount = vi.fn(async (_conversationId: string, _bounds: unknown) => undefined);
    const pendingCapture = deferred<{
      tabId: string;
      mode: 'viewport';
      mimeType: 'image/png';
      dataUrl: string;
      width: number;
      height: number;
    }>();
    const screenshot = vi.fn(() => pendingCapture.promise);
    const capture = {
      tabId: tab.id,
      mode: 'viewport' as const,
      mimeType: 'image/png' as const,
      dataUrl: 'data:image/png;base64,AAAA',
      width: 400,
      height: 300,
    };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount,
        captureMenuPreview: screenshot,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');

    const detachedBeforeClick = mount.mock.calls.filter(([, bounds]) => bounds === null).length;
    fireEvent.click(screen.getByTitle('Browser menu'));

    expect(screen.queryByRole('menu', { name: 'Browser menu' })).not.toBeInTheDocument();
    expect(mount.mock.calls.filter(([, bounds]) => bounds === null)).toHaveLength(detachedBeforeClick);
    await act(async () => pendingCapture.resolve(capture));

    expect(screen.getByRole('menu', { name: 'Browser menu' })).toBeInTheDocument();
    const preview = screen.getByTestId('browser-menu-page-preview');
    await waitFor(() => expect(preview.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,AAAA'));
    expect(screenshot).toHaveBeenCalledWith('chat-1', tab.id, expect.any(String));
    await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', null));

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('browser-menu-page-preview')).not.toBeInTheDocument();
  });

  it.each(['Escape', 'outside pointer'] as const)(
    'cancels a pending menu preview on %s without reopening after capture resolves',
    async (dismissal) => {
      const cancelMenuPreview = vi.fn(async () => undefined);
      const pendingCapture = deferred<{
        tabId: string;
        mode: 'viewport';
        mimeType: 'image/png';
        dataUrl: string;
        width: number;
        height: number;
      }>();
      installAppBridgeStub({
        browser: {
          available: async () => true,
          getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
          mount: async () => undefined,
          captureMenuPreview: () => pendingCapture.promise,
          cancelMenuPreview,
          listBookmarks: async () => [],
          listHistory: async () => [],
        },
      });
      render(<BrowserPanel conversationId="chat-1" />);
      await screen.findByText('Example');

      fireEvent.click(screen.getByTitle('Browser menu'));
      expect(screen.queryByRole('menu', { name: 'Browser menu' })).not.toBeInTheDocument();
      if (dismissal === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
      else fireEvent.pointerDown(document.body);
      await waitFor(() => expect(cancelMenuPreview).toHaveBeenCalledWith(expect.any(String)));
      await act(async () =>
        pendingCapture.resolve({
          tabId: tab.id,
          mode: 'viewport',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,CANCELLED',
          width: 400,
          height: 300,
        }),
      );

      expect(screen.queryByRole('menu', { name: 'Browser menu' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('browser-menu-page-preview')).not.toBeInTheDocument();
    },
  );

  it('keeps the native page mounted while bounded menu-preview capture is delayed', async () => {
    const mount = vi.fn(async (_conversationId: string, _bounds: unknown) => undefined);
    const pendingCapture = deferred<{
      tabId: string;
      mode: 'viewport';
      mimeType: 'image/png';
      dataUrl: string;
      width: number;
      height: number;
    }>();
    const screenshot = vi.fn(() => pendingCapture.promise);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount,
        captureMenuPreview: screenshot,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');

    const detachedBeforeClick = mount.mock.calls.filter(([, bounds]) => bounds === null).length;
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTitle('Browser menu'));
      expect(screen.queryByRole('menu', { name: 'Browser menu' })).not.toBeInTheDocument();
      await act(async () => vi.advanceTimersByTimeAsync(1_100));
      expect(screen.queryByRole('menu', { name: 'Browser menu' })).not.toBeInTheDocument();
      expect(mount.mock.calls.filter(([, bounds]) => bounds === null)).toHaveLength(detachedBeforeClick);
      expect(screenshot).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }

    await act(async () =>
      pendingCapture.resolve({
        tabId: tab.id,
        mode: 'viewport',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,LATE',
        width: 400,
        height: 300,
      }),
    );
    expect(await screen.findByRole('menu', { name: 'Browser menu' })).toBeInTheDocument();
    expect(screen.getByTestId('browser-menu-page-preview').querySelector('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,LATE',
    );
    await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', null));
  });

  it('never captures a menu preview from a sensitive page', async () => {
    const screenshot = vi.fn();
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [{ ...tab, sensitive: true }],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        captureMenuPreview: screenshot,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');

    await openBrowserMenu();

    expect(screen.getByText('Sensitive page hidden while Browser controls are open.')).toBeInTheDocument();
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('waits for main to hide the native page before opening Browser chrome', async () => {
    const detached = deferred<void>();
    const mount = vi.fn(async (_conversationId: string, bounds: unknown) => {
      if (bounds === null) await detached.promise;
    });
    const screenshot = vi.fn();
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [{ ...tab, sensitive: true }],
          activeTabId: tab.id,
        }),
        mount,
        captureMenuPreview: screenshot,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');

    fireEvent.click(screen.getByTitle('Browser menu'));
    await waitFor(() => expect(mount).toHaveBeenCalledWith('chat-1', null));
    expect(screen.queryByRole('menu', { name: 'Browser menu' })).not.toBeInTheDocument();
    expect(screenshot).not.toHaveBeenCalled();

    await act(async () => detached.resolve());
    expect(await screen.findByRole('menu', { name: 'Browser menu' })).toBeInTheDocument();
    expect(screen.getByText('Sensitive page hidden while Browser controls are open.')).toBeInTheDocument();
  });

  it('cancels a sensitive-page menu while native detachment is still pending', async () => {
    const detached = deferred<void>();
    const mount = vi.fn(async (_conversationId: string, bounds: unknown) => {
      if (bounds === null) await detached.promise;
    });
    const captureMenuPreview = vi.fn();
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [{ ...tab, sensitive: true }],
          activeTabId: tab.id,
        }),
        mount,
        captureMenuPreview,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');

    fireEvent.click(screen.getByTitle('Browser menu'));
    await waitFor(() => expect(mount).toHaveBeenCalledWith('chat-1', null));
    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => detached.resolve());

    expect(screen.queryByRole('menu', { name: 'Browser menu' })).not.toBeInTheDocument();
    expect(captureMenuPreview).not.toHaveBeenCalled();
  });

  it('cancels a fallback menu while native detachment after capture failure is still pending', async () => {
    const detached = deferred<void>();
    const mount = vi.fn(async (_conversationId: string, bounds: unknown) => {
      if (bounds === null) await detached.promise;
    });
    const captureMenuPreview = vi.fn(async () => {
      throw new Error('capture failed');
    });
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount,
        captureMenuPreview,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');

    fireEvent.click(screen.getByTitle('Browser menu'));
    await waitFor(() => expect(captureMenuPreview).toHaveBeenCalledOnce());
    await waitFor(() => expect(mount).toHaveBeenCalledWith('chat-1', null));
    fireEvent.pointerDown(document.body);
    await act(async () => detached.resolve());

    expect(screen.queryByRole('menu', { name: 'Browser menu' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('browser-menu-page-preview')).not.toBeInTheDocument();
  });

  it('republishes current bounds when a dismissed menu detach completes late', async () => {
    const detached = deferred<void>();
    let delayDetach = false;
    const mount = vi.fn(async (_conversationId: string, bounds: unknown) => {
      if (delayDetach && bounds === null) await detached.promise;
    });
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount,
        captureMenuPreview: async () => ({
          tabId: tab.id,
          mode: 'viewport',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,CURRENT',
          width: 400,
          height: 300,
        }),
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await waitFor(() => expect(mount.mock.calls.some(([, bounds]) => bounds !== null)).toBe(true));

    delayDetach = true;
    fireEvent.click(screen.getByTitle('Browser menu'));
    await waitFor(() => expect(mount.mock.calls.some(([, bounds]) => bounds === null)).toBe(true));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Browser menu' })).not.toBeInTheDocument());
    const visibleMountsBeforeLateDetach = mount.mock.calls.filter(([, bounds]) => bounds !== null).length;

    await act(async () => detached.resolve());
    await waitFor(() =>
      expect(mount.mock.calls.filter(([, bounds]) => bounds !== null).length).toBeGreaterThan(
        visibleMountsBeforeLateDetach,
      ),
    );
    expect(mount).toHaveBeenLastCalledWith('chat-1', expect.objectContaining({ width: expect.any(Number) }));
  });

  it('ignores an old same-bounds mount rejection after a replacement mount succeeds', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const firstVisibleMount = deferred<void>();
    let visibleMounts = 0;
    const mount = vi.fn((_conversationId: string, bounds: unknown) => {
      if (bounds !== null && ++visibleMounts === 1) return firstVisibleMount.promise;
      return Promise.resolve();
    });
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await waitFor(() => expect(visibleMounts).toBe(1));

    act(() => emit?.({ type: 'profile-data-cleared', conversationId: 'chat-1', scopeKeys: ['global'] }));
    await waitFor(() => expect(visibleMounts).toBeGreaterThanOrEqual(2));
    await act(async () => firstVisibleMount.reject(new Error('Stale native mount failed')));

    expect(screen.queryByText('Stale native mount failed')).not.toBeInTheDocument();
    expect(mount).toHaveBeenLastCalledWith('chat-1', expect.objectContaining({ width: expect.any(Number) }));
  });

  it('does not open a menu with a preview captured for a superseded document', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const pendingCapture = deferred<{
      tabId: string;
      mode: 'viewport';
      mimeType: 'image/png';
      dataUrl: string;
      width: number;
      height: number;
    }>();
    const screenshot = vi.fn(() => pendingCapture.promise);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        captureMenuPreview: screenshot,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');

    fireEvent.click(screen.getByTitle('Browser menu'));
    await waitFor(() => expect(screenshot).toHaveBeenCalledOnce());
    act(() => {
      emit?.({
        type: 'tabs-changed',
        conversationId: 'chat-1',
        tabs: [
          {
            ...tab,
            title: 'Replacement',
            url: 'https://replacement.example',
            updatedAt: '2026-01-01T00:00:01.000Z',
          },
        ],
      });
    });
    await act(async () => {
      pendingCapture.resolve({
        tabId: tab.id,
        mode: 'viewport',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,STALE',
        width: 400,
        height: 300,
      });
    });

    expect(screen.queryByRole('menu', { name: 'Browser menu' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('browser-menu-page-preview')).not.toBeInTheDocument();
  });

  it('dismisses an open preview in the document-change layout commit', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        captureMenuPreview: async () => ({
          tabId: tab.id,
          mode: 'viewport',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,CURRENT',
          width: 400,
          height: 300,
        }),
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    expect(screen.getByTestId('browser-menu-page-preview')).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'tabs-changed',
        conversationId: 'chat-1',
        tabs: [
          {
            ...tab,
            title: 'Replacement',
            url: 'https://replacement.example',
            updatedAt: '2026-01-01T00:00:01.000Z',
          },
        ],
      });
    });

    expect(screen.queryByRole('menu', { name: 'Browser menu' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('browser-menu-page-preview')).not.toBeInTheDocument();
  });

  it('reviews and resets remembered permissions from Site information', async () => {
    const listSitePermissions = vi.fn(async () => [
      { origin: 'https://example.com', permission: 'media:audio', decision: 'allow' as const },
      { origin: 'https://example.com', permission: 'notifications', decision: 'deny' as const },
    ]);
    const resetSitePermissions = vi.fn(async () => undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listSitePermissions,
        resetSitePermissions,
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    fireEvent.click(screen.getByTitle('Site information'));

    expect(await screen.findByText('media:audio')).toBeInTheDocument();
    expect(screen.getByText('notifications')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Reset media:audio permission'));
    await waitFor(() =>
      expect(resetSitePermissions).toHaveBeenCalledWith('chat-1', 'https://example.com', 'media:audio'),
    );
    expect(screen.queryByText('media:audio')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Reset all'));
    await waitFor(() => expect(resetSitePermissions).toHaveBeenLastCalledWith('chat-1', 'https://example.com'));
  });

  it('shows the complete site origin with wrapping and left-to-right isolation', async () => {
    const origin = `https://${Array.from({ length: 3 }, () => 'lookalike'.repeat(6)).join('.')}.trusted.example`;
    const longUrlTab = { ...tab, url: `${origin}/private/path?token=not-for-site-info` };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [longUrlTab], activeTabId: longUrlTab.id }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listSitePermissions: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    fireEvent.click(screen.getByTitle('Site information'));

    const displayedOrigin = await screen.findByText(origin);
    expect(displayedOrigin).toHaveAttribute('dir', 'ltr');
    expect(displayedOrigin).toHaveClass('break-all');
    expect(displayedOrigin).not.toHaveClass('truncate');
    expect(screen.queryByText(/not-for-site-info/)).not.toBeInTheDocument();
  });

  it('clears and reloads Site information permissions after a profile-scope change', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    let profile: 'global' | 'conversation' = 'global';
    const listSitePermissions = vi.fn(async () =>
      profile === 'global'
        ? [{ origin: 'https://example.com', permission: 'media:audio', decision: 'allow' as const }]
        : [{ origin: 'https://example.com', permission: 'camera', decision: 'deny' as const }],
    );
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listSitePermissions,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    fireEvent.click(screen.getByTitle('Site information'));
    expect(await screen.findByText('media:audio')).toBeInTheDocument();

    profile = 'conversation';
    act(() => emit?.({ type: 'profile-scope-changed', dataScope: 'conversation' }));

    expect(screen.queryByText('media:audio')).not.toBeInTheDocument();
    expect(await screen.findByText('camera')).toBeInTheDocument();
    expect(listSitePermissions).toHaveBeenCalledTimes(2);
  });

  it.each([
    { control: 'Reset all', permission: undefined },
    { control: 'Reset media:audio permission', permission: 'media:audio' },
  ])('ignores a stale $control completion after the active origin changes', async ({ control, permission }) => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const pendingReset = deferred<void>();
    const secondTab: BrowserTab = {
      ...tab,
      id: '00000000-0000-0000-0000-000000000002',
      title: 'Second site',
      url: 'https://second.example/path',
      active: false,
    };
    const listSitePermissions = vi.fn(async (_conversationId: string, origin: string) =>
      origin === 'https://second.example'
        ? [{ origin, permission: 'camera', decision: 'allow' as const }]
        : [{ origin, permission: 'media:audio', decision: 'allow' as const }],
    );
    const resetSitePermissions = vi.fn(() => pendingReset.promise);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab, secondTab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listSitePermissions,
        resetSitePermissions,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    fireEvent.click(screen.getByTitle('Site information'));
    expect(await screen.findByText('media:audio')).toBeInTheDocument();

    fireEvent.click(permission ? screen.getByLabelText(control) : screen.getByText(control));
    await waitFor(() =>
      permission
        ? expect(resetSitePermissions).toHaveBeenCalledWith('chat-1', 'https://example.com', permission)
        : expect(resetSitePermissions).toHaveBeenCalledWith('chat-1', 'https://example.com'),
    );
    act(() => {
      emit?.({
        type: 'tabs-changed',
        conversationId: 'chat-1',
        tabs: [
          { ...tab, active: false },
          { ...secondTab, active: true },
        ],
      });
    });
    expect(await screen.findByText('camera')).toBeInTheDocument();

    await act(async () => {
      pendingReset.resolve();
      await pendingReset.promise;
    });
    expect(screen.getByText('camera')).toBeInTheDocument();
    expect(screen.queryByText('media:audio')).not.toBeInTheDocument();
  });

  it('binds an interactive component screenshot to the document that was picked', async () => {
    const pickElement = vi.fn(async () => ({
      selector: '#picked',
      documentToken: 'picked-document-token',
    }));
    const screenshot = vi.fn(async () => ({
      tabId: tab.id,
      mode: 'element' as const,
      mimeType: 'image/png' as const,
      width: 10,
      height: 10,
    }));
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        pickElement,
        screenshot,
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByRole('tab', { name: 'Example' });

    await openBrowserMenu();
    fireEvent.click(screen.getByText('Screenshot component'));

    await waitFor(() =>
      expect(screenshot).toHaveBeenCalledWith('chat-1', {
        tabId: tab.id,
        mode: 'element',
        selector: '#picked',
        documentToken: 'picked-document-token',
        exportToFile: true,
      }),
    );
    expect(pickElement).toHaveBeenCalledWith('chat-1', tab.id);
  });

  it.each([
    ['Screenshot viewport', 'viewport'],
    ['Screenshot component', 'element'],
  ] as const)('waits for the native page to remount before running %s from the Browser menu', async (label, mode) => {
    const visibleMount = deferred<void>();
    let holdVisibleMount = false;
    const mount = vi.fn(async (_conversationId: string, bounds: unknown) => {
      if (holdVisibleMount && bounds !== null) await visibleMount.promise;
    });
    const pickElement = vi.fn(async () => ({
      selector: '#picked',
      documentToken: 'picked-document-token',
    }));
    const screenshot = vi.fn(async () => ({
      tabId: tab.id,
      mode,
      mimeType: 'image/png' as const,
      width: 10,
      height: 10,
    }));
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount,
        captureMenuPreview: async () => ({
          tabId: tab.id,
          mode: 'viewport' as const,
          mimeType: 'image/png' as const,
          width: 400,
          height: 300,
        }),
        listBookmarks: async () => [],
        listHistory: async () => [],
        pickElement,
        screenshot,
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByRole('tab', { name: 'Example' });
    await waitFor(() => expect(mount).toHaveBeenCalledWith('chat-1', expect.any(Object)));

    await openBrowserMenu();
    holdVisibleMount = true;
    fireEvent.click(screen.getByText(label));
    await waitFor(() =>
      expect(mount.mock.calls.filter(([, bounds]) => bounds !== null).length).toBeGreaterThanOrEqual(2),
    );
    expect(pickElement).not.toHaveBeenCalled();
    expect(screenshot).not.toHaveBeenCalled();

    await act(async () => visibleMount.resolve());
    if (mode === 'element') await waitFor(() => expect(pickElement).toHaveBeenCalledWith('chat-1', tab.id));
    await waitFor(() => expect(screenshot).toHaveBeenCalledOnce());
  });

  it.each(['Screenshot viewport', 'Screenshot component'] as const)(
    'fails closed when the native page cannot remount before %s',
    async (label) => {
      let rejectVisibleMount = false;
      const mount = vi.fn(async (_conversationId: string, bounds: unknown) => {
        if (rejectVisibleMount && bounds !== null) throw new Error('Native remount failed');
      });
      const pickElement = vi.fn();
      const screenshot = vi.fn();
      installAppBridgeStub({
        browser: {
          available: async () => true,
          getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
          mount,
          captureMenuPreview: async () => ({
            tabId: tab.id,
            mode: 'viewport' as const,
            mimeType: 'image/png' as const,
            width: 400,
            height: 300,
          }),
          listBookmarks: async () => [],
          listHistory: async () => [],
          pickElement,
          screenshot,
        },
      });
      render(<BrowserPanel conversationId="chat-1" />);
      await screen.findByRole('tab', { name: 'Example' });
      await waitFor(() => expect(mount).toHaveBeenCalledWith('chat-1', expect.any(Object)));

      await openBrowserMenu();
      rejectVisibleMount = true;
      fireEvent.click(screen.getByText(label));

      expect(await screen.findByText('Native remount failed')).toBeInTheDocument();
      expect(pickElement).not.toHaveBeenCalled();
      expect(screenshot).not.toHaveBeenCalled();
    },
  );

  it('uses tab semantics, roving arrow navigation, and separately focusable close controls', async () => {
    const second = {
      ...tab,
      id: '00000000-0000-0000-0000-000000000002',
      title: 'Second',
      active: false,
    };
    const commandTab = vi.fn().mockResolvedValue(undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab, second],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        commandTab,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    expect(await screen.findByRole('tablist', { name: 'Browser tabs' })).toBeInTheDocument();
    const [firstTab, secondTab] = screen.getAllByRole('tab');
    expect(firstTab).toHaveAttribute('aria-selected', 'true');
    expect(firstTab).toHaveAttribute('tabindex', '0');
    expect(secondTab).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('button', { name: 'Close Example' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Second' })).toBeInTheDocument();

    firstTab.focus();
    fireEvent.keyDown(firstTab, { key: 'ArrowRight' });
    await waitFor(() => expect(commandTab).toHaveBeenCalledWith('chat-1', second.id, 'activate'));
    await waitFor(() => expect(secondTab).toHaveFocus());

    const observed = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    window.addEventListener('keydown', observed);
    try {
      fireEvent.keyDown(secondTab, { key: '1', ctrlKey: true });
      expect(observed).toHaveReturnedWith(true);
    } finally {
      window.removeEventListener('keydown', observed);
    }
  });

  it('restores focus to an adjacent tab and then the empty-state action after focused tabs close', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const second = {
      ...tab,
      id: '00000000-0000-0000-0000-000000000002',
      title: 'Second',
      active: false,
    };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab, second], activeTabId: tab.id }),
        mount: async () => undefined,
        commandTab: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const firstClose = await screen.findByRole('button', { name: 'Close Example' });
    firstClose.focus();
    fireEvent.click(firstClose);
    act(() => {
      emit?.({
        type: 'tabs-changed',
        conversationId: 'chat-1',
        tabs: [{ ...second, active: true }],
      });
    });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Second' })).toHaveFocus());

    const secondClose = screen.getByRole('button', { name: 'Close Second' });
    secondClose.focus();
    fireEvent.click(secondClose);
    act(() => {
      emit?.({ type: 'tabs-changed', conversationId: 'chat-1', tabs: [] });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open a new tab' })).toHaveFocus());
  });

  it('does not publish or refocus a delayed close failure after newer focused tab work', async () => {
    const pendingClose = deferred<void>();
    const second = {
      ...tab,
      id: '00000000-0000-0000-0000-000000000002',
      title: 'Second',
      active: false,
    };
    const commandTab = vi.fn((_conversationId: string, _tabId: string, action: string) =>
      action === 'close' ? pendingClose.promise : Promise.resolve(),
    );
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab, second], activeTabId: tab.id }),
        mount: async () => undefined,
        commandTab,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const close = await screen.findByRole('button', { name: 'Close Example' });
    const secondTab = screen.getByRole('tab', { name: 'Second' });
    close.focus();
    fireEvent.click(close);
    secondTab.focus();
    fireEvent.click(secondTab);

    await act(async () => pendingClose.reject(new Error('Stale close failed')));

    expect(screen.queryByText('Stale close failed')).not.toBeInTheDocument();
    expect(secondTab).toHaveFocus();
  });

  it('reports a failed background close without refocusing the tab', async () => {
    const pendingClose = deferred<void>();
    const commandTab = vi.fn((_conversationId: string, _tabId: string, action: string) =>
      action === 'close' ? pendingClose.promise : Promise.resolve(),
    );
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        commandTab,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText('Address and search bar');
    const close = screen.getByRole('button', { name: 'Close Example' });
    fireEvent.focus(omnibox);
    fireEvent.click(close);
    await waitFor(() => expect(commandTab).toHaveBeenCalledWith('chat-1', tab.id, 'close'));

    await act(async () => pendingClose.reject(new Error('Background close failed')));

    expect(await screen.findByText(/Background close failed/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Example' })).not.toHaveFocus();
  });

  it('preserves cached favicons across lightweight tab updates and applies dedicated favicon events', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const initialFavicon = 'data:image/png;base64,aW5pdGlhbA==';
    const replacementFavicon = 'data:image/png;base64,cmVwbGFjZW1lbnQ=';
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [{ ...tab, favicon: initialFavicon }],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    const { container } = render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    expect(container.querySelector(`img[src="${initialFavicon}"]`)).not.toBeNull();

    act(() => {
      emit?.({
        type: 'tabs-changed',
        conversationId: 'chat-1',
        tabs: [{ ...tab, title: 'Updated' }],
      });
    });
    expect(await screen.findByText('Updated')).toBeInTheDocument();
    expect(container.querySelector(`img[src="${initialFavicon}"]`)).not.toBeNull();

    act(() => {
      emit?.({
        type: 'tab-favicon',
        conversationId: 'chat-1',
        tabId: tab.id,
        favicon: replacementFavicon,
      });
    });
    expect(container.querySelector(`img[src="${replacementFavicon}"]`)).not.toBeNull();

    act(() =>
      emit?.({
        type: 'tab-favicon',
        conversationId: 'chat-1',
        tabId: tab.id,
        favicon: null,
      }),
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('does not let a delayed state snapshot overwrite a newer tab event', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const snapshot = deferred<{
      conversationId: string;
      tabs: BrowserTab[];
      activeTabId: string | null;
    }>();
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => snapshot.promise,
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await waitFor(() => expect(emit).toBeDefined());

    act(() =>
      emit?.({
        type: 'tabs-changed',
        conversationId: 'chat-1',
        tabs: [{ ...tab, title: 'Live title' }],
      }),
    );
    expect(await screen.findByText('Live title')).toBeInTheDocument();

    snapshot.resolve({
      conversationId: 'chat-1',
      tabs: [{ ...tab, title: 'Stale snapshot' }],
      activeTabId: tab.id,
    });
    await act(async () => {
      await snapshot.promise;
    });

    expect(screen.queryByText('Stale snapshot')).not.toBeInTheDocument();
    expect(screen.getByText('Live title')).toBeInTheDocument();
  });

  it('subscribes before hydration so a prompt racing the initial snapshot is retained', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const order: string[] = [];
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => {
          order.push('snapshot');
          emit?.({
            type: 'permission-prompt',
            conversationId: 'chat-1',
            prompt: {
              id: 'racing-permission',
              tabId: tab.id,
              origin: 'https://race.example',
              permission: 'camera',
              assistantTriggered: true,
            },
          });
          return {
            conversationId: 'chat-1',
            tabs: [tab],
            activeTabId: tab.id,
            permissionPrompts: [],
          };
        },
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          order.push('subscribe');
          emit = callback;
          return vi.fn();
        },
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);

    expect(await screen.findByRole('alertdialog', { name: 'Browser permission request for camera' })).toHaveTextContent(
      'AI requested: Allow https://race.example to use camera?',
    );
    expect(order.slice(0, 2)).toEqual(['subscribe', 'snapshot']);
  });

  it('invalidates and replaces an in-flight state snapshot when the browser profile changes', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const staleSnapshot = deferred<{
      conversationId: string;
      tabs: BrowserTab[];
      activeTabId: string | null;
    }>();
    let requests = 0;
    const profileTab = { ...tab, title: 'Conversation profile tab', url: 'about:blank' };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () =>
          requests++ === 0
            ? staleSnapshot.promise
            : { conversationId: 'chat-1', tabs: [profileTab], activeTabId: profileTab.id },
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await waitFor(() => expect(emit).toBeDefined());

    act(() => emit?.({ type: 'profile-scope-changed', dataScope: 'conversation' }));
    expect(await screen.findByText('Conversation profile tab')).toBeInTheDocument();

    staleSnapshot.resolve({
      conversationId: 'chat-1',
      tabs: [{ ...tab, title: 'Old global profile tab', url: 'https://secret.example/token' }],
      activeTabId: tab.id,
    });
    await act(async () => {
      await staleSnapshot.promise;
    });

    expect(screen.queryByText('Old global profile tab')).not.toBeInTheDocument();
    expect(screen.getByText('Conversation profile tab')).toBeInTheDocument();
  });

  it('clears focused omnibox and find state when the browser profile changes', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    let profileChanged = false;
    const pendingNavigation = deferred<void>();
    const profileTab = { ...tab, title: 'New Tab', url: 'about:blank', canGoBack: false };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [profileChanged ? profileTab : tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        navigate: vi.fn(() => pendingNavigation.promise),
        find: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText<HTMLInputElement>('Address and search bar');

    fireEvent.change(omnibox, { target: { value: 'https://old-profile.example/private' } });
    fireEvent.keyDown(omnibox, { key: 'Enter' });
    fireEvent.focus(omnibox);
    fireEvent.change(omnibox, { target: { value: 'old-profile draft' } });
    fireEvent.keyDown(omnibox, { key: 'f', ctrlKey: true });
    const findInput = await screen.findByPlaceholderText('Find in page');
    fireEvent.change(findInput, { target: { value: 'old-profile search' } });

    profileChanged = true;
    act(() => {
      emit?.({ type: 'tabs-changed', conversationId: 'chat-1', tabs: [profileTab] });
      emit?.({ type: 'profile-scope-changed', dataScope: 'conversation' });
    });

    await waitFor(() => expect(omnibox).toHaveValue(''));
    expect(omnibox).not.toHaveFocus();
    expect(screen.queryByPlaceholderText('Find in page')).not.toBeInTheDocument();

    await act(async () => pendingNavigation.reject(new Error('Old profile navigation failed')));
    expect(screen.queryByText(/Old profile navigation failed/)).not.toBeInTheDocument();
  });

  it('hydrates retained prompts and actions when a tab event supersedes the snapshot tabs', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const snapshot = deferred<{
      conversationId: string;
      tabs: BrowserTab[];
      activeTabId: string | null;
      permissionPrompts: BrowserPermissionPrompt[];
      runningActions: BrowserActionEvent[];
    }>();
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => snapshot.promise,
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await waitFor(() => expect(emit).toBeDefined());

    act(() => {
      emit?.({
        type: 'tabs-changed',
        conversationId: 'chat-1',
        tabs: [{ ...tab, title: 'Live title' }],
      });
    });
    snapshot.resolve({
      conversationId: 'chat-1',
      tabs: [{ ...tab, title: 'Stale snapshot' }],
      activeTabId: tab.id,
      permissionPrompts: [
        {
          id: 'retained-permission',
          tabId: tab.id,
          origin: 'https://example.com',
          permission: 'camera',
          assistantTriggered: true,
        },
      ],
      runningActions: [
        {
          id: 'retained-action',
          tabId: tab.id,
          kind: 'scroll',
          status: 'running',
          startedAt: '2026-01-01T00:00:00.000Z',
          summary: 'scrolling',
        },
      ],
    });
    await act(async () => {
      await snapshot.promise;
    });

    expect(screen.getByText('Live title')).toBeInTheDocument();
    expect(screen.queryByText('Stale snapshot')).not.toBeInTheDocument();
    expect(screen.getByRole('alertdialog', { name: 'Browser permission request for camera' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Kai · scrolling');
  });

  it('does not let a delayed state snapshot hide live prompts or running actions', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const snapshot = deferred<{
      conversationId: string;
      tabs: BrowserTab[];
      activeTabId: string | null;
      permissionPrompts: [];
      runningActions: [];
    }>();
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => snapshot.promise,
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await waitFor(() => expect(emit).toBeDefined());

    act(() => {
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'live-permission',
          tabId: tab.id,
          origin: 'https://example.com',
          permission: 'camera',
          assistantTriggered: true,
        },
      });
      emit?.({
        type: 'action',
        conversationId: 'chat-1',
        action: {
          id: 'live-action',
          tabId: tab.id,
          kind: 'scroll',
          status: 'running',
          startedAt: '2026-01-01T00:00:00.000Z',
          summary: 'scrolling',
        },
      });
    });

    snapshot.resolve({
      conversationId: 'chat-1',
      tabs: [tab],
      activeTabId: tab.id,
      permissionPrompts: [],
      runningActions: [],
    });
    await act(async () => {
      await snapshot.promise;
    });

    expect(screen.getByRole('alertdialog', { name: 'Browser permission request for camera' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Kai · scrolling');
  });

  it('keeps unrelated snapshotted actions visible when another action completes during hydration', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const snapshot = deferred<{
      conversationId: string;
      tabs: BrowserTab[];
      activeTabId: string | null;
      runningActions: BrowserActionEvent[];
    }>();
    const retainedAction: BrowserActionEvent = {
      id: 'retained-action',
      tabId: tab.id,
      kind: 'scroll',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      summary: 'still scrolling',
    };
    const completedAction: BrowserActionEvent = {
      id: 'completed-action',
      tabId: tab.id,
      kind: 'click',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      summary: 'clicked',
    };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => snapshot.promise,
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await waitFor(() => expect(emit).toBeDefined());

    act(() => emit?.({ type: 'action', conversationId: 'chat-1', action: completedAction }));
    snapshot.resolve({
      conversationId: 'chat-1',
      tabs: [tab],
      activeTabId: tab.id,
      runningActions: [retainedAction, { ...completedAction, status: 'running', completedAt: undefined }],
    });
    await act(async () => {
      await snapshot.promise;
    });

    expect(screen.getByRole('status')).toHaveTextContent('Kai · still scrolling');
    expect(screen.getByRole('status')).not.toHaveTextContent('clicked');
  });

  it('reconciles same-kind prompt additions and dismissals over a hydration snapshot', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const snapshot = deferred<{
      conversationId: string;
      tabs: BrowserTab[];
      activeTabId: string | null;
      permissionPrompts: BrowserPermissionPrompt[];
    }>();
    const retainedPrompt: BrowserPermissionPrompt = {
      id: 'retained-permission',
      tabId: tab.id,
      origin: 'https://camera.example',
      permission: 'camera',
      assistantTriggered: true,
    };
    const dismissedPrompt: BrowserPermissionPrompt = {
      id: 'dismissed-permission',
      tabId: tab.id,
      origin: 'https://location.example',
      permission: 'geolocation',
      assistantTriggered: true,
    };
    const livePrompt: BrowserPermissionPrompt = {
      id: 'live-permission',
      tabId: tab.id,
      origin: 'https://microphone.example',
      permission: 'microphone',
      assistantTriggered: true,
    };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => snapshot.promise,
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await waitFor(() => expect(emit).toBeDefined());

    act(() => {
      emit?.({ type: 'permission-prompt', conversationId: 'chat-1', prompt: livePrompt });
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-1',
        promptId: dismissedPrompt.id,
        promptKind: 'permission',
      });
    });
    snapshot.resolve({
      conversationId: 'chat-1',
      tabs: [tab],
      activeTabId: tab.id,
      permissionPrompts: [retainedPrompt, dismissedPrompt],
    });
    await act(async () => {
      await snapshot.promise;
    });

    expect(screen.getByRole('alertdialog', { name: 'Browser permission request for camera' })).toHaveTextContent(
      'https://camera.example',
    );
    expect(screen.queryByText('https://location.example')).not.toBeInTheDocument();

    act(() =>
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-1',
        promptId: retainedPrompt.id,
        promptKind: 'permission',
      }),
    );
    expect(screen.getByRole('alertdialog', { name: 'Browser permission request for microphone' })).toHaveTextContent(
      'https://microphone.example',
    );
  });

  it('hydrates unrelated retained prompt domains when live prompt and action events race the snapshot', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const snapshot = deferred<{
      conversationId: string;
      tabs: BrowserTab[];
      activeTabId: string | null;
      credentialPrompts: BrowserCredentialPrompt[];
      permissionPrompts: BrowserPermissionPrompt[];
      authPrompts: BrowserAuthPrompt[];
      runningActions: BrowserActionEvent[];
    }>();
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => snapshot.promise,
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await waitFor(() => expect(emit).toBeDefined());

    act(() => {
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'live-permission',
          tabId: tab.id,
          origin: 'https://camera.example',
          permission: 'camera',
          assistantTriggered: true,
        },
      });
      emit?.({
        type: 'action',
        conversationId: 'chat-1',
        action: {
          id: 'live-action',
          tabId: tab.id,
          kind: 'scroll',
          status: 'running',
          startedAt: '2026-01-01T00:00:00.000Z',
          summary: 'scrolling',
        },
      });
    });
    snapshot.resolve({
      conversationId: 'chat-1',
      tabs: [tab],
      activeTabId: tab.id,
      credentialPrompts: [
        {
          id: 'retained-credential',
          tabId: tab.id,
          origin: 'https://login.example',
          username: 'user@example.com',
          update: false,
        },
      ],
      permissionPrompts: [],
      authPrompts: [
        {
          id: 'retained-auth',
          tabId: tab.id,
          host: 'auth.example',
          endpoint: 'https://auth.example',
          authScheme: 'basic',
          realm: 'Protected',
          isProxy: false,
          assistantTriggered: true,
        },
      ],
      runningActions: [],
    });
    await act(async () => {
      await snapshot.promise;
    });

    expect(screen.getByRole('alertdialog', { name: 'Save browser password' })).toBeInTheDocument();
    expect(screen.getByRole('alertdialog', { name: 'Browser authentication required' })).toBeInTheDocument();
    expect(screen.getByRole('alertdialog', { name: 'Browser permission request for camera' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Kai · scrolling');
  });

  it('autofocuses menus, supports roving keys, restores focus, and clamps tab menus', async () => {
    const commandTab = vi.fn(async () => undefined);
    const setZoom = vi.fn(async (_conversationId: string, _tabId: string, level: number) => level);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        commandTab,
        listBookmarks: async () => [],
        listHistory: async () => [],
        setZoom,
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const browserMenuTrigger = await screen.findByTitle('Browser menu');
    fireEvent.click(browserMenuTrigger);
    const browserMenu = await screen.findByRole('menu', { name: 'Browser menu' });
    expect(browserMenu.parentElement).toBe(document.body);
    expect(browserMenu).toHaveClass('fixed');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'New tab' })).toHaveFocus());
    fireEvent.keyDown(browserMenu, { key: 'Tab' });
    await waitFor(() => expect(browserMenuTrigger).toHaveFocus());
    expect(screen.queryByRole('menu', { name: 'Browser menu' })).not.toBeInTheDocument();

    fireEvent.click(browserMenuTrigger);
    const reopenedBrowserMenu = await screen.findByRole('menu', { name: 'Browser menu' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'New tab' })).toHaveFocus());
    fireEvent.keyDown(reopenedBrowserMenu, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Developer tools' })).toHaveFocus();
    fireEvent.keyDown(reopenedBrowserMenu, { key: 'Escape' });
    await waitFor(() => expect(browserMenuTrigger).toHaveFocus());

    fireEvent.click(browserMenuTrigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Zoom in' }));
    await waitFor(() => expect(browserMenuTrigger).toHaveFocus());
    expect(setZoom).toHaveBeenCalledWith('chat-1', tab.id, 0.5);

    fireEvent.click(browserMenuTrigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'History' }));
    const managerBackButton = await screen.findByTitle('Back to browser');
    await waitFor(() => expect(managerBackButton).toHaveFocus());
    fireEvent.click(managerBackButton);
    await waitFor(() => expect(browserMenuTrigger).toHaveFocus());

    const tabControl = screen.getByRole('tab', { name: 'Example' });
    fireEvent.contextMenu(tabControl, {
      clientX: window.innerWidth + 500,
      clientY: window.innerHeight + 500,
    });
    const tabMenu = screen.getByRole('menu', { name: 'Tab menu for Example' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toHaveFocus());
    expect(Number.parseFloat(tabMenu.style.left)).toBeLessThan(window.innerWidth);
    expect(Number.parseFloat(tabMenu.style.top)).toBeLessThan(window.innerHeight);
    fireEvent.keyDown(tabMenu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Mute site' })).toHaveFocus();
    fireEvent.keyDown(tabMenu, { key: 'Tab' });
    await waitFor(() => expect(tabControl).toHaveFocus());
    expect(screen.queryByRole('menu', { name: 'Tab menu for Example' })).not.toBeInTheDocument();

    fireEvent.contextMenu(tabControl, { clientX: 40, clientY: 40 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mute site' }));
    await waitFor(() => expect(tabControl).toHaveFocus());
    expect(commandTab).toHaveBeenCalledWith('chat-1', tab.id, 'toggle-mute');
  });

  it('does not let a completed menu action steal focus from an open manager', async () => {
    const print = deferred<void>();
    const menuAction = vi.fn((_conversationId: string, action: string) =>
      action === 'print' ? print.promise : Promise.resolve(),
    );
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        menuAction,
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);

    const browserMenuTrigger = await screen.findByTitle('Browser menu');
    fireEvent.click(browserMenuTrigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Print…' }));
    expect(menuAction).toHaveBeenCalledWith('chat-1', 'print');

    fireEvent.click(browserMenuTrigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'History' }));
    const managerBackButton = await screen.findByTitle('Back to browser');
    await waitFor(() => expect(managerBackButton).toHaveFocus());

    await act(async () => {
      print.resolve();
      await print.promise;
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(managerBackButton).toHaveFocus();
  });

  it('keeps Browser chrome clipboard shortcuts available while the page is sensitive', async () => {
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [{ ...tab, sensitive: true }],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText('Address and search bar');

    expect(fireEvent.keyDown(omnibox, { key: 'c', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(omnibox, { key: 'v', ctrlKey: true })).toBe(true);
  });

  it('does not reorder a different tab when the dragged tab closes before drop', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const reorderTabs = vi.fn().mockResolvedValue(undefined);
    const second = {
      ...tab,
      id: '00000000-0000-0000-0000-000000000002',
      title: 'Second',
      active: false,
    };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab, second],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        reorderTabs,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const firstButton = (await screen.findByText('Example')).closest('button')!;
    const secondButton = screen.getByText('Second').closest('button')!;
    fireEvent.dragStart(firstButton);
    act(() => {
      emit?.({
        type: 'tabs-changed',
        conversationId: 'chat-1',
        tabs: [{ ...second, active: true }],
      });
    });
    fireEvent.drop(secondButton);

    expect(reorderTabs).not.toHaveBeenCalled();
  });

  it('reorders tabs with the keyboard and tab context menu', async () => {
    const reorderTabs = vi.fn().mockResolvedValue(undefined);
    const commandTab = vi.fn().mockResolvedValue(undefined);
    const second = {
      ...tab,
      id: '00000000-0000-0000-0000-000000000002',
      title: 'Second',
      active: false,
    };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab, second],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        reorderTabs,
        commandTab,
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const firstTab = await screen.findByRole('tab', { name: 'Example' });
    const secondTab = screen.getByRole('tab', { name: 'Second' });

    fireEvent.keyDown(firstTab, { key: 'ArrowRight', altKey: true, shiftKey: true });
    await waitFor(() => expect(reorderTabs).toHaveBeenCalledWith('chat-1', [second.id, tab.id]));
    expect(commandTab).not.toHaveBeenCalled();

    fireEvent.contextMenu(secondTab, { clientX: 30, clientY: 30 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move tab left' }));
    await waitFor(() => expect(reorderTabs).toHaveBeenCalledTimes(2));
    expect(reorderTabs).toHaveBeenLastCalledWith('chat-1', [second.id, tab.id]);
  });

  it('reorders bookmarks with focusable move controls', async () => {
    const first = {
      id: 'bookmark-1',
      scopeKey: 'global',
      title: 'First bookmark',
      url: 'https://first.example',
      folder: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const second = { ...first, id: 'bookmark-2', title: 'Second bookmark', url: 'https://second.example' };
    const reorderBookmarks = vi.fn().mockResolvedValue(undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [first, second],
        listHistory: async () => [],
        reorderBookmarks,
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('Bookmarks'));

    fireEvent.click(await screen.findByTitle('Move Second bookmark up'));
    await waitFor(() => expect(reorderBookmarks).toHaveBeenCalledWith('chat-1', ['bookmark-2', 'bookmark-1']));
  });

  it('surfaces find, tab-reorder, and download-reveal failures', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const second = {
      ...tab,
      id: '00000000-0000-0000-0000-000000000002',
      title: 'Second',
      active: false,
    };
    const stopFind = vi.fn().mockRejectedValue(new Error('Find unavailable'));
    const reorderTabs = vi.fn().mockRejectedValue(new Error('Tabs changed'));
    const showDownload = vi.fn().mockRejectedValue(new Error('Download missing'));
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab, second],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        stopFind,
        reorderTabs,
        showDownload,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText('Address and search bar');

    fireEvent.keyDown(omnibox, { key: 'f', ctrlKey: true });
    fireEvent.click(await screen.findByTitle('Close find'));
    expect(await screen.findByText('Find unavailable')).toBeInTheDocument();

    const firstButton = screen.getByText('Example').closest('button')!;
    const secondButton = screen.getByText('Second').closest('button')!;
    fireEvent.dragStart(firstButton);
    fireEvent.drop(secondButton);
    expect(await screen.findByText('Tabs changed')).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'download',
        conversationId: 'chat-1',
        download: {
          id: 'download-1',
          tabId: tab.id,
          filename: 'report.pdf',
          receivedBytes: 10,
          totalBytes: 10,
          state: 'completed',
          path: '/tmp/report.pdf',
        },
      });
    });
    fireEvent.click(await screen.findByText(/report\.pdf/));
    expect(await screen.findByText('Download missing')).toBeInTheDocument();
  });

  it('refreshes an open downloads manager when live download progress changes', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const progressing = {
      id: 'download-live',
      tabId: tab.id,
      filename: 'archive.zip',
      receivedBytes: 1,
      totalBytes: 10,
      state: 'progressing' as const,
      path: '/tmp/archive.zip',
    };
    const completed = {
      ...progressing,
      receivedBytes: 10,
      state: 'completed' as const,
    };
    const listDownloads = vi.fn().mockResolvedValueOnce([progressing]).mockResolvedValue([completed]);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listDownloads,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('Downloads'));
    expect(await screen.findByText('progressing · 1 / 10 bytes')).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'download',
        conversationId: 'chat-1',
        download: completed,
      });
    });

    await waitFor(() => expect(listDownloads).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('completed · 10 / 10 bytes')).toBeInTheDocument();
  });

  it('labels downloads without a saved path as unavailable and does not offer an open action', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const unavailable = {
      id: 'download-unavailable',
      tabId: tab.id,
      filename: 'missing.pdf',
      receivedBytes: 10,
      totalBytes: 10,
      state: 'completed' as const,
    };
    const showDownload = vi.fn(async () => undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listDownloads: async () => [unavailable],
        showDownload,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    act(() => {
      emit?.({ type: 'download', conversationId: 'chat-1', download: unavailable });
    });

    const shelfStatus = await screen.findByText(/missing\.pdf · completed · file unavailable/);
    expect(shelfStatus.tagName).toBe('SPAN');
    fireEvent.click(shelfStatus);
    expect(showDownload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('Open downloads'));
    const managerTitle = await screen.findByText('missing.pdf');
    expect(managerTitle.closest('button')).toBeDisabled();
    expect(screen.getByText(/completed · 10 \/ 10 bytes · file unavailable/)).toBeInTheDocument();
    expect(showDownload).not.toHaveBeenCalled();
  });

  it('exports completed quarantined files from the detached Downloads manager', async () => {
    const completed = {
      id: 'download-exportable',
      tabId: tab.id,
      filename: 'assistant-report.pdf',
      receivedBytes: 10,
      totalBytes: 10,
      state: 'completed' as const,
      quarantined: true,
      path: '/tmp/Kai-download.download',
    };
    const exportDownload = vi.fn(async () => ({ canceled: true }));
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listDownloads: async () => [completed],
        exportDownload,
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('Downloads'));
    fireEvent.click(await screen.findByTitle('Export assistant-report.pdf'));

    await waitFor(() => expect(exportDownload).toHaveBeenCalledWith('chat-1', completed.id));
  });

  it('updates or clears only the matching shelf item for download-history changes', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const completed = {
      id: 'download-latest',
      tabId: tab.id,
      filename: 'assistant-report.pdf',
      receivedBytes: 10,
      totalBytes: 10,
      state: 'completed' as const,
      quarantined: true,
      path: '/tmp/Kai-download.download',
    };
    const exportDownload = vi.fn(async () => ({ canceled: true }));
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listDownloads: async () => [completed],
        exportDownload,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    act(() => {
      emit?.({ type: 'download', conversationId: 'chat-1', download: completed });
    });
    expect(await screen.findByText(/assistant-report\.pdf · completed/)).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'download-history-changed',
        conversationId: 'chat-1',
        downloadId: 'older-download',
        change: 'deleted',
      });
    });
    expect(screen.getByText(/assistant-report\.pdf · completed/)).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'download-history-changed',
        conversationId: 'chat-1',
        downloadId: completed.id,
        change: 'unavailable',
      });
    });
    const unavailable = await screen.findByText(/assistant-report\.pdf · completed · file unavailable/);
    expect(unavailable.tagName).toBe('SPAN');
    expect(exportDownload).not.toHaveBeenCalled();

    act(() => {
      emit?.({
        type: 'download-history-changed',
        conversationId: 'chat-1',
        downloadId: completed.id,
        change: 'deleted',
      });
    });
    expect(screen.queryByText(/assistant-report\.pdf/)).not.toBeInTheDocument();
  });

  it('cancels active downloads from the shelf and downloads manager', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const progressing = {
      id: 'download-live',
      tabId: tab.id,
      filename: 'archive.zip',
      receivedBytes: 1,
      totalBytes: 10,
      state: 'progressing' as const,
    };
    const cancelDownload = vi.fn(async () => undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listDownloads: async () => [progressing],
        cancelDownload,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    act(() => {
      emit?.({ type: 'download', conversationId: 'chat-1', download: progressing });
    });

    fireEvent.click(await screen.findByTitle('Cancel download'));
    await waitFor(() => expect(cancelDownload).toHaveBeenCalledWith('chat-1', 'download-live'));

    fireEvent.click(screen.getByTitle('Open downloads'));
    fireEvent.click(await screen.findByTitle('Cancel archive.zip'));
    await waitFor(() => expect(cancelDownload).toHaveBeenCalledTimes(2));
  });

  it('surfaces omnibox suggestion and password-manager action failures', async () => {
    const listHistory = vi.fn().mockRejectedValue(new Error('History unavailable'));
    const copyCredential = vi.fn().mockRejectedValue(new Error('Touch ID cancelled'));
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory,
        listCredentials: async () => [
          {
            id: 'credential-1',
            scopeKey: 'global',
            origin: 'https://example.com',
            username: 'alice',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        copyCredential,
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText('Address and search bar');
    fireEvent.change(omnibox, { target: { value: 'query' } });
    expect(await screen.findByText('History unavailable')).toBeInTheDocument();

    await openBrowserMenu();
    fireEvent.click(screen.getByText('Passwords'));
    expect(await screen.findByText('alice')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Copy with Touch ID'));
    expect(await screen.findByText('Touch ID cancelled')).toBeInTheDocument();
    expect(copyCredential).toHaveBeenCalledWith('chat-1', 'credential-1');
  });

  it('locks password plaintext controls when Touch ID is unavailable', async () => {
    const copyCredential = vi.fn();
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listCredentials: async () => [
          {
            id: 'credential-1',
            scopeKey: 'global',
            origin: 'https://example.com',
            username: 'alice',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        credentialAuthenticationAvailable: async () => false,
        copyCredential,
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('Passwords'));

    expect(await screen.findByText(/Touch ID is unavailable on this Mac/)).toHaveTextContent(
      'Saved passwords can still be autofilled, but editing, revealing, copying, and deleting stay locked.',
    );
    expect(screen.getByTitle(/Edit unavailable/)).toBeDisabled();
    expect(screen.getByTitle(/Reveal unavailable/)).toBeDisabled();
    const copy = screen.getByTitle(/Copy unavailable/);
    expect(copy).toBeDisabled();
    expect(screen.getByTitle(/Delete unavailable/)).toBeDisabled();
    fireEvent.click(copy);
    expect(copyCredential).not.toHaveBeenCalled();
  });

  it('moves focus into the password editor and restores it after cancel or save', async () => {
    const revealCredential = vi.fn(async () => 'secret');
    const updateCredential = vi.fn(async () => undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listCredentials: async () => [
          {
            id: 'credential-1',
            scopeKey: 'global',
            origin: 'https://example.com',
            username: 'alice',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        revealCredential,
        updateCredential,
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('Passwords'));
    const editButton = await screen.findByTitle('Edit with Touch ID');

    fireEvent.click(editButton);
    const username = await screen.findByLabelText('Saved username');
    await waitFor(() => expect(username).toHaveFocus());
    const password = screen.getByLabelText('Saved password');
    password.focus();
    fireEvent.change(password, { target: { value: 'changed' } });
    expect(password).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(editButton).toHaveFocus());

    fireEvent.click(editButton);
    await screen.findByLabelText('Saved username');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateCredential).toHaveBeenCalled());
    await waitFor(() => expect(editButton).toHaveFocus());
  });

  it('only applies the newest credential authentication completion across reveal and edit requests', async () => {
    const requests = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
    const revealCredential = vi.fn(() => requests[revealCredential.mock.calls.length - 1].promise);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listCredentials: async () => [
          {
            id: 'credential-alice',
            scopeKey: 'global',
            origin: 'https://alice.example',
            username: 'alice',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'credential-bob',
            scopeKey: 'global',
            origin: 'https://bob.example',
            username: 'bob',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        revealCredential,
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('Passwords'));
    const editButtons = await screen.findAllByTitle('Edit with Touch ID');
    const revealButtons = screen.getAllByTitle('Reveal with Touch ID');

    fireEvent.click(editButtons[0]);
    fireEvent.click(revealButtons[1]);
    await act(async () => {
      requests[1].resolve('bob-revealed-secret');
      await requests[1].promise;
    });
    expect(await screen.findByText('bob-revealed-secret')).toBeInTheDocument();
    await act(async () => {
      requests[0].resolve('stale-alice-edit-secret');
      await requests[0].promise;
    });
    expect(screen.queryByText('stale-alice-edit-secret')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Saved username')).not.toBeInTheDocument();

    fireEvent.click(revealButtons[0]);
    fireEvent.click(editButtons[1]);
    await act(async () => {
      requests[3].resolve('bob-edit-secret');
      await requests[3].promise;
    });
    expect(await screen.findByLabelText('Saved username')).toHaveValue('bob');
    expect(screen.getByLabelText('Saved password')).toHaveValue('bob-edit-secret');
    await act(async () => {
      requests[2].resolve('stale-alice-revealed-secret');
      await requests[2].promise;
    });
    expect(screen.queryByText('stale-alice-revealed-secret')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Saved username')).toHaveValue('bob');
    expect(screen.getByLabelText('Saved password')).toHaveValue('bob-edit-secret');
  });

  it('confirms saved-password deletion before requesting Touch ID', async () => {
    const deleteCredential = vi.fn(async () => undefined);
    const revealCredential = vi.fn(async () => 'secret-that-must-not-linger');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    try {
      installAppBridgeStub({
        browser: {
          available: async () => true,
          getState: async () => ({
            conversationId: 'chat-1',
            tabs: [tab],
            activeTabId: tab.id,
          }),
          mount: async () => undefined,
          listBookmarks: async () => [],
          listHistory: async () => [],
          listCredentials: async () => [
            {
              id: 'credential-1',
              scopeKey: 'global',
              origin: 'https://example.com',
              username: 'alice',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          deleteCredential,
          revealCredential,
        },
      });

      render(<BrowserPanel conversationId="chat-1" />);
      await screen.findByText('Example');
      await openBrowserMenu();
      fireEvent.click(screen.getByText('Passwords'));
      expect(await screen.findByText('alice')).toBeInTheDocument();

      fireEvent.click(screen.getByTitle('Edit with Touch ID'));
      expect(await screen.findByLabelText('Saved password')).toHaveValue('secret-that-must-not-linger');

      const deleteButton = screen.getByTitle('Delete with Touch ID');
      fireEvent.click(deleteButton);
      expect(confirm).toHaveBeenCalledOnce();
      expect(deleteCredential).not.toHaveBeenCalled();

      fireEvent.click(deleteButton);
      await waitFor(() => expect(deleteCredential).toHaveBeenCalledWith('chat-1', 'credential-1'));
      await waitFor(() => expect(screen.queryByLabelText('Saved password')).not.toBeInTheDocument());
    } finally {
      confirm.mockRestore();
    }
  });

  it('reloads a completed password mutation with the current search query', async () => {
    const pendingDelete = deferred<void>();
    const alice = {
      id: 'credential-alice',
      scopeKey: 'global',
      origin: 'https://alice.example',
      username: 'alice',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const bob = { ...alice, id: 'credential-bob', origin: 'https://bob.example', username: 'bob' };
    const listCredentials = vi.fn(async (_conversationId: string, query = '') => (query === 'bob' ? [bob] : [alice]));
    const deleteCredential = vi.fn(() => pendingDelete.promise);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      installAppBridgeStub({
        browser: {
          available: async () => true,
          getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
          mount: async () => undefined,
          listBookmarks: async () => [],
          listHistory: async () => [],
          listCredentials,
          credentialAuthenticationAvailable: async () => true,
          deleteCredential,
        },
      });
      render(<BrowserPanel conversationId="chat-1" />);
      await screen.findByText('Example');
      await openBrowserMenu();
      fireEvent.click(screen.getByText('Passwords'));
      await screen.findByText('alice');
      const search = screen.getByPlaceholderText('Search passwords');
      fireEvent.change(search, { target: { value: 'alice' } });
      await waitFor(() => expect(listCredentials).toHaveBeenLastCalledWith('chat-1', 'alice'));

      fireEvent.click(screen.getByTitle('Delete with Touch ID'));
      await waitFor(() => expect(deleteCredential).toHaveBeenCalledWith('chat-1', alice.id));
      fireEvent.change(search, { target: { value: 'bob' } });
      expect(await screen.findByText('bob')).toBeInTheDocument();

      await act(async () => {
        pendingDelete.resolve();
        await pendingDelete.promise;
      });
      await waitFor(() => expect(listCredentials).toHaveBeenLastCalledWith('chat-1', 'bob'));
      expect(screen.getByText('bob')).toBeInTheDocument();
      expect(screen.queryByText('alice')).not.toBeInTheDocument();
    } finally {
      confirm.mockRestore();
    }
  });

  it('shows complete saved-password origins without visual truncation', async () => {
    const origin = `https://${'lookalike-'.repeat(12)}accounts.trusted.example:8443`;
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listCredentials: async () => [
          {
            id: 'credential-long-origin',
            scopeKey: 'global',
            origin,
            username: 'alice',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('Passwords'));

    const displayedOrigin = await screen.findByText(origin);
    expect(displayedOrigin).toHaveAttribute('dir', 'ltr');
    expect(displayedOrigin).toHaveClass('break-all');
    expect(displayedOrigin).not.toHaveClass('truncate');
  });

  it('keeps the password manager open when autofill has no active tab', async () => {
    const autofill = vi.fn().mockResolvedValue(undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [],
          activeTabId: null,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listCredentials: async () => [
          {
            id: 'credential-1',
            scopeKey: 'global',
            origin: 'https://example.com',
            username: 'alice',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        autofill,
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await waitFor(() => expect(screen.getByTitle('Browser menu')).toBeEnabled());
    await openBrowserMenu();
    fireEvent.click(screen.getByText('Passwords'));
    expect(await screen.findByText('alice')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Autofill in active tab'));

    expect(await screen.findByText('Open a browser tab before autofilling a saved password.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Passwords' })).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(autofill).not.toHaveBeenCalled();
  });

  it('surfaces a failed native mount and retries the same bounds after resize', async () => {
    let boundsAttempts = 0;
    const mount = vi.fn(async (_conversationId: string, bounds: unknown) => {
      if (bounds && ++boundsAttempts === 1) throw new Error('Native view unavailable');
    });
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    expect(await screen.findByText('Native view unavailable')).toBeInTheDocument();
    expect(boundsAttempts).toBe(1);

    fireEvent(window, new Event('resize'));
    await waitFor(() => expect(boundsAttempts).toBe(2));
  });

  it('mounts the native view inside the side panel without treating its resize handle as an overlay', async () => {
    const mount = vi.fn(async () => undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    const OpenPanel = () => {
      const { openPanel } = useSidePanel();
      return <button onClick={() => openPanel('browser')}>Open browser panel</button>;
    };
    render(
      <TooltipProvider>
        <SidePanelProvider>
          <OpenPanel />
          <SidePanelHost
            tabs={[
              {
                id: 'browser',
                label: 'Browser',
                render: () => <BrowserPanel conversationId="chat-1" />,
              },
            ]}
          />
        </SidePanelProvider>
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Browser' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByText('Open browser panel'));
    await screen.findByText('Example');
    expect(screen.getByRole('button', { name: 'Browser' })).toHaveAttribute('aria-pressed', 'true');
    const surface = document.querySelector<HTMLElement>('[data-browser-native-surface]');
    const resizeHandle = screen.getByRole('separator');
    expect(surface).not.toBeNull();
    expect(resizeHandle).toHaveAttribute('data-native-browser-overlay-ignore');
    expect(resizeHandle).toHaveClass('-left-2');
    expect(resizeHandle).toHaveAttribute('tabindex', '0');
    expect(resizeHandle).toHaveAttribute('aria-label', 'Resize side panel');
    expect(resizeHandle).toHaveAttribute('aria-valuemin', '20');
    expect(resizeHandle).toHaveAttribute('aria-valuemax', '80');
    expect(resizeHandle).toHaveAttribute('aria-valuenow', '45');
    fireEvent.keyDown(resizeHandle, { key: 'ArrowLeft' });
    expect(resizeHandle).toHaveAttribute('aria-valuenow', '50');
    fireEvent.keyDown(resizeHandle, { key: 'Home' });
    expect(resizeHandle).toHaveAttribute('aria-valuenow', '20');
    fireEvent.keyDown(resizeHandle, { key: 'End' });
    expect(resizeHandle).toHaveAttribute('aria-valuenow', '80');
    vi.spyOn(surface!, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 40, 400, 300));
    vi.spyOn(resizeHandle, 'getBoundingClientRect').mockReturnValue(new DOMRect(98, 0, 8, 400));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [resizeHandle, surface!]),
    });

    fireEvent(window, new Event('resize'));
    await waitFor(() =>
      expect(mount).toHaveBeenLastCalledWith('chat-1', {
        x: 100,
        y: 40,
        width: 400,
        height: 300,
      }),
    );
    Reflect.deleteProperty(document, 'elementsFromPoint');
  });

  it('detaches the native view during collapse before minimized layout effects run', async () => {
    const order: string[] = [];
    let recordOrder = false;
    const mount = vi.fn(async (_conversationId: string, bounds: unknown) => {
      if (recordOrder && bounds === null) order.push('native-detached');
    });
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    const Controls = () => {
      const { state, openPanel, minimizePanel } = useSidePanel();
      useLayoutEffect(() => {
        if (recordOrder && state === 'minimized') order.push('minimized-layout');
      }, [state]);
      return (
        <>
          <button type="button" onClick={() => openPanel('browser')}>
            Open ordered browser panel
          </button>
          <button type="button" onClick={minimizePanel}>
            Collapse ordered browser panel
          </button>
        </>
      );
    };

    render(
      <TooltipProvider>
        <SidePanelProvider>
          <Controls />
          <SidePanelHost
            tabs={[
              {
                id: 'browser',
                label: 'Browser',
                render: () => <BrowserPanel conversationId="chat-1" />,
              },
            ]}
          />
        </SidePanelProvider>
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByText('Open ordered browser panel'));
    await screen.findByText('Example');
    await waitFor(() => expect(mount).toHaveBeenCalledWith('chat-1', expect.any(Object)));

    recordOrder = true;
    fireEvent.click(screen.getByText('Collapse ordered browser panel'));

    expect(order).toEqual(['native-detached', 'minimized-layout']);
  });

  it('detaches the native view while an intersecting renderer overlay is visible', async () => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed';
    const mount = vi.fn(async () => undefined);
    let requestFrame: ReturnType<typeof vi.spyOn> | undefined;
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    try {
      render(<BrowserPanel conversationId="chat-1" />);
      await screen.findByText('Example');
      const surface = document.querySelector<HTMLElement>('[data-browser-native-surface]');
      expect(surface).not.toBeNull();
      vi.spyOn(surface!, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 40, 400, 300));
      vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(420, 40, 80, 60));
      Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: vi.fn(() => [overlay, surface!]),
      });

      fireEvent(window, new Event('resize'));
      await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', expect.objectContaining({ width: 400 })));
      mount.mockClear();
      // Freeze future frames: insertion still must detach synchronously from
      // the MutationObserver callback, before the browser can receive input.
      requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 123);
      document.body.append(overlay);
      await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', null));
    } finally {
      requestFrame?.mockRestore();
      Reflect.deleteProperty(document, 'elementsFromPoint');
      overlay.remove();
    }
  });

  it('observes tracked overlay geometry and detaches when its box changes without a DOM mutation', async () => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed';
    document.body.append(overlay);
    const mount = vi.fn(async () => undefined);
    const previousResizeObserver = globalThis.ResizeObserver;
    const observers: CapturingResizeObserver[] = [];
    class CapturingResizeObserver {
      readonly targets = new Set<Element>();
      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    }
    globalThis.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    try {
      render(<BrowserPanel conversationId="chat-1" />);
      await screen.findByText('Example');
      const surface = document.querySelector<HTMLElement>('[data-browser-native-surface]')!;
      vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 40, 400, 300));
      vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(420, 40, 80, 60));
      Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: vi.fn(() => [overlay, surface]),
      });
      const geometryObserver = observers.find(
        (observer) => observer.targets.has(surface) && observer.targets.has(overlay),
      );
      expect(geometryObserver).toBeDefined();
      mount.mockClear();

      act(() => geometryObserver!.callback([], geometryObserver as unknown as ResizeObserver));

      await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', null));
    } finally {
      globalThis.ResizeObserver = previousResizeObserver;
      Reflect.deleteProperty(document, 'elementsFromPoint');
      overlay.remove();
    }
  });

  it('rebuilds unstyled overlay candidates when the native surface resizes into them', async () => {
    const overlap = document.createElement('div');
    document.body.append(overlap);
    const mount = vi.fn(async () => undefined);
    const previousResizeObserver = globalThis.ResizeObserver;
    const observers: CapturingResizeObserver[] = [];
    class CapturingResizeObserver {
      readonly targets = new Set<Element>();
      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    }
    globalThis.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    try {
      render(<BrowserPanel conversationId="chat-1" />);
      await screen.findByText('Example');
      const surface = document.querySelector<HTMLElement>('[data-browser-native-surface]')!;
      vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 40, 400, 300));
      vi.spyOn(overlap, 'getBoundingClientRect').mockReturnValue(new DOMRect(420, 40, 80, 60));
      Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: vi.fn(() => [overlap, surface]),
      });
      const geometryObserver = observers.find((observer) => observer.targets.has(surface));
      expect(geometryObserver).toBeDefined();
      mount.mockClear();

      act(() =>
        geometryObserver!.callback(
          [{ target: surface } as unknown as ResizeObserverEntry],
          geometryObserver as unknown as ResizeObserver,
        ),
      );

      await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', null));
    } finally {
      globalThis.ResizeObserver = previousResizeObserver;
      Reflect.deleteProperty(document, 'elementsFromPoint');
      overlap.remove();
    }
  });

  it('rebuilds geometry candidates when intrinsic media finishes loading', async () => {
    const overlap = document.createElement('div');
    const image = document.createElement('img');
    overlap.append(image);
    document.body.append(overlap);
    const mount = vi.fn(async () => undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    try {
      render(<BrowserPanel conversationId="chat-1" />);
      await screen.findByText('Example');
      const surface = document.querySelector<HTMLElement>('[data-browser-native-surface]')!;
      vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 40, 400, 300));
      vi.spyOn(overlap, 'getBoundingClientRect').mockReturnValue(new DOMRect(420, 40, 80, 60));
      let paintsAbove = false;
      Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: vi.fn(() => (paintsAbove ? [overlap, surface] : [surface, overlap])),
      });
      fireEvent(window, new Event('resize'));
      await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', expect.objectContaining({ width: 400 })));
      mount.mockClear();

      paintsAbove = true;
      fireEvent.load(image);

      await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', null));
    } finally {
      Reflect.deleteProperty(document, 'elementsFromPoint');
      overlap.remove();
    }
  });

  it('detaches when a head stylesheet restyles an existing element above the native view', async () => {
    const overlay = document.createElement('div');
    overlay.className = 'stylesheet-restyled-overlay';
    document.body.append(overlay);
    const style = document.createElement('style');
    style.setAttribute('data-native-overlay-test-style', '');
    style.textContent = '.stylesheet-restyled-overlay { position: static; }';
    document.head.append(style);
    const mount = vi.fn(async () => undefined);
    let paintsAbove = false;
    let requestFrame: ReturnType<typeof vi.spyOn> | undefined;
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    try {
      render(<BrowserPanel conversationId="chat-1" />);
      await screen.findByText('Example');
      const surface = document.querySelector<HTMLElement>('[data-browser-native-surface]');
      expect(surface).not.toBeNull();
      vi.spyOn(surface!, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 40, 400, 300));
      vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(420, 40, 80, 60));
      Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: vi.fn(() => (paintsAbove ? [overlay, surface!] : [surface!, overlay])),
      });

      fireEvent(window, new Event('resize'));
      await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', expect.objectContaining({ width: 400 })));
      mount.mockClear();
      requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 123);
      paintsAbove = true;
      // PluginProvider updates existing plugin style elements in document.head.
      // That must synchronously detach even though body itself did not mutate.
      style.textContent = '.stylesheet-restyled-overlay { position: fixed; }';
      await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', null));
    } finally {
      requestFrame?.mockRestore();
      Reflect.deleteProperty(document, 'elementsFromPoint');
      overlay.remove();
      style.remove();
    }
  });

  it.each([
    ['id', '#plugin-scrim', (element: HTMLElement) => element.setAttribute('id', 'plugin-scrim')],
    [
      'custom data attribute',
      '[data-plugin-layer="open"]',
      (element: HTMLElement) => element.setAttribute('data-plugin-layer', 'open'),
    ],
  ] as const)('detaches when an arbitrary %s mutation reveals an overlay', async (_label, selector, reveal) => {
    const overlay = document.createElement('div');
    document.body.append(overlay);
    const style = document.createElement('style');
    style.setAttribute('data-native-overlay-test-style', '');
    style.textContent = `${selector} { position: fixed; }`;
    document.head.append(style);
    const mount = vi.fn(async () => undefined);
    let paintsAbove = false;
    let requestFrame: ReturnType<typeof vi.spyOn> | undefined;
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    try {
      render(<BrowserPanel conversationId="chat-1" />);
      await screen.findByText('Example');
      const surface = document.querySelector<HTMLElement>('[data-browser-native-surface]');
      expect(surface).not.toBeNull();
      vi.spyOn(surface!, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 40, 400, 300));
      vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(420, 40, 80, 60));
      Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: vi.fn(() => (paintsAbove ? [overlay, surface!] : [surface!, overlay])),
      });

      fireEvent(window, new Event('resize'));
      await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', expect.objectContaining({ width: 400 })));
      mount.mockClear();
      requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 123);
      paintsAbove = true;
      reveal(overlay);
      await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', null));
    } finally {
      requestFrame?.mockRestore();
      Reflect.deleteProperty(document, 'elementsFromPoint');
      overlay.remove();
      style.remove();
    }
  });

  it('detaches before a popover enters the top layer', async () => {
    const popover = document.createElement('div');
    popover.setAttribute('popover', 'auto');
    document.body.append(popover);
    const mount = vi.fn(async () => undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    try {
      render(<BrowserPanel conversationId="chat-1" />);
      await screen.findByText('Example');
      const surface = document.querySelector<HTMLElement>('[data-browser-native-surface]');
      expect(surface).not.toBeNull();
      vi.spyOn(surface!, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 40, 400, 300));
      vi.spyOn(popover, 'getBoundingClientRect').mockReturnValue(new DOMRect(420, 40, 80, 60));
      Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: vi.fn(() => [surface!, popover]),
      });

      fireEvent(window, new Event('resize'));
      await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', expect.objectContaining({ width: 400 })));
      mount.mockClear();
      const opening = new Event('beforetoggle');
      Object.defineProperty(opening, 'newState', { value: 'open' });
      popover.dispatchEvent(opening);
      await waitFor(() => expect(mount).toHaveBeenLastCalledWith('chat-1', null));
    } finally {
      Reflect.deleteProperty(document, 'elementsFromPoint');
      popover.remove();
    }
  });

  it('opens an entered address in a new user tab when no tab is active', async () => {
    const createTab = vi.fn().mockResolvedValue(tab);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [],
          activeTabId: null,
        }),
        createTab,
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText('Address and search bar');
    fireEvent.change(omnibox, { target: { value: 'openai.com' } });
    fireEvent.keyDown(omnibox, { key: 'Enter' });

    await waitFor(() =>
      expect(createTab).toHaveBeenCalledWith({
        conversationId: 'chat-1',
        url: 'openai.com',
        owner: 'user',
      }),
    );
  });

  it('keeps the native surface detached when the browser has no tabs', async () => {
    const createTab = vi.fn().mockResolvedValue(tab);
    const mount = vi.fn(async (_conversationId: string, _bounds: unknown) => undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [],
          activeTabId: null,
        }),
        createTab,
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    expect(await screen.findByText('Open a new tab')).toBeInTheDocument();
    expect(mount.mock.calls.some(([, bounds]) => bounds !== null)).toBe(false);
    expect(createTab).not.toHaveBeenCalled();
  });

  it('keeps one event subscription and deduplicates replayed prompts', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const onEvent = vi.fn((callback: (event: BrowserEvent) => void) => {
      emit = callback;
      return vi.fn();
    });
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent,
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    const prompt: BrowserEvent = {
      type: 'credential-prompt',
      conversationId: 'chat-1',
      prompt: {
        id: 'prompt-1',
        tabId: tab.id,
        origin: 'https://example.com',
        username: 'alice',
        update: false,
      },
    };
    act(() => {
      emit?.(prompt);
      emit?.(prompt);
    });

    expect(screen.getAllByText('Save password for alice at https://example.com?')).toHaveLength(1);
    act(() => {
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-1',
        promptId: 'prompt-1',
        promptKind: 'credential',
      });
    });
    expect(screen.queryByText(/Save password for alice/)).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText('Address and search bar'), {
      key: 'f',
      ctrlKey: true,
    });
    fireEvent.change(await screen.findByPlaceholderText('Find in page'), {
      target: { value: 'needle' },
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('hydrates prompts and live AI actions that began before the panel mounted', async () => {
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
          permissionPrompts: [
            {
              id: 'permission-before-mount',
              tabId: tab.id,
              origin: 'https://example.com',
              permission: 'camera',
              assistantTriggered: false,
            },
          ],
          runningActions: [
            {
              id: 'action-before-mount',
              tabId: tab.id,
              kind: 'scroll' as const,
              status: 'running' as const,
              startedAt: '2026-01-01T00:00:00.000Z',
              summary: 'scrolling',
            },
          ],
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);

    expect(await screen.findByRole('alertdialog', { name: 'Browser permission request for camera' })).toHaveTextContent(
      'Allow https://example.com to use camera?',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Kai · scrolling');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('shows live AI status only for the tab currently presented in the sidebar', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const backgroundTab: BrowserTab = {
      ...tab,
      id: '00000000-0000-0000-0000-000000000002',
      title: 'Background',
      active: false,
    };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab, backgroundTab],
          activeTabId: tab.id,
          runningActions: [
            {
              id: 'background-action',
              tabId: backgroundTab.id,
              kind: 'scroll' as const,
              status: 'running' as const,
              startedAt: '2026-01-01T00:00:00.000Z',
              summary: 'scrolling elsewhere',
            },
          ],
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByLabelText('Address and search bar');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'action',
        conversationId: 'chat-1',
        action: {
          id: 'visible-action',
          tabId: tab.id,
          kind: 'click',
          status: 'running',
          startedAt: '2026-01-01T00:00:01.000Z',
          summary: 'clicking here',
        },
      });
    });

    expect(screen.getByRole('status')).toHaveTextContent('Kai · clicking here');
  });

  it('identifies file-system targets and offers request-scoped access only', async () => {
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
          permissionPrompts: [
            {
              id: 'file-permission',
              tabId: tab.id,
              origin: 'https://example.com',
              permission: 'file system (readable file)',
              target: 'File: /Users/alice/Documents/taxes.pdf',
              canPersist: false,
              assistantTriggered: false,
            },
          ],
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);

    expect(await screen.findByText('File: /Users/alice/Documents/taxes.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument();
  });

  it('shows the exact external-app destination and offers request-scoped access only', async () => {
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
          permissionPrompts: [
            {
              id: 'external-permission',
              tabId: tab.id,
              origin: 'https://example.com',
              permission: 'openExternal',
              target: 'External URL: https://outside.example/login?continue=%2Faccount',
              canPersist: false,
              assistantTriggered: false,
            },
          ],
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);

    expect(
      await screen.findByText('External URL: https://outside.example/login?continue=%2Faccount'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument();
  });

  it('announces blocking prompts and auto-focuses only user-triggered response controls', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const setChromeFocus = vi.fn().mockResolvedValue(undefined);
    const respondCredentialPrompt = vi.fn().mockResolvedValue(undefined);
    const respondPermissionPrompt = vi.fn().mockResolvedValue(undefined);
    const respondAuthPrompt = vi.fn().mockResolvedValue(undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        setChromeFocus,
        respondCredentialPrompt,
        respondPermissionPrompt,
        respondAuthPrompt,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    act(() => {
      emit?.({
        type: 'credential-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'credential-focus',
          tabId: tab.id,
          origin: 'https://example.com',
          username: 'alice',
          update: false,
        },
      });
    });
    expect(screen.getByRole('alertdialog', { name: 'Save browser password' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Not now' })).toHaveFocus());

    act(() => {
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'permission-focus',
          tabId: tab.id,
          origin: 'https://example.com',
          permission: 'camera',
          assistantTriggered: false,
        },
      });
    });
    expect(screen.getByRole('alertdialog', { name: 'Browser permission request for camera' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Block' })).toHaveFocus());

    act(() => {
      emit?.({
        type: 'auth-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'auth-focus',
          tabId: tab.id,
          host: 'secure.example',
          endpoint: 'https://secure.example:443',
          authScheme: 'basic',
          isProxy: false,
          assistantTriggered: true,
        },
      });
    });
    expect(screen.getByRole('alertdialog', { name: 'Browser authentication required' })).toBeInTheDocument();
    expect(screen.getByText(/Verify this endpoint before sending credentials/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Block' })).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toHaveFocus();
    expect(screen.queryByPlaceholderText('Username')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Save browser password' })).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Enter credentials' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Username')).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Browser authentication required' })).toBeNull(),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Block' })).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Browser permission request for camera' })).toBeNull(),
    );
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Example' })).toHaveFocus());
    expect(setChromeFocus).toHaveBeenCalledWith('chat-1', true);
  });

  it('does not steal focus from controls outside the Browser panel when a background prompt arrives', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    const modalControl = document.createElement('button');
    modalControl.textContent = 'Modal control';
    document.body.append(modalControl);

    try {
      render(<BrowserPanel conversationId="chat-1" />);
      await screen.findByText('Example');
      modalControl.focus();
      act(() => {
        emit?.({
          type: 'auth-prompt',
          conversationId: 'chat-1',
          prompt: {
            id: 'background-auth',
            tabId: tab.id,
            host: 'secure.example',
            endpoint: 'https://secure.example:443',
            authScheme: 'basic',
            isProxy: false,
            assistantTriggered: false,
          },
        });
      });
      await screen.findByRole('alertdialog', { name: 'Browser authentication required' });
      await act(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );

      expect(modalControl).toHaveFocus();
      expect(screen.getByRole('button', { name: 'Cancel' })).not.toHaveFocus();
    } finally {
      modalControl.remove();
    }
  });

  it('resets queued credential and permission prompt controls when the prompt id changes', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const respondCredentialPrompt = vi.fn(() => new Promise<void>(() => undefined));
    const respondPermissionPrompt = vi.fn(() => new Promise<void>(() => undefined));
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        respondCredentialPrompt,
        respondPermissionPrompt,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    act(() => {
      emit?.({
        type: 'credential-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'credential-1',
          tabId: tab.id,
          origin: 'https://one.example',
          username: 'alice',
          update: false,
        },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    act(() => {
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-1',
        promptId: 'credential-1',
        promptKind: 'credential',
      });
      emit?.({
        type: 'credential-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'credential-2',
          tabId: tab.id,
          origin: 'https://two.example',
          username: 'bob',
          update: false,
        },
      });
    });
    expect(screen.getByText('Save password for bob at https://two.example?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    act(() => {
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-1',
        promptId: 'credential-2',
        promptKind: 'credential',
      });
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'permission-1',
          tabId: tab.id,
          origin: 'https://one.example',
          permission: 'camera',
          assistantTriggered: false,
        },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();

    act(() => {
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-1',
        promptId: 'permission-1',
        promptKind: 'permission',
      });
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'permission-2',
          tabId: tab.id,
          origin: 'https://two.example',
          permission: 'microphone',
          assistantTriggered: false,
        },
      });
    });
    expect(screen.getByText('Allow https://two.example to use microphone?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
  });

  it('surfaces asynchronous browser-profile persistence errors', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    act(() => {
      emit?.({
        type: 'profile-error',
        conversationId: 'chat-1',
        area: 'history',
        message: 'Browsing history could not be saved: disk full',
      });
    });

    expect(screen.getByText('Browsing history could not be saved: disk full')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Browsing history could not be saved: disk full');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss browser error' }));
    expect(screen.queryByText('Browsing history could not be saved: disk full')).not.toBeInTheDocument();
  });

  it('wraps full origins in password and permission prompts instead of truncating security context', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const origin = 'https://accounts.example.com.lookalike.invalid:8443';
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    act(() => {
      emit?.({
        type: 'credential-prompt',
        conversationId: 'chat-1',
        prompt: { id: 'credential-origin', tabId: tab.id, origin, username: 'alice', update: false },
      });
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'permission-origin',
          tabId: tab.id,
          origin,
          permission: 'camera',
          assistantTriggered: false,
        },
      });
    });

    const passwordMessage = screen.getByText(`Save password for alice at ${origin}?`);
    const permissionMessage = screen.getByText(`Allow ${origin} to use camera?`);
    expect(passwordMessage).toHaveClass('break-all');
    expect(passwordMessage).not.toHaveClass('truncate');
    expect(permissionMessage).toHaveClass('break-all');
    expect(permissionMessage).not.toHaveClass('truncate');
  });

  it('keeps a long HTTP-auth endpoint complete, bounded, and left-to-right', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const endpoint = `https://${'very-long-host-label-'.repeat(12)}secure.example:443`;
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');

    act(() => {
      emit?.({
        type: 'auth-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'auth-long-host',
          tabId: tab.id,
          host: 'secure.example',
          endpoint,
          authScheme: 'basic',
          isProxy: false,
          assistantTriggered: false,
        },
      });
    });

    const securityContext = screen.getByText(`${endpoint} · basic`);
    expect(securityContext).toHaveTextContent(endpoint);
    expect(securityContext).toHaveClass('min-w-0', 'max-w-full', 'break-all', '[overflow-wrap:anywhere]');
    expect(securityContext).toHaveAttribute('dir', 'ltr');
    expect(securityContext).not.toHaveClass('truncate');
  });

  it('updates an open permission prompt when assistant control begins', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');

    act(() => {
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'permission-ai',
          tabId: tab.id,
          origin: 'https://example.com',
          permission: 'camera',
          assistantTriggered: false,
        },
      });
    });

    const prompt = screen.getByRole('alertdialog', { name: 'Browser permission request for camera' });
    expect(prompt).not.toHaveTextContent('AI requested:');
    expect(prompt).not.toHaveTextContent('Future AI requests will ask again.');

    act(() => {
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'permission-ai',
          tabId: tab.id,
          origin: 'https://example.com',
          permission: 'camera',
          canPersist: false,
          assistantTriggered: true,
        },
      });
    });

    expect(prompt).toHaveTextContent('AI requested: Allow https://example.com to use camera?');
    expect(prompt).toHaveTextContent('This approval applies to this request. Future AI requests will ask again.');
    expect(within(prompt).queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(within(prompt).getByRole('button', { name: 'Allow once' })).toBeInTheDocument();
    expect(within(prompt).getByRole('button', { name: 'Block' })).toBeInTheDocument();
  });

  it('ignores state and bookmark responses from a previously selected chat', async () => {
    const stateA = deferred<{
      conversationId: string;
      tabs: BrowserTab[];
      activeTabId: string | null;
    }>();
    const bookmarksA = deferred<[]>();
    const tabB = {
      ...tab,
      id: '00000000-0000-0000-0000-000000000002',
      conversationId: 'chat-2',
      title: 'Chat B',
    };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: (conversationId: string) =>
          conversationId === 'chat-1'
            ? stateA.promise
            : Promise.resolve({
                conversationId: 'chat-2',
                tabs: [tabB],
                activeTabId: tabB.id,
              }),
        listBookmarks: (conversationId: string) =>
          conversationId === 'chat-1' ? bookmarksA.promise : Promise.resolve([]),
        listHistory: async () => [],
        mount: async () => undefined,
      },
    });

    const rendered = render(<BrowserPanel conversationId="chat-1" />);
    rendered.rerender(<BrowserPanel conversationId="chat-2" />);
    expect(await screen.findByText('Chat B')).toBeInTheDocument();

    stateA.resolve({
      conversationId: 'chat-1',
      tabs: [{ ...tab, title: 'Stale Chat A' }],
      activeTabId: tab.id,
    });
    bookmarksA.resolve([]);
    await act(async () => {
      await Promise.all([stateA.promise, bookmarksA.promise]);
    });

    expect(screen.queryByText('Stale Chat A')).not.toBeInTheDocument();
    expect(screen.getByText('Chat B')).toBeInTheDocument();
  });

  it('does not carry a focused omnibox draft into another chat', async () => {
    const tabB = {
      ...tab,
      id: '00000000-0000-0000-0000-000000000002',
      conversationId: 'chat-2',
      title: 'Chat B',
      url: 'https://chat-b.example/',
    };
    const navigate = vi.fn(async () => undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async (conversationId: string) =>
          conversationId === 'chat-1'
            ? { conversationId, tabs: [tab], activeTabId: tab.id }
            : { conversationId, tabs: [tabB], activeTabId: tabB.id },
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        navigate,
      },
    });

    const rendered = render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText('Address and search bar');
    fireEvent.focus(omnibox);
    fireEvent.change(omnibox, {
      target: { value: 'https://old-chat.example/private' },
    });

    rendered.rerender(<BrowserPanel conversationId="chat-2" />);
    await waitFor(() => expect(screen.getByLabelText('Address and search bar')).toHaveValue(tabB.url));
    fireEvent.keyDown(screen.getByLabelText('Address and search bar'), {
      key: 'Enter',
    });

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('chat-2', tabB.id, tabB.url));
    expect(navigate).not.toHaveBeenCalledWith('chat-2', tabB.id, 'https://old-chat.example/private');
  });

  it('rekeys the browser panel before rendering another chat so revealed passwords cannot carry over', async () => {
    const tabB = {
      ...tab,
      id: '00000000-0000-0000-0000-000000000002',
      conversationId: 'chat-2',
      title: 'Chat B',
      url: 'https://chat-b.example/',
    };
    const credential = {
      id: 'credential-1',
      scopeKey: 'global',
      origin: 'https://example.com',
      username: 'alice',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async (conversationId: string) =>
          conversationId === 'chat-1'
            ? { conversationId, tabs: [tab], activeTabId: tab.id }
            : { conversationId, tabs: [tabB], activeTabId: tabB.id },
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listCredentials: async () => [credential],
        revealCredential: async () => 'chat-a-secret',
      },
    });

    const rendered = render(<BrowserPanel conversationId="chat-1" />);
    const firstOmnibox = await screen.findByLabelText('Address and search bar');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('Passwords'));
    await screen.findByText('alice');
    fireEvent.click(screen.getByTitle('Reveal with Touch ID'));
    expect(await screen.findByText('chat-a-secret')).toBeInTheDocument();
    const revealed = screen.getByLabelText('Revealed password');
    expect(revealed).toHaveClass('break-all', 'overflow-auto');
    expect(revealed).not.toHaveClass('truncate');

    rendered.rerender(<BrowserPanel conversationId="chat-2" />);

    const secondOmnibox = await screen.findByLabelText('Address and search bar');
    expect(secondOmnibox).not.toBe(firstOmnibox);
    expect(screen.queryByText('chat-a-secret')).not.toBeInTheDocument();
  });

  it('drops profile-derived manager state after the applied browser data scope changes', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    let profile: 'global' | 'conversation' = 'global';
    const globalCredential = {
      id: 'credential-global',
      scopeKey: 'global',
      origin: 'https://global.example',
      username: 'global-user',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const conversationCredential = {
      ...globalCredential,
      id: 'credential-conversation',
      scopeKey: 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
      origin: 'https://conversation.example',
      username: 'conversation-user',
    };
    const listCredentials = vi.fn(async () => (profile === 'global' ? [globalCredential] : [conversationCredential]));
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listCredentials,
        revealCredential: async () => 'global-profile-secret',
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('Passwords'));
    await screen.findByText('global-user');
    fireEvent.click(screen.getByTitle('Reveal with Touch ID'));
    expect(await screen.findByText('global-profile-secret')).toBeInTheDocument();

    profile = 'conversation';
    act(() => {
      emit?.({
        type: 'profile-scope-changed',
        dataScope: 'conversation',
      });
    });

    expect(screen.queryByText('global-profile-secret')).not.toBeInTheDocument();
    expect(screen.queryByText('global-user')).not.toBeInTheDocument();
    expect(await screen.findByText('conversation-user')).toBeInTheDocument();
    expect(listCredentials).toHaveBeenCalledTimes(2);
  });

  it('clears the live AI action indicator when switching chats', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const tabB = {
      ...tab,
      id: '00000000-0000-0000-0000-000000000002',
      conversationId: 'chat-2',
      title: 'Chat B',
    };
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async (conversationId: string) =>
          conversationId === 'chat-1'
            ? { conversationId, tabs: [tab], activeTabId: tab.id }
            : { conversationId, tabs: [tabB], activeTabId: tabB.id },
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });

    const rendered = render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    act(() => {
      emit?.({
        type: 'action',
        conversationId: 'chat-1',
        action: {
          id: 'action-1',
          tabId: tab.id,
          kind: 'click',
          status: 'running',
          startedAt: '2026-01-01T00:00:00.000Z',
          summary: 'click',
        },
      });
    });
    expect(screen.getByText('Kai · click')).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'action',
        conversationId: 'chat-1',
        action: {
          id: 'action-2',
          tabId: tab.id,
          kind: 'scroll',
          status: 'running',
          startedAt: '2026-01-01T00:00:01.000Z',
          summary: 'scroll',
        },
      });
    });
    expect(screen.getByText('Kai · 2 actions')).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'action',
        conversationId: 'chat-1',
        action: {
          id: 'action-1',
          tabId: tab.id,
          kind: 'click',
          status: 'completed',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:02.000Z',
          summary: 'click',
        },
      });
    });
    expect(screen.getByText('Kai · scroll')).toBeInTheDocument();

    rendered.rerender(<BrowserPanel conversationId="chat-2" />);
    await screen.findByText('Chat B');
    expect(screen.queryByText('Kai · scroll')).not.toBeInTheDocument();
  });

  it('scrolls a newly active tab into view without moving keyboard focus', async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      let emit: ((event: BrowserEvent) => void) | undefined;
      const secondTab = {
        ...tab,
        id: '00000000-0000-0000-0000-000000000002',
        title: 'Second tab',
        active: false,
      };
      installAppBridgeStub({
        browser: {
          available: async () => true,
          getState: async () => ({
            conversationId: 'chat-1',
            tabs: [tab, secondTab],
            activeTabId: tab.id,
          }),
          mount: async () => undefined,
          listBookmarks: async () => [],
          listHistory: async () => [],
          onEvent: (callback: (event: BrowserEvent) => void) => {
            emit = callback;
            return vi.fn();
          },
        },
      });

      render(<BrowserPanel conversationId="chat-1" />);
      await screen.findByRole('tab', { name: 'Second tab' });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      scrollIntoView.mockClear();

      act(() => {
        emit?.({
          type: 'tabs-changed',
          conversationId: 'chat-1',
          tabs: [
            { ...tab, active: false },
            { ...secondTab, active: true },
          ],
        });
      });

      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' }));
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(screen.getByRole('tab', { name: 'Second tab' }));
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    }
  });

  it('keeps a password-save prompt open and reports secure-storage failures', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const respondCredentialPrompt = vi.fn().mockRejectedValue(new Error('Secure OS encryption unavailable'));
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        respondCredentialPrompt,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    act(() => {
      emit?.({
        type: 'credential-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'prompt-save-failure',
          tabId: tab.id,
          origin: 'https://example.com',
          username: 'alice',
          update: false,
        },
      });
    });

    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('Secure OS encryption unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Save password for alice/)).toBeInTheDocument();
    expect(respondCredentialPrompt).toHaveBeenCalledWith('prompt-save-failure', true);
  });

  it('refreshes an already-open Passwords manager after accepting a save prompt', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    let saved = false;
    const existing = {
      id: 'credential-existing',
      scopeKey: 'global',
      origin: 'https://example.com',
      username: 'alice',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const added = {
      ...existing,
      id: 'credential-added',
      origin: 'https://saved.example',
      username: 'bob',
    };
    const listCredentials = vi.fn(async () => (saved ? [existing, added] : [existing]));
    const respondCredentialPrompt = vi.fn(async (_id: string, save: boolean) => {
      saved = save;
    });
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        listCredentials,
        credentialAuthenticationAvailable: async () => true,
        respondCredentialPrompt,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('Passwords'));
    await screen.findByText('alice');

    act(() => {
      emit?.({
        type: 'credential-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'prompt-save-refresh',
          tabId: tab.id,
          origin: added.origin,
          username: added.username,
          update: false,
        },
      });
    });
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('bob')).toBeInTheDocument();
    expect(respondCredentialPrompt).toHaveBeenCalledWith('prompt-save-refresh', true);
    expect(listCredentials).toHaveBeenCalledTimes(2);
  });

  it('dismisses password prompts by id and labels a one-time decline accurately', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const respondCredentialPrompt = vi.fn(async (id: string) => {
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-1',
        promptId: id,
        promptKind: 'credential',
      });
    });
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        respondCredentialPrompt,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    act(() => {
      emit?.({
        type: 'credential-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'credential-1',
          tabId: tab.id,
          origin: 'https://one.example',
          username: 'alice',
          update: false,
        },
      });
      emit?.({
        type: 'credential-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'credential-2',
          tabId: tab.id,
          origin: 'https://two.example',
          username: 'bob',
          update: false,
        },
      });
    });

    fireEvent.click(screen.getByText('Not now'));

    expect(await screen.findByText(/Save password for bob/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Not now')).toHaveFocus());
    expect(respondCredentialPrompt).toHaveBeenCalledWith('credential-1', false);
    fireEvent.click(screen.getByText('Not now'));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Example' })).toHaveFocus());
  });

  it('keeps permission and HTTP-auth prompts available when their response fails', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const respondPermissionPrompt = vi.fn().mockRejectedValue(new Error('Permission storage unavailable'));
    const respondAuthPrompt = vi.fn().mockRejectedValue(new Error('Authentication input rejected'));
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        respondPermissionPrompt,
        respondAuthPrompt,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    act(() => {
      emit?.({
        type: 'permission-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'permission-1',
          tabId: tab.id,
          origin: 'https://example.com',
          permission: 'camera',
          assistantTriggered: false,
        },
      });
      emit?.({
        type: 'auth-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'auth-retry',
          tabId: tab.id,
          host: 'secure.example',
          endpoint: 'https://secure.example:443',
          authScheme: 'basic',
          isProxy: false,
          assistantTriggered: false,
        },
      });
    });

    fireEvent.click(screen.getByText('Allow'));
    expect(await screen.findByText('Permission storage unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Allow https:\/\/example.com to use camera/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Enter credentials' }));
    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: 'alice' },
    });
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByText('Sign in'));
    expect(await screen.findByText('Authentication input rejected')).toBeInTheDocument();
    expect(screen.getByText('https://secure.example:443 · basic')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Username')).toHaveValue('alice');
  });

  it('refreshes bookmarks and remounts an open manager after profile data is cleared', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const listBookmarks = vi.fn().mockResolvedValue([]);
    const listHistory = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'history-1',
          scopeKey: 'global',
          title: 'Before clear',
          url: 'https://example.com',
          visitedAt: '2026-01-01T00:00:00.000Z',
        },
      ])
      .mockResolvedValue([]);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks,
        listHistory,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('History'));
    expect(await screen.findByText('Before clear')).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'download',
        conversationId: 'chat-1',
        download: {
          id: 'download-1',
          tabId: tab.id,
          filename: 'private-report.pdf',
          receivedBytes: 10,
          totalBytes: 10,
          state: 'completed',
          path: '/tmp/private-report.pdf',
        },
      });
    });
    expect(screen.getByText(/private-report\.pdf/)).toBeInTheDocument();

    act(() => {
      emit?.({
        type: 'profile-data-cleared',
        conversationId: 'chat-1',
        scopeKeys: ['global'],
      });
    });

    await waitFor(() => expect(listHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listBookmarks).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Before clear')).not.toBeInTheDocument();
    expect(screen.queryByText(/private-report\.pdf/)).not.toBeInTheDocument();
  });

  it('ignores page-data lookups that resolve after the active profile is cleared', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const pendingHistory = deferred<BrowserHistoryEntry[]>();
    const pendingBookmarks = deferred<BrowserBookmark[]>();
    const pendingPermissions = deferred<BrowserSitePermission[]>();
    const listHistory = vi.fn(() => pendingHistory.promise);
    const listBookmarks = vi.fn((_conversationId: string, query?: string) =>
      query ? pendingBookmarks.promise : Promise.resolve([]),
    );
    const listSitePermissions = vi.fn(() => pendingPermissions.promise);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks,
        listHistory,
        listSitePermissions,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');

    fireEvent.click(screen.getByTitle('Site information'));
    await waitFor(() => expect(listSitePermissions).toHaveBeenCalledOnce());
    const omnibox = screen.getByLabelText<HTMLInputElement>('Address and search bar');
    fireEvent.focus(omnibox);
    fireEvent.change(omnibox, { target: { value: 'before-clear' } });
    await waitFor(() => expect(listHistory).toHaveBeenCalled());

    act(() => {
      emit?.({
        type: 'profile-data-cleared',
        conversationId: 'chat-1',
        scopeKeys: ['global'],
      });
    });

    await act(async () => {
      pendingHistory.resolve([
        {
          id: 'history-stale',
          scopeKey: 'global',
          title: 'Stale history result',
          url: 'https://history-stale.example',
          visitedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      pendingBookmarks.resolve([
        {
          id: 'bookmark-stale',
          scopeKey: 'global',
          title: 'Stale bookmark result',
          url: 'https://bookmark-stale.example',
          folder: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      pendingPermissions.resolve([
        {
          origin: 'https://example.com',
          permission: 'media:audio',
          decision: 'allow',
        },
      ]);
      await Promise.all([pendingHistory.promise, pendingBookmarks.promise, pendingPermissions.promise]);
    });

    expect(screen.queryByRole('option', { name: /Stale history result/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Stale bookmark result/ })).not.toBeInTheDocument();
    expect(screen.queryByText('media:audio')).not.toBeInTheDocument();
  });

  it('remounts the native page after its live profile data is cleared', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const mount = vi.fn().mockResolvedValue(undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await waitFor(() =>
      expect(mount).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
        }),
      ),
    );
    mount.mockClear();

    act(() =>
      emit?.({
        type: 'profile-data-cleared',
        conversationId: 'chat-1',
        scopeKeys: ['global'],
      }),
    );

    await waitFor(() => expect(mount).toHaveBeenCalledWith('chat-1', null));
    await waitFor(() =>
      expect(mount).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
        }),
      ),
    );
  });

  it('refreshes an open bookmarks manager when bookmarks change', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const bookmark = {
      id: 'bookmark-1',
      scopeKey: 'global',
      title: 'Fresh bookmark',
      url: 'https://fresh.example',
      folder: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const listBookmarks = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([bookmark]);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks,
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('Bookmarks'));
    expect(await screen.findByText('Nothing here yet.')).toBeInTheDocument();

    act(() => emit?.({ type: 'bookmarks-changed', conversationId: 'chat-1' }));

    expect(await screen.findByText('Fresh bookmark')).toBeInTheDocument();
    expect(listBookmarks).toHaveBeenCalledTimes(4);
  });

  it('routes shortcuts only when focus belongs to the browser panel', async () => {
    const createTab = vi.fn().mockResolvedValue(tab);
    const setChromeFocus = vi.fn().mockResolvedValue(undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        createTab,
        setChromeFocus,
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(
      <>
        <input aria-label="Chat composer" />
        <BrowserPanel conversationId="chat-1" />
      </>,
    );
    const composer = await screen.findByLabelText('Chat composer');
    const omnibox = await screen.findByLabelText('Address and search bar');

    act(() => omnibox.focus());
    await waitFor(() => expect(setChromeFocus).toHaveBeenCalledWith('chat-1', true));
    act(() => composer.focus());
    await waitFor(() => expect(setChromeFocus).toHaveBeenCalledWith('chat-1', false));

    fireEvent.keyDown(composer, { key: 't', ctrlKey: true });
    expect(createTab).not.toHaveBeenCalled();
    fireEvent.keyDown(omnibox, { key: 't', ctrlKey: true });
    await waitFor(() => expect(createTab).toHaveBeenCalledTimes(1));
  });

  it('preserves macOS Control editing chords and reserves browser shortcuts for Command', async () => {
    const createTab = vi.fn().mockResolvedValue(tab);
    const commandTab = vi.fn().mockResolvedValue(undefined);
    installAppBridgeStub({
      platform: { os: 'darwin', homedir: async () => '/Users/test' },
      browser: {
        available: async () => true,
        getState: async () => ({ conversationId: 'chat-1', tabs: [tab], activeTabId: tab.id }),
        createTab,
        commandTab,
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText('Address and search bar');

    expect(fireEvent.keyDown(omnibox, { key: 't', ctrlKey: true })).toBe(true);
    expect(createTab).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(omnibox, { key: 't', metaKey: true })).toBe(false);
    await waitFor(() => expect(createTab).toHaveBeenCalledOnce());
    expect(fireEvent.keyDown(omnibox, { key: 'ArrowLeft', altKey: true })).toBe(true);
    expect(fireEvent.keyDown(omnibox, { key: 'ArrowLeft', metaKey: true })).toBe(true);
    expect(commandTab).not.toHaveBeenCalled();
  });

  it('tracks rapid zoom shortcuts optimistically instead of repeating a stale level', async () => {
    const setZoom = vi.fn(async (_conversationId: string, _tabId: string, level: number) => level);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        setZoom,
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const trigger = await screen.findByTitle('New tab (⌘/Ctrl+T)');
    trigger.focus();
    await act(async () => undefined);

    act(() => {
      fireEvent.keyDown(trigger, { key: '+', ctrlKey: true });
      fireEvent.keyDown(trigger, { key: '+', ctrlKey: true });
    });

    expect(setZoom).toHaveBeenNthCalledWith(1, 'chat-1', tab.id, 0.5);
    expect(setZoom).toHaveBeenNthCalledWith(2, 'chat-1', tab.id, 1);
  });

  it('focuses and selects the omnibox for Ctrl+L and after opening a blank user tab', async () => {
    const createTab = vi.fn().mockResolvedValue(tab);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        createTab,
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    const omnibox = await screen.findByLabelText<HTMLInputElement>('Address and search bar');
    const newTab = screen.getByTitle('New tab (⌘/Ctrl+T)');

    newTab.focus();
    fireEvent.keyDown(newTab, { key: 'l', ctrlKey: true });
    await waitFor(() => expect(omnibox).toHaveFocus());
    await waitFor(() => expect(omnibox.selectionStart).toBe(0));
    expect(omnibox.selectionEnd).toBe(omnibox.value.length);

    newTab.focus();
    fireEvent.click(newTab);
    await waitFor(() => expect(createTab).toHaveBeenCalledOnce());
    await waitFor(() => expect(omnibox).toHaveFocus());
  });

  it('focuses renderer Browser controls for shortcuts emitted by the native page', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');

    act(() =>
      emit?.({
        type: 'shortcut',
        conversationId: 'chat-1',
        action: 'focus-url',
      }),
    );
    await waitFor(() => expect(screen.getByLabelText('Address and search bar')).toHaveFocus());

    act(() => emit?.({ type: 'shortcut', conversationId: 'chat-1', action: 'find' }));
    const findInput = await screen.findByPlaceholderText('Find in page');
    await waitFor(() => expect(findInput).toHaveFocus());

    screen.getByTitle('Browser menu').focus();
    act(() => emit?.({ type: 'shortcut', conversationId: 'chat-1', action: 'find' }));
    await waitFor(() => expect(findInput).toHaveFocus());
    fireEvent.click(screen.getByTitle('Close find'));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Example' })).toHaveFocus());
  });

  it('removes expired auth prompts and resets credentials when the prompt changes', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const respondAuthPrompt = vi.fn().mockResolvedValue(undefined);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        respondAuthPrompt,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
    });
    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    act(() => {
      emit?.({
        type: 'auth-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'auth-1',
          tabId: tab.id,
          host: 'one.example',
          endpoint: 'https://one.example:443',
          authScheme: 'basic',
          isProxy: false,
          assistantTriggered: false,
        },
      });
    });
    const firstPrompt = screen.getByRole('alertdialog', { name: 'Browser authentication required' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    fireEvent.submit(firstPrompt);
    expect(respondAuthPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Enter credentials' }));
    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: 'alice' },
    });
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'secret' },
    });

    act(() => {
      emit?.({
        type: 'prompt-dismissed',
        conversationId: 'chat-1',
        promptId: 'auth-1',
        promptKind: 'auth',
      });
      emit?.({
        type: 'auth-prompt',
        conversationId: 'chat-1',
        prompt: {
          id: 'auth-2',
          tabId: tab.id,
          host: 'two.example',
          endpoint: 'proxy://two.example:8080',
          authScheme: 'basic',
          isProxy: true,
          assistantTriggered: false,
        },
      });
    });

    expect(await screen.findByText('Proxy authentication · proxy://two.example:8080 · basic')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Username')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Enter credentials' }));
    expect(screen.getByPlaceholderText('Username')).toHaveValue('');
    expect(screen.getByPlaceholderText('Password')).toHaveValue('');
    fireEvent.click(screen.getByText('Cancel'));
    expect(respondAuthPrompt).toHaveBeenCalledWith('auth-2', undefined, undefined);
  });

  it('surfaces browser data-clear failures from the sidebar menu', async () => {
    const clearData = vi.fn().mockRejectedValue(new Error('Profile storage is busy'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [],
        clearData,
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('Clear browser data…'));

    expect(await screen.findByText('Profile storage is busy')).toBeInTheDocument();
    expect(clearData).toHaveBeenCalledWith({ conversationId: 'chat-1' });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/unexported assistant download quarantine copies/i));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/already exported or saved remain on disk/i));
  });

  it('confirms that History clear removes the complete profile history', async () => {
    const clearHistory = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    installAppBridgeStub({
      browser: {
        available: async () => true,
        getState: async () => ({
          conversationId: 'chat-1',
          tabs: [tab],
          activeTabId: tab.id,
        }),
        mount: async () => undefined,
        listBookmarks: async () => [],
        listHistory: async () => [
          {
            id: 'history-1',
            scopeKey: 'global',
            title: 'Result',
            url: 'https://example.com/result',
            visitedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        clearHistory,
      },
    });

    render(<BrowserPanel conversationId="chat-1" />);
    await screen.findByText('Example');
    await openBrowserMenu();
    fireEvent.click(screen.getByText('History'));
    const clear = await screen.findByRole('button', { name: 'Clear' });
    fireEvent.click(clear);
    expect(clearHistory).not.toHaveBeenCalled();
    fireEvent.click(clear);
    await waitFor(() => expect(clearHistory).toHaveBeenCalledWith('chat-1'));
    expect(confirm).toHaveBeenCalledWith('Clear all browsing history for this browser profile? This cannot be undone.');
  });
});
