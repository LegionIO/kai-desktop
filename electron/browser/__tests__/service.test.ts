import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearStorageData: vi.fn(async () => undefined),
  clearCache: vi.fn(async () => undefined),
  clearAuthCache: vi.fn(async () => undefined),
  closeAllConnections: vi.fn(async () => undefined),
  getAllRunning: vi.fn(() => ({ 'worker-version-1': {} })),
  debuggerAttach: vi.fn(),
  debuggerDetach: vi.fn(),
  debuggerSendCommand: vi.fn(async () => ({})),
  webContentsClose: vi.fn(),
  onBeforeRequest: vi.fn(),
  fromPartition: vi.fn(),
  profileClear: vi.fn(),
  credentialClear: vi.fn(),
  pendingCleanupClear: vi.fn(() => true),
  pendingCleanupMark: vi.fn(() => true),
  chromiumScopeClearedMark: vi.fn(),
  profileExists: vi.fn(() => true),
  screenshotClear: vi.fn(),
  quarantineClear: vi.fn(),
  managerDispose: vi.fn(),
  managerShutdown: vi.fn<() => Promise<void>>(async () => undefined),
  managerFenceConversation: vi.fn(),
  managerRemoveConversation: vi.fn<(conversationId: string) => Promise<void>>(async () => undefined),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'sessionData' ? '/tmp/chromium-session-data' : '/tmp')),
  },
  session: {
    fromPartition: mocks.fromPartition.mockReturnValue({
      clearStorageData: mocks.clearStorageData,
      clearCache: mocks.clearCache,
      clearAuthCache: mocks.clearAuthCache,
      closeAllConnections: mocks.closeAllConnections,
      serviceWorkers: { getAllRunning: mocks.getAllRunning },
      webRequest: { onBeforeRequest: mocks.onBeforeRequest },
    }),
  },
  WebContentsView: class WebContentsView {
    webContents = {
      close: mocks.webContentsClose,
      debugger: {
        attach: mocks.debuggerAttach,
        detach: mocks.debuggerDetach,
        isAttached: () => false,
        sendCommand: mocks.debuggerSendCommand,
      },
      isDestroyed: () => false,
    };
  },
}));
vi.mock('../manager.js', () => ({
  BrowserManager: class BrowserManager {
    dispose = mocks.managerDispose;
    shutdown = mocks.managerShutdown;
    fenceRemovedConversation = mocks.managerFenceConversation;
    removeConversation = mocks.managerRemoveConversation;
  },
}));
vi.mock('../store.js', () => ({
  BrowserProfileStore: class BrowserProfileStore {
    clear = mocks.profileClear;
  },
}));
vi.mock('../credential-vault.js', () => ({
  BrowserCredentialVault: class BrowserCredentialVault {
    clear = mocks.credentialClear;
  },
}));
vi.mock('../profile-data.js', () => ({
  clearPendingBrowserCleanupScopeKey: mocks.pendingCleanupClear,
  hasStoredBrowserScopeData: mocks.profileExists,
  markChromiumBrowserScopeCleared: mocks.chromiumScopeClearedMark,
  markPendingBrowserCleanupScopeKey: mocks.pendingCleanupMark,
}));
vi.mock('../screenshot-store.js', () => ({
  removeBrowserScreenshotsForConversation: mocks.screenshotClear,
}));
vi.mock('../download-quarantine.js', () => ({
  removeAssistantDownloadQuarantineForScope: mocks.quarantineClear,
}));

const {
  BROWSER_FORCE_EXIT_GRACE_MS,
  BROWSER_SHUTDOWN_TIMEOUT_MS,
  initializeBrowserManager,
  getExistingBrowserManager,
  removeBrowserConversationData,
  removeBrowserConversationsData,
  replaceBrowserManager,
  shutdownBrowserManager,
} = await import('../service.js');

