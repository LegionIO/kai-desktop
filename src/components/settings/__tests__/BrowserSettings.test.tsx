import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserDataSummary, BrowserEvent } from '../../../../shared/browser';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { BrowserSettings } from '../BrowserSettings';

afterEach(() => {
  uninstallAppBridgeStub();
  vi.restoreAllMocks();
});

describe('BrowserSettings data management', () => {
  it('keeps plugin browser data controls available in web clients', async () => {
    const listPartitions = vi.fn(async () => []);
    installAppBridgeStub({
      browser: undefined,
      partitions: { list: listPartitions, delete: vi.fn(async () => ({ success: true, deleted: [] })) },
    });
    const updateConfig = vi.fn();

    render(<BrowserSettings config={{ browser: {} }} updateConfig={updateConfig} conversationId="chat-1" />);

    expect(
      screen.getByText(/In-app Browser settings and profile data management are available in the Kai desktop app only/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Browser data scope')).not.toBeInTheDocument();
    expect(screen.getByText('Plugin Browser Data')).toBeInTheDocument();
    await waitFor(() => expect(listPartitions).toHaveBeenCalledOnce());
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('associates every Browser policy label with its select control', async () => {
    installAppBridgeStub({ partitions: { list: async () => [] } });
    render(<BrowserSettings config={{ browser: {} }} updateConfig={vi.fn()} conversationId="chat-1" />);

    expect(screen.getByLabelText('Browser data scope')).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByLabelText('Omnibox search provider')).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByLabelText('Tab listing, page inspection, screenshots, and network diagnostics')).toBeInstanceOf(
      HTMLSelectElement,
    );
    expect(screen.getByLabelText('Clicks, typing, scrolling, and navigation')).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByLabelText('Injected JavaScript')).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByLabelText('AI saved-password access')).toBeInstanceOf(HTMLSelectElement);
    await waitFor(() => expect(screen.queryByText('Loading profiles…')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('Loading partitions...')).not.toBeInTheDocument());
  });

  it('persists the independent AI Browser read policy', async () => {
    installAppBridgeStub({ partitions: { list: async () => [] } });
    const updateConfig = vi.fn(async () => undefined);
    render(
      <BrowserSettings
        config={{ browser: { readAccess: 'allow' } }}
        updateConfig={updateConfig}
        conversationId="chat-1"
      />,
    );

    fireEvent.change(screen.getByLabelText('Tab listing, page inspection, screenshots, and network diagnostics'), {
      target: { value: 'ask' },
    });

    expect(updateConfig).toHaveBeenCalledWith('browser.readAccess', 'ask');
    await waitFor(() => expect(screen.queryByText('Loading profiles…')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('Loading partitions...')).not.toBeInTheDocument());
  });

  it('shows initial profile-load failures without an unhandled rejection', async () => {
    installAppBridgeStub({
      conversations: { getActiveId: async () => 'chat-1' },
      browser: {
        dataSummary: async () => Promise.reject(new Error('Profile metadata is unreadable')),
      },
      partitions: { list: async () => [] },
    });

    render(<BrowserSettings config={{ browser: {} }} updateConfig={vi.fn()} conversationId="chat-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Browser data could not be loaded: Profile metadata is unreadable',
    );
  });

  it("uses this window's selected chat instead of the backend-global active chat", async () => {
    const getActiveId = vi.fn(async () => 'other-client-chat');
    const dataSummary = vi.fn(async () => []);
    installAppBridgeStub({
      conversations: { getActiveId },
      browser: { dataSummary },
      partitions: { list: async () => [] },
    });

    render(<BrowserSettings config={{ browser: {} }} updateConfig={vi.fn()} conversationId="window-chat" />);

    await waitFor(() => expect(dataSummary).toHaveBeenCalledWith('window-chat'));
    expect(getActiveId).not.toHaveBeenCalled();
  });

  it('shows a clear-data failure instead of discarding it', async () => {
    const clearData = vi.fn().mockRejectedValue(new Error('Credential vault is locked'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    installAppBridgeStub({
      conversations: { getActiveId: async () => 'chat-1' },
      browser: {
        dataSummary: async () => [
          {
            scopeKey: 'global',
            partition: 'persist:kai-browser-global',
            cleanupPending: false,
            historyCount: 1,
            bookmarkCount: 2,
            downloadCount: 4,
            credentialCount: 3,
            activeTabCount: 1,
          },
        ],
        clearData,
      },
      partitions: { list: async () => [] },
    });

    render(<BrowserSettings config={{ browser: {} }} updateConfig={vi.fn()} conversationId="chat-1" />);
    expect(await screen.findByText(/1 history · 2 bookmarks · 4 downloads · 3 passwords · 1 tabs/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Browser data could not be cleared: Credential vault is locked',
    );
    expect(clearData).toHaveBeenCalledWith({
      conversationId: 'chat-1',
      scopeKeys: ['global'],
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/unexported assistant download quarantine copies/i));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/already exported or saved remain on disk/i));
  });

  it('uses the atomic main-process path to clear and delete plugin partition data', async () => {
    const clearData = vi.fn(async () => undefined);
    const deletePartitions = vi.fn(async () => ({ success: true, deleted: ['plugin-auth'] }));
    const listPartitions = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'plugin-auth', sizeBytes: 1_024 }])
      .mockResolvedValue([]);
    installAppBridgeStub({
      browser: { clearData },
      partitions: { list: listPartitions, delete: deletePartitions },
    });

    render(<BrowserSettings config={{ browser: {} }} updateConfig={vi.fn()} conversationId="chat-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all' }));
    const pluginData = screen.getByText('Plugin Browser Data').closest('fieldset');
    expect(pluginData).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deletePartitions).toHaveBeenCalledWith(['plugin-auth']));
    expect(clearData).not.toHaveBeenCalled();
  });

  it('offers an explicit recover-all path for unreadable plugin cleanup markers', async () => {
    const recoveryId = '\0kai:recover-plugin-browser-quarantine';
    const deletePartitions = vi.fn(async () => ({
      success: true,
      deleted: [],
      recoveredCorruptMarkers: 1,
    }));
    const listPartitions = vi
      .fn()
      .mockResolvedValueOnce([
        {
          name: recoveryId,
          displayName: 'Unreadable plugin Browser cleanup state',
          sizeBytes: 0,
          quarantined: true,
          recoveryRequired: 'all-plugin-partitions' as const,
          corruptMarkerCount: 1,
        },
      ])
      .mockResolvedValue([]);
    installAppBridgeStub({ partitions: { list: listPartitions, delete: deletePartitions } });

    render(<BrowserSettings config={{ browser: {} }} updateConfig={vi.fn()} conversationId="chat-1" />);
    expect(await screen.findByText('Unreadable plugin Browser cleanup state')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recover all plugin Browser data' }));
    expect(screen.getByText(/Recovery clears every plugin Browser profile/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recover all' }));

    await waitFor(() => expect(deletePartitions).toHaveBeenCalledWith([recoveryId]));
    expect(await screen.findByText('Removed 1 unreadable cleanup marker.')).toBeInTheDocument();
  });

  it('keeps corrupt profile recovery controls visible with a warning', async () => {
    installAppBridgeStub({
      conversations: { getActiveId: async () => 'chat-1' },
      browser: {
        dataSummary: async () => [
          {
            scopeKey: 'global',
            partition: 'persist:kai-browser-global',
            cleanupPending: false,
            warning: 'Saved-password metadata is unreadable. Clear this profile to recover.',
            historyCount: 0,
            bookmarkCount: 0,
            downloadCount: 0,
            credentialCount: 0,
            activeTabCount: 0,
          },
        ],
      },
      partitions: { list: async () => [] },
    });

    render(<BrowserSettings config={{ browser: {} }} updateConfig={vi.fn()} conversationId="chat-1" />);

    expect(
      await screen.findByText('Saved-password metadata is unreadable. Clear this profile to recover.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeEnabled();
  });

  it('requires explicit all-profile recovery for unreadable cleanup metadata', async () => {
    const clearData = vi.fn(async () => undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    installAppBridgeStub({
      conversations: { getActiveId: async () => 'chat-1' },
      browser: {
        dataSummary: async () => [
          {
            scopeKey: 'global',
            partition: 'persist:kai-browser-global',
            cleanupPending: false,
            recoveryRequired: true,
            warning: 'Pending cleanup metadata is unreadable.',
            historyCount: 0,
            bookmarkCount: 0,
            downloadCount: 0,
            credentialCount: 0,
            activeTabCount: 0,
          },
        ],
        clearData,
      },
      partitions: { list: async () => [] },
    });

    render(<BrowserSettings config={{ browser: {} }} updateConfig={vi.fn()} conversationId="chat-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Recover all' }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('every discoverable Browser profile'));
    expect(clearData).toHaveBeenCalledWith({
      conversationId: 'chat-1',
      recoverUnreadableCleanup: true,
    });
  });

  it('identifies the exact conversation profile whose cleanup is pending', async () => {
    installAppBridgeStub({
      conversations: { getActiveId: async () => 'chat-1' },
      browser: {
        dataSummary: async () => [
          {
            scopeKey: 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
            partition: 'persist:kai-browser-conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
            cleanupPending: false,
            historyCount: 0,
            bookmarkCount: 0,
            downloadCount: 0,
            credentialCount: 0,
            activeTabCount: 0,
          },
          {
            scopeKey: 'conversation-bbbbbbbbbbbbbbbbbbbbbbbb',
            partition: 'persist:kai-browser-conversation-bbbbbbbbbbbbbbbbbbbbbbbb',
            cleanupPending: true,
            historyCount: 1,
            bookmarkCount: 2,
            downloadCount: 4,
            credentialCount: 3,
            activeTabCount: 0,
          },
        ],
      },
      partitions: { list: async () => [] },
    });

    render(<BrowserSettings config={{ browser: {} }} updateConfig={vi.fn()} conversationId="chat-1" />);

    expect(await screen.findByText('Cleanup needed for conversation-bbbbbbbbbbbbbbbbbbbbbbbb')).toBeInTheDocument();
    expect(screen.queryByText('Cleanup needed for conversation-aaaaaaaaaaaaaaaaaaaaaaaa')).not.toBeInTheDocument();
  });

  it('reloads Browser Data summaries when the configured profile scope changes', async () => {
    let scope: 'global' | 'conversation' = 'global';
    const dataSummary = vi.fn(async () => [
      {
        scopeKey: scope === 'global' ? 'global' : 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
        partition:
          scope === 'global'
            ? 'persist:kai-browser-global'
            : 'persist:kai-browser-conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
        cleanupPending: false,
        historyCount: 0,
        bookmarkCount: 0,
        downloadCount: 0,
        credentialCount: 0,
        activeTabCount: 0,
      },
    ]);
    installAppBridgeStub({
      conversations: { getActiveId: async () => 'chat-1' },
      browser: { dataSummary },
      partitions: { list: async () => [] },
    });
    const updateConfig = vi.fn();
    const rendered = render(
      <BrowserSettings
        config={{ browser: { dataScope: 'global' } }}
        updateConfig={updateConfig}
        conversationId="chat-1"
      />,
    );
    expect(await screen.findByText('App-wide browser profile')).toBeInTheDocument();

    scope = 'conversation';
    rendered.rerender(
      <BrowserSettings
        config={{ browser: { dataScope: 'conversation' } }}
        updateConfig={updateConfig}
        conversationId="chat-1"
      />,
    );

    expect(
      await screen.findByText('Conversation browser profile · conversation-aaaaaaaaaaaaaaaaaaaaaaaa'),
    ).toBeInTheDocument();
    expect(screen.queryByText('App-wide browser profile')).not.toBeInTheDocument();
    expect(dataSummary).toHaveBeenCalledTimes(2);
  });

  it('refreshes Browser Data after the native profile migration or an external clear commits', async () => {
    let emit: ((event: BrowserEvent) => void) | undefined;
    const summary = (activeTabCount: number): BrowserDataSummary => ({
      scopeKey: 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
      partition: 'persist:kai-browser-conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
      cleanupPending: false,
      historyCount: 0,
      bookmarkCount: 0,
      downloadCount: 0,
      credentialCount: 0,
      activeTabCount,
    });
    const dataSummary = vi
      .fn()
      .mockResolvedValueOnce([summary(0)])
      .mockResolvedValueOnce([summary(1)])
      .mockResolvedValueOnce([summary(0)]);
    installAppBridgeStub({
      browser: {
        dataSummary,
        onEvent: (callback: (event: BrowserEvent) => void) => {
          emit = callback;
          return vi.fn();
        },
      },
      partitions: { list: async () => [] },
    });

    render(
      <BrowserSettings
        config={{ browser: { dataScope: 'conversation' } }}
        updateConfig={vi.fn()}
        conversationId="chat-1"
      />,
    );
    expect(await screen.findByText(/0 passwords · 0 tabs/)).toBeInTheDocument();

    act(() => emit?.({ type: 'profile-scope-changed', dataScope: 'conversation' }));
    expect(await screen.findByText(/0 passwords · 1 tabs/)).toBeInTheDocument();

    act(() =>
      emit?.({
        type: 'profile-data-cleared',
        conversationId: 'chat-1',
        scopeKeys: ['conversation-aaaaaaaaaaaaaaaaaaaaaaaa'],
      }),
    );
    expect(await screen.findByText(/0 passwords · 0 tabs/)).toBeInTheDocument();
    expect(dataSummary).toHaveBeenCalledTimes(3);
  });

  it('ignores a stale Browser Data load after the configured scope changes', async () => {
    let resolveGlobal: ((summaries: BrowserDataSummary[]) => void) | undefined;
    const globalLoad = new Promise<BrowserDataSummary[]>((resolve) => {
      resolveGlobal = resolve;
    });
    const conversationSummary = {
      scopeKey: 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
      partition: 'persist:kai-browser-conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
      cleanupPending: false,
      historyCount: 0,
      bookmarkCount: 0,
      downloadCount: 0,
      credentialCount: 0,
      activeTabCount: 0,
    };
    const dataSummary = vi
      .fn()
      .mockImplementationOnce(() => globalLoad)
      .mockResolvedValueOnce([conversationSummary]);
    installAppBridgeStub({
      conversations: { getActiveId: async () => 'chat-1' },
      browser: { dataSummary },
      partitions: { list: async () => [] },
    });
    const updateConfig = vi.fn();
    const rendered = render(
      <BrowserSettings
        config={{ browser: { dataScope: 'global' } }}
        updateConfig={updateConfig}
        conversationId="chat-1"
      />,
    );
    await waitFor(() => expect(dataSummary).toHaveBeenCalledTimes(1));

    rendered.rerender(
      <BrowserSettings
        config={{ browser: { dataScope: 'conversation' } }}
        updateConfig={updateConfig}
        conversationId="chat-1"
      />,
    );

    expect(
      await screen.findByText('Conversation browser profile · conversation-aaaaaaaaaaaaaaaaaaaaaaaa'),
    ).toBeInTheDocument();
    await act(async () => {
      resolveGlobal?.([
        {
          scopeKey: 'global',
          partition: 'persist:kai-browser-global',
          cleanupPending: false,
          historyCount: 9,
          bookmarkCount: 8,
          downloadCount: 6,
          credentialCount: 7,
          activeTabCount: 6,
        },
      ]);
      await globalLoad;
    });
    expect(screen.queryByText('App-wide browser profile')).not.toBeInTheDocument();
    expect(
      screen.getByText('Conversation browser profile · conversation-aaaaaaaaaaaaaaaaaaaaaaaa'),
    ).toBeInTheDocument();
  });

  it('does not let a clear completion restart a load for the previously selected chat', async () => {
    let resolveClear: (() => void) | undefined;
    let resolveNextChat: ((summaries: BrowserDataSummary[]) => void) | undefined;
    const clearData = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClear = resolve;
        }),
    );
    const nextChatLoad = new Promise<BrowserDataSummary[]>((resolve) => {
      resolveNextChat = resolve;
    });
    const dataSummary = vi
      .fn()
      .mockResolvedValueOnce([
        {
          scopeKey: 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
          partition: 'persist:kai-browser-conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
          cleanupPending: false,
          historyCount: 1,
          bookmarkCount: 0,
          downloadCount: 0,
          credentialCount: 0,
          activeTabCount: 0,
        },
      ])
      .mockImplementationOnce(() => nextChatLoad)
      .mockResolvedValue([
        {
          scopeKey: 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
          partition: 'persist:kai-browser-conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
          cleanupPending: false,
          historyCount: 9,
          bookmarkCount: 0,
          downloadCount: 0,
          credentialCount: 0,
          activeTabCount: 0,
        },
      ]);
    installAppBridgeStub({
      browser: { dataSummary, clearData },
      partitions: { list: async () => [] },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const rendered = render(
      <BrowserSettings
        config={{ browser: { dataScope: 'conversation' } }}
        updateConfig={vi.fn()}
        conversationId="chat-1"
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));

    rendered.rerender(
      <BrowserSettings
        config={{ browser: { dataScope: 'conversation' } }}
        updateConfig={vi.fn()}
        conversationId="chat-2"
      />,
    );
    await waitFor(() => expect(dataSummary).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveClear?.();
    });
    expect(dataSummary).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveNextChat?.([
        {
          scopeKey: 'conversation-bbbbbbbbbbbbbbbbbbbbbbbb',
          partition: 'persist:kai-browser-conversation-bbbbbbbbbbbbbbbbbbbbbbbb',
          cleanupPending: false,
          historyCount: 2,
          bookmarkCount: 0,
          downloadCount: 0,
          credentialCount: 0,
          activeTabCount: 0,
        },
      ]);
      await nextChatLoad;
    });
    expect(
      screen.getByText('Conversation browser profile · conversation-bbbbbbbbbbbbbbbbbbbbbbbb'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Conversation browser profile · conversation-aaaaaaaaaaaaaaaaaaaaaaaa'),
    ).not.toBeInTheDocument();
  });

  it('does not surface a clear failure from the previously selected chat', async () => {
    let rejectClear: ((reason: Error) => void) | undefined;
    const clearData = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectClear = reject;
        }),
    );
    const summary = (scopeKey: string): BrowserDataSummary => ({
      scopeKey,
      partition: `persist:kai-browser-${scopeKey}`,
      cleanupPending: false,
      historyCount: 0,
      bookmarkCount: 0,
      downloadCount: 0,
      credentialCount: 0,
      activeTabCount: 0,
    });
    const dataSummary = vi
      .fn()
      .mockResolvedValueOnce([summary('conversation-aaaaaaaaaaaaaaaaaaaaaaaa')])
      .mockResolvedValueOnce([summary('conversation-bbbbbbbbbbbbbbbbbbbbbbbb')]);
    installAppBridgeStub({
      browser: { dataSummary, clearData },
      partitions: { list: async () => [] },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const rendered = render(
      <BrowserSettings
        config={{ browser: { dataScope: 'conversation' } }}
        updateConfig={vi.fn()}
        conversationId="chat-1"
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));

    rendered.rerender(
      <BrowserSettings
        config={{ browser: { dataScope: 'conversation' } }}
        updateConfig={vi.fn()}
        conversationId="chat-2"
      />,
    );
    expect(
      await screen.findByText('Conversation browser profile · conversation-bbbbbbbbbbbbbbbbbbbbbbbb'),
    ).toBeInTheDocument();
    await act(async () => {
      rejectClear?.(new Error('old chat clear failed'));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
