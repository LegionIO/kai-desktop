import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
}));
const atomicWriteFileSync = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'pictures' ? '/tmp/pictures' : '/tmp'),
    off: vi.fn(),
    on: vi.fn(),
  },
  clipboard: { clear: vi.fn(), readText: vi.fn(() => ''), writeText: vi.fn() },
  dialog: { showSaveDialog: electronMocks.showSaveDialog },
  ipcMain: { off: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  Menu: class Menu {},
  MenuItem: class MenuItem {},
  safeStorage: {
    decryptString: vi.fn(),
    encryptString: vi.fn(),
    isEncryptionAvailable: vi.fn(() => false),
  },
  session: { fromPartition: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  systemPreferences: {},
  WebContentsView: class WebContentsView {},
}));

vi.mock('../../utils/atomic-write.js', () => ({ atomicWriteFileSync }));

const { BrowserManager } = await import('../manager.js');
const { BrowserActionQueue } = await import('../action-queue.js');

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function screenshotManager(options?: {
  revokeAfterCapture?: boolean;
  revokePanelAfterCapture?: boolean;
  navigateAfterCapture?: boolean;
}) {
  const contents = { isDestroyed: () => false };
  const tab = {
    shell: {
      id: 'tab-1',
      conversationId: 'chat-1',
      url: 'https://example.com',
      owner: 'user' as const,
      keepOpen: true,
    },
    scopeKey: 'global',
    generation: 4,
    trustedUserNavigationLease: 2,
    assistantOwnerId: null,
    aiControlOwnerId: 'run-1',
    aiControlGeneration: 7,
    visibleAssistantGeneration: 0,
    view: { setBounds: vi.fn(), setVisible: vi.fn(), webContents: contents },
  };
  const lease = {
    runId: 'run-1',
    runGeneration: 7,
    hostRendererAuthorityGeneration: 3,
    tabGeneration: 4,
    userNavigationLease: 2,
    url: 'https://example.com',
  };
  const manager = Object.create(BrowserManager.prototype) as InstanceType<typeof BrowserManager>;
  Object.assign(manager as unknown as Record<string, unknown>, {
    activeTabs: new Map([['chat-1', tab.shell.id]]),
    assistantRuns: {
      assertActive: () => 7,
      generationIfActive: () => null,
    },
    appHome: '/tmp/kai-browser-screenshot-authority',
    attachActiveView: vi.fn(),
    attachedView: tab.view,
    browserEnabled: true,
    clearingScopes: new Set<string>(),
    clearQuarantinedScopes: new Set<string>(),
    disposed: false,
    emit: vi.fn(),
    emitTabs: vi.fn(),
    shuttingDown: false,
    hostRendererAuthorityAvailable: true,
    hostRendererAuthorityGeneration: 3,
    mountedBounds: { x: 10, y: 20, width: 300, height: 200 },
    mountedConversationId: 'chat-1',
    panelAuthorityGenerations: new Map(),
    panelStateWaiters: new Map(),
    pendingCleanupQuarantineUnreadable: false,
    removedConversations: new Set<string>(),
    runningActions: new Map(),
    screenshotQueue: new BrowserActionQueue(),
    visibleAssistantQueue: new BrowserActionQueue(),
    assertBrowserPageLease: vi.fn((_tab: unknown, pageLease: { generation: number }) => {
      if (pageLease.generation !== tab.generation) {
        throw new Error('The browser page changed while this screenshot was in progress.');
      }
    }),
    captureBrowserPageLease: vi.fn(() => ({ tabId: tab.shell.id, generation: tab.generation })),
    setAutomationOverlay: vi.fn(async () => undefined),
    tabOrder: new Map([['chat-1', [tab.shell.id]]]),
    tabs: new Map([[tab.shell.id, tab]]),
    requireTab: () => tab,
    runTabOperation: (_tab: unknown, operation: () => Promise<unknown>) => operation(),
    withAssistantControl: (
      _tab: unknown,
      _run: unknown,
      operation: (documentLease: typeof lease) => Promise<unknown>,
    ) => operation(lease),
    ensureAssistantView: async () => ({ webContents: contents }),
    ensureView: async () => ({ webContents: contents }),
    runRendererOperationWithDeadline: async () => {
      if (options?.revokeAfterCapture) {
        Reflect.set(manager, 'hostRendererAuthorityAvailable', false);
        Reflect.set(manager, 'hostRendererAuthorityGeneration', 4);
      }
      if (options?.revokePanelAfterCapture) {
        (Reflect.get(manager, 'panelAuthorityGenerations') as Map<string, number>).set('chat-1', 1);
      }
      if (options?.navigateAfterCapture) tab.generation++;
      return { png: Buffer.from('png'), width: 1, height: 1 };
    },
    getWindow: () => ({
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      isFocused: () => true,
    }),
  });
  return manager;
}