describe('headless browser profile cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.profileExists.mockReturnValue(true);
    mocks.pendingCleanupClear.mockReturnValue(true);
    mocks.pendingCleanupMark.mockReturnValue(true);
    mocks.managerRemoveConversation.mockReset();
    mocks.managerRemoveConversation.mockResolvedValue(undefined);
  });

  it('leaves hard-exit fallbacks enough time for the graceful Browser flush', () => {
    expect(BROWSER_FORCE_EXIT_GRACE_MS).toBeGreaterThan(BROWSER_SHUTDOWN_TIMEOUT_MS);
  });

  it('stops workers and connections before clearing data without a BrowserManager', async () => {
    await removeBrowserConversationData('/tmp/kai-home', 'conversation-123');

    expect(mocks.fromPartition).toHaveBeenCalledOnce();
    expect(mocks.fromPartition.mock.calls[0][0]).toMatch(/^persist:.*-browser-conversation-[a-f0-9]{24}$/);
    expect(mocks.clearStorageData).toHaveBeenCalledOnce();
    expect(mocks.clearCache).toHaveBeenCalledOnce();
    expect(mocks.clearAuthCache).toHaveBeenCalledOnce();
    expect(mocks.debuggerSendCommand).toHaveBeenNthCalledWith(1, 'ServiceWorker.enable');
    expect(mocks.debuggerSendCommand).toHaveBeenNthCalledWith(2, 'ServiceWorker.stopWorker', {
      versionId: 'worker-version-1',
    });
    expect(mocks.closeAllConnections).toHaveBeenCalledOnce();
    expect(mocks.closeAllConnections.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearStorageData.mock.invocationCallOrder[0],
    );
    expect(mocks.onBeforeRequest).toHaveBeenLastCalledWith(null);
    expect(mocks.profileClear).toHaveBeenCalledOnce();
    expect(mocks.credentialClear).toHaveBeenCalledOnce();
    expect(mocks.quarantineClear).toHaveBeenCalledWith(
      '/tmp/kai-home',
      expect.stringMatching(/^conversation-[a-f0-9]{24}$/),
    );
    expect(mocks.screenshotClear).toHaveBeenCalledWith('/tmp/kai-home', 'conversation-123');
    expect(mocks.chromiumScopeClearedMark).toHaveBeenCalledWith(
      '/tmp/kai-home',
      expect.stringMatching(/^conversation-[a-f0-9]{24}$/),
    );
    expect(mocks.pendingCleanupClear).toHaveBeenCalledWith(
      '/tmp/kai-home',
      expect.stringMatching(/^conversation-[a-f0-9]{24}$/),
    );
    expect(mocks.profileExists).toHaveBeenCalledWith(
      '/tmp/kai-home',
      '/tmp/chromium-session-data',
      expect.stringMatching(/^conversation-[a-f0-9]{24}$/),
    );
  });

  it('does not remove a BrowserManager request guard when GUI promotion races headless cleanup', async () => {
    let finishStorageClear!: () => void;
    mocks.clearStorageData.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        finishStorageClear = () => resolve(undefined);
      }),
    );
    const cleanup = removeBrowserConversationData('/tmp/kai-home', 'conversation-123');
    await vi.waitFor(() => expect(mocks.clearStorageData).toHaveBeenCalledOnce());

    initializeBrowserManager(
      '/tmp/kai-home',
      () => ({}) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    finishStorageClear();
    await cleanup;

    expect(mocks.managerFenceConversation).toHaveBeenCalledWith('conversation-123');
    expect(mocks.onBeforeRequest).toHaveBeenCalledOnce();
    expect(mocks.onBeforeRequest).not.toHaveBeenCalledWith(null);
    await shutdownBrowserManager();
  });

  it.each([
    [
      'service-worker shutdown',
      () => mocks.debuggerSendCommand.mockRejectedValueOnce(new Error('worker still active')),
    ],
    [
      'connection shutdown',
      () => mocks.closeAllConnections.mockRejectedValueOnce(new Error('connections still active')),
    ],
    ['profile clearing', () => mocks.clearStorageData.mockRejectedValueOnce(new Error('profile still active'))],
  ] as const)('retains the deny-all network guard when headless %s fails', async (_label, fail) => {
    fail();

    await expect(removeBrowserConversationData('/tmp/kai-home', 'conversation-123')).rejects.toThrow();

    if (_label !== 'profile clearing') {
      expect(mocks.clearStorageData).not.toHaveBeenCalled();
      expect(mocks.clearCache).not.toHaveBeenCalled();
      expect(mocks.clearAuthCache).not.toHaveBeenCalled();
      expect(mocks.profileClear).not.toHaveBeenCalled();
      expect(mocks.credentialClear).not.toHaveBeenCalled();
    }
    expect(mocks.pendingCleanupMark).toHaveBeenCalledOnce();
    expect(mocks.onBeforeRequest).toHaveBeenCalledOnce();
    expect(mocks.onBeforeRequest).not.toHaveBeenCalledWith(null);
  });

  it('retains the conversation-profile retry marker when screenshot cleanup fails last', async () => {
    mocks.screenshotClear.mockImplementationOnce(() => {
      throw new Error('screenshot directory is busy');
    });

    await expect(removeBrowserConversationData('/tmp/kai-home', 'conversation-123')).rejects.toThrow(
      /screenshot directory is busy/,
    );

    expect(mocks.clearStorageData).toHaveBeenCalledOnce();
    expect(mocks.profileClear).toHaveBeenCalledOnce();
    expect(mocks.credentialClear).toHaveBeenCalledOnce();
    expect(mocks.pendingCleanupClear).not.toHaveBeenCalled();
    expect(mocks.pendingCleanupMark).toHaveBeenCalledWith(
      '/tmp/kai-home',
      expect.stringMatching(/^conversation-[a-f0-9]{24}$/),
    );
  });

  it('skips nonexistent profiles and bounds bulk cleanup to one session at a time', async () => {
    mocks.profileExists.mockReturnValueOnce(false).mockReturnValue(true);
    let active = 0;
    let maxActive = 0;
    mocks.clearStorageData.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
    });

    await expect(removeBrowserConversationsData('/tmp/kai-home', ['never-used', 'used-a', 'used-b'])).resolves.toEqual(
      [],
    );

    expect(mocks.fromPartition).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it('quarantines every headless profile before the first bulk clear can wait', async () => {
    let finishFirstClear!: () => void;
    mocks.clearStorageData
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            finishFirstClear = () => resolve(undefined);
          }),
      )
      .mockResolvedValueOnce(undefined);

    const cleanup = removeBrowserConversationsData('/tmp/kai-home', ['deleted-a', 'deleted-b']);
    await vi.waitFor(() => expect(mocks.clearStorageData).toHaveBeenCalledOnce());

    expect(mocks.fromPartition).toHaveBeenCalledTimes(2);
    const denyHookOrders = mocks.onBeforeRequest.mock.invocationCallOrder.slice(0, 2);
    expect(denyHookOrders).toHaveLength(2);
    expect(denyHookOrders.every((order) => order < mocks.clearStorageData.mock.invocationCallOrder[0])).toBe(true);

    finishFirstClear();
    await expect(cleanup).resolves.toEqual([]);
    expect(mocks.clearStorageData).toHaveBeenCalledTimes(2);
  });

  it('starts every manager removal before awaiting the first bulk cleanup', async () => {
    let finishFirstRemoval!: () => void;
    mocks.managerRemoveConversation
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstRemoval = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    initializeBrowserManager(
      '/tmp/kai-home',
      () => ({}) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );

    try {
      const cleanup = removeBrowserConversationsData('/tmp/kai-home', ['deleted-a', 'deleted-b']);
      expect(mocks.managerRemoveConversation.mock.calls.map(([conversationId]) => conversationId)).toEqual([
        'deleted-a',
        'deleted-b',
      ]);

      finishFirstRemoval();
      await expect(cleanup).resolves.toEqual([]);
    } finally {
      await shutdownBrowserManager();
    }
  });

  it('retains a failed cleanup scope so Settings can retry it after chat deletion', async () => {
    mocks.clearStorageData.mockRejectedValueOnce(new Error('profile busy'));
    mocks.profileClear.mockRejectedValueOnce(new Error('metadata locked'));

    await expect(removeBrowserConversationData('/tmp/kai-home', 'deleted-conversation')).rejects.toThrow(
      /profile busy.*metadata locked/,
    );

    expect(mocks.clearCache).toHaveBeenCalledOnce();
    expect(mocks.clearAuthCache).toHaveBeenCalledOnce();
    expect(mocks.profileClear).toHaveBeenCalledOnce();
    expect(mocks.credentialClear).toHaveBeenCalledOnce();
    expect(mocks.chromiumScopeClearedMark).not.toHaveBeenCalled();
    expect(mocks.onBeforeRequest).not.toHaveBeenCalledWith(null);
    expect(mocks.pendingCleanupMark).toHaveBeenCalledWith(
      '/tmp/kai-home',
      expect.stringMatching(/^conversation-[a-f0-9]{24}$/),
    );
    expect(mocks.pendingCleanupClear).not.toHaveBeenCalled();
  });

  it('retains the cleanup marker when profile detection itself fails', async () => {
    mocks.profileExists.mockImplementationOnce(() => {
      throw new Error('partition directory is unreadable');
    });

    await expect(removeBrowserConversationData('/tmp/kai-home', 'deleted-conversation')).rejects.toThrow(
      /partition directory is unreadable/,
    );

    expect(mocks.fromPartition).not.toHaveBeenCalled();
    expect(mocks.pendingCleanupMark).toHaveBeenCalledWith(
      '/tmp/kai-home',
      expect.stringMatching(/^conversation-[a-f0-9]{24}$/),
    );
    expect(mocks.pendingCleanupClear).not.toHaveBeenCalled();
  });

  it('waits for the manager to quiesce callbacks and flush before completing graceful shutdown', async () => {
    let finishShutdown!: () => void;
    mocks.managerShutdown.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishShutdown = resolve;
      }),
    );
    initializeBrowserManager(
      '/tmp/kai-home',
      () => ({}) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );

    const shutdown = shutdownBrowserManager();
    await Promise.resolve();
    expect(mocks.managerShutdown).toHaveBeenCalledOnce();

    finishShutdown();
    await shutdown;
    expect(mocks.managerDispose).not.toHaveBeenCalled();
  });

  it('does not replace a live manager until its graceful shutdown completes', async () => {
    let finishShutdown!: () => void;
    mocks.managerShutdown.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishShutdown = resolve;
      }),
    );
    initializeBrowserManager(
      '/tmp/kai-home',
      () => ({}) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );

    expect(() =>
      initializeBrowserManager(
        '/tmp/kai-home',
        () => ({}) as never,
        () => null,
        '/tmp/browser-page.cjs',
      ),
    ).toThrow(/already initialized/);
    const replacement = replaceBrowserManager(
      '/tmp/kai-home',
      () => ({}) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    await Promise.resolve();
    expect(mocks.managerShutdown).toHaveBeenCalledOnce();

    finishShutdown();
    const replaced = await replacement;
    expect(replaced).toBe(getExistingBrowserManager());
    await shutdownBrowserManager();
  });

  it('retains manager ownership and guards when graceful Browser shutdown misses its deadline', async () => {
    vi.useFakeTimers();
    try {
      mocks.managerShutdown.mockReturnValueOnce(new Promise<void>(() => undefined));
      initializeBrowserManager(
        '/tmp/kai-home',
        () => ({}) as never,
        () => null,
        '/tmp/browser-page.cjs',
      );

      const shutdown = shutdownBrowserManager(25);
      const assertion = expect(shutdown).rejects.toThrow(/25 ms deadline/);
      await vi.advanceTimersByTimeAsync(25);
      await assertion;

      expect(mocks.managerDispose).not.toHaveBeenCalled();
      expect(getExistingBrowserManager()).not.toBeNull();
      mocks.managerShutdown.mockResolvedValueOnce(undefined);
      await expect(shutdownBrowserManager(25)).resolves.toBeUndefined();
      expect(getExistingBrowserManager()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