describe('assistant screenshot renderer authority', () => {
  beforeEach(() => {
    atomicWriteFileSync.mockClear();
    electronMocks.showSaveDialog.mockReset();
  });

  it('does not retain a screenshot after renderer authority is revoked following capture', async () => {
    const manager = screenshotManager({ revokeAfterCapture: true });

    await expect(
      manager.screenshot('chat-1', { mode: 'viewport', saveToFile: true }, 'assistant', { id: 'run-1' }),
    ).rejects.toThrow(/Kai renderer changed/);
    expect(atomicWriteFileSync).not.toHaveBeenCalled();
  });

  it('does not retain user screenshot pixels after the captured document navigates', async () => {
    const manager = screenshotManager({ navigateAfterCapture: true });

    await expect(manager.screenshot('chat-1', { mode: 'viewport', saveToFile: true })).rejects.toThrow(
      /page changed while this screenshot/i,
    );
    expect(atomicWriteFileSync).not.toHaveBeenCalled();
  });

  it('rechecks renderer authority after the native export dialog returns', async () => {
    let resolveDialog!: (result: { canceled: boolean; filePath: string }) => void;
    electronMocks.showSaveDialog.mockReturnValue(
      new Promise((resolve) => {
        resolveDialog = resolve;
      }),
    );
    const manager = screenshotManager();
    const screenshot = manager.screenshot('chat-1', { mode: 'viewport', exportToFile: true }, 'assistant', {
      id: 'run-1',
    });
    await vi.waitFor(() => expect(electronMocks.showSaveDialog).toHaveBeenCalledOnce());

    Reflect.set(manager, 'hostRendererAuthorityAvailable', false);
    Reflect.set(manager, 'hostRendererAuthorityGeneration', 4);
    resolveDialog({ canceled: false, filePath: '/tmp/exported-browser.png' });

    await expect(screenshot).rejects.toThrow(/Kai renderer changed/);
    expect(atomicWriteFileSync).not.toHaveBeenCalled();
  });

  it('does not export a replacement document selected while the native dialog is open', async () => {
    let resolveDialog!: (result: { canceled: boolean; filePath: string }) => void;
    electronMocks.showSaveDialog.mockReturnValue(
      new Promise((resolve) => {
        resolveDialog = resolve;
      }),
    );
    const manager = screenshotManager();
    const screenshot = manager.screenshot('chat-1', { mode: 'viewport', exportToFile: true });
    await vi.waitFor(() => expect(electronMocks.showSaveDialog).toHaveBeenCalledOnce());

    const tab = Reflect.get(manager, 'tabs').get('tab-1') as { generation: number };
    tab.generation++;
    resolveDialog({ canceled: false, filePath: '/tmp/exported-browser.png' });

    await expect(screenshot).rejects.toThrow(/page changed while this screenshot/i);
    expect(atomicWriteFileSync).not.toHaveBeenCalled();
  });

  it('cancels an export when its Browser panel is withdrawn while the native dialog is open', async () => {
    const selected = deferred<{ canceled: boolean; filePath: string }>();
    electronMocks.showSaveDialog.mockReturnValue(selected.promise);
    const manager = screenshotManager();
    const screenshot = manager.screenshot('chat-1', { mode: 'viewport', exportToFile: true });
    await vi.waitFor(() => expect(electronMocks.showSaveDialog).toHaveBeenCalledOnce());

    (Reflect.get(manager, 'panelAuthorityGenerations') as Map<string, number>).set('chat-1', 1);
    selected.resolve({ canceled: false, filePath: '/tmp/exported-browser.png' });

    await expect(screenshot).resolves.toMatchObject({ canceled: true });
    expect(atomicWriteFileSync).not.toHaveBeenCalled();
  });

  it('does not write an export when its Browser panel is withdrawn during capture', async () => {
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/exported-browser.png' });
    const manager = screenshotManager({ revokePanelAfterCapture: true });

    await expect(manager.screenshot('chat-1', { mode: 'viewport', exportToFile: true })).rejects.toThrow(
      /Browser panel changed/i,
    );
    expect(atomicWriteFileSync).not.toHaveBeenCalled();
  });

  it('does not open an export dialog after Browser presentation is withdrawn during tab preparation', async () => {
    const preparation = deferred<void>();
    const manager = screenshotManager();
    const tab = Reflect.get(manager, 'tabs').get('tab-1') as { view: unknown };
    Reflect.set(manager, 'runTabOperation', async (_tab: unknown, operation: () => Promise<unknown>) => {
      await preparation.promise;
      return operation();
    });

    const screenshot = manager.screenshot('chat-1', { mode: 'viewport', exportToFile: true });
    Reflect.set(manager, 'mountedConversationId', null);
    (Reflect.get(manager, 'panelAuthorityGenerations') as Map<string, number>).set('chat-1', 1);
    preparation.resolve();

    await expect(screenshot).resolves.toMatchObject({ canceled: true });
    expect(tab.view).not.toBeNull();
    expect(electronMocks.showSaveDialog).not.toHaveBeenCalled();
    expect(atomicWriteFileSync).not.toHaveBeenCalled();
  });

  it('does not retain pixels when the page navigates during screenshot postprocessing', async () => {
    let releaseProcessing!: () => void;
    const processingStarted = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });
    let finishProcessing!: () => void;
    const processingFinished = new Promise<void>((resolve) => {
      finishProcessing = resolve;
    });
    const manager = screenshotManager();
    const screenshot = manager.screenshot(
      'chat-1',
      { mode: 'viewport', saveToFile: true },
      'user',
      undefined,
      async (result) => {
        releaseProcessing();
        await processingFinished;
        return result;
      },
    );
    await processingStarted;

    const tab = Reflect.get(manager, 'tabs').get('tab-1') as { generation: number };
    tab.generation++;
    finishProcessing();

    await expect(screenshot).rejects.toThrow(/page changed while this screenshot/i);
    expect(atomicWriteFileSync).not.toHaveBeenCalled();
  });

  it('does not hold the global screenshot queue while an export dialog is open', async () => {
    let resolveDialog!: (result: { canceled: boolean; filePath?: string }) => void;
    electronMocks.showSaveDialog.mockReturnValue(
      new Promise((resolve) => {
        resolveDialog = resolve;
      }),
    );
    const manager = screenshotManager();
    const waitingForExport = manager.screenshot('chat-1', { mode: 'viewport', exportToFile: true });
    await vi.waitFor(() => expect(electronMocks.showSaveDialog).toHaveBeenCalledOnce());

    await expect(manager.screenshot('chat-1', { mode: 'viewport' })).resolves.toMatchObject({
      tabId: 'tab-1',
      width: 1,
      height: 1,
    });

    resolveDialog({ canceled: true });
    await expect(waitingForExport).resolves.toMatchObject({ canceled: true });
  });
});
