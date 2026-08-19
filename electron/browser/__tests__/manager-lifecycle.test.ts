import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error jsdom is installed for Vitest's DOM environment without its optional declaration package.
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  appOff: vi.fn(),
  appOn: vi.fn(),
  fromPartition: vi.fn(),
  ipcOff: vi.fn(),
  ipcOn: vi.fn(),
  screenGetAllDisplays: vi.fn(() => [{ scaleFactor: 1 }]),
  showSaveDialog: vi.fn(),
  webContentsView: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'downloads' ? '/tmp/downloads' : '/tmp'),
    off: electronMocks.appOff,
    on: electronMocks.appOn,
  },
  clipboard: { clear: vi.fn(), readText: vi.fn(() => ''), writeText: vi.fn() },
  dialog: { showSaveDialog: electronMocks.showSaveDialog },
  ipcMain: {
    off: electronMocks.ipcOff,
    on: electronMocks.ipcOn,
    removeListener: vi.fn(),
  },
  Menu: class Menu {
    items: unknown[] = [];
    append(item: unknown) {
      this.items.push(item);
    }
  },
  MenuItem: class MenuItem {
    constructor(options: Record<string, unknown>) {
      Object.assign(this, options);
    }
  },
  safeStorage: {
    decryptString: vi.fn(),
    encryptString: vi.fn(),
    isEncryptionAvailable: vi.fn(() => false),
  },
  screen: { getAllDisplays: electronMocks.screenGetAllDisplays },
  session: { fromPartition: electronMocks.fromPartition },
  shell: { showItemInFolder: vi.fn() },
  systemPreferences: {},
  WebContentsView: class WebContentsView {
    constructor(options: Record<string, unknown>) {
      Object.assign(this, electronMocks.webContentsView(options));
    }
  },
}));

const { BrowserManager, popupInitiatorFrameTreeNodeId } = await import('../manager.js');
const { MAX_BROWSER_URL_CHARS } = await import('../metadata.js');
const { BROWSER_PRIVATE_NETWORK_GUARD_ARGUMENT } = await import('../session.js');
const { BrowserActionQueue } = await import('../action-queue.js');
const { BROWSER_SERVICE_WORKER_COMMAND_TIMEOUT_MS } = await import('../service-workers.js');
const { trackPluginBrowserWindow } = await import('../../plugins/browser-window/lifecycle.js');
const {
  clearPendingBrowserCleanupScopeKey,
  isChromiumBrowserScopeCleared,
  listPendingBrowserCleanupScopeKeys,
  markPendingBrowserCleanupScopeKey,
} = await import('../profile-data.js');

function managerWithoutConstructor(properties: Record<string, unknown>): InstanceType<typeof BrowserManager> {
  const manager = Object.create(BrowserManager.prototype) as InstanceType<typeof BrowserManager>;
  Object.assign(
    manager as unknown as Record<string, unknown>,
    {
      activeDownloads: new Map(),
      disposed: false,
      activeTabs: new Map(),
      activeFindRequests: new Map(),
      browserConfigGeneration: 0,
      browserEnabled: true,
      clearingScopes: new Set<string>(),
      clearingOrigins: new Map<string, string>(),
      scriptOriginCleanupTails: new Map<string, Promise<void>>(),
      clearQuarantinedScopes: new Set<string>(),
      closedTabs: new Map(),
      dataScope: 'global',
      readAccessPolicy: 'allow',
      structuredActionsPolicy: 'allow',
      scriptInjectionPolicy: 'allow',
      passwordAccessPolicy: 'user-only',
      aiAllowPrivateNetwork: false,
      getWindow: () => null,
      getConfig: () => ({ browser: { dataScope: 'conversation', enabled: true } }),
      conversationExists: () => true,
      hostRendererAuthorityGeneration: 0,
      hostRendererAuthorityAvailable: true,
      shuttingDown: false,
      pendingAuth: new Map(),
      pendingCredentials: new Map(),
      pendingElementPickerCancels: new Map(),
      pendingElementPickerFrames: new Map(),
      pendingPermissions: new Map(),
      profileMutationTail: Promise.resolve(),
      oneTimePermissions: new Set(),
      panelAuthorityGenerations: new Map(),
      panelLayoutGenerations: new Map(),
      panelStateWaiters: new Map(),
      runningActions: new Map(),
      scopeActivityCounts: new Map(),
      scopeGenerations: new Map(),
      scopeGenerationSerial: 0,
      scopeIdleWaiters: new Map(),
      scopeRequestActivities: new Map(),
      scopeRuntimeReleaseTokens: new Map(),
      stores: new Map(),
      suspendedScopes: new Set<string>(),
      tabOrder: new Map(),
      removedConversations: new Set<string>(),
      restrictedBackgroundScopes: new Set<string>(),
      pendingCleanupQuarantineUnreadable: false,
      assistantControlledOrigins: new Map<string, Set<string>>(),
      assistantContinuationLeases: new Set<string>(),
      screenshotQueue: new BrowserActionQueue(),
      visibleAssistantQueue: new BrowserActionQueue(),
      tabs: new Map(),
      vaults: new Map(),
      wiredSessions: new WeakSet(),
      wiredSessionsByScope: new Map<string, unknown>(),
      wiredSessionCleanups: new Map<string, () => void>(),
    },
    properties,
  );
  return manager;
}

function invokePrivate(target: object, name: string, ...args: unknown[]): unknown {
  const fn = Reflect.get(Object.getPrototypeOf(target), name) as (this: object, ...values: unknown[]) => unknown;
  return fn.call(target, ...args);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function visibleHostWindow(overrides: Record<string, unknown> = {}) {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isFocused: () => true,
    ...overrides,
  };
}

describe('assistant Browser authority revocation', () => {
  it('rotates authority, aborts operations, closes temporary tabs, and clears kept-tab control', () => {
    const temporary = {
      shell: { id: 'temporary', conversationId: 'chat-1', owner: 'assistant', keepOpen: false },
      popupGesture: { source: 'assistant', assistantOwnerId: 'run-1', expiresAt: Date.now() + 1_000 },
      aiControlOwnerId: 'run-1',
      aiControlGeneration: 1,
      aiActionDepth: 1,
      aiActionUntil: Date.now() + 1_000,
      assistantScriptDepth: 1,
      trustedGestureGeneration: 0,
      visibleAssistantGeneration: 0,
    };
    const kept = {
      shell: {
        id: 'kept',
        conversationId: 'chat-1',
        owner: 'assistant',
        keepOpen: true,
        discarded: false,
        sensitive: true,
      },
      view: { webContents: { id: 41 } } as { webContents: { id: number } } | null,
      popupGesture: { source: 'assistant', assistantOwnerId: 'run-1', expiresAt: Date.now() + 1_000 },
      aiNetworkRestricted: true,
      aiControlOwnerId: 'run-1',
      aiControlGeneration: 1,
      aiActionDepth: 1,
      aiActionUntil: Date.now() + 1_000,
      assistantScriptDepth: 1,
      trustedGestureGeneration: 0,
      visibleAssistantGeneration: 0,
    };
    const tabs = new Map([
      [temporary.shell.id, temporary],
      [kept.shell.id, kept],
    ]);
    const operation = new AbortController();
    const clearRuns = vi.fn();
    const cancelContinuations = vi.fn(async () => undefined);
    const cancelTemporaryDownload = vi.fn(async () => undefined);
    const cancelKeptDownload = vi.fn(async () => undefined);
    const emitTabs = vi.fn();
    const closeTab = vi.fn((tab: typeof temporary) => tabs.delete(tab.shell.id));
    const destroyView = vi.fn((tab: typeof kept) => {
      tab.view = null;
    });
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', kept.shell.id]]),
      activeDownloads: new Map([
        [
          {},
          {
            assistantOwnerId: 'run-1',
            keepOpen: false,
            cancel: cancelTemporaryDownload,
          },
        ],
        [
          {},
          {
            assistantOwnerId: 'run-1',
            keepOpen: true,
            cancel: cancelKeptDownload,
          },
        ],
      ]),
      assistantRuns: { clear: clearRuns },
      automationGestureTokens: new Map([['gesture', {}]]),
      cancelAssistantContinuations: cancelContinuations,
      closeTab,
      destroyView,
      emitTabs,
      chromeFocusConversationId: 'chat-1',
      hostRendererAuthorityGeneration: 7,
      hostRendererOperationControllers: new Set([operation]),
      notifyPanelStateChanged: vi.fn(),
      tabs,
    });

    manager.revokeAssistantAccess();

    expect(manager.getHostRendererAuthorityGeneration()).toBe(8);
    expect(operation.signal.aborted).toBe(true);
    expect(clearRuns).toHaveBeenCalledOnce();
    expect(cancelContinuations).toHaveBeenCalledOnce();
    expect(cancelTemporaryDownload).toHaveBeenCalledOnce();
    expect(cancelKeptDownload).not.toHaveBeenCalled();
    expect(Reflect.get(manager, 'chromeFocusConversationId')).toBeNull();
    expect(closeTab).toHaveBeenCalledWith(temporary, false);
    expect(tabs.has(temporary.shell.id)).toBe(false);
    expect(destroyView).toHaveBeenCalledWith(kept);
    expect(kept.view).toBeNull();
    expect(kept.shell).toMatchObject({ discarded: true, sensitive: false });
    expect(kept.popupGesture).toBeNull();
    expect(kept.aiControlOwnerId).toBeNull();
    expect(kept.aiControlGeneration).toBeNull();
    expect(kept.aiActionDepth).toBe(0);
    expect(kept.assistantScriptDepth).toBe(0);
    expect(emitTabs).toHaveBeenCalledWith('chat-1');
  });
});

describe('assistant Browser download ownership', () => {
  it('uses the current run for assistant tabs without making user-tab downloads temporary', () => {
    const manager = managerWithoutConstructor({
      assistantRuns: {
        generationIfActive: (_conversationId: string, runId: string) => (runId === 'active-creator' ? 1 : null),
      },
    });
    const shell = { conversationId: 'chat-1', owner: 'assistant' as const };

    expect(
      invokePrivate(manager, 'assistantDownloadOwner', {
        shell,
        assistantOwnerId: 'old-creator',
        aiControlOwnerId: 'current-run',
      }),
    ).toBe('current-run');
    expect(
      invokePrivate(manager, 'assistantDownloadOwner', {
        shell,
        assistantOwnerId: 'active-creator',
        aiControlOwnerId: null,
      }),
    ).toBe('active-creator');
    expect(
      invokePrivate(manager, 'assistantDownloadOwner', {
        shell: { ...shell, owner: 'user' },
        assistantOwnerId: null,
        aiControlOwnerId: 'current-run',
      }),
    ).toBeNull();
  });
});

describe('browser manager renderer lifecycle', () => {
  beforeEach(() => {
    electronMocks.appOff.mockReset();
    electronMocks.appOn.mockReset();
    electronMocks.fromPartition.mockReset();
    electronMocks.ipcOff.mockReset();
    electronMocks.ipcOn.mockReset();
    electronMocks.screenGetAllDisplays.mockReset().mockReturnValue([{ scaleFactor: 1 }]);
    electronMocks.showSaveDialog.mockReset();
    electronMocks.webContentsView.mockReset();
  });

  it('accepts an element-picker result only after the exact armed frame and token report a trusted point', async () => {
    const mainFrame = {
      detached: false,
      frameTreeNodeId: 101,
      framesInSubtree: [] as unknown[],
      isDestroyed: () => false,
      send: vi.fn(),
    };
    mainFrame.framesInSubtree = [mainFrame];
    const contents = {
      id: 42,
      getZoomFactor: () => 1,
      isDestroyed: () => false,
      mainFrame,
    };
    const view = {
      getBounds: () => ({ x: 0, y: 0, width: 640, height: 480 }),
      webContents: contents,
    };
    const tab = {
      generation: 3,
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      trustedUserNavigationLease: 7,
      view,
    };
    const manager = new BrowserManager(
      '/tmp/kai-browser-picker-test',
      () => ({ browser: { dataScope: 'global' } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    const tabs = Reflect.get(manager, 'tabs') as Map<string, typeof tab>;
    tabs.set(tab.shell.id, tab);
    Object.assign(manager as unknown as Record<string, unknown>, {
      assertTabNotSensitive: vi.fn(async () => undefined),
      ensureView: vi.fn(async () => view),
      runTabOperation: (_tab: unknown, operation: () => Promise<unknown>) => operation(),
    });

    const picked = manager.pickElement('chat-1', 'tab-1');
    await vi.waitFor(() =>
      expect(mainFrame.send).toHaveBeenCalledWith(
        'browser-page:element-picker-arm',
        expect.objectContaining({ token: expect.any(String) }),
      ),
    );
    const arm = mainFrame.send.mock.calls.find(([channel]) => channel === 'browser-page:element-picker-arm');
    const token = (arm?.[1] as { token?: string })?.token;
    expect(token).toEqual(expect.any(String));
    const clickHandler = electronMocks.ipcOn.mock.calls.find(
      ([channel]) => channel === 'browser-page:element-picker-click',
    )?.[1] as (event: unknown, payload: unknown) => void;
    const resultHandler = electronMocks.ipcOn.mock.calls.find(
      ([channel]) => channel === 'browser-page:element-picker-result',
    )?.[1] as (event: unknown, payload: unknown) => void;

    clickHandler({ sender: { id: 42 }, senderFrame: mainFrame }, { token, x: 12, y: 18 });
    expect(mainFrame.send).not.toHaveBeenCalledWith('browser-page:element-picker-select-at', expect.anything());
    clickHandler({ sender: contents, senderFrame: mainFrame }, { token, x: 12, y: 18 });
    expect(mainFrame.send).toHaveBeenCalledWith('browser-page:element-picker-select-at', { token });
    resultHandler({ sender: contents, senderFrame: mainFrame }, { token, selector: '#target' });

    await expect(picked).resolves.toEqual({
      selector: '#target',
      documentToken: 'tab-1:3:7:42',
    });
    expect(mainFrame.send).toHaveBeenCalledWith('browser-page:element-picker-disarm', { token });
    tabs.clear();
    manager.dispose();
  });

  it('suppresses and rejects an element-picker click from an embedded frame', async () => {
    const childFrame = {
      detached: false,
      frameTreeNodeId: 102,
      isDestroyed: () => false,
      send: vi.fn(),
    };
    const mainFrame = {
      detached: false,
      frameTreeNodeId: 101,
      framesInSubtree: [] as unknown[],
      isDestroyed: () => false,
      send: vi.fn(),
    };
    mainFrame.framesInSubtree = [mainFrame, childFrame];
    const contents = {
      id: 42,
      getZoomFactor: () => 1,
      isDestroyed: () => false,
      mainFrame,
    };
    const view = {
      getBounds: () => ({ x: 0, y: 0, width: 640, height: 480 }),
      webContents: contents,
    };
    const tab = {
      generation: 3,
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      trustedUserNavigationLease: 7,
      view,
    };
    const manager = new BrowserManager(
      '/tmp/kai-browser-picker-frame-test',
      () => ({ browser: { dataScope: 'global' } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    const tabs = Reflect.get(manager, 'tabs') as Map<string, typeof tab>;
    tabs.set(tab.shell.id, tab);
    Object.assign(manager as unknown as Record<string, unknown>, {
      assertTabNotSensitive: vi.fn(async () => undefined),
      ensureView: vi.fn(async () => view),
      runTabOperation: (_tab: unknown, operation: () => Promise<unknown>) => operation(),
    });

    const picked = manager.pickElement('chat-1', 'tab-1');
    await vi.waitFor(() =>
      expect(childFrame.send).toHaveBeenCalledWith(
        'browser-page:element-picker-arm',
        expect.objectContaining({ token: expect.any(String) }),
      ),
    );
    const childArm = childFrame.send.mock.calls.find(([channel]) => channel === 'browser-page:element-picker-arm');
    const token = (childArm?.[1] as { token?: string })?.token;
    const clickHandler = electronMocks.ipcOn.mock.calls.find(
      ([channel]) => channel === 'browser-page:element-picker-click',
    )?.[1] as (event: unknown, payload: unknown) => void;
    clickHandler({ sender: contents, senderFrame: childFrame }, { token, x: 12, y: 18 });

    await expect(picked).rejects.toThrow(/embedded frames/);
    expect(childFrame.send).not.toHaveBeenCalledWith('browser-page:element-picker-select-at', expect.anything());
    expect(childFrame.send).toHaveBeenCalledWith('browser-page:element-picker-disarm', { token });
    tabs.clear();
    manager.dispose();
  });

  it('does not commit rejected native-view bounds', async () => {
    const previousBounds = { x: 10, y: 20, width: 300, height: 200 };
    const manager = managerWithoutConstructor({
      getConfig: () => ({ browser: { enabled: true } }),
      getWindow: () => ({
        isDestroyed: () => false,
        getContentBounds: () => ({ width: 800, height: 600 }),
      }),
      mountedBounds: previousBounds,
      mountedConversationId: 'chat-existing',
    });

    await expect(manager.mount('chat-new', { x: 700, y: 0, width: 200, height: 100 })).rejects.toThrow(/fit inside/);
    expect(Reflect.get(manager, 'mountedConversationId')).toBe('chat-existing');
    expect(Reflect.get(manager, 'mountedBounds')).toBe(previousBounds);
  });

  it('does not steal Browser chrome focus when a temporarily detached native view is reattached', () => {
    const focus = vi.fn();
    const view = {
      setBounds: vi.fn(),
      webContents: { focus },
    };
    const addChildView = vi.fn();
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'tab-1']]),
      attachedView: null,
      getWindow: () => ({
        contentView: { addChildView, removeChildView: vi.fn() },
        isDestroyed: () => false,
      }),
      mountedBounds: { x: 10, y: 20, width: 300, height: 200 },
      mountedConversationId: 'chat-1',
      tabs: new Map([['tab-1', { shell: { id: 'tab-1', conversationId: 'chat-1' }, view }]]),
    });

    invokePrivate(manager, 'attachActiveView', 'chat-1');

    expect(addChildView).toHaveBeenCalledWith(view);
    expect(focus).not.toHaveBeenCalled();

    invokePrivate(manager, 'attachActiveView', 'chat-1', true);
    expect(focus).toHaveBeenCalledOnce();
  });

  it('publishes an activated discarded tab before waiting for its view to restore', async () => {
    const restored = deferred<{ webContents: Record<string, never> }>();
    const emitTabs = vi.fn();
    const attachActiveView = vi.fn();
    const activeTabs = new Map([['chat-1', 'tab-old']]);
    const tab = {
      shell: { id: 'tab-new', conversationId: 'chat-1' },
      lastUsedAt: 0,
    };
    const manager = managerWithoutConstructor({
      activeTabs,
      attachActiveView,
      cancelElementPickersForConversation: vi.fn(),
      emitTabs,
      ensureView: vi.fn(() => restored.promise),
      tabs: new Map([['tab-new', tab]]),
    });

    const activation = invokePrivate(manager, 'commandTabWithinOperation', tab, 'activate', 'user') as Promise<void>;
    await vi.waitFor(() => expect(emitTabs).toHaveBeenCalledOnce());

    expect(activeTabs.get('chat-1')).toBe('tab-new');
    expect(attachActiveView).not.toHaveBeenCalled();

    restored.resolve({ webContents: {} });
    await activation;

    expect(attachActiveView).toHaveBeenCalledWith('chat-1', true);
    expect(emitTabs).toHaveBeenCalledTimes(2);
  });

  it('updates active download retention when an assistant tab is kept open', async () => {
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', keepOpen: false },
    };
    const download = { tabId: 'tab-1', keepOpen: false };
    const manager = managerWithoutConstructor({
      activeDownloads: new Map([[{}, download]]),
      emitTabs: vi.fn(),
      tabs: new Map([[tab.shell.id, tab]]),
    });

    await invokePrivate(manager, 'commandTabWithinOperation', tab, 'keep-open', 'assistant');

    expect(tab.shell.keepOpen).toBe(true);
    expect(download.keepOpen).toBe(true);
  });

  it.each(['activate', 'close', 'keep-open'] as const)(
    'opens the Browser panel before an assistant %s tab command',
    async (command) => {
      const emit = vi.fn();
      const commandTabWithinOperation = vi.fn(async () => undefined);
      const tab = { scopeKey: 'global', shell: { id: 'tab-1', conversationId: 'chat-1' } };
      const manager = managerWithoutConstructor({
        commandTabWithinOperation,
        emit,
        runTabOperation: (_tab: unknown, operation: () => Promise<void>) => operation(),
        withAssistantControl: (_tab: unknown, _run: unknown, operation: () => Promise<void>) => operation(),
        withScopeActivity: (_scopeKey: string, operation: () => Promise<void>) => operation(),
        tabs: new Map([['tab-1', tab]]),
      });

      await manager.commandTab('chat-1', 'tab-1', command, 'assistant', { id: 'run-1' });

      expect(emit).toHaveBeenCalledWith({ type: 'open-panel', conversationId: 'chat-1', tabId: 'tab-1' });
      expect(commandTabWithinOperation).toHaveBeenCalled();
    },
  );

  it('stops an in-flight page load without joining its unresolved load promise', async () => {
    const pageLoad = deferred<never>();
    const stop = vi.fn();
    const ensureView = vi.fn();
    const emitTabs = vi.fn();
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      trustedUserNavigation: true,
      trustedUserNavigationTarget: 'https://slow.example',
      trustedUserNavigationRequestId: 42,
      trustedUserNavigationLease: 1,
      view: {
        webContents: {
          isDestroyed: () => false,
          stop,
        },
      },
      viewLoadPromise: pageLoad.promise,
    };
    const manager = managerWithoutConstructor({
      emitTabs,
      ensureView,
      tabs: new Map([[tab.shell.id, tab]]),
    });

    await expect(
      invokePrivate(manager, 'commandTabWithinOperation', tab, 'stop', 'user') as Promise<void>,
    ).resolves.toBeUndefined();

    expect(stop).toHaveBeenCalledOnce();
    expect(ensureView).not.toHaveBeenCalled();
    expect(tab.trustedUserNavigation).toBe(false);
    expect(emitTabs).toHaveBeenCalledWith('chat-1');
  });

  it('removes a provisional popup shell when native view creation fails', () => {
    const opener = {
      shell: { id: 'opener', conversationId: 'chat-1', owner: 'user' },
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      assistantOwnerId: null,
      aiNetworkRestricted: false,
      aiControlOwnerId: null,
      aiControlGeneration: null,
      assistantScriptDepth: 0,
      popupGesture: null,
      scriptTainted: false,
    };
    const tabs = new Map<string, unknown>([['opener', opener]]);
    const tabOrder = new Map([['chat-1', ['opener']]]);
    const activeTabs = new Map([['chat-1', 'opener']]);
    const emitTabs = vi.fn();
    const manager = managerWithoutConstructor({
      activeTabs,
      attachActiveView: vi.fn(),
      closedTabs: new Map(),
      config: () => ({
        enabled: true,
        maxTabsPerConversation: 10,
        aiAllowPrivateNetwork: true,
      }),
      createView: vi.fn(() => {
        throw new Error('native view failed');
      }),
      destroyView: vi.fn(),
      dropPendingForTab: vi.fn(),
      emit: vi.fn(),
      emitTabs,
      pendingTabCreations: new Map(),
      requireLiveWindow: vi.fn(),
      assertScopeAvailable: vi.fn(),
      storeForScope: () => ({ getZoomLevel: () => 0 }),
      tabs,
      tabOrder,
    });

    const createWindow = invokePrivate(
      manager,
      'createPopupTab',
      opener,
      'https://example.com/popup',
      'foreground-tab',
    ) as (options: Record<string, unknown>) => unknown;
    const popupId = tabOrder.get('chat-1')?.[1];
    expect(popupId).toBeTruthy();
    expect(tabs.has(popupId!)).toBe(true);

    expect(() => createWindow({})).toThrow('native view failed');

    expect(tabOrder.get('chat-1')).toEqual(['opener']);
    expect(activeTabs.get('chat-1')).toBe('opener');
    expect(tabs.has(popupId!)).toBe(false);
    expect(emitTabs).toHaveBeenCalledTimes(2);
  });

  it('denies popups from an evaluated renderer before creating an unguarded WebContents', () => {
    const opener = {
      shell: { id: 'opener', conversationId: 'chat-1', owner: 'user' as const },
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      assistantOwnerId: null,
      aiNetworkRestricted: true,
      aiControlOwnerId: 'run-1',
      aiControlGeneration: 7,
      assistantScriptDepth: 1,
      popupGesture: null,
      scriptTainted: true,
    };
    const tabs = new Map<string, unknown>([['opener', opener]]);
    const tabOrder = new Map([['chat-1', ['opener']]]);
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'opener']]),
      assistantRuns: { generationIfActive: () => 7 },
      config: () => ({ enabled: true, maxTabsPerConversation: 10, aiAllowPrivateNetwork: true }),
      emit: vi.fn(),
      emitTabs: vi.fn(),
      pendingTabCreations: new Map(),
      requireLiveWindow: vi.fn(),
      assertScopeAvailable: vi.fn(),
      storeForScope: () => ({ getZoomLevel: () => 0 }),
      tabs,
      tabOrder,
    });

    const createWindow = invokePrivate(manager, 'createPopupTab', opener, 'about:blank', 'foreground-tab');

    expect(createWindow).toBeNull();
    expect(tabOrder.get('chat-1')).toEqual(['opener']);
    expect(tabs.size).toBe(1);
  });

  it('resolves a popup referrer only when it identifies one live frame', () => {
    const frame = (frameTreeNodeId: number, url: string) => ({
      detached: false,
      frameTreeNodeId,
      isDestroyed: () => false,
      url,
    });
    const contents = {
      isDestroyed: () => false,
      mainFrame: {
        framesInSubtree: [frame(1, 'https://example.com/main#current'), frame(2, 'https://widgets.example/frame')],
      },
    };

    expect(popupInitiatorFrameTreeNodeId(contents as never, 'https://widgets.example/frame#ignored')).toBe(2);
    contents.mainFrame.framesInSubtree.push(frame(3, 'https://widgets.example/frame'));
    expect(popupInitiatorFrameTreeNodeId(contents as never, 'https://widgets.example/frame')).toBeNull();
    expect(popupInitiatorFrameTreeNodeId(contents as never, '')).toBeNull();
  });

  it('does not let a user gesture in another frame declassify an assistant-controlled popup', () => {
    const opener = {
      shell: { id: 'opener', conversationId: 'chat-1', owner: 'user' as const },
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      assistantOwnerId: null,
      aiNetworkRestricted: true,
      aiControlOwnerId: 'run-1',
      aiControlGeneration: 1,
      assistantScriptDepth: 0,
      popupGesture: {
        source: 'user' as const,
        assistantOwnerId: null,
        expiresAt: Date.now() + 5_000,
        frameTreeNodeId: 7,
        kind: 'pointerdown' as const,
      },
      scriptTainted: false,
    };
    const tabs = new Map<string, unknown>([['opener', opener]]);
    const tabOrder = new Map([['chat-1', ['opener']]]);
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'opener']]),
      assistantRuns: { generationIfActive: () => 1 },
      attachActiveView: vi.fn(),
      config: () => ({ enabled: true, maxTabsPerConversation: 10, aiAllowPrivateNetwork: true }),
      emit: vi.fn(),
      emitTabs: vi.fn(),
      pendingTabCreations: new Map(),
      requireLiveWindow: vi.fn(),
      assertScopeAvailable: vi.fn(),
      storeForScope: () => ({ getZoomLevel: () => 0 }),
      tabs,
      tabOrder,
    });

    expect(invokePrivate(manager, 'createPopupTab', opener, 'https://popup.example', 'foreground-tab', 8)).toBeTypeOf(
      'function',
    );

    const popupId = tabOrder.get('chat-1')?.[1];
    expect(tabs.get(popupId!)).toMatchObject({
      assistantOwnerId: 'run-1',
      shell: { owner: 'assistant' },
    });
  });

  it('allows only an exact user popup after a completed run leaves the opener network-restricted', () => {
    const opener = {
      shell: { id: 'opener', conversationId: 'chat-1', owner: 'user' as const },
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      assistantOwnerId: null,
      aiNetworkRestricted: true,
      aiControlOwnerId: null,
      aiControlGeneration: null,
      assistantScriptDepth: 0,
      popupGesture: null as {
        source: 'user';
        assistantOwnerId: null;
        expiresAt: number;
        frameTreeNodeId: number;
      } | null,
      scriptTainted: false,
    };
    const tabs = new Map<string, unknown>([['opener', opener]]);
    const tabOrder = new Map([['chat-1', ['opener']]]);
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'opener']]),
      attachActiveView: vi.fn(),
      config: () => ({ enabled: true, maxTabsPerConversation: 10, aiAllowPrivateNetwork: true }),
      emit: vi.fn(),
      emitTabs: vi.fn(),
      pendingTabCreations: new Map(),
      requireLiveWindow: vi.fn(),
      assertScopeAvailable: vi.fn(),
      storeForScope: () => ({ getZoomLevel: () => 0 }),
      tabs,
      tabOrder,
    });

    expect(invokePrivate(manager, 'createPopupTab', opener, 'https://delayed.example', 'foreground-tab')).toBeNull();

    opener.popupGesture = {
      source: 'user',
      assistantOwnerId: null,
      expiresAt: Date.now() + 5_000,
      frameTreeNodeId: 7,
    };
    expect(invokePrivate(manager, 'createPopupTab', opener, 'https://clicked.example', 'foreground-tab', 7)).toBeTypeOf(
      'function',
    );

    const popupId = tabOrder.get('chat-1')?.[1];
    expect(tabs.get(popupId!)).toMatchObject({
      aiNetworkRestricted: true,
      aiControlOwnerId: null,
      shell: { owner: 'user' },
    });
  });

  it('intercepts Electron accelerators only while Browser chrome owns focus', async () => {
    const applyShortcut = vi.fn(async () => undefined);
    const preventDefault = vi.fn();
    const focus = vi.fn();
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'tab-1']]),
      applyShortcut,
      disposed: false,
      getWindow: () => ({
        isDestroyed: () => false,
        webContents: { focus, isDestroyed: () => false },
      }),
      shuttingDown: false,
      tabs: new Map([['tab-1', { shell: { id: 'tab-1', conversationId: 'chat-1' } }]]),
    });
    const input = { type: 'keyDown', key: 't', meta: true, control: true };

    expect(manager.handleChromeShortcut({ preventDefault } as never, input as never)).toBe(false);
    manager.setChromeFocus('chat-1', true);
    expect(focus).toHaveBeenCalledOnce();
    expect(manager.handleChromeShortcut({ preventDefault } as never, input as never)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(applyShortcut).toHaveBeenCalledWith('chat-1', 'tab-1', 'new-tab', undefined));

    expect(
      manager.handleChromeShortcut(
        { preventDefault } as never,
        {
          type: 'keyDown',
          key: 'Escape',
          meta: false,
          control: false,
        } as never,
      ),
    ).toBe(false);
    manager.setChromeFocus('chat-1', false);
    expect(manager.handleChromeShortcut({ preventDefault } as never, input as never)).toBe(false);
  });

  it('routes application-menu commands to focused Browser pages or chrome only', async () => {
    const pageContents = { id: 42, isDestroyed: () => false };
    const hostContents = { id: 7, focus: vi.fn(), isDestroyed: () => false };
    const applyShortcut = vi.fn(async () => undefined);
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      view: { webContents: pageContents },
    };
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'tab-1']]),
      applyShortcut,
      getWindow: () => ({ isDestroyed: () => false, webContents: hostContents }),
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
    });

    expect(manager.dispatchApplicationMenuCommand(pageContents as never, 'reload')).toBe(true);
    await vi.waitFor(() => expect(applyShortcut).toHaveBeenCalledWith('chat-1', 'tab-1', 'reload'));

    manager.setChromeFocus('chat-1', true);
    expect(manager.dispatchApplicationMenuCommand(hostContents as never, 'find')).toBe(true);
    await vi.waitFor(() => expect(applyShortcut).toHaveBeenCalledWith('chat-1', 'tab-1', 'find'));

    expect(manager.dispatchApplicationMenuCommand({ id: 99, isDestroyed: () => false } as never, 'zoom-in')).toBe(
      false,
    );
  });

  it('fails closed when an application-menu target has a stale managed mapping', () => {
    const contents = { id: 42, isDestroyed: () => false };
    const manager = managerWithoutConstructor({
      getWindow: () => null,
      tabs: new Map(),
      webContentsToTab: new Map([[42, 'missing-tab']]),
    });

    expect(manager.dispatchApplicationMenuCommand(contents as never, 'reload')).toBe(true);
  });

  it('broadcasts global bookmark mutations to every known conversation', () => {
    const bookmark = {
      id: 'bookmark-1',
      scopeKey: 'global',
      title: 'Example',
      url: 'https://example.com',
      folder: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const emit = vi.fn();
    const manager = managerWithoutConstructor({
      activeDownloads: new Map(),
      clearingScopes: new Set(),
      getConfig: () => ({ browser: { dataScope: 'global' } }),
      mountedConversationId: 'chat-3',
      stores: new Map([['global', { addBookmark: vi.fn(() => bookmark) }]]),
      tabOrder: new Map([
        ['chat-1', []],
        ['chat-2', []],
      ]),
      emit,
    });

    expect(manager.addBookmark('chat-1', bookmark.title, bookmark.url)).toEqual(bookmark);
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'bookmarks-changed', conversationId: 'chat-1' },
      { type: 'bookmarks-changed', conversationId: 'chat-2' },
      { type: 'bookmarks-changed', conversationId: 'chat-3' },
    ]);
  });

  it('broadcasts global download updates to every known conversation', () => {
    const emit = vi.fn();
    const download = {
      id: 'download-1',
      tabId: 'tab-1',
      filename: 'report.pdf',
      receivedBytes: 10,
      totalBytes: 10,
      state: 'completed' as const,
    };
    const manager = managerWithoutConstructor({
      getConfig: () => ({ browser: { dataScope: 'global' } }),
      mountedConversationId: 'chat-3',
      tabOrder: new Map([
        ['chat-1', []],
        ['chat-2', []],
      ]),
      emit,
    });

    invokePrivate(manager, 'emitDownloadForScope', 'global', 'chat-1', download);

    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'download', conversationId: 'chat-1', download },
      { type: 'download', conversationId: 'chat-2', download },
      { type: 'download', conversationId: 'chat-3', download },
    ]);
  });

  it('broadcasts asynchronous profile errors across a shared scope', () => {
    const emit = vi.fn();
    const manager = managerWithoutConstructor({
      getConfig: () => ({ browser: { dataScope: 'global' } }),
      mountedConversationId: 'chat-2',
      tabOrder: new Map([['chat-1', []]]),
      emit,
    });

    invokePrivate(manager, 'emitProfileErrorForScope', 'global', 'history', new Error('disk full'));

    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      {
        type: 'profile-error',
        conversationId: 'chat-1',
        area: 'history',
        message: 'Browsing history could not be saved: disk full',
      },
      {
        type: 'profile-error',
        conversationId: 'chat-2',
        area: 'history',
        message: 'Browsing history could not be saved: disk full',
      },
    ]);
  });

  it('arms assistant pointer provenance with frame-independent screen coordinates', () => {
    const send = vi.fn();
    const view = {
      getBounds: () => ({ x: 20, y: 30, width: 400, height: 300 }),
    };
    const manager = managerWithoutConstructor({
      attachedView: view,
      automationGestureTokens: new Map(),
      getWindow: () => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false },
        getContentBounds: () => ({ x: 100, y: 200, width: 800, height: 600 }),
      }),
    });
    const tab = {
      shell: { id: 'tab-1' },
      aiControlOwnerId: 'run-1',
      view,
    };
    const contents = {
      getZoomFactor: () => 2,
      mainFrame: {
        framesInSubtree: [{ detached: false, isDestroyed: () => false, send }],
      },
    };

    invokePrivate(manager, 'armAutomationGesture', tab, contents, {
      kind: 'pointerdown',
      x: 10,
      y: 20,
    });

    expect(send).toHaveBeenCalledWith(
      'browser-page:arm-automation-input',
      expect.objectContaining({
        kind: 'pointerdown',
        x: 10,
        y: 20,
        screenX: 140,
        screenY: 270,
      }),
    );
  });

  it('keeps typed plaintext in main instead of broadcasting it to page frames', () => {
    const send = vi.fn();
    const manager = managerWithoutConstructor({
      attachedView: null,
      automationGestureTokens: new Map(),
      getWindow: () => null,
    });
    const tab = {
      shell: { id: 'tab-1' },
      aiControlOwnerId: 'run-1',
      view: null,
    };
    const contents = {
      mainFrame: {
        framesInSubtree: [{ detached: false, isDestroyed: () => false, send }],
      },
    };

    invokePrivate(manager, 'armAutomationGesture', tab, contents, {
      kind: 'input',
      inputType: 'insertText',
      data: 'assistant text',
    });

    const published = send.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(published).toMatchObject({ kind: 'input', inputType: 'insertText' });
    expect(published).not.toHaveProperty('data');
    const pending = [...(Reflect.get(manager, 'automationGestureTokens') as Map<string, unknown>).values()];
    expect(pending).toEqual([expect.objectContaining({ inputData: 'assistant text' })]);
  });

  it('publishes pointer provenance only from the exact synchronous before-mouse callback', () => {
    const send = vi.fn();
    const manager = managerWithoutConstructor({
      attachedView: null,
      automationGestureTokens: new Map(),
      pendingSyntheticInputs: new Map(),
      getWindow: () => null,
    });
    const tab = {
      shell: { id: 'tab-1' },
      aiControlOwnerId: 'run-1',
      popupGesture: {
        source: 'user' as const,
        assistantOwnerId: null,
        expiresAt: Date.now() + 1_000,
      },
      view: null,
    };
    const beforeEvent = { preventDefault: vi.fn() };
    const contents = {
      id: 42,
      getZoomFactor: () => 1,
      mainFrame: {
        framesInSubtree: [{ detached: false, isDestroyed: () => false, send }],
      },
      sendInputEvent: vi.fn((input: { type: Electron.InputEvent['type'] }) => {
        // The preload has not received a shape token while a physical user
        // event could race the queued synthetic click.
        expect(send).not.toHaveBeenCalled();
        invokePrivate(manager, 'handlePendingSyntheticInput', tab, contents, beforeEvent, input.type);
      }),
    };

    invokePrivate(
      manager,
      'sendAttributedInputEvent',
      tab,
      contents,
      { kind: 'pointerdown', x: 10, y: 20 },
      { type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1 },
    );

    expect(beforeEvent.preventDefault).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      'browser-page:arm-automation-input',
      expect.objectContaining({ kind: 'pointerdown', token: expect.any(String) }),
    );
    expect(tab.popupGesture).toMatchObject({ source: 'assistant', assistantOwnerId: 'run-1' });
    expect(Reflect.get(manager, 'pendingSyntheticInputs')).toHaveLength(0);
  });

  it('uses kind-only provenance while an assistant page is detached', () => {
    const send = vi.fn();
    const manager = managerWithoutConstructor({
      attachedView: null,
      automationGestureTokens: new Map(),
      getWindow: () => null,
    });
    const tab = {
      shell: { id: 'tab-1' },
      aiControlOwnerId: 'run-1',
      view: { getBounds: vi.fn() },
    };
    const contents = {
      mainFrame: {
        framesInSubtree: [{ detached: false, isDestroyed: () => false, send }],
      },
    };

    invokePrivate(manager, 'armAutomationGesture', tab, contents, {
      kind: 'pointerdown',
      x: 10,
      y: 20,
    });

    const payload = send.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({ kind: 'pointerdown' });
    expect(payload).not.toHaveProperty('x');
    expect(payload).not.toHaveProperty('y');
    expect(payload).not.toHaveProperty('screenX');
    expect(payload).not.toHaveProperty('screenY');
  });

  it('drops secrets and resolves site prompts even when the renderer view is already gone', () => {
    const permissionCallback = vi.fn();
    const authCallback = vi.fn();
    const pickerCancel = vi.fn();
    const credential = {
      tabId: 'tab-1',
      conversationId: 'chat-1',
      origin: 'https://example.com',
      username: 'user',
      password: 'secret',
      scopeKey: 'global',
      timer: setTimeout(() => undefined, 60_000),
    };
    const manager = managerWithoutConstructor({
      attachedView: null,
      getWindow: () => null,
      oneTimePermissions: new Set(['tab-1\u0000https://example.com\u0000media']),
      pendingAuth: new Map([
        [
          'auth-1',
          {
            tabId: 'tab-1',
            conversationId: 'chat-1',
            callback: authCallback,
            timer: setTimeout(() => undefined, 60_000),
          },
        ],
      ]),
      pendingCredentials: new Map([['credential-1', credential]]),
      pendingElementPickerCancels: new Map([['tab-1', pickerCancel]]),
      pendingPermissions: new Map([
        [
          'permission-1',
          {
            tabId: 'tab-1',
            conversationId: 'chat-1',
            callback: permissionCallback,
            timer: setTimeout(() => undefined, 60_000),
          },
        ],
      ]),
      automationGestureTokens: new Map(),
      webContentsToTab: new Map(),
    });
    const tab = {
      shell: { id: 'tab-1' },
      view: null,
      overlayTimer: null,
      overlayGeneration: 0,
    };

    invokePrivate(manager, 'destroyView', tab);

    expect(credential.password).toBe('');
    expect(pickerCancel).toHaveBeenCalledOnce();
    expect(permissionCallback).toHaveBeenCalledWith(false);
    expect(authCallback).toHaveBeenCalledWith(undefined, undefined);
    expect(Reflect.get(manager, 'pendingCredentials')).toHaveLength(0);
    expect(Reflect.get(manager, 'pendingPermissions')).toHaveLength(0);
    expect(Reflect.get(manager, 'pendingAuth')).toHaveLength(0);
    expect(Reflect.get(manager, 'oneTimePermissions')).toHaveLength(0);
  });

  it('reclaims the owning native view when its renderer process exits', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const contents = {
      id: 42,
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      setWindowOpenHandler: vi.fn(),
    };
    const view = { webContents: contents };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', discarded: false } as {
        id: string;
        conversationId: string;
        discarded: boolean;
        error?: string;
      },
      view,
    };
    const destroyView = vi.fn((target: typeof tab) => {
      target.view = null as never;
    });
    const emitTabs = vi.fn();
    const manager = managerWithoutConstructor({
      destroyView,
      emitTabs,
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
    });

    invokePrivate(manager, 'wireWebContents', tab, contents);
    listeners.get('render-process-gone')?.({}, { reason: 'crashed' });

    expect(destroyView).toHaveBeenCalledOnce();
    expect(destroyView).toHaveBeenCalledWith(tab);
    expect(tab.view).toBeNull();
    expect(tab.shell).toMatchObject({
      discarded: true,
      error: 'Page renderer exited: crashed',
    });
    expect(emitTabs).toHaveBeenCalledWith('chat-1');
  });

  it('uses the authenticated replacement path for accepted password-save prompts', async () => {
    const pending = {
      tabId: 'tab-1',
      conversationId: 'chat-1',
      origin: 'https://example.com',
      username: 'alice',
      password: 'replacement-secret',
      scopeKey: 'global',
      timer: setTimeout(() => undefined, 60_000),
    };
    const upsertWithAuthentication = vi.fn(async () => undefined);
    const withScopeActivity = vi.fn(async (_scopeKey: string, operation: () => Promise<unknown>) => operation());
    const emit = vi.fn();
    const manager = managerWithoutConstructor({
      assertScopeAvailable: vi.fn(),
      emit,
      pendingCredentials: new Map([['credential-1', pending]]),
      tabs: new Map([
        ['tab-1', { generation: 4, scopeKey: 'global', shell: { id: 'tab-1', conversationId: 'chat-1' } }],
      ]),
      vaultForScope: vi.fn(() => ({ upsertWithAuthentication })),
      withScopeActivity,
    });

    await manager.respondCredentialPrompt('credential-1', true);

    expect(withScopeActivity).toHaveBeenCalledWith('global', expect.any(Function));
    expect(upsertWithAuthentication).toHaveBeenCalledWith(
      'https://example.com',
      'alice',
      'replacement-secret',
      expect.any(Function),
    );
    expect(pending.password).toBe('');
    expect(Reflect.get(manager, 'pendingCredentials')).toHaveLength(0);
    expect(emit).toHaveBeenCalledWith({
      type: 'prompt-dismissed',
      conversationId: 'chat-1',
      promptId: 'credential-1',
      promptKind: 'credential',
    });
  });

  it('keeps a password-save prompt retryable when native authentication is cancelled', async () => {
    const pending = {
      tabId: 'tab-1',
      conversationId: 'chat-1',
      origin: 'https://example.com',
      username: 'alice',
      password: 'replacement-secret',
      scopeKey: 'global',
      timer: setTimeout(() => undefined, 60_000),
    };
    const upsertWithAuthentication = vi.fn(async () => {
      throw new Error('Touch ID cancelled');
    });
    const emit = vi.fn();
    const manager = managerWithoutConstructor({
      assertScopeAvailable: vi.fn(),
      emit,
      pendingCredentials: new Map([['credential-1', pending]]),
      tabs: new Map([
        ['tab-1', { generation: 4, scopeKey: 'global', shell: { id: 'tab-1', conversationId: 'chat-1' } }],
      ]),
      vaultForScope: vi.fn(() => ({ upsertWithAuthentication })),
      withScopeActivity: (_scopeKey: string, operation: () => Promise<unknown>) => operation(),
    });

    await expect(manager.respondCredentialPrompt('credential-1', true)).rejects.toThrow(/Touch ID cancelled/);

    expect(Reflect.get(manager, 'pendingCredentials').get('credential-1')).toBe(pending);
    expect(pending).toMatchObject({
      password: 'replacement-secret',
      responding: false,
    });
    expect(emit).not.toHaveBeenCalled();
    clearTimeout(pending.timer);
  });

  it('does not persist a captured password when its page changes during native authentication', async () => {
    const authentication = deferred<void>();
    const pending = {
      tabId: 'tab-1',
      conversationId: 'chat-1',
      origin: 'https://example.com',
      username: 'alice',
      password: 'replacement-secret',
      scopeKey: 'global',
      timer: setTimeout(() => undefined, 60_000),
    };
    const tab = {
      generation: 7,
      scopeKey: 'global',
      shell: { id: 'tab-1', conversationId: 'chat-1' },
    };
    const authenticatedWrite = vi.fn(
      async (_origin: string, _username: string, _password: string, checkpoint: () => void) => {
        checkpoint();
        await authentication.promise;
        checkpoint();
      },
    );
    const manager = managerWithoutConstructor({
      assertScopeAvailable: vi.fn(),
      pendingCredentials: new Map([['credential-1', pending]]),
      tabs: new Map([['tab-1', tab]]),
      vaultForScope: vi.fn(() => ({ upsertWithAuthentication: authenticatedWrite })),
      withScopeActivity: (_scopeKey: string, operation: () => Promise<unknown>) => operation(),
    });

    const response = manager.respondCredentialPrompt('credential-1', true);
    await vi.waitFor(() => expect(authenticatedWrite).toHaveBeenCalledOnce());
    tab.generation += 1;
    authentication.resolve();

    await expect(response).rejects.toThrow(/page changed/i);
    expect(Reflect.get(manager, 'pendingCredentials')).toHaveLength(0);
    expect(pending.password).toBe('');
  });

  it('keys HTTP-auth prompts by the complete protection space and exposes the endpoint', () => {
    const manager = new BrowserManager(
      '/tmp/kai-browser-http-auth-test',
      () => ({ browser: { dataScope: 'global', idleDiscardMinutes: 10 } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    try {
      const listener = electronMocks.appOn.mock.calls.find(([event]) => event === 'login')?.[1] as
        | ((
            event: { preventDefault: () => void },
            contents: { id: number },
            details: { url: string; pid: number },
            authInfo: {
              isProxy: boolean;
              scheme: string;
              host: string;
              port: number;
              realm: string;
            },
            callback: (username?: string, password?: string) => void,
          ) => void)
        | undefined;
      expect(listener).toBeTypeOf('function');
      Reflect.get(manager, 'tabs').set('tab-1', {
        shell: { id: 'tab-1', conversationId: 'chat-1' },
        scopeKey: 'global',
        generation: 1,
        aiNetworkRestricted: false,
      });
      Reflect.get(manager, 'webContentsToTab').set(42, 'tab-1');
      const event = { preventDefault: vi.fn() };
      const contents = { id: 42 };
      const firstCallback = vi.fn();
      const secondCallback = vi.fn();
      const thirdCallback = vi.fn();
      const duplicateCallback = vi.fn();
      const baseAuth = {
        isProxy: false,
        scheme: 'basic',
        host: 'accounts.example',
        port: 443,
        realm: 'Members',
      };

      listener?.(event, contents, { url: 'https://accounts.example/login', pid: 1 }, baseAuth, firstCallback);
      listener?.(
        event,
        contents,
        { url: 'http://accounts.example/login', pid: 1 },
        { ...baseAuth, port: 80 },
        secondCallback,
      );
      listener?.(
        event,
        contents,
        { url: 'https://accounts.example/login', pid: 1 },
        { ...baseAuth, scheme: 'digest' },
        thirdCallback,
      );
      listener?.(event, contents, { url: 'https://accounts.example/again', pid: 1 }, baseAuth, duplicateCallback);

      const prompts = [...Reflect.get(manager, 'pendingAuth').values()].map(
        (pending) => (pending as { prompt: { endpoint: string; authScheme: string } }).prompt,
      );
      expect(prompts).toMatchObject([
        { endpoint: 'https://accounts.example:443', authScheme: 'basic', assistantTriggered: false },
        { endpoint: 'http://accounts.example:80', authScheme: 'basic', assistantTriggered: false },
        { endpoint: 'https://accounts.example:443', authScheme: 'digest', assistantTriggered: false },
      ]);
      expect(duplicateCallback).toHaveBeenCalledOnce();
      expect(duplicateCallback).toHaveBeenCalledWith();
      expect(firstCallback).not.toHaveBeenCalled();
      expect(secondCallback).not.toHaveBeenCalled();
      expect(thirdCallback).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it('marks HTTP-auth prompts opened by an assistant-controlled document', () => {
    const manager = new BrowserManager(
      '/tmp/kai-browser-ai-http-auth-test',
      () => ({ browser: { dataScope: 'global', idleDiscardMinutes: 10 } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    try {
      const listener = electronMocks.appOn.mock.calls.find(([event]) => event === 'login')?.[1] as
        | ((
            event: { preventDefault: () => void },
            contents: { id: number },
            details: { url: string; pid: number },
            authInfo: { isProxy: boolean; scheme: string; host: string; port: number; realm: string },
            callback: (username?: string, password?: string) => void,
          ) => void)
        | undefined;
      Reflect.get(manager, 'tabs').set('tab-1', {
        shell: { id: 'tab-1', conversationId: 'chat-1' },
        scopeKey: 'global',
        generation: 5,
        aiNetworkRestricted: true,
      });
      Reflect.get(manager, 'webContentsToTab').set(42, 'tab-1');
      const callback = vi.fn();

      listener?.(
        { preventDefault: vi.fn() },
        { id: 42 },
        { url: 'https://accounts.example/login', pid: 1 },
        {
          isProxy: false,
          scheme: 'basic',
          host: 'accounts.example',
          port: 443,
          realm: 'Members',
        },
        callback,
      );

      expect(manager.getState('chat-1').authPrompts).toEqual([
        expect.objectContaining({
          endpoint: 'https://accounts.example:443',
          assistantTriggered: true,
        }),
      ]);
      expect(callback).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it('requires a refreshed warning when AI control begins after an HTTP-auth prompt opens', () => {
    const callback = vi.fn();
    const emit = vi.fn();
    const timer = setTimeout(() => undefined, 60_000);
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      scopeKey: 'global',
      generation: 3,
      aiNetworkRestricted: true,
    };
    const prompt = {
      id: 'auth-1',
      tabId: 'tab-1',
      host: 'accounts.example',
      endpoint: 'https://accounts.example:443',
      authScheme: 'basic',
      isProxy: false,
      assistantTriggered: false,
    };
    const pending = {
      tabId: 'tab-1',
      conversationId: 'chat-1',
      scopeKey: 'global',
      tabGeneration: 3,
      prompt,
      callback,
      timer,
    };
    const manager = managerWithoutConstructor({
      emit,
      pendingAuth: new Map([['auth-1', pending]]),
      tabs: new Map([['tab-1', tab]]),
    });

    expect(() => manager.respondAuthPrompt('auth-1', 'alice', 'secret')).toThrow(/updated warning/);
    expect(callback).not.toHaveBeenCalled();
    expect(Reflect.get(manager, 'pendingAuth').get('auth-1')).toBe(pending);
    expect(pending.prompt.assistantTriggered).toBe(true);
    expect(emit).toHaveBeenCalledWith({
      type: 'auth-prompt',
      conversationId: 'chat-1',
      prompt: expect.objectContaining({ id: 'auth-1', assistantTriggered: true }),
    });

    manager.respondAuthPrompt('auth-1', 'alice', 'secret');
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith('alice', 'secret');
  });

  it('rejects HTTP-auth responses after either document navigation or profile replacement', () => {
    for (const [id, tab] of [
      ['navigated', { shell: { id: 'tab-1', conversationId: 'chat-1' }, scopeKey: 'global', generation: 2 }],
      [
        'rescope',
        {
          shell: { id: 'tab-1', conversationId: 'chat-1' },
          scopeKey: 'conversation-deadbeefdeadbeefdeadbeef',
          generation: 1,
        },
      ],
    ] as const) {
      const callback = vi.fn();
      const timer = setTimeout(() => undefined, 60_000);
      const manager = managerWithoutConstructor({
        pendingAuth: new Map([
          [
            id,
            {
              tabId: 'tab-1',
              conversationId: 'chat-1',
              scopeKey: 'global',
              tabGeneration: 1,
              prompt: {
                id,
                tabId: 'tab-1',
                host: 'accounts.example',
                endpoint: 'https://accounts.example:443',
                authScheme: 'basic',
                isProxy: false,
                assistantTriggered: false,
              },
              callback,
              timer,
            },
          ],
        ]),
        tabs: new Map([['tab-1', tab]]),
      });

      expect(() => manager.respondAuthPrompt(id, 'alice', 'secret')).toThrow(/expired after the page navigated/);
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(undefined, undefined);
      expect(Reflect.get(manager, 'pendingAuth').has(id)).toBe(false);
    }
  });

  it('denies client-certificate disclosure for Browser tabs and background session traffic', async () => {
    const manager = new BrowserManager(
      '/tmp/kai-browser-client-certificate-test',
      () => ({ browser: { dataScope: 'global', idleDiscardMinutes: 10 } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    try {
      const listener = electronMocks.appOn.mock.calls.find(([event]) => event === 'select-client-certificate')?.[1] as
        | ((
            event: { preventDefault: () => void },
            contents: { id: number; session?: object },
            url: string,
            certificates: unknown[],
            callback: (certificate?: unknown) => void,
          ) => void)
        | undefined;
      expect(listener).toBeTypeOf('function');
      Reflect.get(manager, 'webContentsToTab').set(42, 'tab-1');
      const managedEvent = { preventDefault: vi.fn() };
      const managedCallback = vi.fn();

      listener?.(
        managedEvent,
        { id: 42 },
        'https://certificate.example',
        [{ subjectName: 'Private identity' }],
        managedCallback,
      );

      expect(managedEvent.preventDefault).toHaveBeenCalledOnce();
      expect(managedCallback).toHaveBeenCalledOnce();
      expect(managedCallback).toHaveBeenCalledWith();

      const browserSession = {};
      Reflect.get(manager, 'wiredSessions').add(browserSession);
      const backgroundEvent = { preventDefault: vi.fn() };
      const backgroundCallback = vi.fn();
      listener?.(
        backgroundEvent,
        { id: 43, session: browserSession },
        'https://worker.example',
        [{ subjectName: 'Private identity' }],
        backgroundCallback,
      );
      expect(backgroundEvent.preventDefault).toHaveBeenCalledOnce();
      expect(backgroundCallback).toHaveBeenCalledWith();

      const unrelatedEvent = { preventDefault: vi.fn() };
      const unrelatedCallback = vi.fn();
      listener?.(unrelatedEvent, { id: 99, session: {} }, 'https://plugin.example', [], unrelatedCallback);
      expect(unrelatedEvent.preventDefault).not.toHaveBeenCalled();
      expect(unrelatedCallback).not.toHaveBeenCalled();
    } finally {
      await manager.shutdown();
    }
    expect(electronMocks.appOff).toHaveBeenCalledWith('select-client-certificate', expect.any(Function));
  });

  it("blocks remote pages from changing Kai's host-window bounds", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const contents = {
      id: 42,
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      setWindowOpenHandler: vi.fn(),
    };
    const manager = managerWithoutConstructor({});
    const tab = { shell: { id: 'tab-1', conversationId: 'chat-1' }, view: { webContents: contents } };

    invokePrivate(manager, 'wireWebContents', tab, contents);
    const event = { preventDefault: vi.fn() };
    listeners.get('content-bounds-updated')?.(event, {
      x: 0,
      y: 0,
      width: 10_000,
      height: 10_000,
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('ignores callbacks from WebContents that no longer owns the tab', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    let popupHandler: ((details: Record<string, unknown>) => { action: string }) | undefined;
    const contents = {
      id: 42,
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      setWindowOpenHandler: vi.fn((handler: typeof popupHandler) => {
        popupHandler = handler;
      }),
    };
    const replacementContents = { ...contents, id: 43 };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        title: 'Replacement',
        loading: false,
      },
      view: { webContents: contents },
    };
    const emit = vi.fn();
    const createPopupTab = vi.fn();
    const buildContextMenu = vi.fn();
    const handlePendingSyntheticInput = vi.fn();
    const handlePageShortcut = vi.fn();
    const manager = managerWithoutConstructor({
      activeFindRequests: new Map([['tab-1', { requestId: 7, electronRequestId: 42 }]]),
      emit,
      createPopupTab,
      buildContextMenu,
      handlePendingSyntheticInput,
      handlePageShortcut,
    });

    invokePrivate(manager, 'wireWebContents', tab, contents);
    tab.view = { webContents: replacementContents };

    listeners.get('did-start-loading')?.();
    listeners.get('page-title-updated')?.({}, 'Stale title');
    listeners.get('found-in-page')?.({}, { requestId: 42 });
    listeners.get('context-menu')?.({}, {});
    const inputEvent = { preventDefault: vi.fn() };
    listeners.get('before-input-event')?.(inputEvent, { type: 'keyDown' });
    const navigationEvent = { preventDefault: vi.fn() };
    listeners.get('will-navigate')?.(navigationEvent, 'file:///stale');
    const popup = popupHandler?.({
      url: 'https://stale.example',
      disposition: 'new-window',
      referrer: { url: 'https://stale.example' },
    });

    expect(tab.shell).toMatchObject({ title: 'Replacement', loading: false });
    expect(emit).not.toHaveBeenCalled();
    expect(createPopupTab).not.toHaveBeenCalled();
    expect(buildContextMenu).not.toHaveBeenCalled();
    expect(handlePendingSyntheticInput).not.toHaveBeenCalled();
    expect(handlePageShortcut).not.toHaveBeenCalled();
    expect(inputEvent.preventDefault).toHaveBeenCalledOnce();
    expect(navigationEvent.preventDefault).toHaveBeenCalledOnce();
    expect(popup).toEqual({ action: 'deny' });
  });

  it('emits find counts only for the latest Electron request and preserves the renderer request id', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const contents = {
      id: 42,
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      setWindowOpenHandler: vi.fn(),
    };
    const emit = vi.fn();
    const manager = managerWithoutConstructor({
      activeFindRequests: new Map([['tab-1', { requestId: 7, electronRequestId: 42 }]]),
      emit,
    });
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      view: { webContents: contents },
    };

    invokePrivate(manager, 'wireWebContents', tab, contents);
    listeners.get('found-in-page')?.(
      {},
      {
        requestId: 41,
        activeMatchOrdinal: 9,
        matches: 9,
        finalUpdate: true,
      },
    );
    expect(emit).not.toHaveBeenCalled();

    listeners.get('found-in-page')?.(
      {},
      {
        requestId: 42,
        activeMatchOrdinal: 1,
        matches: 3,
        finalUpdate: true,
      },
    );
    expect(emit).toHaveBeenCalledWith({
      type: 'find-result',
      conversationId: 'chat-1',
      tabId: 'tab-1',
      result: {
        requestId: 7,
        activeMatchOrdinal: 1,
        matches: 3,
        finalUpdate: true,
      },
    });
  });

  it('persists combined permission decisions in one profile transaction', () => {
    const callback = vi.fn();
    const setPermissions = vi.fn();
    const timer = setTimeout(() => undefined, 60_000);
    const manager = managerWithoutConstructor({
      getWindow: () => null,
      oneTimePermissions: new Set(),
      pendingPermissions: new Map([
        [
          'permission-1',
          {
            tabId: 'tab-1',
            conversationId: 'chat-1',
            scopeKey: 'global',
            tabGeneration: 1,
            origin: 'https://example.com',
            permission: 'media',
            canPersist: true,
            assistantTriggered: false,
            storageKeys: ['media:audio', 'media:video'],
            callback,
            timer,
          },
        ],
      ]),
      storeForScope: () => ({ setPermissions }),
      tabs: new Map([
        [
          'tab-1',
          {
            shell: { id: 'tab-1', conversationId: 'chat-1' },
            scopeKey: 'global',
            generation: 1,
          },
        ],
      ]),
    });

    expect(() => manager.respondPermissionPrompt('permission-1', 'allow-forever')).toThrow(/permission decision/i);
    expect(setPermissions).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(Reflect.get(manager, 'pendingPermissions')).toHaveLength(1);

    manager.respondPermissionPrompt('permission-1', 'allow');

    expect(setPermissions).toHaveBeenCalledOnce();
    expect(setPermissions).toHaveBeenCalledWith('https://example.com', ['media:audio', 'media:video'], 'allow');
    expect(callback).toHaveBeenCalledWith(true);
    expect(Reflect.get(manager, 'pendingPermissions')).toHaveLength(0);
  });

  it('requires an updated warning when assistant control begins while a user permission prompt is open', () => {
    const callback = vi.fn();
    const setPermissions = vi.fn();
    const emit = vi.fn();
    const pending = {
      tabId: 'tab-1',
      conversationId: 'chat-1',
      scopeKey: 'global',
      tabGeneration: 1,
      origin: 'https://example.com',
      permission: 'camera',
      canPersist: true,
      assistantTriggered: false,
      storageKeys: ['camera'],
      callback,
      timer: setTimeout(() => undefined, 60_000),
    };
    const manager = managerWithoutConstructor({
      emit,
      getWindow: () => null,
      oneTimePermissions: new Set(),
      pendingPermissions: new Map([['permission-1', pending]]),
      storeForScope: () => ({ setPermissions }),
      tabs: new Map([
        [
          'tab-1',
          {
            aiNetworkRestricted: true,
            shell: { id: 'tab-1', conversationId: 'chat-1' },
            scopeKey: 'global',
            generation: 1,
          },
        ],
      ]),
    });

    expect(() => manager.respondPermissionPrompt('permission-1', 'allow')).toThrow(/AI control began/i);
    expect(pending.assistantTriggered).toBe(true);
    expect(setPermissions).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({
      type: 'permission-prompt',
      conversationId: 'chat-1',
      prompt: {
        id: 'permission-1',
        tabId: 'tab-1',
        origin: 'https://example.com',
        permission: 'camera',
        canPersist: false,
        assistantTriggered: true,
      },
    });

    expect(() => manager.respondPermissionPrompt('permission-1', 'allow')).toThrow(/current request only/i);
    manager.respondPermissionPrompt('permission-1', 'allow-once');
    expect(setPermissions).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(true);
  });

  it('rejects a permission decision after its document generation changes', () => {
    const callback = vi.fn();
    const setPermissions = vi.fn();
    const manager = managerWithoutConstructor({
      getWindow: () => null,
      oneTimePermissions: new Set(),
      pendingPermissions: new Map([
        [
          'permission-1',
          {
            tabId: 'tab-1',
            conversationId: 'chat-1',
            scopeKey: 'global',
            tabGeneration: 1,
            origin: 'https://departed.example',
            storageKeys: ['notifications'],
            callback,
            timer: setTimeout(() => undefined, 60_000),
          },
        ],
      ]),
      storeForScope: () => ({ setPermissions }),
      tabs: new Map([
        [
          'tab-1',
          {
            shell: { id: 'tab-1', conversationId: 'chat-1' },
            scopeKey: 'global',
            generation: 2,
          },
        ],
      ]),
    });

    expect(() => manager.respondPermissionPrompt('permission-1', 'allow')).toThrow(/expired after the page navigated/i);
    expect(setPermissions).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(false);
    expect(Reflect.get(manager, 'pendingPermissions')).toHaveLength(0);
  });

  it('preserves document grants for same-document navigation and dismisses them for a replacement', () => {
    const callback = vi.fn();
    const authCallback = vi.fn();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://departed.example',
        title: 'Departed',
        favicon: 'data:image/png;base64,icon',
      },
      scopeKey: 'global',
      generation: 1,
    };
    const manager = managerWithoutConstructor({
      cancelFaviconFetch: vi.fn(),
      getWindow: () => null,
      oneTimePermissions: new Set(['tab-1\u0000https://departed.example\u0000notifications']),
      pendingPermissions: new Map([
        [
          'permission-1',
          {
            tabId: 'tab-1',
            conversationId: 'chat-1',
            scopeKey: 'global',
            tabGeneration: 1,
            origin: 'https://departed.example',
            storageKeys: ['notifications'],
            callback,
            timer: setTimeout(() => undefined, 60_000),
          },
        ],
      ]),
      pendingAuth: new Map([
        [
          'auth-1',
          {
            tabId: 'tab-1',
            conversationId: 'chat-1',
            callback: authCallback,
            timer: setTimeout(() => undefined, 60_000),
          },
        ],
      ]),
    });
    const contents = {
      getTitle: () => 'Departed',
      getURL: () => tab.shell.url,
      isCurrentlyAudible: () => false,
      isDestroyed: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      setWindowOpenHandler: vi.fn(),
    };
    Object.assign(tab, { view: { webContents: contents } });

    invokePrivate(manager, 'wireWebContents', tab, contents);
    listeners.get('did-start-navigation')?.({}, 'https://departed.example#next', true, true);

    expect(tab.generation).toBe(1);
    expect(tab.shell.favicon).toBe('data:image/png;base64,icon');
    expect(callback).not.toHaveBeenCalled();
    expect(authCallback).not.toHaveBeenCalled();
    expect(Reflect.get(manager, 'pendingPermissions')).toHaveLength(1);
    expect(Reflect.get(manager, 'pendingAuth')).toHaveLength(1);
    expect(Reflect.get(manager, 'oneTimePermissions')).toHaveLength(1);
    expect(Reflect.get(manager, 'cancelFaviconFetch')).not.toHaveBeenCalled();

    listeners.get('did-start-navigation')?.({}, 'about:blank', false, true);

    expect(tab.generation).toBe(2);
    expect(tab.shell.favicon).toBeUndefined();
    expect(callback).toHaveBeenCalledWith(false);
    expect(authCallback).toHaveBeenCalledWith(undefined, undefined);
    expect(Reflect.get(manager, 'pendingPermissions')).toHaveLength(0);
    expect(Reflect.get(manager, 'pendingAuth')).toHaveLength(0);
    expect(Reflect.get(manager, 'oneTimePermissions')).toHaveLength(0);
    expect(Reflect.get(manager, 'cancelFaviconFetch')).toHaveBeenCalledWith('tab-1');
  });

  it('contains profile-marker filesystem failures inside Electron navigation callbacks', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const cancelFaviconFetch = vi.fn();
    const oneTimePermissions = new Set(['tab-marker-error\u0000https://example.com\u0000camera']);
    const tab = {
      shell: {
        id: 'tab-marker-error',
        conversationId: 'chat-1',
        url: 'https://example.com',
        title: 'Example',
      },
      scopeKey: 'global',
      generation: 1,
    };
    let generationWhenReported = 0;
    let grantsWhenReported = -1;
    const emitProfileErrorForScope = vi.fn(() => {
      generationWhenReported = tab.generation;
      grantsWhenReported = oneTimePermissions.size;
    });
    const manager = managerWithoutConstructor({
      // Joining below /dev/null makes rmSync fail with ENOTDIR on both macOS
      // and Linux without mutating a real browser profile.
      appHome: '/dev/null',
      cancelFaviconFetch,
      emitProfileErrorForScope,
      oneTimePermissions,
      pendingPermissions: new Map(),
      pendingAuth: new Map(),
    });
    const contents = {
      getTitle: () => 'Example',
      getURL: () => tab.shell.url,
      isCurrentlyAudible: () => false,
      isDestroyed: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      setWindowOpenHandler: vi.fn(),
    };
    Object.assign(tab, { view: { webContents: contents } });

    invokePrivate(manager, 'wireWebContents', tab, contents);
    expect(() => listeners.get('did-start-navigation')?.({}, 'https://example.com/next', false, true)).not.toThrow();

    expect(emitProfileErrorForScope).toHaveBeenCalledWith('global', 'profile', expect.any(Error));
    expect(generationWhenReported).toBe(2);
    expect(grantsWhenReported).toBe(0);
    expect(tab.generation).toBe(2);
    expect(cancelFaviconFetch).toHaveBeenCalledWith(tab.shell.id);
  });

  it('retains the AI network policy across ordinary page gestures', () => {
    const manager = new BrowserManager(
      '/tmp/kai-browser-gesture-test',
      () => ({ browser: { dataScope: 'global' } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      view: null,
      overlayTimer: null,
      overlayGeneration: 0,
      aiActionDepth: 0,
      aiActionUntil: 0,
      trustedGestureGeneration: 0,
      assistantScriptDepth: 0,
      popupGesture: null as null | {
        source: 'assistant' | 'user';
        assistantOwnerId: string | null;
      },
      scriptTainted: false,
      aiNetworkRestricted: true,
      aiControlOwnerId: 'run-1' as string | null,
      aiControlGeneration: 1 as number | null,
    };
    const tabs = Reflect.get(manager, 'tabs') as Map<string, typeof tab>;
    const webContentsToTab = Reflect.get(manager, 'webContentsToTab') as Map<number, string>;
    const tokens = Reflect.get(manager, 'automationGestureTokens') as Map<
      string,
      { tabId: string; assistantOwnerId: string; expiresAt: number; inputData?: string }
    >;
    tabs.set('tab-1', tab);
    webContentsToTab.set(42, 'tab-1');
    tokens.set('automation-token', {
      tabId: 'tab-1',
      assistantOwnerId: 'run-1',
      expiresAt: Date.now() + 1_000,
    });
    const gestureHandler = electronMocks.ipcOn.mock.calls.find(
      ([channel]) => channel === 'browser-page:gesture',
    )?.[1] as (
      event: { sender: { id: number }; returnValue?: unknown },
      payload?: { token?: string; kind?: string; data?: string },
    ) => void;

    const assistantEvent = {
      sender: { id: 42 },
      returnValue: undefined as unknown,
    };
    gestureHandler(assistantEvent, { token: 'automation-token' });
    expect(tab.popupGesture).toMatchObject({
      source: 'assistant',
      assistantOwnerId: 'run-1',
    });
    expect(assistantEvent.returnValue).toBe(true);
    expect(tab.trustedGestureGeneration).toBe(0);

    tokens.set('typing-token', {
      tabId: 'tab-1',
      assistantOwnerId: 'run-1',
      expiresAt: Date.now() + 1_000,
      inputData: 'assistant secret',
    });
    const mismatchedTypingEvent = { sender: { id: 42 }, returnValue: undefined as unknown };
    gestureHandler(mismatchedTypingEvent, {
      token: 'typing-token',
      kind: 'input',
      data: 'concurrent user text',
    });
    expect(mismatchedTypingEvent.returnValue).toBe(false);
    expect(tokens.has('typing-token')).toBe(true);

    const matchedTypingEvent = { sender: { id: 42 }, returnValue: undefined as unknown };
    gestureHandler(matchedTypingEvent, {
      token: 'typing-token',
      kind: 'input',
      data: 'assistant secret',
    });
    expect(matchedTypingEvent.returnValue).toBe(true);
    expect(tokens.has('typing-token')).toBe(false);

    // A genuine pointer/key gesture without an exact automation token remains
    // user-owned even when it races an active AI operation.
    tab.aiActionDepth = 1;
    const concurrentUserEvent = {
      sender: { id: 42 },
      senderFrame: { frameTreeNodeId: 7 },
      returnValue: undefined as unknown,
    };
    gestureHandler(concurrentUserEvent, { kind: 'pointerdown' });
    expect(tab.popupGesture).toMatchObject({
      source: 'user',
      assistantOwnerId: null,
      frameTreeNodeId: 7,
    });
    expect(tab.aiNetworkRestricted).toBe(true);
    expect(tab.aiControlOwnerId).toBe('run-1');
    expect(concurrentUserEvent.returnValue).toBe(true);
    expect(tab.trustedGestureGeneration).toBe(1);

    tab.aiActionDepth = 0;
    tab.aiActionUntil = 0;
    const userEvent = { sender: { id: 42 }, returnValue: undefined as unknown };
    gestureHandler(userEvent, {});
    expect(tab.popupGesture).toMatchObject({
      source: 'user',
      assistantOwnerId: null,
    });
    expect(tab.aiNetworkRestricted).toBe(true);
    expect(tab.aiControlOwnerId).toBe('run-1');
    expect(userEvent.returnValue).toBe(true);
    expect(tab.trustedGestureGeneration).toBe(2);

    manager.dispose();
  });

  it('accepts password-save prompts only from the activated frame and its actual origin', () => {
    const manager = new BrowserManager(
      '/tmp/kai-browser-login-prompt-test',
      () =>
        ({
          browser: {
            dataScope: 'global',
            enabled: true,
            offerToSavePasswords: true,
            idleDiscardMinutes: 10,
          },
        }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    try {
      const listener = electronMocks.ipcOn.mock.calls.find(
        ([channel]) => channel === 'browser-page:login-submitted',
      )?.[1] as ((event: Record<string, unknown>, payload: Record<string, unknown>) => void) | undefined;
      expect(listener).toBeTypeOf('function');
      const tab = {
        shell: { id: 'tab-1', conversationId: 'chat-1' },
        scopeKey: 'global',
        popupGesture: null as null | {
          source: 'user';
          assistantOwnerId: null;
          expiresAt: number;
          frameTreeNodeId: number;
          kind: 'pointerdown';
        },
      };
      Reflect.get(manager, 'tabs').set('tab-1', tab);
      Reflect.get(manager, 'webContentsToTab').set(42, 'tab-1');
      Reflect.get(manager, 'vaults').set('global', {
        dispose: vi.fn(),
        has: vi.fn(() => false),
      });
      const frame = {
        detached: false,
        frameTreeNodeId: 7,
        isDestroyed: () => false,
        origin: 'https://accounts.example',
      };
      const event = { sender: { id: 42 }, senderFrame: frame };
      const payload = {
        origin: frame.origin,
        username: 'alice',
        password: 'secret',
      };

      listener?.(event, payload);
      expect(Reflect.get(manager, 'pendingCredentials')).toHaveLength(0);

      tab.popupGesture = {
        source: 'user',
        assistantOwnerId: null,
        expiresAt: Date.now() + 5_000,
        frameTreeNodeId: 1,
        kind: 'pointerdown',
      };
      listener?.(event, payload);
      expect(Reflect.get(manager, 'pendingCredentials')).toHaveLength(0);

      tab.popupGesture.frameTreeNodeId = frame.frameTreeNodeId;
      listener?.(event, { ...payload, origin: 'https://spoofed.example' });
      expect(Reflect.get(manager, 'pendingCredentials')).toHaveLength(0);

      listener?.(event, payload);
      const pendingIds = [...Reflect.get(manager, 'pendingCredentials').keys()];
      const firstPending = [...Reflect.get(manager, 'pendingCredentials').values()][0] as { password: string };
      expect(Reflect.get(manager, 'pendingCredentials')).toHaveLength(1);
      expect([...Reflect.get(manager, 'pendingCredentials').values()][0]).toMatchObject({
        origin: frame.origin,
        username: 'alice',
      });

      tab.popupGesture = {
        source: 'user',
        assistantOwnerId: null,
        expiresAt: Date.now() + 5_000,
        frameTreeNodeId: frame.frameTreeNodeId,
        kind: 'pointerdown',
      };
      listener?.(event, { ...payload, username: 'replacement' });
      const replacementIds = [...Reflect.get(manager, 'pendingCredentials').keys()];
      expect(replacementIds).toHaveLength(1);
      expect(replacementIds).not.toEqual(pendingIds);
      expect(firstPending.password).toBe('');
      expect([...Reflect.get(manager, 'pendingCredentials').values()][0]).toMatchObject({
        origin: frame.origin,
        username: 'replacement',
        password: 'secret',
      });
    } finally {
      manager.dispose();
    }
  });

  it('marks assistant popup provenance before dispatching synthetic page input', () => {
    const send = vi.fn();
    const tab = {
      shell: { id: 'tab-1' },
      aiControlOwnerId: 'run-1',
      popupGesture: {
        source: 'user',
        assistantOwnerId: null,
        expiresAt: Date.now() + 5_000,
        kind: 'pointerdown',
      },
      view: null,
    };
    const manager = managerWithoutConstructor({
      attachedView: null,
      automationGestureTokens: new Map(),
      getWindow: () => null,
    });
    const contents = {
      mainFrame: {
        framesInSubtree: [{ detached: false, isDestroyed: () => false, send }],
      },
    };

    invokePrivate(manager, 'armAutomationGesture', tab, contents, {
      kind: 'pointerdown',
      x: 4,
      y: 8,
    });

    expect(tab.popupGesture).toMatchObject({
      source: 'assistant',
      assistantOwnerId: 'run-1',
    });
    expect(send).toHaveBeenCalledWith(
      'browser-page:arm-automation-input',
      expect.objectContaining({
        kind: 'pointerdown',
        token: expect.any(String),
      }),
    );
  });

  it('rejects an approval after its tab document or origin changes', () => {
    const tab = {
      shell: { id: 'tab-1', url: 'https://example.com/account' },
      generation: 4,
    };
    const manager = managerWithoutConstructor({});
    const approval = {
      tabId: 'tab-1',
      tabGeneration: 3,
      origin: 'https://example.com',
      url: 'https://example.com/account',
    };

    expect(() => invokePrivate(manager, 'assertBrowserDocumentApproval', tab, approval)).toThrow(
      /page changed while approval was pending/i,
    );

    tab.generation = 3;
    tab.shell.url = 'https://example.com/other';
    expect(() => invokePrivate(manager, 'assertBrowserDocumentApproval', tab, approval)).toThrow(
      /page changed while approval was pending/i,
    );

    tab.shell.url = 'https://attacker.example/';
    expect(() => invokePrivate(manager, 'assertBrowserDocumentApproval', tab, approval)).toThrow(
      /page changed while approval was pending/i,
    );

    // A discarded tab restoration creates a new document even if it returns
    // to the same origin. The former internal-restore bypass must not make the
    // old approval valid for that replacement document.
    tab.generation = 4;
    tab.shell.url = 'https://example.com/restored';
    expect(() => invokePrivate(manager, 'assertBrowserDocumentApproval', tab, approval, true)).toThrow(
      /page changed while approval was pending/i,
    );
  });

  it('keeps long same-document URLs exact for approval identity while bounding renderer snapshots', () => {
    const sharedPrefix = `https://example.com/${'a'.repeat(MAX_BROWSER_URL_CHARS)}`;
    const firstUrl = `${sharedPrefix}?route=approved`;
    const secondUrl = `${sharedPrefix}?route=changed`;
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', url: firstUrl, active: true },
      generation: 7,
    };
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'tab-1']]),
      tabOrder: new Map([['chat-1', ['tab-1']]]),
      tabs: new Map([['tab-1', tab]]),
    });

    const approval = manager.captureDocumentApproval('chat-1', 'tab-1');
    expect(approval.url).toBe(firstUrl);
    expect(manager.getState('chat-1').tabs[0]?.url).toHaveLength(MAX_BROWSER_URL_CHARS);

    tab.shell.url = secondUrl;
    expect(() => invokePrivate(manager, 'assertBrowserDocumentApproval', tab, approval)).toThrow(
      /page changed while approval was pending/i,
    );
  });

  it('binds tab-list read approval to the exact active tab, order, shells, and documents', () => {
    const first = {
      shell: { id: 'tab-1', conversationId: 'chat-1', url: 'https://one.example/account' },
      generation: 3,
      trustedUserNavigationLease: 4,
    };
    const second = {
      shell: { id: 'tab-2', conversationId: 'chat-1', url: 'https://two.example/' },
      generation: 5,
      trustedUserNavigationLease: 6,
    };
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', first.shell.id]]),
      tabOrder: new Map([['chat-1', [first.shell.id, second.shell.id]]]),
      tabs: new Map([
        [first.shell.id, first],
        [second.shell.id, second],
      ]),
    });
    const approval = manager.captureTabsReadApproval('chat-1');

    expect(() => manager.assertTabsReadApproval('chat-1', approval)).not.toThrow();

    Reflect.get(manager, 'activeTabs').set('chat-1', second.shell.id);
    expect(() => manager.assertTabsReadApproval('chat-1', approval)).toThrow(/tab list changed while approval/i);
    Reflect.get(manager, 'activeTabs').set('chat-1', first.shell.id);

    second.shell.url = 'https://two.example/replaced';
    expect(() => manager.assertTabsReadApproval('chat-1', approval)).toThrow(/tab list changed while approval/i);
  });

  it('allows exactly one internal discarded-tab restoration under a bound approval', () => {
    const tab = {
      shell: {
        id: '00000000-0000-4000-8000-000000000001',
        conversationId: 'chat-1',
        url: 'https://example.com/account',
        discarded: true,
      },
      view: null,
      generation: 3,
      trustedUserNavigationLease: 5,
    };
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', tab.shell.id]]),
      tabOrder: new Map([['chat-1', [tab.shell.id]]]),
      tabs: new Map([[tab.shell.id, tab]]),
    });
    const approval = manager.captureDocumentApproval('chat-1', tab.shell.id);

    tab.generation++;
    tab.shell.discarded = false;
    tab.view = {} as never;
    expect(() => invokePrivate(manager, 'assertBrowserDocumentApproval', tab, approval)).not.toThrow();

    tab.generation++;
    expect(() => invokePrivate(manager, 'assertBrowserDocumentApproval', tab, approval)).toThrow(
      /page changed while approval was pending/i,
    );

    tab.generation = approval.tabGeneration + 1;
    tab.trustedUserNavigationLease++;
    expect(() => invokePrivate(manager, 'assertBrowserDocumentApproval', tab, approval)).toThrow(
      /page changed while approval was pending/i,
    );
  });

  it('rejects targets covered only by a pointer-events-none overlay', async () => {
    const sendCommand = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
      backendNodeId: params.ignorePointerEventsNone === true ? 22 : 11,
      frameId: 'frame-1',
    }));
    const contents = {
      debugger: {
        isAttached: () => true,
        sendCommand,
      },
      isDestroyed: () => false,
    };
    const manager = managerWithoutConstructor({});

    await expect(
      invokePrivate(manager, 'assertNoClickThroughOverlayAtPoints', contents, [{ x: 20, y: 30 }]) as Promise<void>,
    ).rejects.toThrow(/click-through overlay/i);
    expect(sendCommand).toHaveBeenCalledWith('DOM.getNodeForLocation', {
      x: 20,
      y: 30,
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: true,
    });
  });

  it('allows pointer-events-none descendants that belong to the target control', async () => {
    const sendCommand = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'DOM.getNodeForLocation') {
        return {
          backendNodeId: params.ignorePointerEventsNone === true ? 22 : 11,
          frameId: 'frame-1',
        };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
      if (method === 'DOM.resolveNode') return { object: { objectId: `node-${params.backendNodeId}` } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
      return {};
    });
    const contents = {
      debugger: { isAttached: () => true, sendCommand },
      isDestroyed: () => false,
    };
    const manager = managerWithoutConstructor({});

    await expect(
      invokePrivate(manager, 'assertNoClickThroughOverlayAtPoints', contents, [{ x: 20, y: 30 }]) as Promise<void>,
    ).resolves.toBeUndefined();
  });

  it('applies click-through-overlay validation to coordinate action targets', async () => {
    const assertNoClickThroughOverlayAtPoints = vi.fn(async () => {
      throw new Error('The browser target is covered by a visible click-through overlay.');
    });
    const manager = managerWithoutConstructor({
      assertNoClickThroughOverlayAtPoints,
      runRendererOperationWithDeadline: (
        _tab: unknown,
        _contents: unknown,
        _operation: string,
        _timeout: number,
        task: () => Promise<unknown>,
      ) => task(),
    });
    const contents = {};
    const target = { x: 25, y: 35, width: 1, height: 1 };

    await expect(
      invokePrivate(manager, 'validateLocatedTarget', {}, contents, target) as Promise<unknown>,
    ).rejects.toThrow(/click-through overlay/i);
    expect(assertNoClickThroughOverlayAtPoints).toHaveBeenCalledWith(contents, [target]);
  });

  it.each(['target lookup', 'focus', 'user refocus'] as const)(
    'does not type when target authority changes during %s',
    async (navigationStage) => {
      const insertedText = 'never-insert-this';
      const insertText = vi.fn(async () => undefined);
      const armAutomationGesture = vi.fn();
      const contents = {
        getZoomFactor: () => 1,
        insertText,
        isDestroyed: () => false,
      };
      const view = { webContents: contents };
      const tab = {
        shell: {
          id: '00000000-0000-4000-8000-000000000001',
          conversationId: 'chat-1',
          owner: 'user' as const,
          keepOpen: true,
          url: 'https://example.com/login',
          sensitive: false,
        },
        view,
        generation: 4,
        trustedUserNavigationLease: 0,
        trustedGestureGeneration: 0,
        lastUsedAt: 0,
      };
      const documentLease = {
        runId: 'run-1',
        runGeneration: 7,
        hostRendererAuthorityGeneration: 0,
        tabGeneration: tab.generation,
        userNavigationLease: tab.trustedUserNavigationLease,
        url: tab.shell.url,
      };
      const assertAssistantDocumentLease = vi.fn(() => {
        if (tab.generation !== documentLease.tabGeneration) {
          throw new Error('The page navigated while this assistant operation was waiting.');
        }
      });
      const locate = vi.fn(async () => {
        if (navigationStage === 'target lookup') tab.generation++;
        return { x: 20, y: 30, width: 100, height: 20 };
      });
      const evaluateWithDeadline = vi.fn(async () => {
        if (navigationStage === 'focus') tab.generation++;
        if (navigationStage === 'user refocus') tab.trustedGestureGeneration++;
        return true;
      });
      const manager = managerWithoutConstructor({
        armAutomationGesture,
        assertAssistantDocumentLease,
        attachActiveView: vi.fn(),
        emit: vi.fn(),
        emitTabs: vi.fn(),
        ensureAssistantView: vi.fn(async () => view),
        evaluateWithDeadline,
        locate,
        runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
        setAutomationOverlay: vi.fn(async () => undefined),
        tabs: new Map([[tab.shell.id, tab]]),
        validateLocatedTarget: vi.fn(async (_tab: unknown, _contents: unknown, target: unknown) => target),
        waitForPhysicalActionView: vi.fn(async () => undefined),
        withAssistantControl: (_tab: unknown, _run: unknown, task: (lease: typeof documentLease) => Promise<unknown>) =>
          task(documentLease),
        withAssistantScriptPopupAttribution: (_tab: unknown, task: () => Promise<unknown>) => task(),
      });

      const assertion = expect(
        manager.action(
          'chat-1',
          { tabId: tab.shell.id, kind: 'type', selector: '#password', value: insertedText },
          { id: 'run-1' },
        ),
      ).rejects.toThrow(
        navigationStage === 'user refocus'
          ? /user changed browser focus while assistant typing was waiting/i
          : /page navigated while this assistant operation was waiting/i,
      );
      await assertion;

      expect(insertText).not.toHaveBeenCalled();
      expect(armAutomationGesture).not.toHaveBeenCalled();
    },
  );

  it('does not dispatch semantic input after the page replaces or obscures the located target', async () => {
    const sendInputEvent = vi.fn();
    const contents = { getZoomFactor: () => 1, isDestroyed: () => false, sendInputEvent };
    const view = { webContents: contents };
    const tab = {
      shell: {
        id: '00000000-0000-4000-8000-000000000001',
        conversationId: 'chat-1',
        owner: 'user' as const,
        keepOpen: true,
        url: 'https://example.com/form',
        sensitive: false,
      },
      view,
      generation: 4,
      trustedUserNavigationLease: 0,
      trustedGestureGeneration: 0,
      lastUsedAt: 0,
    };
    const documentLease = {
      runId: 'run-1',
      runGeneration: 7,
      hostRendererAuthorityGeneration: 0,
      tabGeneration: tab.generation,
      userNavigationLease: tab.trustedUserNavigationLease,
      url: tab.shell.url,
    };
    const releaseLocatedTarget = vi.fn(async () => undefined);
    const manager = managerWithoutConstructor({
      assertAssistantDocumentLease: vi.fn(),
      attachActiveView: vi.fn(),
      emit: vi.fn(),
      emitTabs: vi.fn(),
      ensureAssistantView: vi.fn(async () => view),
      locate: vi.fn(async () => ({
        x: 20,
        y: 30,
        width: 100,
        height: 20,
        semanticLease: { contextId: 7, globalKey: '__target', detachDebugger: true },
      })),
      releaseLocatedTarget,
      runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
      setAutomationOverlay: vi.fn(async () => undefined),
      tabs: new Map([[tab.shell.id, tab]]),
      validateLocatedTarget: vi.fn(async () => {
        throw new Error('The requested browser target moved, was replaced, or became obscured before input.');
      }),
      waitForPhysicalActionView: vi.fn(async () => undefined),
      withAssistantControl: (_tab: unknown, _run: unknown, task: (lease: typeof documentLease) => Promise<unknown>) =>
        task(documentLease),
    });

    await expect(
      manager.action('chat-1', { tabId: tab.shell.id, kind: 'click', selector: '#submit' }, { id: 'run-1' }),
    ).rejects.toThrow(/moved, was replaced, or became obscured/i);
    expect(sendInputEvent).not.toHaveBeenCalled();
    expect(releaseLocatedTarget).toHaveBeenCalledOnce();
  });

  it.each([
    ['click', { kind: 'click', selector: '#target' }, 'target lookup'],
    ['double click', { kind: 'doubleClick', selector: '#target' }, 'overlay'],
    ['hover', { kind: 'hover', selector: '#target' }, 'target lookup'],
    ['focus', { kind: 'focus', selector: '#target' }, 'overlay'],
    ['press', { kind: 'press', keys: ['Enter'] as string[] }, 'assistant control'],
    ['scroll', { kind: 'scroll', deltaY: 100 }, 'view creation'],
    ['drag', { kind: 'drag', selector: '#target', endX: 80, endY: 90 }, 'overlay'],
  ] as const)(
    'does not dispatch a stale %s action after a trusted user gesture during %s',
    async (_label, request, interruptionStage) => {
      const sendInputEvent = vi.fn();
      const armAutomationGesture = vi.fn();
      const contents = {
        getZoomFactor: () => 1,
        isDestroyed: () => false,
        sendInputEvent,
      };
      const view = { webContents: contents };
      const tab = {
        shell: {
          id: '00000000-0000-4000-8000-000000000001',
          conversationId: 'chat-1',
          owner: 'user' as const,
          keepOpen: true,
          url: 'https://example.com/form',
          sensitive: false,
        },
        view,
        generation: 4,
        trustedUserNavigationLease: 0,
        trustedGestureGeneration: 0,
        lastUsedAt: 0,
      };
      const documentLease = {
        runId: 'run-1',
        runGeneration: 7,
        hostRendererAuthorityGeneration: 0,
        tabGeneration: tab.generation,
        userNavigationLease: tab.trustedUserNavigationLease,
        url: tab.shell.url,
      };
      const locate = vi.fn(async () => {
        if (interruptionStage === 'target lookup') tab.trustedGestureGeneration++;
        return { x: 20, y: 30, width: 100, height: 20 };
      });
      let overlayCalls = 0;
      const setAutomationOverlay = vi.fn(async () => {
        overlayCalls++;
        if (interruptionStage === 'overlay' && overlayCalls === 1) tab.trustedGestureGeneration++;
      });
      const manager = managerWithoutConstructor({
        armAutomationGesture,
        assertAssistantDocumentLease: vi.fn(),
        attachActiveView: vi.fn(),
        emit: vi.fn(),
        emitTabs: vi.fn(),
        ensureAssistantView: vi.fn(async () => {
          if (interruptionStage === 'view creation') tab.trustedGestureGeneration++;
          return view;
        }),
        evaluateWithDeadline: vi.fn(async () => true),
        locate,
        runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
        setAutomationOverlay,
        tabs: new Map([[tab.shell.id, tab]]),
        waitForPhysicalActionView: vi.fn(async () => undefined),
        withAssistantControl: (
          _tab: unknown,
          _run: unknown,
          task: (lease: typeof documentLease) => Promise<unknown>,
        ) => {
          if (interruptionStage === 'assistant control') tab.trustedGestureGeneration++;
          return task(documentLease);
        },
        withAssistantScriptPopupAttribution: (_tab: unknown, task: () => Promise<unknown>) => task(),
      });

      await expect(manager.action('chat-1', { tabId: tab.shell.id, ...request }, { id: 'run-1' })).rejects.toThrow(
        /user interacted with the browser while the assistant action was waiting/i,
      );

      expect(sendInputEvent).not.toHaveBeenCalled();
      expect(armAutomationGesture).not.toHaveBeenCalled();
    },
  );

  it('waits for the Browser panel to attach before dispatching physical input', async () => {
    const sendInputEvent = vi.fn();
    const contents = {
      getZoomFactor: () => 1,
      isDestroyed: () => false,
      sendInputEvent,
    };
    const view = { webContents: contents };
    const tab = {
      shell: {
        id: '00000000-0000-4000-8000-000000000001',
        conversationId: 'chat-1',
        owner: 'user' as const,
        keepOpen: true,
        url: 'https://example.com/form',
        sensitive: false,
      },
      view,
      generation: 4,
      trustedUserNavigationLease: 0,
      trustedGestureGeneration: 0,
      lastUsedAt: 0,
    };
    const documentLease = {
      runId: 'run-1',
      runGeneration: 7,
      hostRendererAuthorityGeneration: 0,
      tabGeneration: tab.generation,
      userNavigationLease: tab.trustedUserNavigationLease,
      url: tab.shell.url,
    };
    const emit = vi.fn();
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', tab.shell.id]]),
      armAutomationGesture: vi.fn(),
      assertAssistantDocumentLease: vi.fn(),
      attachActiveView: vi.fn(),
      attachedView: null,
      emit,
      emitTabs: vi.fn(),
      ensureAssistantView: vi.fn(async () => view),
      getWindow: () => visibleHostWindow(),
      locate: vi.fn(async () => ({ x: 20, y: 30, width: 100, height: 20 })),
      mountedBounds: null,
      mountedConversationId: null,
      runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
      sendAttributedInputEvent: (
        _tab: unknown,
        targetContents: { sendInputEvent: (event: unknown) => void },
        _arm: unknown,
        event: unknown,
      ) => targetContents.sendInputEvent(event),
      setAutomationOverlay: vi.fn(async () => undefined),
      tabs: new Map([[tab.shell.id, tab]]),
      validateLocatedTarget: vi.fn(async (_tab: unknown, _contents: unknown, target: unknown) => target),
      withAssistantControl: (_tab: unknown, _run: unknown, task: (lease: typeof documentLease) => Promise<unknown>) =>
        task(documentLease),
    });

    const action = manager.action(
      'chat-1',
      { tabId: tab.shell.id, kind: 'click', selector: '#submit' },
      { id: 'run-1' },
    );
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith({ type: 'open-panel', conversationId: 'chat-1', tabId: tab.shell.id }),
    );
    expect(sendInputEvent).not.toHaveBeenCalled();

    Reflect.set(manager, 'mountedConversationId', 'chat-1');
    Reflect.set(manager, 'mountedBounds', { x: 10, y: 20, width: 300, height: 200 });
    Reflect.set(manager, 'attachedView', view);
    invokePrivate(manager, 'notifyPanelStateChanged', 'chat-1');

    await expect(action).resolves.toMatchObject({ ok: true });
    expect(sendInputEvent).toHaveBeenCalled();
  });

  it('does not focus a physical action view until Kai is foregrounded and Browser chrome releases focus', async () => {
    let windowFocused = false;
    const hostFocus = vi.fn();
    const attachActiveView = vi.fn();
    const view = { webContents: { isDestroyed: () => false } };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      view,
      trustedGestureGeneration: 0,
    };
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', tab.shell.id]]),
      assertAssistantDocumentLease: vi.fn(),
      attachActiveView,
      attachedView: view,
      getWindow: () =>
        visibleHostWindow({
          isFocused: () => windowFocused,
          webContents: { focus: hostFocus, isDestroyed: () => false },
        }),
      mountedBounds: { x: 10, y: 20, width: 300, height: 200 },
      mountedConversationId: 'chat-1',
      tabs: new Map([[tab.shell.id, tab]]),
    });

    manager.setChromeFocus('chat-1', true);
    const gestureGeneration = tab.trustedGestureGeneration;
    const waiting = invokePrivate(manager, 'waitForPhysicalActionView', tab, view, undefined, {}, () => {
      if (tab.trustedGestureGeneration !== gestureGeneration) throw new Error('physical authority changed');
    }) as Promise<void>;
    await Promise.resolve();
    expect(attachActiveView).not.toHaveBeenCalled();

    windowFocused = true;
    manager.handleHostWindowVisibilityChanged();
    await Promise.resolve();
    expect(attachActiveView).not.toHaveBeenCalled();

    manager.setChromeFocus('chat-1', false);
    await expect(waiting).rejects.toThrow('physical authority changed');
    expect(attachActiveView).not.toHaveBeenCalled();

    await expect(
      invokePrivate(manager, 'waitForPhysicalActionView', tab, view, undefined, {}, vi.fn()) as Promise<void>,
    ).resolves.toBeUndefined();
    expect(attachActiveView).toHaveBeenCalledWith('chat-1', true);
    expect(hostFocus).toHaveBeenCalledOnce();
    expect(tab.trustedGestureGeneration).toBe(2);
  });

  it('keeps a guard-only structured-action page attached so automation remains visible', () => {
    const addChildView = vi.fn();
    const setBounds = vi.fn();
    const view = {
      setBounds,
      webContents: { focus: vi.fn(), isDestroyed: () => false },
    };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', reloadRequired: false },
      view,
      scriptTainted: false,
      privateNetworkNewDocumentGuard: { contentsId: 41, identifier: 'guard-1' },
    };
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', tab.shell.id]]),
      attachedView: null,
      getWindow: () =>
        visibleHostWindow({
          contentView: { addChildView, removeChildView: vi.fn() },
        }),
      mountedBounds: { x: 10, y: 20, width: 300, height: 200 },
      mountedConversationId: 'chat-1',
      tabs: new Map([[tab.shell.id, tab]]),
    });

    invokePrivate(manager, 'attachActiveView', 'chat-1');

    expect(addChildView).toHaveBeenCalledWith(view);
    expect(setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 300, height: 200 });
    expect(Reflect.get(manager, 'attachedView')).toBe(view);
  });

  it('revokes physical input on window blur and visible operations on minimize', () => {
    let focused = true;
    let minimized = false;
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', url: 'https://example.com' },
      aiControlOwnerId: 'run-1',
      aiControlGeneration: 7,
      generation: 4,
      trustedUserNavigationLease: 0,
      trustedGestureGeneration: 0,
      visibleAssistantGeneration: 0,
    };
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', tab.shell.id]]),
      getWindow: () =>
        visibleHostWindow({
          isFocused: () => focused,
          isMinimized: () => minimized,
        }),
      hostWindowInteractive: true,
      hostWindowShown: true,
      mountedConversationId: 'chat-1',
      tabs: new Map([[tab.shell.id, tab]]),
    });
    const documentLease = {
      runId: 'run-1',
      runGeneration: 7,
      hostRendererAuthorityGeneration: 0,
      tabGeneration: 4,
      userNavigationLease: 0,
      url: 'https://example.com',
      visibleAssistantGeneration: 0,
    };

    expect(() => invokePrivate(manager, 'assertAssistantDocumentLease', tab, documentLease)).not.toThrow();
    focused = false;
    manager.handleHostWindowVisibilityChanged();
    expect(tab.trustedGestureGeneration).toBe(1);
    expect(tab.visibleAssistantGeneration).toBe(0);

    minimized = true;
    manager.handleHostWindowVisibilityChanged();
    expect(tab.visibleAssistantGeneration).toBe(1);
    expect(() => invokePrivate(manager, 'assertAssistantDocumentLease', tab, documentLease)).toThrow(
      /stopped being visible/i,
    );
  });

  it('does not dispatch physical input after the Browser panel detaches during target lookup', async () => {
    const sendInputEvent = vi.fn();
    const contents = {
      getZoomFactor: () => 1,
      isDestroyed: () => false,
      sendInputEvent,
    };
    const view = { webContents: contents };
    const tab = {
      shell: {
        id: '00000000-0000-4000-8000-000000000001',
        conversationId: 'chat-1',
        owner: 'user' as const,
        keepOpen: true,
        url: 'https://example.com/form',
        sensitive: false,
      },
      view,
      generation: 4,
      trustedUserNavigationLease: 0,
      trustedGestureGeneration: 0,
      lastUsedAt: 0,
    };
    const documentLease = {
      runId: 'run-1',
      runGeneration: 7,
      hostRendererAuthorityGeneration: 0,
      tabGeneration: tab.generation,
      userNavigationLease: tab.trustedUserNavigationLease,
      url: tab.shell.url,
    };
    let manager!: InstanceType<typeof BrowserManager>;
    manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', tab.shell.id]]),
      armAutomationGesture: vi.fn(),
      assertAssistantDocumentLease: vi.fn(),
      attachActiveView: vi.fn(),
      attachedView: view,
      cancelElementPickersForConversation: vi.fn(),
      emit: vi.fn(),
      emitTabs: vi.fn(),
      ensureAssistantView: vi.fn(async () => view),
      getConfig: () => ({ browser: { enabled: true } }),
      getWindow: () => visibleHostWindow(),
      locate: vi.fn(async () => {
        await manager.mount('chat-1', null);
        return { x: 20, y: 30, width: 100, height: 20 };
      }),
      mountedBounds: { x: 10, y: 20, width: 300, height: 200 },
      mountedConversationId: 'chat-1',
      runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
      setAutomationOverlay: vi.fn(async () => undefined),
      tabs: new Map([[tab.shell.id, tab]]),
      withAssistantControl: (_tab: unknown, _run: unknown, task: (lease: typeof documentLease) => Promise<unknown>) =>
        task(documentLease),
    });

    await expect(
      manager.action('chat-1', { tabId: tab.shell.id, kind: 'click', selector: '#submit' }, { id: 'run-1' }),
    ).rejects.toThrow(/Browser panel visibility changed while the assistant action was waiting/i);
    expect(sendInputEvent).not.toHaveBeenCalled();
    expect(tab.trustedGestureGeneration).toBe(1);
  });

  it('restores renderer zoom and leaves shell state unchanged when zoom persistence fails', async () => {
    const persistenceError = new Error('profile disk failure');
    const setZoomLevel = vi.fn();
    const view = { webContents: { setZoomLevel } };
    const tab = {
      shell: {
        id: '00000000-0000-4000-8000-000000000001',
        conversationId: 'chat-1',
        zoomLevel: 0,
      },
      scopeKey: 'global',
      view,
    };
    const invalidatePanelLayout = vi.fn();
    const emitTabs = vi.fn();
    const storeSetZoomLevel = vi.fn(() => {
      throw persistenceError;
    });
    const manager = managerWithoutConstructor({
      emitTabs,
      ensureView: vi.fn(async () => view),
      invalidatePanelLayout,
      requireTab: vi.fn(() => tab),
      storeForScope: () => ({ setZoomLevel: storeSetZoomLevel }),
      withScopeActivity: (_scopeKey: string, task: () => Promise<unknown>) => task(),
    });

    await expect(manager.setZoom('chat-1', tab.shell.id, 1)).rejects.toBe(persistenceError);

    expect(setZoomLevel).toHaveBeenNthCalledWith(1, 1);
    expect(setZoomLevel).toHaveBeenNthCalledWith(2, 0);
    expect(storeSetZoomLevel).toHaveBeenCalledWith(1);
    expect(tab.shell.zoomLevel).toBe(0);
    expect(invalidatePanelLayout).not.toHaveBeenCalled();
    expect(emitTabs).not.toHaveBeenCalled();
  });

  it.each(['sidebar bounds', 'page zoom'] as const)(
    'does not dispatch physical input after %s changes during target lookup',
    async (change) => {
      const sendInputEvent = vi.fn();
      const setZoomLevel = vi.fn();
      const contents = {
        getZoomFactor: () => 1,
        isDestroyed: () => false,
        sendInputEvent,
        setZoomLevel,
      };
      const view = { webContents: contents };
      const tab = {
        shell: {
          id: '00000000-0000-4000-8000-000000000001',
          conversationId: 'chat-1',
          owner: 'user' as const,
          keepOpen: true,
          url: 'https://example.com/form',
          sensitive: false,
          zoomLevel: 0,
        },
        scopeKey: 'global',
        view,
        generation: 4,
        trustedUserNavigationLease: 0,
        trustedGestureGeneration: 0,
        lastUsedAt: 0,
      };
      const documentLease = {
        runId: 'run-1',
        runGeneration: 7,
        hostRendererAuthorityGeneration: 0,
        tabGeneration: tab.generation,
        userNavigationLease: tab.trustedUserNavigationLease,
        url: tab.shell.url,
      };
      let manager!: InstanceType<typeof BrowserManager>;
      manager = managerWithoutConstructor({
        activeTabs: new Map([['chat-1', tab.shell.id]]),
        armAutomationGesture: vi.fn(),
        assertAssistantDocumentLease: vi.fn(),
        attachActiveView: vi.fn(),
        attachedView: view,
        emit: vi.fn(),
        emitPendingPrompts: vi.fn(),
        emitTabs: vi.fn(),
        ensureAssistantView: vi.fn(async () => view),
        ensureView: vi.fn(async () => view),
        getConfig: () => ({ browser: { enabled: true } }),
        getWindow: () => ({
          getContentBounds: () => ({ width: 1_000, height: 800 }),
          isDestroyed: () => false,
          isVisible: () => true,
          isMinimized: () => false,
          isFocused: () => true,
        }),
        locate: vi.fn(async () => {
          if (change === 'sidebar bounds') {
            await manager.mount('chat-1', { x: 10, y: 20, width: 360, height: 200 });
          } else {
            await manager.setZoom('chat-1', tab.shell.id, 1);
          }
          return { x: 20, y: 30, width: 100, height: 20 };
        }),
        mountedBounds: { x: 10, y: 20, width: 300, height: 200 },
        mountedConversationId: 'chat-1',
        runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
        setAutomationOverlay: vi.fn(async () => undefined),
        storeForScope: () => ({ setZoomLevel: vi.fn() }),
        tabs: new Map([[tab.shell.id, tab]]),
        withAssistantControl: (_tab: unknown, _run: unknown, task: (lease: typeof documentLease) => Promise<unknown>) =>
          task(documentLease),
        withScopeActivity: (_scopeKey: string, task: () => Promise<unknown>) => task(),
      });

      await expect(
        manager.action('chat-1', { tabId: tab.shell.id, kind: 'click', selector: '#submit' }, { id: 'run-1' }),
      ).rejects.toThrow(/panel layout or page zoom changed while the assistant action was waiting/i);
      expect(sendInputEvent).not.toHaveBeenCalled();
      expect(setZoomLevel).toHaveBeenCalledTimes(change === 'page zoom' ? 1 : 0);
    },
  );

  it('revokes a queued physical action for an inactive tab when the Browser panel closes', async () => {
    const queueBlocker = deferred<void>();
    const ensureAssistantView = vi.fn();
    const target = {
      shell: {
        id: '00000000-0000-4000-8000-000000000001',
        conversationId: 'chat-1',
        owner: 'user' as const,
        keepOpen: true,
        url: 'https://example.com/form',
        sensitive: false,
      },
      view: null,
      generation: 4,
      trustedUserNavigationLease: 0,
      trustedGestureGeneration: 0,
      lastUsedAt: 0,
    };
    const visibleView = { webContents: { isDestroyed: () => false } };
    const visible = {
      shell: { id: '00000000-0000-4000-8000-000000000002', conversationId: 'chat-1' },
      view: visibleView,
      trustedGestureGeneration: 0,
    };
    const documentLease = {
      runId: 'run-1',
      runGeneration: 7,
      hostRendererAuthorityGeneration: 0,
      tabGeneration: target.generation,
      userNavigationLease: target.trustedUserNavigationLease,
      url: target.shell.url,
    };
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', visible.shell.id]]),
      assertAssistantDocumentLease: vi.fn(),
      attachedView: visibleView,
      cancelElementPickersForConversation: vi.fn(),
      emit: vi.fn(),
      emitTabs: vi.fn(),
      ensureAssistantView,
      getConfig: () => ({ browser: { enabled: true } }),
      mountedBounds: { x: 10, y: 20, width: 300, height: 200 },
      mountedConversationId: 'chat-1',
      runTabOperation: async (_tab: unknown, task: () => Promise<unknown>) => {
        await queueBlocker.promise;
        return task();
      },
      setAutomationOverlay: vi.fn(async () => undefined),
      tabs: new Map<string, unknown>([
        [target.shell.id, target],
        [visible.shell.id, visible],
      ]),
      withAssistantControl: (_tab: unknown, _run: unknown, task: (lease: typeof documentLease) => Promise<unknown>) =>
        task(documentLease),
    });

    const action = manager.action(
      'chat-1',
      { tabId: target.shell.id, kind: 'click', selector: '#submit' },
      { id: 'run-1' },
    );
    await manager.mount('chat-1', null);
    queueBlocker.resolve();

    await expect(action).rejects.toThrow(/Browser panel visibility changed while the assistant action was waiting/i);
    expect(ensureAssistantView).not.toHaveBeenCalled();
  });

  it('does not dispatch physical input after the user switches away during target lookup', async () => {
    const sendInputEvent = vi.fn();
    const contents = {
      getZoomFactor: () => 1,
      isDestroyed: () => false,
      sendInputEvent,
    };
    const firstView = { webContents: contents };
    const secondView = { webContents: { isDestroyed: () => false } };
    const first = {
      shell: {
        id: '00000000-0000-4000-8000-000000000001',
        conversationId: 'chat-1',
        owner: 'user' as const,
        keepOpen: true,
        url: 'https://example.com/form',
        sensitive: false,
      },
      view: firstView,
      generation: 4,
      trustedUserNavigationLease: 0,
      trustedGestureGeneration: 0,
      lastUsedAt: 0,
    };
    const second = {
      shell: { id: '00000000-0000-4000-8000-000000000002', conversationId: 'chat-1' },
      view: secondView,
      trustedGestureGeneration: 0,
      lastUsedAt: 0,
    };
    const documentLease = {
      runId: 'run-1',
      runGeneration: 7,
      hostRendererAuthorityGeneration: 0,
      tabGeneration: first.generation,
      userNavigationLease: first.trustedUserNavigationLease,
      url: first.shell.url,
    };
    let manager!: InstanceType<typeof BrowserManager>;
    const activeTabs = new Map([['chat-1', first.shell.id]]);
    manager = managerWithoutConstructor({
      activeTabs,
      armAutomationGesture: vi.fn(),
      assertAssistantDocumentLease: vi.fn(),
      attachActiveView: vi.fn(),
      attachedView: firstView,
      cancelElementPickersForConversation: vi.fn(),
      emit: vi.fn(),
      emitTabs: vi.fn(),
      ensureAssistantView: vi.fn(async () => firstView),
      ensureView: vi.fn(async () => secondView),
      getWindow: () => visibleHostWindow(),
      locate: vi.fn(async () => {
        await (invokePrivate(manager, 'commandTabWithinOperation', second, 'activate', 'user') as Promise<void>);
        return { x: 20, y: 30, width: 100, height: 20 };
      }),
      mountedBounds: { x: 10, y: 20, width: 300, height: 200 },
      mountedConversationId: 'chat-1',
      runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
      setAutomationOverlay: vi.fn(async () => undefined),
      tabs: new Map([
        [first.shell.id, first],
        [second.shell.id, second],
      ]),
      withAssistantControl: (_tab: unknown, _run: unknown, task: (lease: typeof documentLease) => Promise<unknown>) =>
        task(documentLease),
    });

    await expect(
      manager.action('chat-1', { tabId: first.shell.id, kind: 'click', selector: '#submit' }, { id: 'run-1' }),
    ).rejects.toThrow(/user interacted with the browser while the assistant action was waiting/i);
    expect(sendInputEvent).not.toHaveBeenCalled();
    expect(first.trustedGestureGeneration).toBe(1);
    expect(activeTabs.get('chat-1')).toBe(second.shell.id);
  });

  it.each(['inspect', 'evaluate', 'screenshot', 'autofill'] as const)(
    'publishes %s as a visible assistant operation with terminal status',
    async (kind) => {
      const contents = { isDestroyed: () => false };
      const view = { webContents: contents };
      const tab = {
        shell: { id: 'tab-1', conversationId: 'chat-1' },
        view,
        lastUsedAt: 0,
      };
      const emit = vi.fn();
      const emitTabs = vi.fn();
      const attachActiveView = vi.fn();
      const setAutomationOverlay = vi.fn(async () => undefined);
      const manager = managerWithoutConstructor({
        activeTabs: new Map([['chat-1', tab.shell.id]]),
        assertAssistantDocumentLease: vi.fn(),
        attachActiveView,
        attachedView: view,
        emit,
        emitTabs,
        getWindow: () => visibleHostWindow(),
        mountedBounds: { x: 10, y: 20, width: 300, height: 200 },
        mountedConversationId: 'chat-1',
        setAutomationOverlay,
        tabs: new Map([[tab.shell.id, tab]]),
      });
      const lease = {};

      await expect(
        invokePrivate(
          manager,
          'withVisibleAssistantOperation',
          'chat-1',
          tab,
          { id: 'run-1' },
          kind,
          `${kind} page`,
          async (reveal: (target: unknown, documentLease: unknown) => Promise<void>) => {
            await reveal(contents, lease);
            expect(Reflect.get(manager, 'runningActions')).toHaveLength(1);
            return 'done';
          },
        ),
      ).resolves.toBe('done');

      expect(Reflect.get(manager, 'activeTabs').get('chat-1')).toBe('tab-1');
      expect(emitTabs).toHaveBeenCalledWith('chat-1');
      expect(attachActiveView).toHaveBeenCalledWith('chat-1', false);
      expect(emit).toHaveBeenCalledWith({ type: 'open-panel', conversationId: 'chat-1', tabId: 'tab-1' });
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'action',
          conversationId: 'chat-1',
          action: expect.objectContaining({ kind, status: 'running' }),
        }),
      );
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'action',
          conversationId: 'chat-1',
          action: expect.objectContaining({ kind, status: 'completed' }),
        }),
      );
      expect(setAutomationOverlay).toHaveBeenCalledTimes(2);
      expect(Reflect.get(manager, 'runningActions')).toHaveLength(0);
    },
  );

  it('serializes assistant-visible operations before switching tabs', async () => {
    const firstTab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      scopeKey: 'global',
      lastUsedAt: 0,
      visibleAssistantGeneration: 0,
    };
    const secondTab = {
      shell: { id: 'tab-2', conversationId: 'chat-1' },
      scopeKey: 'global',
      lastUsedAt: 0,
      visibleAssistantGeneration: 0,
    };
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', firstTab.shell.id]]),
      emit: vi.fn(),
      emitTabs: vi.fn(),
      setAutomationOverlay: vi.fn(async () => undefined),
      tabs: new Map([
        [firstTab.shell.id, firstTab],
        [secondTab.shell.id, secondTab],
      ]),
    });

    const first = invokePrivate(
      manager,
      'withVisibleAssistantOperation',
      'chat-1',
      firstTab,
      { id: 'run-1' },
      'inspect',
      'inspecting first page',
      async () => {
        order.push('first:start');
        firstStarted.resolve();
        await releaseFirst.promise;
        order.push('first:end');
        return 'first';
      },
    ) as Promise<string>;
    await firstStarted.promise;

    const second = invokePrivate(
      manager,
      'withVisibleAssistantOperation',
      'chat-1',
      secondTab,
      { id: 'run-1' },
      'evaluate',
      'evaluating second page',
      async () => {
        order.push('second');
        return 'second';
      },
    ) as Promise<string>;
    await Promise.resolve();

    expect(order).toEqual(['first:start']);
    expect(Reflect.get(manager, 'activeTabs').get('chat-1')).toBe(firstTab.shell.id);
    expect(firstTab.visibleAssistantGeneration).toBe(0);

    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(Reflect.get(manager, 'activeTabs').get('chat-1')).toBe(secondTab.shell.id);
    expect(firstTab.visibleAssistantGeneration).toBe(1);
  });

  it('redacts page-controlled URLs from failed action events before renderer exposure', async () => {
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      view: { webContents: { isDestroyed: () => false } },
      lastUsedAt: 0,
    };
    const emit = vi.fn();
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', tab.shell.id]]),
      emit,
      emitTabs: vi.fn(),
      setAutomationOverlay: vi.fn(async () => undefined),
      tabs: new Map([[tab.shell.id, tab]]),
    });

    await expect(
      invokePrivate(
        manager,
        'withVisibleAssistantOperation',
        'chat-1',
        tab,
        { id: 'run-1' },
        'inspect',
        'inspecting page',
        async () => {
          throw new Error('Navigation failed at https://example.com/account?token=never-expose');
        },
      ),
    ).rejects.toThrow('never-expose');

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'action',
        action: expect.objectContaining({
          status: 'failed',
          error: 'Navigation failed at [redacted browser URL: https://example.com]',
        }),
      }),
    );
    expect(JSON.stringify(emit.mock.calls)).not.toContain('never-expose');
  });

  it('does not begin a visible assistant operation until the requested chat and tab are mounted', async () => {
    const contents = { isDestroyed: () => false };
    const view = { webContents: contents };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      view,
      lastUsedAt: 0,
      visibleAssistantGeneration: 0,
    };
    const emit = vi.fn();
    let operated = false;
    const manager = managerWithoutConstructor({
      assertAssistantDocumentLease: vi.fn(),
      attachActiveView: vi.fn(),
      attachedView: null,
      emit,
      emitTabs: vi.fn(),
      getWindow: () => visibleHostWindow(),
      mountedBounds: { x: 10, y: 20, width: 300, height: 200 },
      mountedConversationId: 'chat-other',
      setAutomationOverlay: vi.fn(async () => undefined),
      tabs: new Map([[tab.shell.id, tab]]),
    });

    const operation = invokePrivate(
      manager,
      'withVisibleAssistantOperation',
      'chat-1',
      tab,
      { id: 'run-1' },
      'autofill',
      'autofilling saved password',
      async (reveal: (target: unknown, documentLease: Record<string, unknown>) => Promise<void>) => {
        const lease: Record<string, unknown> = {};
        await reveal(contents, lease);
        operated = true;
        return lease.visibleAssistantGeneration;
      },
    ) as Promise<unknown>;
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith({ type: 'open-panel', conversationId: 'chat-1', tabId: 'tab-1' }),
    );
    expect(operated).toBe(false);

    Reflect.set(manager, 'mountedConversationId', 'chat-1');
    Reflect.set(manager, 'attachedView', view);
    invokePrivate(manager, 'notifyPanelStateChanged', 'chat-1');

    await expect(operation).resolves.toBe(0);
    expect(operated).toBe(true);
  });

  it('quarantines a scripted page before evaluation and keeps it detached after failure', async () => {
    const view = { webContents: { isDestroyed: () => false } };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        owner: 'user',
        keepOpen: true,
        url: 'https://example.com/account',
        sensitive: false,
        reloadRequired: false,
      },
      view,
      scopeKey: 'global',
      generation: 3,
      assistantScriptDepth: 0,
      scriptTainted: false,
    };
    const detachAttachedView = vi.fn();
    const emitTabs = vi.fn();
    const installPrivateNetworkNewDocumentGuard = vi.fn(async () => undefined);
    const markScriptCleanupOrigin = vi.fn();
    const evaluateWithDeadline = vi.fn(async () => {
      expect(tab.scriptTainted).toBe(true);
      expect(tab.shell.reloadRequired).toBe(true);
      expect(detachAttachedView).toHaveBeenCalledOnce();
      throw new Error('script failed');
    });
    const manager = managerWithoutConstructor({
      assertAssistantDocumentLease: vi.fn(),
      attachActiveView: vi.fn(),
      attachedView: view,
      detachAttachedView,
      emit: vi.fn(),
      emitTabs,
      ensureAssistantView: vi.fn(async () => view),
      evaluateWithDeadline,
      getWindow: () => visibleHostWindow(),
      installPrivateNetworkNewDocumentGuard,
      mountedBounds: { x: 10, y: 20, width: 300, height: 200 },
      mountedConversationId: 'chat-1',
      assertTabNotSensitive: vi.fn(async () => undefined),
      runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
      setAutomationOverlay: vi.fn(async () => undefined),
      storeForScope: () => ({ markScriptCleanupOrigin }),
      tabs: new Map([[tab.shell.id, tab]]),
      withAssistantControl: (
        _tab: unknown,
        _run: unknown,
        task: (lease: Record<string, unknown>) => Promise<unknown>,
      ) => task({}),
    });

    await expect(manager.evaluate('chat-1', 'document.title', tab.shell.id, { id: 'run-1' })).rejects.toThrow(
      'script failed',
    );
    expect(tab.scriptTainted).toBe(true);
    expect(tab.shell.reloadRequired).toBe(true);
    expect(installPrivateNetworkNewDocumentGuard).toHaveBeenCalledWith(tab, view.webContents);
    expect(markScriptCleanupOrigin).toHaveBeenCalledWith('https://example.com');
    expect(emitTabs).toHaveBeenCalledWith('chat-1');
  });

  it('unregisters durable service workers before releasing a scripted origin', async () => {
    const origin = 'https://example.com';
    const clearScriptCleanupOrigin = vi.fn();
    const store = {
      listScriptCleanupOrigins: vi.fn(() => [origin]),
      clearScriptCleanupOrigin,
    };
    const scopedSession = {
      closeAllConnections: vi.fn(async () => undefined),
      clearStorageData: vi.fn(async () => undefined),
    };
    electronMocks.fromPartition.mockReturnValue(scopedSession);
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: `${origin}/account`,
        discarded: true,
        sensitive: false,
        reloadRequired: true,
      },
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      scriptTainted: true,
      view: null,
      queue: { whenIdle: vi.fn(async () => undefined) },
    };
    const stopRunningServiceWorkers = vi.fn(async () => undefined);
    const manager = managerWithoutConstructor({
      emitTabs: vi.fn(),
      stopRunningServiceWorkers,
      storeForScope: () => store,
      tabs: new Map([[tab.shell.id, tab]]),
    });

    await invokePrivate(manager, 'clearScriptedOriginBeforeRenderer', tab, origin);

    expect(stopRunningServiceWorkers).toHaveBeenCalledWith(scopedSession, undefined, true);
    expect(scopedSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(scopedSession.clearStorageData).toHaveBeenCalledWith({
      origin,
      storages: ['serviceworkers'],
    });
    expect(clearScriptCleanupOrigin).toHaveBeenCalledWith(origin);
    expect(tab.scriptTainted).toBe(false);
    expect(tab.shell.reloadRequired).toBe(false);
  });

  it('keeps script quarantine durable when service-worker removal fails', async () => {
    const origin = 'https://example.com';
    const clearScriptCleanupOrigin = vi.fn();
    const store = {
      listScriptCleanupOrigins: vi.fn(() => [origin]),
      clearScriptCleanupOrigin,
    };
    const scopedSession = {
      closeAllConnections: vi.fn(async () => undefined),
      clearStorageData: vi.fn(async () => {
        throw new Error('registration busy');
      }),
    };
    electronMocks.fromPartition.mockReturnValue(scopedSession);
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: `${origin}/account`,
        discarded: true,
        sensitive: false,
        reloadRequired: true,
      },
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      scriptTainted: true,
      view: null,
      queue: { whenIdle: vi.fn(async () => undefined) },
    };
    const manager = managerWithoutConstructor({
      emitTabs: vi.fn(),
      stopRunningServiceWorkers: vi.fn(async () => undefined),
      storeForScope: () => store,
      tabs: new Map([[tab.shell.id, tab]]),
    });

    await expect(invokePrivate(manager, 'clearScriptedOriginBeforeRenderer', tab, origin)).rejects.toThrow(
      /registration busy/,
    );

    expect(clearScriptCleanupOrigin).not.toHaveBeenCalled();
    expect(tab.scriptTainted).toBe(true);
    expect(tab.shell.reloadRequired).toBe(true);
    expect(Reflect.get(manager, 'clearingOrigins')).toHaveLength(0);
  });

  it('activates the private-network document guard in already-loaded execution contexts', async () => {
    const sendCommand = vi.fn(async () => ({ identifier: 'guard-1' }));
    const executeJavaScript = vi.fn(async () => true);
    const mainFrame = {
      detached: false,
      frameTreeNodeId: 7,
      isDestroyed: () => false,
      executeJavaScript,
      framesInSubtree: [] as unknown[],
    };
    mainFrame.framesInSubtree = [mainFrame];
    const contents = {
      id: 42,
      mainFrame,
      debugger: {
        attach: vi.fn(),
        detach: vi.fn(),
        isAttached: () => false,
        sendCommand,
      },
      isDestroyed: () => false,
    };
    const tab = {};
    const manager = managerWithoutConstructor({ aiAllowPrivateNetwork: false });

    await invokePrivate(manager, 'installPrivateNetworkNewDocumentGuard', tab, contents);

    expect(sendCommand).toHaveBeenCalledWith('Page.addScriptToEvaluateOnNewDocument', {
      source: expect.any(String),
      runImmediately: true,
    });
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('__kaiBrowserActivatePrivateNetworkGuard'));
    expect(tab).toMatchObject({
      privateNetworkNewDocumentGuard: { contentsId: 42, identifier: 'guard-1' },
    });
  });

  it('rejects an assistant page when any live frame reports a failed WebRTC membrane installation', async () => {
    const topFrame = {
      detached: false,
      frameTreeNodeId: 7,
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => true),
      framesInSubtree: [] as unknown[],
    };
    const childFrame = {
      detached: false,
      frameTreeNodeId: 8,
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
    };
    topFrame.framesInSubtree = [topFrame, childFrame];
    const contents = {
      id: 42,
      mainFrame: topFrame,
      debugger: {
        attach: vi.fn(),
        detach: vi.fn(),
        isAttached: () => false,
        sendCommand: vi.fn(async () => ({ identifier: 'guard-1' })),
      },
      isDestroyed: () => false,
    };
    const tab = {
      privateNetworkNewDocumentGuard: { contentsId: 42, identifier: 'preload-pending' },
    };
    const manager = managerWithoutConstructor({ aiAllowPrivateNetwork: false });

    await expect(invokePrivate(manager, 'installPrivateNetworkNewDocumentGuard', tab, contents)).rejects.toThrow(
      /preload could not install.*WebRTC guard/,
    );

    expect(tab.privateNetworkNewDocumentGuard).toEqual({ contentsId: 42, identifier: 'preload-pending' });
  });

  it('activates the WebRTC guard before a ready page is exposed to structured assistant actions', async () => {
    const order: string[] = [];
    const setWebRTCIPHandlingPolicy = vi.fn(() => {
      order.push('native-policy');
    });
    const view = { webContents: { isDestroyed: () => false, setWebRTCIPHandlingPolicy } };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', url: 'https://example.com' },
      view,
      viewLoadPromise: null,
      generation: 3,
      trustedUserNavigationLease: 0,
    };
    const lease = {
      runId: 'run-1',
      runGeneration: 7,
      hostRendererAuthorityGeneration: 0,
      tabGeneration: 3,
      userNavigationLease: 0,
      url: 'https://example.com',
    };
    const installPrivateNetworkNewDocumentGuard = vi.fn(async () => {
      order.push('guard');
    });
    const assertAssistantDocumentLease = vi.fn(() => {
      order.push('assert');
    });
    const manager = managerWithoutConstructor({
      aiAllowPrivateNetwork: false,
      assertAssistantDocumentLease,
      ensureView: vi.fn(async () => view),
      installPrivateNetworkNewDocumentGuard,
    });

    await expect(invokePrivate(manager, 'ensureAssistantView', tab, { id: 'run-1' }, lease)).resolves.toBe(view);

    expect(setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
    expect(installPrivateNetworkNewDocumentGuard).toHaveBeenCalledWith(tab, view.webContents);
    expect(order).toEqual(['assert', 'native-policy', 'guard', 'assert']);
  });

  it('autofills a saved credential only in its matching top-level frame', async () => {
    const topFrame = {
      detached: false,
      isDestroyed: () => false,
      origin: 'https://login.example',
      executeJavaScript: vi.fn(async (_source: string, _userGesture?: boolean) => true),
    };
    const loginFrame = {
      detached: false,
      isDestroyed: () => false,
      origin: 'https://login.example',
      executeJavaScript: vi.fn(async (_source: string, _userGesture?: boolean) => true),
    };
    const contents = {
      mainFrame: Object.assign(topFrame, { framesInSubtree: [topFrame, loginFrame] }),
    };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://login.example/account',
        sensitive: false,
      },
      scopeKey: 'global',
      generation: 4,
      scriptTainted: false,
      queue: { run: (task: () => Promise<unknown>) => task() },
    };
    const decrypted = {
      origin: 'https://login.example',
      username: 'saved-user',
      password: 'vault-secret',
    };
    const credential = {
      id: 'credential-1',
      scopeKey: 'global',
      origin: 'https://login.example',
      username: 'saved-user',
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    };
    const listCredentials = vi.fn(() => [credential]);
    const vault = {
      list: listCredentials,
      findForOrigin: vi.fn(
        (origin: string, id: string) =>
          listCredentials().find((item) => item.origin === origin && item.id === id) ?? null,
      ),
      decrypt: vi.fn(() => decrypted),
    };
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'tab-1']]),
      clearingScopes: new Set(),
      disposed: false,
      ensureView: vi.fn(async () => ({ webContents: contents })),
      runRendererOperationWithDeadline: (
        _tab: unknown,
        _contents: unknown,
        _operation: string,
        _timeoutMs: number,
        task: () => Promise<unknown>,
      ) => task(),
      scopeActivityCounts: new Map(),
      scopeIdleWaiters: new Map(),
      setTabSensitive: (target: typeof tab, sensitive: boolean) => {
        target.shell.sensitive = sensitive;
      },
      shuttingDown: false,
      suspendedScopes: new Set(),
      tabs: new Map([['tab-1', tab]]),
      vaultForScope: () => vault,
    });

    const approval = {
      tabId: 'tab-1',
      tabGeneration: 4,
      origin: 'https://login.example',
      url: 'https://login.example/account',
      credentialId: 'credential-1',
      credentialUpdatedAt: credential.updatedAt,
      destinationOrigin: 'https://login.example',
    };
    await manager.autofill('chat-1', 'tab-1', 'credential-1', 'user', undefined, approval);

    expect(loginFrame.executeJavaScript).not.toHaveBeenCalled();
    expect(topFrame.executeJavaScript).toHaveBeenCalledTimes(2);
    expect(topFrame.executeJavaScript.mock.calls[0][0]).not.toContain('vault-secret');
    expect(topFrame.executeJavaScript.mock.calls[1][0]).toContain('vault-secret');
    expect(topFrame.executeJavaScript.mock.calls[1][1]).toBe(false);
    expect(vault.decrypt).toHaveBeenCalledWith('credential-1');
    expect(decrypted.password).toBe('');
    expect(tab.shell.sensitive).toBe(true);

    decrypted.password = 'never-expose-this-password';
    topFrame.executeJavaScript.mockImplementation(async (source: string) => {
      if (source.includes('never-expose-this-password')) throw new Error('never-expose-this-password');
      return true;
    });
    const hostileError = await manager
      .autofill('chat-1', 'tab-1', 'credential-1', 'user', undefined, approval)
      .catch((error: unknown) => error);
    expect(hostileError).toBeInstanceOf(Error);
    expect((hostileError as Error).message).toBe('Saved-password autofill could not fill the selected login form.');
    expect((hostileError as Error).message).not.toContain('never-expose-this-password');
    expect(decrypted.password).toBe('');

    vault.findForOrigin.mockReturnValueOnce({
      ...credential,
      updatedAt: '2026-08-16T00:30:00.000Z',
    });
    await expect(manager.autofill('chat-1', 'tab-1', 'credential-1', 'user', undefined, approval)).rejects.toThrow(
      /credential or destination changed while autofill was waiting/i,
    );
    expect(vault.decrypt).toHaveBeenCalledTimes(2);

    listCredentials.mockReturnValue([{ ...credential, updatedAt: '2026-08-16T01:00:00.000Z' }]);
    await expect(manager.autofill('chat-1', 'tab-1', 'credential-1', 'user', undefined, approval)).rejects.toThrow(
      /credential or destination changed while approval was pending/i,
    );
    expect(vault.decrypt).toHaveBeenCalledTimes(2);
  });

  it('does not offer a child-frame credential for autofill approval', async () => {
    const topFrame = { detached: false, isDestroyed: () => false, origin: 'https://app.example' };
    const contents = {
      isDestroyed: () => false,
      mainFrame: Object.assign(topFrame, {
        framesInSubtree: [topFrame, { detached: false, isDestroyed: () => false, origin: 'https://login.example' }],
      }),
    };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', url: 'https://app.example/account' },
      scopeKey: 'global',
      generation: 4,
      view: { webContents: contents },
      viewLoadPromise: null,
    };
    const credential = {
      id: 'credential-1',
      scopeKey: 'global',
      origin: 'https://login.example',
      username: 'saved-user',
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    };
    const ensureAssistantView = vi.fn(async () => ({ webContents: contents }));
    const withAssistantControl = vi.fn();
    const manager = managerWithoutConstructor({
      assertAssistantRun: vi.fn(),
      assertBrowserPageLease: vi.fn(),
      captureBrowserPageLease: vi.fn(() => ({})),
      ensureAssistantView,
      runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
      tabs: new Map([['tab-1', tab]]),
      vaultForScope: () => ({ list: () => [credential] }),
      withAssistantControl,
    });

    await expect(manager.captureAutofillApproval('chat-1', 'tab-1', undefined, { id: 'run-1' })).rejects.toThrow(
      /No saved credential matches/i,
    );
    expect(ensureAssistantView).not.toHaveBeenCalled();
    expect(withAssistantControl).not.toHaveBeenCalled();
  });

  it('does not duplicate a temporary tab owned by another active assistant run', async () => {
    const manager = new BrowserManager(
      '/tmp/kai-browser-duplicate-owner-test',
      () => ({ browser: { dataScope: 'global', enabled: true } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    manager.beginAssistantRun('chat-1', 'run-a');
    manager.beginAssistantRun('chat-1', 'run-b');
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        owner: 'assistant',
        keepOpen: false,
        sensitive: false,
        url: 'https://example.com',
      },
      assistantOwnerId: 'run-a',
      scopeKey: 'global',
      queue: { run: (operation: () => Promise<unknown>) => operation() },
      aiActionDepth: 0,
    };
    const tabs = Reflect.get(manager, 'tabs') as Map<string, typeof tab>;
    tabs.set(tab.shell.id, tab);

    await expect(manager.duplicateAssistantTab('chat-1', tab.shell.id, { id: 'run-b' })).rejects.toThrow(
      /belongs to another active assistant run/,
    );

    tabs.clear();
    manager.dispose();
  });

  it('rejects an approved duplicate after the target document changes in its tab queue', async () => {
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        owner: 'user' as const,
        keepOpen: false,
        sensitive: false,
        url: 'https://example.com/original',
      },
      generation: 4,
    };
    const createTab = vi.fn();
    const manager = managerWithoutConstructor({
      createTab,
      tabs: new Map([[tab.shell.id, tab]]),
      assertAssistantDocumentLease: vi.fn(),
      runTabOperation: async (_target: unknown, operation: () => Promise<unknown>) => {
        tab.generation++;
        tab.shell.url = 'https://example.com/changed';
        return operation();
      },
      withAssistantControl: async (
        _target: unknown,
        _run: unknown,
        operation: (lease: Record<string, never>) => Promise<unknown>,
      ) => operation({}),
    });
    const approval = manager.captureTabsApproval('chat-1', 'duplicate', tab.shell.id);

    await expect(manager.duplicateAssistantTab('chat-1', tab.shell.id, { id: 'run-1' }, approval)).rejects.toThrow(
      /page changed while approval was pending/,
    );
    expect(createTab).not.toHaveBeenCalled();
  });

  it('binds approved reopen and multi-tab close operations to the exact captured list state', async () => {
    const retained = {
      shell: {
        id: 'tab-a',
        conversationId: 'chat-1',
        owner: 'user' as const,
        keepOpen: false,
        url: 'https://a.example',
      },
      generation: 1,
      assistantOwnerId: null,
    };
    const rightOne = {
      shell: {
        id: 'tab-b',
        conversationId: 'chat-1',
        owner: 'user' as const,
        keepOpen: false,
        url: 'https://b.example',
      },
      generation: 1,
      assistantOwnerId: null,
    };
    const rightTwo = {
      shell: {
        id: 'tab-c',
        conversationId: 'chat-1',
        owner: 'user' as const,
        keepOpen: false,
        url: 'https://c.example',
      },
      generation: 1,
      assistantOwnerId: null,
    };
    const closed = {
      id: 'closed-1',
      url: 'https://closed.example/first',
      title: 'First',
      owner: 'user' as const,
      keepOpen: false,
      sensitive: false,
      scopeKey: 'global',
    };
    const replacementClosed = { ...closed, id: 'closed-2', url: 'https://closed.example/second' };
    const tabOrder = new Map([['chat-1', ['tab-a', 'tab-b', 'tab-c']]]);
    const tabs = new Map([
      ['tab-a', retained],
      ['tab-b', rightOne],
      ['tab-c', rightTwo],
    ]);
    const closeTab = vi.fn();
    let queueCompletions = 0;
    const manager = managerWithoutConstructor({
      assistantRuns: {
        acquire: () => ({ generation: 1, release: vi.fn() }),
        assertActive: () => 1,
        generationIfActive: () => null,
      },
      closedTabs: new Map([['chat-1', [closed]]]),
      closeTab,
      emitTabs: vi.fn(),
      tabs,
      tabOrder,
      runTabOperation: async (_target: unknown, operation: () => Promise<unknown>) => {
        const result = await operation();
        queueCompletions++;
        if (queueCompletions === 3) tabOrder.set('chat-1', ['tab-a', 'tab-c', 'tab-b']);
        return result;
      },
      withAssistantControl: async (_target: unknown, _run: unknown, operation: () => Promise<unknown>) => operation(),
    });

    const reopenApproval = manager.captureTabsApproval('chat-1', 'reopen_closed');
    Reflect.get(manager, 'closedTabs').set('chat-1', [replacementClosed, closed]);
    await expect(manager.reopenClosedTab('chat-1', 'assistant', { id: 'run-1' }, reopenApproval)).rejects.toThrow(
      /closed-tab history changed/,
    );

    const closeApproval = manager.captureTabsApproval('chat-1', 'close_right', retained.shell.id);
    await expect(
      manager.commandTab('chat-1', retained.shell.id, 'close-right', 'assistant', { id: 'run-1' }, closeApproval),
    ).rejects.toThrow(/tab order changed/);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('hands temporary tabs to an automatic continuation and reclaims an abandoned handoff', async () => {
    const manager = new BrowserManager(
      '/tmp/kai-browser-continuation-test',
      () => ({ browser: { dataScope: 'global', enabled: true } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    manager.beginAssistantRun('chat-1', 'run-1');
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        owner: 'assistant',
        keepOpen: false,
        active: true,
      },
      assistantOwnerId: 'run-1',
      aiControlOwnerId: 'run-1',
      aiControlGeneration: 1,
      popupGesture: {
        source: 'assistant' as const,
        assistantOwnerId: 'run-1',
        expiresAt: Date.now() + 1_000,
      },
    };
    const tabs = Reflect.get(manager, 'tabs') as Map<string, typeof tab>;
    const order = Reflect.get(manager, 'tabOrder') as Map<string, string[]>;
    const cancelDownload = vi.fn(async () => undefined);
    const activeDownloads = Reflect.get(manager, 'activeDownloads') as Map<object, Record<string, unknown>>;
    tabs.set(tab.shell.id, tab);
    order.set('chat-1', [tab.shell.id]);
    activeDownloads.set(
      {},
      {
        id: 'download-1',
        scopeKey: 'global',
        conversationId: 'chat-1',
        tabId: tab.shell.id,
        assistantOwnerId: 'run-1',
        keepOpen: false,
        item: {},
        done: Promise.resolve(),
        cancel: cancelDownload,
      },
    );

    expect(manager.prepareAssistantContinuation('chat-1', 'run-1')).toBe(true);
    expect(manager.hasPendingAssistantContinuation('chat-1', 'run-1')).toBe(true);
    expect(manager.hasPendingAssistantContinuationForConversation('chat-1')).toBe(true);
    expect(() => manager.assertAssistantRun('chat-1', { id: 'run-1' })).toThrow(/ended or is not registered/);

    await manager.beginAssistantContinuation('chat-1', 'run-2', 'run-1');
    expect(manager.hasPendingAssistantContinuation('chat-1', 'run-1')).toBe(false);
    expect(manager.hasPendingAssistantContinuationForConversation('chat-1')).toBe(false);

    expect(tab.assistantOwnerId).toBe('run-2');
    expect(tab.aiControlOwnerId).toBe('run-2');
    expect(tab.popupGesture.assistantOwnerId).toBe('run-2');
    expect([...activeDownloads.values()][0]?.assistantOwnerId).toBe('run-2');
    expect(() => manager.assertAssistantRun('chat-1', { id: 'run-2' })).not.toThrow();

    const closeTab = vi.fn((closed: typeof tab) => {
      tabs.delete(closed.shell.id);
      order.set('chat-1', []);
    });
    Reflect.set(manager, 'closeTab', closeTab);
    expect(manager.prepareAssistantContinuation('chat-1', 'run-2')).toBe(true);
    await manager.cancelAssistantContinuations('chat-1');

    expect(closeTab).toHaveBeenCalledWith(tab, false);
    expect(cancelDownload).toHaveBeenCalledOnce();
    expect(tabs.has(tab.shell.id)).toBe(false);
    activeDownloads.clear();
    manager.dispose();
  });

  it('reclaims a retained predecessor when Realtime wins before continuation admission', async () => {
    const manager = new BrowserManager(
      '/tmp/kai-browser-continuation-conflict-test',
      () => ({ browser: { dataScope: 'global', enabled: true } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    manager.beginAssistantRun('chat-1', 'text-run-1');
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        owner: 'assistant',
        keepOpen: false,
        active: true,
      },
      assistantOwnerId: 'text-run-1',
      aiControlOwnerId: 'text-run-1',
      aiControlGeneration: 1,
      popupGesture: null,
    };
    const tabs = Reflect.get(manager, 'tabs') as Map<string, typeof tab>;
    const order = Reflect.get(manager, 'tabOrder') as Map<string, string[]>;
    tabs.set(tab.shell.id, tab);
    order.set('chat-1', [tab.shell.id]);
    const closeTab = vi.fn((closed: typeof tab) => {
      tabs.delete(closed.shell.id);
      order.set('chat-1', []);
    });
    Reflect.set(manager, 'closeTab', closeTab);

    expect(manager.prepareAssistantContinuation('chat-1', 'text-run-1')).toBe(true);
    manager.beginAssistantRun('chat-1', 'realtime-run', 'realtime');

    await expect(manager.beginAssistantContinuation('chat-1', 'text-run-2', 'text-run-1')).rejects.toThrow(
      /another assistant modality/i,
    );
    expect(closeTab).toHaveBeenCalledWith(tab, false);
    expect(tabs.has(tab.shell.id)).toBe(false);

    await manager.cleanupAssistantTabs('chat-1', 'realtime-run');
    manager.dispose();
  });

  it('releases the AI network policy after a verified user takeover and the remaining activity grace', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const tab = {
        shell: { id: 'tab-1' },
        aiActionDepth: 0,
        aiActionUntil: Date.now() + 1_500,
        aiNetworkReleaseRequested: false,
        aiNetworkReleaseTimer: null as ReturnType<typeof setTimeout> | null,
        aiNetworkRestricted: true,
        aiControlOwnerId: 'run-1' as string | null,
        aiControlGeneration: 1 as number | null,
        scriptTainted: false,
      };
      const manager = managerWithoutConstructor({
        tabs: new Map([['tab-1', tab]]),
      });

      invokePrivate(manager, 'releaseAiNetworkRestrictionForUser', tab);
      expect(tab.aiNetworkRestricted).toBe(true);
      expect(tab.aiNetworkReleaseTimer).not.toBeNull();

      vi.advanceTimersByTime(1_499);
      expect(tab.aiNetworkRestricted).toBe(true);
      vi.advanceTimersByTime(1);
      expect(tab.aiNetworkRestricted).toBe(false);
      expect(tab.aiControlOwnerId).toBeNull();
      expect(tab.aiNetworkReleaseTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not release an irreversible WebRTC guard in place', () => {
    const tab = {
      shell: { id: 'tab-1' },
      aiActionDepth: 0,
      aiActionUntil: 0,
      aiNetworkReleaseRequested: false,
      aiNetworkReleaseTimer: null,
      aiNetworkRestricted: true,
      aiControlOwnerId: 'run-1',
      aiControlGeneration: 1,
      scriptTainted: false,
      privateNetworkNewDocumentGuard: { contentsId: 41, identifier: 'guard-1' },
    };
    const manager = managerWithoutConstructor({ tabs: new Map([['tab-1', tab]]) });

    invokePrivate(manager, 'releaseAiNetworkRestrictionForUser', tab);

    expect(tab.aiNetworkRestricted).toBe(true);
    expect(tab.aiControlOwnerId).toBe('run-1');
    expect(tab.aiNetworkReleaseRequested).toBe(false);
  });

  it('revokes a completed run control lease while retaining the AI network policy', async () => {
    const end = vi.fn(async () => undefined);
    const closeTab = vi.fn();
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        owner: 'user' as const,
        keepOpen: false,
      },
      assistantOwnerId: null,
      aiActionDepth: 0,
      aiActionUntil: 0,
      aiNetworkReleaseRequested: false,
      aiNetworkReleaseTimer: null,
      aiNetworkRestricted: true,
      aiControlOwnerId: 'run-1' as string | null,
      aiControlGeneration: 1 as number | null,
      popupGesture: {
        source: 'assistant' as const,
        assistantOwnerId: 'run-1',
        expiresAt: Date.now() + 1_000,
      } as {
        source: 'assistant';
        assistantOwnerId: string;
        expiresAt: number;
      } | null,
      scriptTainted: false,
    };
    const manager = managerWithoutConstructor({
      assistantRuns: { end },
      automationGestureTokens: new Map([
        ['token-1', { tabId: tab.shell.id, assistantOwnerId: 'run-1', expiresAt: Date.now() + 1_000 }],
      ]),
      closeTab,
      tabOrder: new Map([['chat-1', [tab.shell.id]]]),
      tabs: new Map([[tab.shell.id, tab]]),
      emitTabs: vi.fn(),
    });

    await manager.cleanupAssistantTabs('chat-1', 'run-1');

    expect(end).toHaveBeenCalledWith('chat-1', 'run-1');
    expect(closeTab).not.toHaveBeenCalled();
    expect(tab.aiNetworkRestricted).toBe(true);
    expect(tab.aiControlOwnerId).toBeNull();
    expect(tab.aiControlGeneration).toBeNull();
    expect(tab.aiNetworkReleaseRequested).toBe(false);
    expect(tab.aiNetworkReleaseTimer).toBeNull();
    expect(tab.popupGesture).toBeNull();
    expect((Reflect.get(manager, 'automationGestureTokens') as Map<unknown, unknown>).size).toBe(0);
  });

  it('reclaims and restores a retained guard-only renderer when its assistant run ends', async () => {
    const view = { webContents: { id: 41 } };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        owner: 'user' as const,
        keepOpen: false,
        discarded: false,
        sensitive: true,
        reloadRequired: false,
      },
      assistantOwnerId: null,
      aiControlOwnerId: 'run-1' as string | null,
      aiControlGeneration: 1 as number | null,
      aiNetworkRestricted: true,
      popupGesture: null,
      scriptTainted: false,
      privateNetworkNewDocumentGuard: { contentsId: 41, identifier: 'guard-1' } as
        | { contentsId: number; identifier: string }
        | undefined,
      generation: 3,
      view: view as typeof view | null,
    };
    const destroyView = vi.fn(() => {
      tab.privateNetworkNewDocumentGuard = undefined;
      tab.view = null;
    });
    const restoreActiveViewAfterClose = vi.fn();
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', tab.shell.id]]),
      assistantRuns: { end: vi.fn(async () => undefined) },
      automationGestureTokens: new Map(),
      cancelActiveDownloadsForAssistantRun: vi.fn(async () => undefined),
      closeTab: vi.fn(),
      destroyView,
      emitTabs: vi.fn(),
      restoreActiveViewAfterClose,
      tabOrder: new Map([['chat-1', [tab.shell.id]]]),
      tabs: new Map([[tab.shell.id, tab]]),
    });

    await manager.cleanupAssistantTabs('chat-1', 'run-1');

    expect(destroyView).toHaveBeenCalledWith(tab);
    expect(tab.generation).toBe(4);
    expect(tab.view).toBeNull();
    expect(tab.shell).toMatchObject({ discarded: true, sensitive: false, reloadRequired: false });
    expect(tab.aiNetworkRestricted).toBe(true);
    expect(tab.aiControlOwnerId).toBeNull();
    expect(restoreActiveViewAfterClose).toHaveBeenCalledWith('chat-1', tab.shell.id);
  });

  it('cancels run-owned downloads after their temporary assistant tabs have already closed', async () => {
    const cancelTemporary = vi.fn(async () => undefined);
    const cancelKept = vi.fn(async () => undefined);
    const kept = {
      shell: { id: 'kept', conversationId: 'chat-1', owner: 'assistant' as const, keepOpen: true },
      assistantOwnerId: 'run-1',
      aiControlOwnerId: null,
      popupGesture: null,
    };
    const manager = managerWithoutConstructor({
      activeDownloads: new Map([
        [
          {},
          {
            id: 'download-temporary',
            scopeKey: 'global',
            conversationId: 'chat-1',
            tabId: 'temporary',
            assistantOwnerId: 'run-1',
            keepOpen: false,
            cancel: cancelTemporary,
          },
        ],
        [
          {},
          {
            id: 'download-kept',
            scopeKey: 'global',
            conversationId: 'chat-1',
            tabId: 'kept',
            assistantOwnerId: 'run-1',
            keepOpen: true,
            cancel: cancelKept,
          },
        ],
      ]),
      assistantRuns: { end: vi.fn(async () => undefined) },
      automationGestureTokens: new Map(),
      closeTab: vi.fn(),
      emitTabs: vi.fn(),
      // The temporary shell is already gone; only captured download ownership
      // can still associate its DownloadItem with this completed run.
      tabOrder: new Map([['chat-1', ['kept']]]),
      tabs: new Map([['kept', kept]]),
    });

    await manager.cleanupAssistantTabs('chat-1', 'run-1');

    expect(cancelTemporary).toHaveBeenCalledOnce();
    expect(cancelKept).not.toHaveBeenCalled();
  });

  it('publishes text-run cleanup drains before a successor modality can be admitted', async () => {
    const drain = deferred<void>();
    const end = vi.fn(() => drain.promise);
    const cleanupAssistantStateOwnedByRun = vi.fn();
    const manager = managerWithoutConstructor({
      assistantRuns: { end },
      cleanupAssistantStateOwnedByRun,
      emitTabs: vi.fn(),
    });

    const cleanup = manager.cleanupAssistantTabs('chat-1', 'text-run');
    expect(end).toHaveBeenCalledWith('chat-1', 'text-run');

    let barrierFinished = false;
    const barrier = manager.waitForAssistantTabCleanup('chat-1').then(() => {
      barrierFinished = true;
    });
    await Promise.resolve();
    expect(barrierFinished).toBe(false);

    drain.resolve();
    await Promise.all([cleanup, barrier]);
    expect(cleanupAssistantStateOwnedByRun).toHaveBeenCalledWith('chat-1', 'text-run');
    expect(barrierFinished).toBe(true);
  });

  it('destroys a retained scripted renderer when its assistant run ends', async () => {
    const end = vi.fn(async () => undefined);
    const destroyView = vi.fn((tab: { view: unknown }) => {
      tab.view = null;
    });
    const tab = {
      shell: {
        id: 'scripted-tab',
        conversationId: 'chat-1',
        owner: 'user' as const,
        keepOpen: false,
        discarded: false,
        sensitive: true,
      },
      assistantOwnerId: null,
      aiControlOwnerId: 'run-1' as string | null,
      aiControlGeneration: 1 as number | null,
      generation: 4,
      popupGesture: null,
      scriptTainted: true,
      view: { webContents: {} } as unknown,
    };
    const manager = managerWithoutConstructor({
      assistantRuns: { end },
      automationGestureTokens: new Map(),
      destroyView,
      emitTabs: vi.fn(),
      tabOrder: new Map([['chat-1', [tab.shell.id]]]),
      tabs: new Map([[tab.shell.id, tab]]),
    });

    await manager.cleanupAssistantTabs('chat-1', 'run-1');

    expect(destroyView).toHaveBeenCalledWith(tab);
    expect(tab.generation).toBe(5);
    expect(tab.view).toBeNull();
    expect(tab.shell.discarded).toBe(true);
    expect(tab.shell.sensitive).toBe(false);
    expect(tab.aiControlOwnerId).toBeNull();
  });

  it('clears a pending continuation lease when direct run cleanup consumes it', async () => {
    const manager = new BrowserManager(
      '/tmp/kai-browser-continuation-cleanup-test',
      () => ({ browser: { dataScope: 'global', enabled: true } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    manager.beginAssistantRun('chat-1', 'run-1');
    expect(manager.prepareAssistantContinuation('chat-1', 'run-1')).toBe(true);
    expect(Reflect.get(manager, 'assistantContinuationLeases').has('chat-1\u0000run-1')).toBe(true);

    await manager.cleanupAssistantTabs('chat-1', 'run-1');

    expect(Reflect.get(manager, 'assistantContinuationLeases').has('chat-1\u0000run-1')).toBe(false);
    manager.dispose();
  });

  it('keeps the AI network restriction after a trusted same-document navigation', () => {
    const release = vi.fn();
    const tab = {
      trustedUserNavigation: true,
      trustedUserNavigationTarget: 'https://example.com/app#next',
      trustedUserNavigationRequestId: null,
      trustedUserNavigationLease: 2,
    };
    const manager = managerWithoutConstructor({ releaseAiNetworkRestrictionForUser: release });

    invokePrivate(manager, 'completeTrustedUserNavigation', tab, 'https://example.com/app#next', false);

    expect(tab.trustedUserNavigation).toBe(false);
    expect(tab.trustedUserNavigationTarget).toBeNull();
    expect(release).not.toHaveBeenCalled();
  });

  it('scans for password data before printing the active Browser tab', async () => {
    let completePrint!: (success: boolean, failureReason: string) => void;
    const print = vi.fn((_options: unknown, callback: (success: boolean, failureReason: string) => void) => {
      completePrint = callback;
    });
    const contents = { print };
    const tab = { shell: { id: 'tab-1', conversationId: 'chat-1' } };
    const pageLease = { tabId: 'tab-1' };
    const captureBrowserPageLease = vi.fn(() => pageLease);
    const assertBrowserPageLease = vi.fn();
    const assertTabNotSensitive = vi.fn(async () => undefined);
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'tab-1']]),
      assertBrowserPageLease,
      assertTabNotSensitive,
      captureBrowserPageLease,
      ensureView: vi.fn(async () => ({ webContents: contents })),
      requireTab: vi.fn(() => tab),
      runTabOperation: (_tab: unknown, operation: () => Promise<void>) => operation(),
    });

    const printing = manager.menuAction('chat-1', 'print');
    await vi.waitFor(() => expect(print).toHaveBeenCalledOnce());
    const settled = vi.fn();
    void printing.then(settled, settled);
    await Promise.resolve();

    expect(assertTabNotSensitive).toHaveBeenCalledWith(tab, contents, 'Printing');
    expect(captureBrowserPageLease).toHaveBeenCalledWith(tab, contents);
    expect(assertBrowserPageLease).toHaveBeenCalledTimes(2);
    expect(print).toHaveBeenCalledWith({ printBackground: true }, expect.any(Function));
    expect(settled).not.toHaveBeenCalled();

    completePrint(true, '');
    await expect(printing).resolves.toBeUndefined();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('propagates native print failures from the active Browser tab', async () => {
    const print = vi.fn((_options: unknown, callback: (success: boolean, failureReason: string) => void) => {
      callback(false, 'Native print failed');
    });
    const contents = { print };
    const tab = { shell: { id: 'tab-1', conversationId: 'chat-1' } };
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'tab-1']]),
      assertBrowserPageLease: vi.fn(),
      assertTabNotSensitive: vi.fn(async () => undefined),
      captureBrowserPageLease: vi.fn(() => ({ tabId: 'tab-1' })),
      ensureView: vi.fn(async () => ({ webContents: contents })),
      requireTab: vi.fn(() => tab),
      runTabOperation: (_tab: unknown, operation: () => Promise<void>) => operation(),
    });

    await expect(manager.menuAction('chat-1', 'print')).rejects.toThrow(/native print failed/i);
  });

  it('does not print a replacement page that navigates in during the sensitivity scan', async () => {
    const scan = deferred<void>();
    const print = vi.fn();
    const contents = { print };
    const replacementContents = { print: vi.fn() };
    const tab = {
      generation: 1,
      trustedUserNavigationLease: 0,
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      view: { webContents: contents },
    };
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'tab-1']]),
      assertBrowserPageLease: vi.fn((_tab: unknown, lease: { contents: unknown }) => {
        if (tab.view.webContents !== lease.contents) throw new Error('The browser page changed while printing.');
      }),
      assertTabNotSensitive: vi.fn(() => scan.promise),
      captureBrowserPageLease: vi.fn(() => ({ contents })),
      ensureView: vi.fn(async () => ({ webContents: contents })),
      requireTab: vi.fn(() => tab),
      runTabOperation: (_tab: unknown, operation: () => Promise<void>) => operation(),
    });

    const printing = manager.menuAction('chat-1', 'print');
    await vi.waitFor(() => expect(Reflect.get(manager, 'assertTabNotSensitive')).toHaveBeenCalledOnce());
    tab.view.webContents = replacementContents;
    scan.resolve();

    await expect(printing).rejects.toThrow(/page changed while printing/i);
    expect(print).not.toHaveBeenCalled();
    expect(replacementContents.print).not.toHaveBeenCalled();
  });

  it('cancels a pending AI network release when its tab is destroyed', () => {
    vi.useFakeTimers();
    try {
      const releaseTimer = setTimeout(() => undefined, 1_500);
      const tab = {
        shell: { id: 'tab-1' },
        view: null,
        overlayTimer: null,
        overlayGeneration: 0,
        aiNetworkReleaseRequested: true,
        aiNetworkReleaseTimer: releaseTimer,
        popupGesture: null,
      };
      const manager = managerWithoutConstructor({
        attachedView: null,
        automationGestureTokens: new Map(),
        cancelFaviconFetch: vi.fn(),
        dropPendingForTab: vi.fn(),
      });

      invokePrivate(manager, 'destroyView', tab);

      expect(tab.aiNetworkReleaseRequested).toBe(false);
      expect(tab.aiNetworkReleaseTimer).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an active download bound to the profile where it started', () => {
    let willDownload: ((event: unknown, item: Record<string, unknown>, contents: { id: number }) => void) | undefined;
    const globalStore = {
      addDownload: vi.fn(),
      flushDownloads: vi.fn(async () => undefined),
    };
    const conversationStore = {
      addDownload: vi.fn(),
      flushDownloads: vi.fn(async () => undefined),
    };
    const tab = {
      scopeKey: 'global',
      shell: { id: 'tab-1', conversationId: 'chat-1' },
    };
    const manager = managerWithoutConstructor({
      activeDownloads: new Map(),
      clearingScopes: new Set(),
      downloads: new Map(),
      getWindow: () => null,
      oneTimePermissions: new Set(),
      pagePreloadPath: '/tmp/browser-page.cjs',
      pendingAuth: new Map(),
      pendingCredentials: new Map(),
      pendingPermissions: new Map(),
      scopeGenerations: new Map([
        ['global', 0],
        ['conversation-aaaaaaaaaaaaaaaaaaaaaaaa', 0],
      ]),
      scopeRequestActivities: new Map(),
      stores: new Map([
        ['global', globalStore],
        ['conversation-aaaaaaaaaaaaaaaaaaaaaaaa', conversationStore],
      ]),
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
      wiredSessions: new WeakSet(),
    });
    const fakeSession = {
      getPreloadScripts: () => [],
      on: (event: string, listener: typeof willDownload) => {
        if (event === 'will-download') willDownload = listener;
      },
      registerPreloadScript: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: vi.fn(),
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
      },
    };
    invokePrivate(manager, 'wireSession', fakeSession, 'persist:kai-browser-global', 'global');
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const item = {
      getFilename: () => 'report.pdf',
      getReceivedBytes: () => 10,
      getSavePath: () => '/tmp/downloads/report.pdf',
      getTotalBytes: () => 10,
      getURL: () => 'https://example.com/report.pdf',
      cancel: vi.fn(),
      off: (event: string) => listeners.delete(event),
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      setSaveDialogOptions: vi.fn(),
    };

    willDownload?.({}, item, { id: 42 });
    expect([...(Reflect.get(manager, 'activeDownloads') as Map<unknown, { conversationId: string }>).values()]).toEqual(
      [expect.objectContaining({ conversationId: 'chat-1' })],
    );
    tab.scopeKey = 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa';
    listeners.get('done')?.({}, 'completed');

    expect(globalStore.addDownload).toHaveBeenCalledTimes(2);
    expect(globalStore.flushDownloads).toHaveBeenCalledOnce();
    expect(conversationStore.addDownload).not.toHaveBeenCalled();
  });

  it('cancels only an active download in the current browser profile', async () => {
    const cancel = vi.fn(async () => undefined);
    const manager = managerWithoutConstructor({
      activeDownloads: new Map([
        [
          {},
          {
            id: 'download-1',
            scopeKey: 'global',
            item: {},
            cancel,
            done: Promise.resolve(),
          },
        ],
      ]),
      clearingScopes: new Set(),
      dataScope: 'global',
      suspendedScopes: new Set(),
    });

    await manager.cancelDownload('chat-1', 'download-1');
    expect(cancel).toHaveBeenCalledOnce();
    await expect(manager.cancelDownload('chat-1', 'missing-download')).rejects.toThrow(/no longer active/i);
  });

  it('lists and resets remembered and one-time permissions for one site', () => {
    const permissions = [
      {
        origin: 'https://example.com',
        permission: 'camera',
        decision: 'allow' as const,
      },
      {
        origin: 'https://example.com',
        permission: 'fileSystem:readable:file:legacy-digest',
        decision: 'allow' as const,
      },
    ];
    const store = {
      listPermissions: vi.fn(() => permissions),
      clearPermissions: vi.fn(),
    };
    const oneTimePermissions = new Set([
      'tab-1\u0000https://example.com\u0000camera',
      'tab-1\u0000https://other.example\u0000camera',
      'tab-2\u0000https://example.com\u0000camera',
    ]);
    const manager = managerWithoutConstructor({
      clearingScopes: new Set(),
      dataScope: 'global',
      oneTimePermissions,
      stores: new Map([['global', store]]),
      suspendedScopes: new Set(),
      tabs: new Map([
        ['tab-1', { scopeKey: 'global', shell: { id: 'tab-1' } }],
        ['tab-2', { scopeKey: 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa', shell: { id: 'tab-2' } }],
      ]),
    });

    expect(manager.listSitePermissions('chat-1', 'https://example.com')).toEqual([permissions[0]]);
    manager.resetSitePermissions('chat-1', 'https://example.com', 'camera');

    expect(store.clearPermissions).toHaveBeenCalledWith('https://example.com', 'camera');
    expect(oneTimePermissions).toEqual(
      new Set(['tab-1\u0000https://other.example\u0000camera', 'tab-2\u0000https://example.com\u0000camera']),
    );
    expect(manager.listSitePermissions('chat-1', 'about:blank')).toEqual([]);
  });

  it('requires fresh approval for remembered permissions while assistant control is active', () => {
    type PermissionContents = { id: number; getURL: () => string };
    type PermissionDetails = { requestingUrl?: string; securityOrigin?: string };
    let checkPermission:
      | ((
          contents: PermissionContents | null,
          permission: string,
          requestingOrigin: string,
          details: PermissionDetails,
        ) => boolean)
      | undefined;
    let requestPermission:
      | ((
          contents: PermissionContents,
          permission: string,
          callback: (allowed: boolean) => void,
          details: PermissionDetails,
        ) => void)
      | undefined;
    const decisions = new Map([
      ['camera', 'allow' as const],
      ['geolocation', 'deny' as const],
    ]);
    const store = {
      getPermission: vi.fn((_origin: string, permission: string) => decisions.get(permission)),
      setPermissions: vi.fn(),
    };
    const emit = vi.fn();
    const tab = {
      aiNetworkRestricted: false,
      generation: 1,
      scopeKey: 'global',
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        owner: 'user',
        url: 'https://example.com/page',
      },
    };
    const manager = managerWithoutConstructor({
      clearingScopes: new Set(),
      emit,
      oneTimePermissions: new Set(['tab-1\u0000https://example.com\u0000notifications']),
      pagePreloadPath: '/tmp/browser-page.cjs',
      stores: new Map([['global', store]]),
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
    });
    const fakeSession = {
      getPreloadScripts: () => [],
      on: vi.fn(),
      registerPreloadScript: vi.fn(),
      setPermissionCheckHandler: (handler: typeof checkPermission) => {
        checkPermission = handler;
      },
      setPermissionRequestHandler: (handler: typeof requestPermission) => {
        requestPermission = handler;
      },
      webRequest: {
        onBeforeRequest: vi.fn(),
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
      },
    };
    invokePrivate(manager, 'wireSession', fakeSession, 'persist:kai-browser-global', 'global');
    const contents = { id: 42, getURL: () => 'https://example.com/page' };

    expect(checkPermission?.(contents, 'camera', 'https://example.com', {})).toBe(true);
    expect(checkPermission?.(contents, 'notifications', 'https://example.com', {})).toBe(true);
    const userRemembered = vi.fn();
    requestPermission?.(contents, 'camera', userRemembered, {});
    expect(userRemembered).toHaveBeenCalledWith(true);

    tab.aiNetworkRestricted = true;
    expect(checkPermission?.(contents, 'camera', 'https://example.com', {})).toBe(false);
    expect(checkPermission?.(contents, 'notifications', 'https://example.com', {})).toBe(false);

    const firstAssistantRequest = vi.fn();
    requestPermission?.(contents, 'camera', firstAssistantRequest, {});
    expect(firstAssistantRequest).not.toHaveBeenCalled();
    const firstPrompt = [
      ...(Reflect.get(manager, 'pendingPermissions') as Map<string, { assistantTriggered: boolean }>),
    ].at(0);
    expect(firstPrompt?.[1].assistantTriggered).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'permission-prompt',
        prompt: expect.objectContaining({ assistantTriggered: true, canPersist: false }),
      }),
    );
    expect(manager.getState('chat-1').permissionPrompts).toEqual([
      expect.objectContaining({ id: firstPrompt?.[0], assistantTriggered: true, canPersist: false }),
    ]);

    manager.respondPermissionPrompt(firstPrompt![0], 'allow-once');
    expect(firstAssistantRequest).toHaveBeenCalledWith(true);
    const repeatedAssistantRequest = vi.fn();
    requestPermission?.(contents, 'camera', repeatedAssistantRequest, {});
    expect(repeatedAssistantRequest).not.toHaveBeenCalled();
    const repeatedPromptId = [
      ...(Reflect.get(manager, 'pendingPermissions') as Map<string, { assistantTriggered: boolean }>).keys(),
    ][0];
    invokePrivate(manager, 'finishPendingPermission', repeatedPromptId, false);

    const oneTimeAssistantRequest = vi.fn();
    requestPermission?.(contents, 'notifications', oneTimeAssistantRequest, {});
    expect(oneTimeAssistantRequest).not.toHaveBeenCalled();
    const oneTimePromptId = [
      ...(Reflect.get(manager, 'pendingPermissions') as Map<string, { assistantTriggered: boolean }>).keys(),
    ][0];
    manager.respondPermissionPrompt(oneTimePromptId, 'deny');
    expect(oneTimeAssistantRequest).toHaveBeenCalledWith(false);
    expect(store.setPermissions).not.toHaveBeenCalled();

    const deniedAssistantRequest = vi.fn();
    requestPermission?.(contents, 'geolocation', deniedAssistantRequest, {});
    expect(deniedAssistantRequest).toHaveBeenCalledWith(false);
    expect(Reflect.get(manager, 'pendingPermissions')).toHaveLength(0);
  });

  it('shows the file-system target and permits only request-scoped access', () => {
    type PermissionContents = { id: number; getURL: () => string };
    type PermissionDetails = {
      requestingUrl?: string;
      filePath?: string;
      fileAccessType?: 'readable' | 'writable';
      isDirectory?: boolean;
    };
    let checkPermission:
      | ((
          contents: PermissionContents | null,
          permission: string,
          origin: string,
          details: PermissionDetails,
        ) => boolean)
      | undefined;
    let requestPermission:
      | ((
          contents: PermissionContents,
          permission: string,
          callback: (allowed: boolean) => void,
          details: PermissionDetails,
        ) => void)
      | undefined;
    const callback = vi.fn();
    const tab = {
      aiNetworkRestricted: false,
      generation: 1,
      scopeKey: 'global',
      shell: { id: 'tab-1', conversationId: 'chat-1', url: 'https://example.com' },
    };
    const store = { getPermission: vi.fn(() => 'allow' as const), setPermissions: vi.fn() };
    const manager = managerWithoutConstructor({
      emit: vi.fn(),
      pagePreloadPath: '/tmp/browser-page.cjs',
      stores: new Map([['global', store]]),
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
    });
    const fakeSession = {
      getPreloadScripts: () => [],
      on: vi.fn(),
      registerPreloadScript: vi.fn(),
      setPermissionCheckHandler: (handler: typeof checkPermission) => {
        checkPermission = handler;
      },
      setPermissionRequestHandler: (handler: typeof requestPermission) => {
        requestPermission = handler;
      },
      webRequest: {
        onBeforeRequest: vi.fn(),
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
      },
    };
    invokePrivate(manager, 'wireSession', fakeSession, 'persist:kai-browser-global', 'global');
    const contents = { id: 42, getURL: () => 'https://example.com' };
    const details = {
      requestingUrl: 'https://example.com',
      filePath: '/Users/alice/Documents/taxes.pdf',
      fileAccessType: 'readable' as const,
      isDirectory: false,
    };

    expect(checkPermission?.(contents, 'fileSystem', 'https://example.com', details)).toBe(false);
    requestPermission?.(contents, 'fileSystem', callback, details);
    const prompt = manager.getState('chat-1').permissionPrompts?.[0];
    expect(prompt).toEqual(
      expect.objectContaining({
        target: 'File: /Users/alice/Documents/taxes.pdf',
        canPersist: false,
      }),
    );
    expect(() => manager.respondPermissionPrompt(prompt!.id, 'allow')).toThrow(/current request only/);
    expect(store.setPermissions).not.toHaveBeenCalled();
    manager.respondPermissionPrompt(prompt!.id, 'allow-once');
    expect(callback).toHaveBeenCalledWith(true);
    expect(store.setPermissions).not.toHaveBeenCalled();
  });

  it('never reuses an allow-once grant across opaque permission origins', () => {
    type PermissionContents = { id: number; getURL: () => string };
    type PermissionDetails = { requestingUrl?: string; securityOrigin?: string; mediaType?: 'video' };
    let checkPermission:
      | ((
          contents: PermissionContents | null,
          permission: string,
          requestingOrigin: string,
          details: PermissionDetails,
        ) => boolean)
      | undefined;
    let requestPermission:
      | ((
          contents: PermissionContents,
          permission: string,
          callback: (allowed: boolean) => void,
          details: PermissionDetails,
        ) => void)
      | undefined;
    const tab = {
      aiNetworkRestricted: false,
      generation: 1,
      scopeKey: 'global',
      shell: { id: 'tab-1', conversationId: 'chat-1' },
    };
    const oneTimePermissions = new Set<string>();
    const manager = managerWithoutConstructor({
      clearingScopes: new Set(),
      emit: vi.fn(),
      oneTimePermissions,
      pagePreloadPath: '/tmp/browser-page.cjs',
      stores: new Map([['global', { getPermission: vi.fn() }]]),
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
    });
    const fakeSession = {
      getPreloadScripts: () => [],
      on: vi.fn(),
      registerPreloadScript: vi.fn(),
      setPermissionCheckHandler: (handler: typeof checkPermission) => {
        checkPermission = handler;
      },
      setPermissionRequestHandler: (handler: typeof requestPermission) => {
        requestPermission = handler;
      },
      webRequest: {
        onBeforeRequest: vi.fn(),
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
      },
    };
    invokePrivate(manager, 'wireSession', fakeSession, 'persist:kai-browser-global', 'global');
    const contents = { id: 42, getURL: () => 'data:text/html,top' };

    const first = vi.fn();
    requestPermission?.(contents, 'media', first, {
      requestingUrl: 'data:text/html,frame-one',
      mediaType: 'video',
    });
    const firstPromptId = [...(Reflect.get(manager, 'pendingPermissions') as Map<string, unknown>).keys()][0]!;
    manager.respondPermissionPrompt(firstPromptId, 'allow-once');

    expect(first).toHaveBeenCalledWith(true);
    expect(oneTimePermissions).toHaveLength(0);
    expect(checkPermission?.(contents, 'media', 'null', { mediaType: 'video' })).toBe(false);

    const second = vi.fn();
    requestPermission?.(contents, 'media', second, {
      requestingUrl: 'data:text/html,frame-two',
      mediaType: 'video',
    });
    expect(second).not.toHaveBeenCalled();
    expect(Reflect.get(manager, 'pendingPermissions')).toHaveLength(1);
    const secondPromptId = [...(Reflect.get(manager, 'pendingPermissions') as Map<string, unknown>).keys()][0]!;
    invokePrivate(manager, 'finishPendingPermission', secondPromptId, false);
  });

  it('cancels downloads that arrive without a live tab or while their profile is unavailable', () => {
    let willDownload: ((event: unknown, item: Record<string, unknown>, contents: { id: number }) => void) | undefined;
    const clearingScopes = new Set(['global']);
    const tab = {
      scopeKey: 'global',
      shell: { id: 'tab-1', conversationId: 'chat-1' },
    };
    const manager = managerWithoutConstructor({
      clearingScopes,
      pagePreloadPath: '/tmp/browser-page.cjs',
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
      wiredSessions: new WeakSet(),
    });
    const fakeSession = {
      getPreloadScripts: () => [],
      on: (event: string, listener: typeof willDownload) => {
        if (event === 'will-download') willDownload = listener;
      },
      registerPreloadScript: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: vi.fn(),
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
      },
    };
    invokePrivate(manager, 'wireSession', fakeSession, 'persist:kai-browser-global', 'global');

    const blockedItem = { cancel: vi.fn() };
    willDownload?.({}, blockedItem, { id: 42 });
    expect(blockedItem.cancel).toHaveBeenCalledOnce();

    clearingScopes.clear();
    const orphanedItem = { cancel: vi.fn() };
    willDownload?.({}, orphanedItem, { id: 404 });
    expect(orphanedItem.cancel).toHaveBeenCalledOnce();
  });

  it('contains download-history persistence failures raised from Electron callbacks', () => {
    let willDownload: ((event: unknown, item: Record<string, unknown>, contents: { id: number }) => void) | undefined;
    const emit = vi.fn();
    const emitTabs = vi.fn();
    const tab = {
      scopeKey: 'global',
      shell: { id: 'tab-1', conversationId: 'chat-1' } as {
        id: string;
        conversationId: string;
        error?: string;
      },
    };
    const manager = managerWithoutConstructor({
      activeDownloads: new Map(),
      clearingScopes: new Set(),
      downloads: new Map(),
      emit,
      emitTabs,
      getWindow: () => null,
      oneTimePermissions: new Set(),
      pagePreloadPath: '/tmp/browser-page.cjs',
      pendingAuth: new Map(),
      pendingCredentials: new Map(),
      pendingPermissions: new Map(),
      scopeGenerations: new Map([['global', 0]]),
      scopeRequestActivities: new Map(),
      stores: new Map([
        [
          'global',
          {
            addDownload: () => {
              throw new Error('profile is read-only');
            },
          },
        ],
      ]),
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
      wiredSessions: new WeakSet(),
    });
    const fakeSession = {
      getPreloadScripts: () => [],
      on: (event: string, listener: typeof willDownload) => {
        if (event === 'will-download') willDownload = listener;
      },
      registerPreloadScript: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: vi.fn(),
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
      },
    };
    invokePrivate(manager, 'wireSession', fakeSession, 'persist:kai-browser-global', 'global');
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const item = {
      getFilename: () => 'report.pdf',
      getReceivedBytes: () => 10,
      getSavePath: () => '/tmp/downloads/report.pdf',
      getTotalBytes: () => 10,
      getURL: () => 'https://example.com/report.pdf',
      cancel: vi.fn(),
      off: (event: string) => listeners.delete(event),
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      setSaveDialogOptions: vi.fn(),
    };

    expect(() => willDownload?.({}, item, { id: 42 })).not.toThrow();
    expect(() => listeners.get('done')?.({}, 'completed')).not.toThrow();

    expect(tab.shell.error).toMatch(/download history could not be saved.*profile is read-only/i);
    expect(emitTabs).toHaveBeenCalledWith('chat-1');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'download', conversationId: 'chat-1' }));
  });

  it('cancels a stale request-policy result before profile clearing can continue', async () => {
    let requestPolicy:
      | ((
          details: {
            id: number;
            webContentsId?: number;
            resourceType: string;
            url: string;
          },
          callback: (result: { cancel?: boolean }) => void,
        ) => void)
      | undefined;
    let resolveHost!: (value: { endpoints: Array<{ address: string }> }) => void;
    electronMocks.fromPartition.mockReturnValue({
      resolveHost: () =>
        new Promise((resolve) => {
          resolveHost = resolve;
        }),
    });
    const scopeActivityCounts = new Map<string, number>();
    const scopeGenerations = new Map([['global', 0]]);
    const clearingScopes = new Set<string>();
    const manager = managerWithoutConstructor({
      clearingScopes,
      getConfig: () => ({ browser: { aiAllowPrivateNetwork: false } }),
      getWindow: () => null,
      oneTimePermissions: new Set(),
      pagePreloadPath: '/tmp/browser-page.cjs',
      pendingAuth: new Map(),
      pendingCredentials: new Map(),
      pendingPermissions: new Map(),
      restrictedBackgroundScopes: new Set(['global']),
      scopeActivityCounts,
      scopeGenerations,
      scopeIdleWaiters: new Map(),
      scopeRequestActivities: new Map(),
      tabs: new Map(),
      webContentsToTab: new Map(),
      wiredSessions: new WeakSet(),
    });
    const fakeSession = {
      getPreloadScripts: () => [],
      on: vi.fn(),
      registerPreloadScript: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: (_filter: unknown, listener: typeof requestPolicy) => {
          requestPolicy = listener;
        },
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
      },
    };
    invokePrivate(manager, 'wireSession', fakeSession, 'persist:kai-browser-global', 'global');
    const callback = vi.fn();

    requestPolicy?.({ id: 10, resourceType: 'xhr', url: 'https://example.com/data' }, callback);
    expect(scopeActivityCounts.get('global')).toBe(1);
    clearingScopes.add('global');
    scopeGenerations.set('global', 1);
    resolveHost({ endpoints: [{ address: '93.184.216.34' }] });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ cancel: true }));

    expect(scopeActivityCounts.has('global')).toBe(false);
  });

  it('validates zero-tab worker traffic before admitting it to the profile', async () => {
    let requestPolicy:
      | ((
          details: { id: number; webContentsId?: number; resourceType: string; url: string },
          callback: (result: { cancel?: boolean }) => void,
        ) => void)
      | undefined;
    const publicResolution = deferred<{ endpoints: Array<{ address: string }> }>();
    const fakeSession = {
      getPreloadScripts: () => [],
      on: vi.fn(),
      registerPreloadScript: vi.fn(),
      resolveHost: vi.fn(() => publicResolution.promise),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: (_filter: unknown, listener: typeof requestPolicy) => {
          requestPolicy = listener;
        },
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
      },
    };
    electronMocks.fromPartition.mockReturnValue(fakeSession);
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-zero-tab-worker-'));
    const manager = managerWithoutConstructor({
      appHome,
      getConfig: () => ({ browser: { aiAllowPrivateNetwork: false } }),
      stores: new Map([
        [
          'global',
          {
            isBackgroundNetworkRestricted: vi.fn(() => false),
          },
        ],
      ]),
    });
    invokePrivate(manager, 'wireSession', fakeSession, 'persist:kai-browser-global', 'global');

    const publicCallback = vi.fn();
    requestPolicy?.({ id: 11, resourceType: 'xhr', url: 'https://public.example/data' }, publicCallback);
    expect(publicCallback).not.toHaveBeenCalled();
    publicResolution.resolve({ endpoints: [{ address: '93.184.216.34' }] });
    await vi.waitFor(() => expect(publicCallback).toHaveBeenCalledWith({}));

    const privateCallback = vi.fn();
    requestPolicy?.({ id: 12, resourceType: 'xhr', url: 'http://127.0.0.1/private' }, privateCallback);
    await vi.waitFor(() => expect(privateCallback).toHaveBeenCalledWith({ cancel: true }));
    rmSync(appHome, { recursive: true, force: true });
  });

  it('does not attribute a worker request to an unrelated unrestricted tab', async () => {
    let requestPolicy:
      | ((
          details: {
            id: number;
            webContentsId?: number;
            resourceType: string;
            url: string;
            referrer?: string;
          },
          callback: (result: { cancel?: boolean }) => void,
        ) => void)
      | undefined;
    const privateResolution = deferred<{ endpoints: Array<{ address: string }> }>();
    const fakeSession = {
      getPreloadScripts: () => [],
      on: vi.fn(),
      registerPreloadScript: vi.fn(),
      resolveHost: vi.fn(() => privateResolution.promise),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: (_filter: unknown, listener: typeof requestPolicy) => {
          requestPolicy = listener;
        },
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
      },
    };
    electronMocks.fromPartition.mockReturnValue(fakeSession);
    const unrelatedTab = {
      scopeKey: 'global',
      generation: 1,
      aiNetworkRestricted: false,
      unrestrictedNetworkGeneration: 1,
      unrestrictedNetworkValidations: new Map<string, Promise<void>>(),
      unrestrictedNetworkUnsafe: false,
      shell: { id: 'tab-b', url: 'https://origin-b.example/page' },
    };
    const manager = managerWithoutConstructor({
      getConfig: () => ({ browser: { aiAllowPrivateNetwork: false } }),
      stores: new Map([['global', { isBackgroundNetworkRestricted: vi.fn(() => false) }]]),
      tabs: new Map([['tab-b', unrelatedTab]]),
    });
    invokePrivate(manager, 'wireSession', fakeSession, 'persist:kai-browser-global', 'global');

    const callback = vi.fn();
    requestPolicy?.(
      {
        id: 13,
        resourceType: 'xhr',
        url: 'https://private-target.example/data',
        referrer: 'https://origin-a.example/service-worker.js',
      },
      callback,
    );

    expect(callback).not.toHaveBeenCalled();
    expect(unrelatedTab.unrestrictedNetworkValidations.size).toBe(0);
    privateResolution.resolve({ endpoints: [{ address: '127.0.0.1' }] });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ cancel: true }));
    expect(unrelatedTab.unrestrictedNetworkUnsafe).toBe(false);
  });

  it('allows user-owned service-worker traffic but persists assistant worker restrictions', async () => {
    let requestPolicy:
      | ((
          details: {
            id: number;
            webContentsId?: number;
            resourceType: string;
            url: string;
            referrer?: string;
          },
          callback: (result: { cancel?: boolean }) => void,
        ) => void)
      | undefined;
    let registrationCompleted: ((_event: unknown, details: { scope: string }) => void) | undefined;
    const store = {
      isBackgroundNetworkRestricted: vi.fn(() => false),
      restrictBackgroundNetwork: vi.fn(() => {
        throw new Error('profile is read-only');
      }),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    electronMocks.fromPartition.mockReturnValue({ resolveHost: vi.fn() });
    const tab = {
      scopeKey: 'global',
      generation: 1,
      aiNetworkRestricted: false,
      scriptTainted: false,
      unrestrictedNetworkGeneration: 1,
      unrestrictedNetworkValidations: new Map<string, Promise<void>>(),
      unrestrictedNetworkUnsafe: false,
      shell: { id: 'tab-1', owner: 'user', url: 'https://app.example/page' },
    };
    const appHome = '/tmp/kai-browser-worker-retry-guard';
    rmSync(appHome, { recursive: true, force: true });
    const manager = managerWithoutConstructor({
      appHome,
      clearingScopes: new Set(),
      disposed: false,
      getConfig: () => ({ browser: { aiAllowPrivateNetwork: false } }),
      getWindow: () => null,
      oneTimePermissions: new Set(),
      pagePreloadPath: '/tmp/browser-page.cjs',
      pendingAuth: new Map(),
      pendingCredentials: new Map(),
      pendingPermissions: new Map(),
      restrictedBackgroundScopes: new Set(),
      scopeActivityCounts: new Map(),
      scopeGenerations: new Map([['global', 0]]),
      scopeIdleWaiters: new Map(),
      scopeRequestActivities: new Map(),
      stores: new Map([['global', store]]),
      suspendedScopes: new Set(),
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map(),
      wiredSessions: new WeakSet(),
      wiredSessionsByScope: new Map(),
    });
    const fakeSession = {
      getPreloadScripts: () => [],
      on: vi.fn(),
      registerPreloadScript: vi.fn(),
      serviceWorkers: {
        on: (_event: string, listener: typeof registrationCompleted) => {
          registrationCompleted = listener;
        },
      },
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: (_filter: unknown, listener: typeof requestPolicy) => {
          requestPolicy = listener;
        },
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
      },
    };
    invokePrivate(manager, 'wireSession', fakeSession, 'persist:kai-browser-global', 'global');

    registrationCompleted?.({}, { scope: 'https://app.example/' });
    expect(store.restrictBackgroundNetwork).not.toHaveBeenCalled();
    const userRequest = vi.fn();
    requestPolicy?.(
      {
        id: 20,
        resourceType: 'xhr',
        url: 'http://127.0.0.1/user-data',
        referrer: 'https://app.example/service-worker.js',
      },
      userRequest,
    );
    expect(userRequest).toHaveBeenCalledWith({});
    await vi.waitFor(() => expect(tab.unrestrictedNetworkUnsafe).toBe(true));

    // A prior failed clear must re-latch the guard before an already-created
    // persistent session can resume background worker requests after restart.
    markPendingBrowserCleanupScopeKey(appHome, 'global');
    invokePrivate(manager, 'wireSession', fakeSession, 'persist:kai-browser-global', 'global');
    expect((Reflect.get(manager, 'restrictedBackgroundScopes') as Set<string>).has('global')).toBe(true);
    expect((Reflect.get(manager, 'clearQuarantinedScopes') as Set<string>).has('global')).toBe(true);
    const quarantinedPublicRequest = vi.fn();
    requestPolicy?.({ id: 23, resourceType: 'xhr', url: 'https://example.com/public' }, quarantinedPublicRequest);
    expect(quarantinedPublicRequest).toHaveBeenCalledWith({ cancel: true });
    clearPendingBrowserCleanupScopeKey(appHome, 'global');
    (Reflect.get(manager, 'restrictedBackgroundScopes') as Set<string>).clear();
    (Reflect.get(manager, 'clearQuarantinedScopes') as Set<string>).clear();

    tab.aiNetworkRestricted = true;
    expect(() => registrationCompleted?.({}, { scope: 'https://app.example/' })).not.toThrow();
    expect(store.restrictBackgroundNetwork).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[Browser] Could not persist service-worker network provenance:',
      expect.objectContaining({ message: 'profile is read-only' }),
    );
    expect(listPendingBrowserCleanupScopeKeys(appHome)).toContain('global');
    tab.aiNetworkRestricted = false;
    Reflect.get(manager, 'tabs').clear();
    const assistantWorkerRequest = vi.fn();
    requestPolicy?.({ id: 21, resourceType: 'xhr', url: 'http://127.0.0.1/assistant-data' }, assistantWorkerRequest);
    await vi.waitFor(() => expect(assistantWorkerRequest).toHaveBeenCalledWith({ cancel: true }));

    const restartedStore = {
      isBackgroundNetworkRestricted: vi.fn(() => false),
      restrictBackgroundNetwork: vi.fn(),
    };
    const restartedManager = managerWithoutConstructor({
      appHome,
      clearingScopes: new Set(),
      disposed: false,
      getConfig: () => ({ browser: { aiAllowPrivateNetwork: false } }),
      getWindow: () => null,
      oneTimePermissions: new Set(),
      pagePreloadPath: '/tmp/browser-page.cjs',
      pendingAuth: new Map(),
      pendingCredentials: new Map(),
      pendingPermissions: new Map(),
      restrictedBackgroundScopes: new Set(),
      scopeActivityCounts: new Map(),
      scopeGenerations: new Map([['global', 0]]),
      scopeIdleWaiters: new Map(),
      scopeRequestActivities: new Map(),
      stores: new Map([['global', restartedStore]]),
      suspendedScopes: new Set(),
      tabs: new Map(),
      webContentsToTab: new Map(),
      wiredSessions: new WeakSet(),
      wiredSessionsByScope: new Map(),
    });
    let restartedRequestPolicy: typeof requestPolicy;
    const restartedSession = {
      ...fakeSession,
      webRequest: {
        onBeforeRequest: (_filter: unknown, listener: typeof requestPolicy) => {
          restartedRequestPolicy = listener;
        },
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
      },
    };
    invokePrivate(restartedManager, 'wireSession', restartedSession, 'persist:kai-browser-global', 'global');
    expect((Reflect.get(restartedManager, 'restrictedBackgroundScopes') as Set<string>).has('global')).toBe(true);
    expect((Reflect.get(restartedManager, 'clearQuarantinedScopes') as Set<string>).has('global')).toBe(true);
    const restartedWorkerRequest = vi.fn();
    restartedRequestPolicy?.(
      { id: 22, resourceType: 'xhr', url: 'https://example.com/restarted-worker-data' },
      restartedWorkerRequest,
    );
    await vi.waitFor(() => expect(restartedWorkerRequest).toHaveBeenCalledWith({ cancel: true }));
    warn.mockRestore();
    rmSync(appHome, { recursive: true, force: true });
  });

  it('summarizes inactive profiles without retaining live store or vault instances', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-summary-'));
    mkdirSync(join(appHome, 'browser'), { recursive: true });
    writeFileSync(join(appHome, 'browser', 'pending-profile-cleanup.json'), '{not-json');
    const stores = new Map();
    const vaults = new Map();
    const manager = managerWithoutConstructor({
      appHome,
      stores,
      tabs: new Map(),
      vaults,
    });

    const summaries = await manager.dataSummary();
    expect(summaries).toEqual(expect.arrayContaining([expect.objectContaining({ scopeKey: 'global' })]));
    expect(summaries.find((summary) => summary.scopeKey === 'global')?.warning).toContain(
      'Pending cleanup metadata could not be enumerated',
    );
    expect(summaries.find((summary) => summary.scopeKey === 'global')).toEqual(
      expect.objectContaining({ recoveryRequired: true }),
    );
    expect(summaries.find((summary) => summary.scopeKey === 'global')?.warning).toContain(
      'clearing every discoverable Browser profile',
    );
    expect(stores.size).toBe(0);
    expect(vaults.size).toBe(0);
    rmSync(appHome, { recursive: true, force: true });
  });

  it('lifts process-wide cleanup quarantine after metadata becomes readable again', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-summary-recovery-'));
    const markerPath = join(appHome, 'browser', 'pending-profile-cleanup.json');
    mkdirSync(join(appHome, 'browser'), { recursive: true });
    writeFileSync(markerPath, '{not-json');
    const manager = managerWithoutConstructor({ appHome });

    try {
      await manager.dataSummary();
      expect(Reflect.get(manager, 'pendingCleanupQuarantineUnreadable')).toBe(true);

      writeFileSync(markerPath, JSON.stringify({ version: 1, scopeKeys: [] }));
      await manager.dataSummary();
      expect(Reflect.get(manager, 'pendingCleanupQuarantineUnreadable')).toBe(false);
    } finally {
      rmSync(appHome, { recursive: true, force: true });
    }
  });

  it('yields between Browser Data summary profiles instead of scanning them synchronously', async () => {
    const counts = vi.fn(() => ({ historyCount: 0, bookmarkCount: 0, downloadCount: 0 }));
    const credentialCount = vi.fn(() => 0);
    const stores = { get: vi.fn(() => ({ counts })) };
    const vaults = { get: vi.fn(() => ({ count: credentialCount })) };
    const manager = managerWithoutConstructor({
      appHome: '/tmp/kai-browser-summary-yield-does-not-exist',
      stores,
      tabs: new Map(),
      vaults,
    });

    const summary = manager.dataSummary('chat-summary-yield');
    expect(stores.get).toHaveBeenCalledOnce();
    expect(vaults.get).toHaveBeenCalledOnce();

    await expect(summary).resolves.toHaveLength(2);
    expect(stores.get).toHaveBeenCalledTimes(2);
    expect(vaults.get).toHaveBeenCalledTimes(2);
  });

  it('retains clearable Browser Data rows when inactive profile metadata is corrupt', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-summary-corrupt-'));
    const corruptProfileScope = 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa';
    const corruptVaultScope = 'conversation-bbbbbbbbbbbbbbbbbbbbbbbb';
    mkdirSync(join(appHome, 'browser', 'profiles'), { recursive: true });
    mkdirSync(join(appHome, 'browser', 'credentials'), { recursive: true });
    writeFileSync(join(appHome, 'browser', 'profiles', `${corruptProfileScope}.json`), '{not-json');
    writeFileSync(join(appHome, 'browser', 'credentials', `${corruptVaultScope}.json`), '{not-json');
    const manager = managerWithoutConstructor({ appHome });

    try {
      const summaries = await manager.dataSummary();
      expect(summaries).toEqual(expect.arrayContaining([expect.objectContaining({ scopeKey: 'global' })]));
      expect(summaries.find((summary) => summary.scopeKey === corruptProfileScope)).toEqual(
        expect.objectContaining({
          historyCount: 0,
          bookmarkCount: 0,
          credentialCount: 0,
          warning: expect.stringContaining('Browser profile metadata is unreadable'),
        }),
      );
      expect(summaries.find((summary) => summary.scopeKey === corruptVaultScope)).toEqual(
        expect.objectContaining({
          historyCount: 0,
          bookmarkCount: 0,
          credentialCount: 0,
          warning: expect.stringContaining('Saved-password metadata is unreadable'),
        }),
      );
    } finally {
      rmSync(appHome, { recursive: true, force: true });
    }
  });

  it('warns when corrupt profile and credential instances are already cached', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-summary-cached-corrupt-'));
    mkdirSync(join(appHome, 'browser', 'profiles'), { recursive: true });
    mkdirSync(join(appHome, 'browser', 'credentials'), { recursive: true });
    writeFileSync(join(appHome, 'browser', 'profiles', 'global.json'), '{not-json');
    writeFileSync(join(appHome, 'browser', 'credentials', 'global.json'), '{not-json');
    const manager = managerWithoutConstructor({ appHome });

    try {
      invokePrivate(manager, 'storeForScope', 'global');
      invokePrivate(manager, 'vaultForScope', 'global');

      const summaries = await manager.dataSummary();
      expect(summaries.find((summary) => summary.scopeKey === 'global')).toEqual(
        expect.objectContaining({
          historyCount: 0,
          bookmarkCount: 0,
          credentialCount: 0,
          warning: expect.stringMatching(
            /Browser profile metadata is unreadable.*Saved-password metadata is unreadable/,
          ),
        }),
      );
    } finally {
      rmSync(appHome, { recursive: true, force: true });
    }
  });

  it('keeps admitted requests active until Chromium reports completion or failure', () => {
    let requestPolicy:
      | ((
          details: {
            id: number;
            webContentsId?: number;
            resourceType: string;
            url: string;
          },
          callback: (result: object) => void,
        ) => void)
      | undefined;
    let completed: ((details: { id: number }) => void) | undefined;
    let failed: ((details: { id: number }) => void) | undefined;
    const scopeActivityCounts = new Map<string, number>();
    const manager = managerWithoutConstructor({
      clearingScopes: new Set(),
      getConfig: () => ({ browser: { aiAllowPrivateNetwork: false } }),
      getWindow: () => null,
      oneTimePermissions: new Set(),
      pagePreloadPath: '/tmp/browser-page.cjs',
      pendingAuth: new Map(),
      pendingCredentials: new Map(),
      pendingPermissions: new Map(),
      scopeActivityCounts,
      scopeGenerations: new Map([['global', 0]]),
      scopeIdleWaiters: new Map(),
      scopeRequestActivities: new Map(),
      tabs: new Map([['tab-1', { shell: { id: 'tab-1' }, aiNetworkRestricted: false }]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
      wiredSessions: new WeakSet(),
    });
    const fakeSession = {
      getPreloadScripts: () => [],
      on: vi.fn(),
      registerPreloadScript: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: (_filter: unknown, listener: typeof requestPolicy) => {
          requestPolicy = listener;
        },
        onCompleted: (_filter: unknown, listener: typeof completed) => {
          completed = listener;
        },
        onErrorOccurred: (_filter: unknown, listener: typeof failed) => {
          failed = listener;
        },
      },
    };
    invokePrivate(manager, 'wireSession', fakeSession, 'persist:kai-browser-global', 'global');

    const admitted = vi.fn();
    requestPolicy?.(
      {
        id: 11,
        webContentsId: 42,
        resourceType: 'xhr',
        url: 'https://example.com/data',
      },
      admitted,
    );
    expect(admitted).toHaveBeenCalledWith({});
    expect(scopeActivityCounts.get('global')).toBe(1);

    completed?.({ id: 11 });
    expect(scopeActivityCounts.has('global')).toBe(false);

    requestPolicy?.(
      {
        id: 12,
        webContentsId: 42,
        resourceType: 'webSocket',
        url: 'wss://example.com/socket',
      },
      vi.fn(),
    );
    expect(scopeActivityCounts.get('global')).toBe(1);
    failed?.({ id: 12 });
    expect(scopeActivityCounts.has('global')).toBe(false);
  });

  it('finalizes live and closed tabs before profile clearing can partially fail without reporting success', async () => {
    const buildFixture = (clearStorageData: () => Promise<void>, appHome = '/tmp/kai-browser-clear-data-test') => {
      const events: unknown[] = [];
      const ensureView = vi.fn();
      const store = { clear: vi.fn(), restrictBackgroundNetwork: vi.fn() };
      const vault = { clear: vi.fn() };
      const browserSession = {
        closeAllConnections: vi.fn(async () => undefined),
        clearStorageData: vi.fn(clearStorageData),
        clearCache: vi.fn(async () => undefined),
        clearAuthCache: vi.fn(async () => undefined),
      };
      electronMocks.fromPartition.mockReturnValue(browserSession);
      const tab = {
        shell: {
          id: 'tab-1',
          conversationId: 'chat-1',
          title: 'Signed-in dashboard',
          url: 'https://example.com/account',
          favicon: 'data:image/png;base64,abc',
          loading: true,
          audible: true,
          discarded: false,
          canGoBack: true,
          canGoForward: true,
          zoomLevel: 2,
          security: 'secure',
          sensitive: true,
          reloadRequired: true,
          error: 'old error' as string | undefined,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        scopeKey: 'global',
        view: { webContents: {} },
        generation: 1,
        scriptTainted: true,
        trustedUserNavigation: true,
        trustedUserNavigationTarget: 'https://example.com/account',
        trustedUserNavigationRequestId: 7,
        lastUsedAt: 0,
        queue: { whenIdle: vi.fn(async () => undefined) },
      };
      const destroyView = vi.fn((target: typeof tab) => {
        target.view = null as unknown as typeof tab.view;
      });
      const manager = managerWithoutConstructor({
        appHome,
        clearingScopes: new Set(),
        closedTabs: new Map([
          [
            'chat-1',
            [
              {
                url: 'https://example.com/reopen-me',
                title: 'Account',
                owner: 'user',
                keepOpen: false,
                sensitive: false,
                scopeKey: 'global',
              },
            ],
          ],
        ]),
        destroyView,
        emit: (event: unknown) => events.push(event),
        emitTabs: vi.fn(),
        ensureView,
        getConfig: () => ({ browser: { dataScope: 'global' } }),
        purgeCachedDownloadsForScope: vi.fn(),
        scopeActivityCounts: new Map(),
        scopeGenerations: new Map(),
        scopeIdleWaiters: new Map(),
        scopeRequestActivities: new Map(),
        storeForScope: () => store,
        tabs: new Map([['tab-1', tab]]),
        vaultForScope: () => vault,
        wireSession: vi.fn(),
      });
      return {
        browserSession,
        destroyView,
        ensureView,
        events,
        manager,
        store,
        tab,
        vault,
      };
    };

    const successful = buildFixture(async () => undefined);
    (Reflect.get(successful.manager, 'scopeRuntimeReleaseTokens') as Map<string, object>).set('global', {});
    const successfulClear = invokePrivate(successful.manager, 'clearDataLocked', {
      includeGlobal: true,
    }) as Promise<void>;
    expect((Reflect.get(successful.manager, 'scopeRuntimeReleaseTokens') as Map<string, object>).has('global')).toBe(
      false,
    );
    await successfulClear;
    expect(successful.destroyView).toHaveBeenCalledWith(successful.tab);
    expect(successful.browserSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(successful.browserSession.clearStorageData).toHaveBeenCalledOnce();
    expect(successful.store.clear).toHaveBeenCalledOnce();
    expect(successful.vault.clear).toHaveBeenCalledOnce();
    expect(successful.ensureView).not.toHaveBeenCalled();
    expect(successful.tab.shell).toMatchObject({
      title: 'New Tab',
      url: 'about:blank',
      loading: false,
      audible: false,
      discarded: true,
      canGoBack: false,
      canGoForward: false,
      zoomLevel: 0,
      sensitive: false,
      reloadRequired: false,
      error: undefined,
    });
    expect(successful.tab.scriptTainted).toBe(false);
    expect(successful.events).toContainEqual({
      type: 'tab-favicon',
      conversationId: 'chat-1',
      tabId: 'tab-1',
      favicon: null,
    });
    expect(successful.events).toContainEqual({
      type: 'profile-data-cleared',
      conversationId: 'chat-1',
      scopeKeys: ['global'],
    });

    const unreadableMarkerHome = mkdtempSync(join(tmpdir(), 'kai-browser-clear-data-unknown-marker-'));
    mkdirSync(join(unreadableMarkerHome, 'browser'), { recursive: true });
    writeFileSync(join(unreadableMarkerHome, 'browser', 'pending-profile-cleanup.json'), '{not-json');
    const discoveredRecoveryScope = 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa';
    mkdirSync(join(unreadableMarkerHome, 'browser', 'profiles'), { recursive: true });
    writeFileSync(join(unreadableMarkerHome, 'browser', 'profiles', `${discoveredRecoveryScope}.json`), '{}');
    const unreadableMarker = buildFixture(async () => undefined, unreadableMarkerHome);
    Reflect.set(unreadableMarker.manager, 'pendingCleanupQuarantineUnreadable', true);

    await expect(
      invokePrivate(unreadableMarker.manager, 'clearDataLocked', { includeGlobal: true }) as Promise<void>,
    ).rejects.toThrow(/full-profile recovery/i);
    expect(Reflect.get(unreadableMarker.manager, 'pendingCleanupQuarantineUnreadable')).toBe(true);
    expect(() => invokePrivate(unreadableMarker.manager, 'assertScopeAvailable', 'global')).toThrow(/quarantined/i);
    expect(() => listPendingBrowserCleanupScopeKeys(unreadableMarkerHome)).toThrow();

    await expect(
      invokePrivate(unreadableMarker.manager, 'clearDataLocked', {
        includeGlobal: true,
        recoverUnreadableCleanup: true,
      }) as Promise<void>,
    ).resolves.toBeUndefined();
    expect(Reflect.get(unreadableMarker.manager, 'pendingCleanupQuarantineUnreadable')).toBe(false);
    expect(() => invokePrivate(unreadableMarker.manager, 'assertScopeAvailable', 'global')).not.toThrow();
    expect(listPendingBrowserCleanupScopeKeys(unreadableMarkerHome)).toEqual([]);
    expect(unreadableMarker.browserSession.clearStorageData).toHaveBeenCalledTimes(3);
    expect(unreadableMarker.events).toContainEqual(
      expect.objectContaining({
        type: 'profile-data-cleared',
        scopeKeys: expect.arrayContaining(['global', discoveredRecoveryScope]),
      }),
    );
    rmSync(unreadableMarkerHome, { recursive: true, force: true });

    const networkFailedAppHome = '/tmp/kai-browser-clear-data-network-failed-test';
    rmSync(networkFailedAppHome, { force: true, recursive: true });
    const networkFailed = buildFixture(async () => undefined, networkFailedAppHome);
    networkFailed.browserSession.closeAllConnections.mockRejectedValueOnce(new Error('connections still active'));
    const finishTrackedRequest = vi.fn();
    const trackedRequests = new Map([['global', new Map([[99, finishTrackedRequest]])]]);
    const trackedActivity = new Map([['global', 1]]);
    const networkCleanupSession = vi.fn();
    Reflect.set(networkFailed.manager, 'scopeRequestActivities', trackedRequests);
    Reflect.set(networkFailed.manager, 'scopeActivityCounts', trackedActivity);
    Reflect.set(networkFailed.manager, 'wiredSessionCleanups', new Map([['global', networkCleanupSession]]));
    Reflect.set(networkFailed.manager, 'wiredSessionsByScope', new Map([['global', networkFailed.browserSession]]));

    await expect(
      invokePrivate(networkFailed.manager, 'clearDataLocked', { includeGlobal: true }) as Promise<void>,
    ).rejects.toThrow(/background network activity could not be stopped/);

    expect(networkFailed.browserSession.clearStorageData).not.toHaveBeenCalled();
    expect(networkFailed.browserSession.clearCache).not.toHaveBeenCalled();
    expect(networkFailed.browserSession.clearAuthCache).not.toHaveBeenCalled();
    expect(networkFailed.store.clear).toHaveBeenCalledOnce();
    expect(networkFailed.vault.clear).toHaveBeenCalledOnce();
    expect(finishTrackedRequest).not.toHaveBeenCalled();
    expect(trackedRequests.get('global')?.has(99)).toBe(true);
    expect(trackedActivity.get('global')).toBe(1);
    expect(networkCleanupSession).not.toHaveBeenCalled();
    expect(networkFailed.store.restrictBackgroundNetwork).toHaveBeenCalledOnce();
    expect((Reflect.get(networkFailed.manager, 'restrictedBackgroundScopes') as Set<string>).has('global')).toBe(true);
    expect((Reflect.get(networkFailed.manager, 'clearQuarantinedScopes') as Set<string>).has('global')).toBe(true);
    expect(() => invokePrivate(networkFailed.manager, 'assertScopeAvailable', 'global')).toThrow(/quarantined/i);
    rmSync(networkFailedAppHome, { force: true, recursive: true });

    const workerFailedAppHome = '/tmp/kai-browser-clear-data-worker-failed-test';
    rmSync(workerFailedAppHome, { force: true, recursive: true });
    const workerFailed = buildFixture(async () => undefined, workerFailedAppHome);
    const stopRunningServiceWorkers = vi.fn(async () => {
      throw new Error('worker stop failed');
    });
    Reflect.set(workerFailed.manager, 'stopRunningServiceWorkers', stopRunningServiceWorkers);

    await expect(
      invokePrivate(workerFailed.manager, 'clearDataLocked', { includeGlobal: true }) as Promise<void>,
    ).rejects.toThrow(/background network activity could not be stopped/);

    expect(stopRunningServiceWorkers).toHaveBeenCalledWith(workerFailed.browserSession, undefined, true);
    expect(workerFailed.browserSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(workerFailed.browserSession.clearStorageData).not.toHaveBeenCalled();
    expect(workerFailed.browserSession.clearCache).not.toHaveBeenCalled();
    expect(workerFailed.browserSession.clearAuthCache).not.toHaveBeenCalled();
    expect(workerFailed.store.clear).toHaveBeenCalledOnce();
    expect(workerFailed.vault.clear).toHaveBeenCalledOnce();
    expect(workerFailed.store.restrictBackgroundNetwork).toHaveBeenCalledOnce();
    expect((Reflect.get(workerFailed.manager, 'clearQuarantinedScopes') as Set<string>).has('global')).toBe(true);
    rmSync(workerFailedAppHome, { force: true, recursive: true });

    const deletedProfileRetry = buildFixture(async () => undefined);
    Reflect.set(deletedProfileRetry.manager, 'tabs', new Map());
    Reflect.set(deletedProfileRetry.manager, 'closedTabs', new Map());
    const deletedScopeKey = 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa';
    const cleanupSession = vi.fn();
    const disposeVault = vi.fn();
    Reflect.set(deletedProfileRetry.manager, 'wiredSessionCleanups', new Map([[deletedScopeKey, cleanupSession]]));
    Reflect.set(deletedProfileRetry.manager, 'wiredSessionsByScope', new Map([[deletedScopeKey, {}]]));
    Reflect.set(deletedProfileRetry.manager, 'stores', new Map([[deletedScopeKey, deletedProfileRetry.store]]));
    Reflect.set(
      deletedProfileRetry.manager,
      'vaults',
      new Map([[deletedScopeKey, { ...deletedProfileRetry.vault, dispose: disposeVault }]]),
    );
    await (invokePrivate(deletedProfileRetry.manager, 'clearDataLocked', {
      conversationId: 'current-chat',
      scopeKeys: [deletedScopeKey],
    }) as Promise<void>);
    expect(deletedProfileRetry.events).toContainEqual({
      type: 'profile-data-cleared',
      conversationId: 'current-chat',
      scopeKeys: [deletedScopeKey],
    });
    expect(cleanupSession).toHaveBeenCalledOnce();
    expect(disposeVault).toHaveBeenCalledOnce();
    expect((Reflect.get(deletedProfileRetry.manager, 'stores') as Map<string, unknown>).has(deletedScopeKey)).toBe(
      false,
    );
    expect((Reflect.get(deletedProfileRetry.manager, 'vaults') as Map<string, unknown>).has(deletedScopeKey)).toBe(
      false,
    );

    const failedAppHome = '/tmp/kai-browser-clear-data-failed-test';
    rmSync(failedAppHome, { force: true, recursive: true });
    const failed = buildFixture(async () => {
      throw new Error('storage clear failed');
    }, failedAppHome);
    failed.browserSession.clearCache.mockRejectedValueOnce(new Error('cache clear failed'));
    failed.store.clear.mockRejectedValueOnce(new Error('metadata clear failed'));
    await expect(
      invokePrivate(failed.manager, 'clearDataLocked', {
        includeGlobal: true,
      }) as Promise<void>,
    ).rejects.toThrow(/storage clear failed.*cache clear failed.*metadata clear failed/);
    expect(failed.ensureView).not.toHaveBeenCalled();
    expect(failed.browserSession.clearCache).toHaveBeenCalledOnce();
    expect(failed.browserSession.clearAuthCache).toHaveBeenCalledOnce();
    expect(failed.store.clear).toHaveBeenCalledOnce();
    expect(failed.vault.clear).toHaveBeenCalledOnce();
    expect(failed.store.restrictBackgroundNetwork).toHaveBeenCalledOnce();
    expect((Reflect.get(failed.manager, 'restrictedBackgroundScopes') as Set<string>).has('global')).toBe(true);
    expect((Reflect.get(failed.manager, 'clearQuarantinedScopes') as Set<string>).has('global')).toBe(true);
    expect(isChromiumBrowserScopeCleared(failedAppHome, 'global')).toBe(false);
    expect(listPendingBrowserCleanupScopeKeys(failedAppHome)).toContain('global');
    expect(failed.tab.shell.url).toBe('about:blank');
    expect((failed.manager as unknown as { closedTabs: Map<string, unknown[]> }).closedTabs.has('chat-1')).toBe(false);
    expect(failed.events).not.toContainEqual({
      type: 'profile-data-cleared',
      conversationId: 'chat-1',
      scopeKeys: ['global'],
    });
    rmSync(failedAppHome, { force: true, recursive: true });

    const inactiveAppHome = '/tmp/kai-browser-clear-data-inactive-failed-test';
    rmSync(inactiveAppHome, { force: true, recursive: true });
    const inactiveFailed = buildFixture(async () => {
      throw new Error('storage clear failed');
    }, inactiveAppHome);
    Reflect.set(inactiveFailed.manager, 'tabs', new Map());
    Reflect.set(inactiveFailed.manager, 'closedTabs', new Map());
    const inactiveCleanupSession = vi.fn();
    Reflect.set(inactiveFailed.manager, 'wiredSessionCleanups', new Map([['global', inactiveCleanupSession]]));
    Reflect.set(inactiveFailed.manager, 'wiredSessionsByScope', new Map([['global', inactiveFailed.browserSession]]));

    await expect(
      invokePrivate(inactiveFailed.manager, 'clearDataLocked', { includeGlobal: true }) as Promise<void>,
    ).rejects.toThrow(/storage clear failed/);

    expect(inactiveCleanupSession).not.toHaveBeenCalled();
    expect(inactiveFailed.store.restrictBackgroundNetwork).toHaveBeenCalledOnce();
    expect((Reflect.get(inactiveFailed.manager, 'restrictedBackgroundScopes') as Set<string>).has('global')).toBe(true);
    expect((Reflect.get(inactiveFailed.manager, 'clearQuarantinedScopes') as Set<string>).has('global')).toBe(true);
    rmSync(inactiveAppHome, { force: true, recursive: true });
  });

  it('destroys live plugin renderers and checks service workers before clearing their partition', async () => {
    const order: string[] = [];
    let destroyed = false;
    const pluginWindow = {
      isDestroyed: () => destroyed,
      destroy: vi.fn(() => {
        destroyed = true;
        order.push('destroy-renderer');
      }),
    };
    const stopTracking = trackPluginBrowserWindow(pluginWindow, 'persist:plugin-auth');
    const makePluginSession = (label: string) => ({
      serviceWorkers: {
        getAllRunning: vi.fn(() => {
          order.push(`inspect-workers:${label}`);
          return {};
        }),
      },
      closeAllConnections: vi.fn(async () => {
        order.push(`close-connections:${label}`);
      }),
      clearStorageData: vi.fn(async () => {
        order.push(`clear-storage:${label}`);
      }),
      clearCache: vi.fn(async () => undefined),
      clearAuthCache: vi.fn(async () => undefined),
    });
    const persistentSession = makePluginSession('persistent');
    const inMemorySession = makePluginSession('in-memory');
    electronMocks.fromPartition.mockImplementation((partition: string) =>
      partition.startsWith('persist:') ? persistentSession : inMemorySession,
    );
    const manager = managerWithoutConstructor({ emit: vi.fn(), emitTabs: vi.fn(), tabs: new Map() });

    try {
      await (invokePrivate(manager, 'clearDataLocked', {
        includePluginPartitions: ['plugin-auth'],
      }) as Promise<void>);
    } finally {
      stopTracking();
    }

    expect(pluginWindow.destroy).toHaveBeenCalledOnce();
    expect(electronMocks.fromPartition).toHaveBeenCalledWith('persist:plugin-auth');
    expect(electronMocks.fromPartition).toHaveBeenCalledWith('plugin-auth');
    for (const [label, pluginSession] of [
      ['persistent', persistentSession],
      ['in-memory', inMemorySession],
    ] as const) {
      expect(pluginSession.serviceWorkers.getAllRunning).toHaveBeenCalledOnce();
      expect(pluginSession.closeAllConnections).toHaveBeenCalledOnce();
      expect(pluginSession.clearStorageData).toHaveBeenCalledOnce();
      expect(pluginSession.clearCache).toHaveBeenCalledOnce();
      expect(pluginSession.clearAuthCache).toHaveBeenCalledOnce();
      expect(order.indexOf('destroy-renderer')).toBeLessThan(order.indexOf(`inspect-workers:${label}`));
      expect(order.indexOf(`inspect-workers:${label}`)).toBeLessThan(order.indexOf(`clear-storage:${label}`));
      expect(order.indexOf(`close-connections:${label}`)).toBeLessThan(order.indexOf(`clear-storage:${label}`));
    }
  });

  it('starts service-worker shutdown lazily for each profile in the sequential clear loop', async () => {
    const firstWorkerStop = deferred<void>();
    const makeSession = () => ({
      closeAllConnections: vi.fn(async () => undefined),
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      clearAuthCache: vi.fn(async () => undefined),
    });
    const firstSession = makeSession();
    const secondSession = makeSession();
    electronMocks.fromPartition.mockImplementation((partition: string) =>
      partition.includes('global') ? firstSession : secondSession,
    );
    const stopRunningServiceWorkers = vi.fn(async (scopedSession: unknown) => {
      if (scopedSession === firstSession) await firstWorkerStop.promise;
    });
    const store = { clear: vi.fn(), restrictBackgroundNetwork: vi.fn() };
    const vault = { clear: vi.fn() };
    const manager = managerWithoutConstructor({
      appHome: '/tmp/kai-browser-sequential-worker-clear-test',
      cancelActiveDownloadsForScopes: vi.fn(async () => undefined),
      emit: vi.fn(),
      emitTabs: vi.fn(),
      purgeCachedDownloadsForScope: vi.fn(),
      releaseScopeRuntime: vi.fn(),
      stopRunningServiceWorkers,
      storeForScope: vi.fn(() => store),
      vaultForScope: vi.fn(() => vault),
      wireSession: vi.fn(),
    });

    const clearing = invokePrivate(manager, 'clearDataLocked', {
      scopeKeys: ['global', 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa'],
    }) as Promise<void>;
    await vi.waitFor(() => expect(stopRunningServiceWorkers).toHaveBeenCalledTimes(1));
    expect(stopRunningServiceWorkers).toHaveBeenLastCalledWith(firstSession, undefined, true);
    firstWorkerStop.resolve();
    await clearing;

    expect(stopRunningServiceWorkers).toHaveBeenCalledTimes(2);
    expect(stopRunningServiceWorkers).toHaveBeenLastCalledWith(secondSession, undefined, true);
  });

  it('uses a bounded CDP scan that treats populated show-password inputs in closed roots as sensitive', async () => {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === 'DOM.performSearch' && params?.query === '*') {
        return { searchId: 'document-search', resultCount: 4 };
      }
      if (method === 'DOM.getFlattenedDocument') return { nodes: [] };
      if (method === 'DOM.performSearch') return { searchId: 'input-search', resultCount: 1 };
      if (method === 'DOM.getSearchResults') return { nodeIds: [42] };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'password-field-1' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
      return {};
    });
    let attached = false;
    const contents = {
      debugger: {
        isAttached: () => attached,
        attach: vi.fn(() => {
          attached = true;
        }),
        detach: vi.fn(() => {
          attached = false;
        }),
        sendCommand,
      },
      isDestroyed: () => false,
    };
    const manager = managerWithoutConstructor({});

    await expect(invokePrivate(manager, 'hasPopulatedPasswordFieldViaCdp', contents)).resolves.toBe(true);
    expect(sendCommand).toHaveBeenCalledWith(
      'DOM.performSearch',
      expect.objectContaining({
        query: 'input',
        includeUserAgentShadowDOM: true,
      }),
    );
    expect(sendCommand).toHaveBeenCalledWith(
      'Runtime.callFunctionOn',
      expect.objectContaining({
        functionDeclaration: expect.stringContaining("root.mode === 'closed'"),
      }),
    );
    expect(sent.some(({ params }) => Object.values(params ?? {}).includes('shadow-secret'))).toBe(false);
    expect(contents.debugger.detach).toHaveBeenCalledOnce();
  });

  it('treats an empty declarative closed shadow root as sensitive before inspecting inputs', async () => {
    const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'DOM.performSearch' && params?.query === '*') {
        return { searchId: 'document-search', resultCount: 2 };
      }
      if (method === 'DOM.getFlattenedDocument') {
        return { nodes: [{ nodeName: '#document' }, { nodeName: '#document-fragment', shadowRootType: 'closed' }] };
      }
      return {};
    });
    let attached = false;
    const contents = {
      debugger: {
        isAttached: () => attached,
        attach: vi.fn(() => {
          attached = true;
        }),
        detach: vi.fn(() => {
          attached = false;
        }),
        sendCommand,
      },
      isDestroyed: () => false,
    };
    const manager = managerWithoutConstructor({});

    await expect(invokePrivate(manager, 'hasPopulatedPasswordFieldViaCdp', contents)).resolves.toBe(true);
    expect(sendCommand).not.toHaveBeenCalledWith('DOM.performSearch', expect.objectContaining({ query: 'input' }));
    expect(contents.debugger.detach).toHaveBeenCalledOnce();
  });

  it('checks populated password fields inside a cross-origin child frame', async () => {
    const childFrame = {
      detached: false,
      frameTreeNodeId: 102,
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => true),
    };
    const mainFrame = {
      detached: false,
      frameTreeNodeId: 101,
      isDestroyed: () => false,
      framesInSubtree: [] as unknown[],
    };
    mainFrame.framesInSubtree = [mainFrame, childFrame];
    const contents = { mainFrame };
    const tab = { shell: { id: 'tab-1', conversationId: 'chat-1', sensitive: false } };
    const hasPopulatedPasswordFieldViaCdp = vi.fn(async () => false);
    const manager = managerWithoutConstructor({
      emit: vi.fn(),
      emitTabs: vi.fn(),
      evaluateWithDeadline: vi.fn(async () => false),
      hasPopulatedPasswordFieldViaCdp,
      runRendererOperationWithDeadline: vi.fn(
        async (
          _tab: unknown,
          _contents: unknown,
          _operation: string,
          _timeoutMs: number,
          task: () => Promise<boolean>,
        ) => task(),
      ),
    });

    await expect(invokePrivate(manager, 'assertTabNotSensitive', tab, contents, 'Screenshot')).rejects.toThrow(
      /password data/,
    );
    expect(childFrame.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("field.type === 'password'"));
    expect(hasPopulatedPasswordFieldViaCdp).not.toHaveBeenCalled();
    expect(tab.shell.sensitive).toBe(true);
  });

  it('scans declarative closed roots in an attached OOPIF CDP target', async () => {
    const listeners = new Set<(...args: unknown[]) => void>();
    let emittedOopif = false;
    const sendCommand = vi.fn(
      async (method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> => {
        if (method === 'Target.setAutoAttach') {
          if (params?.autoAttach === true && !sessionId && !emittedOopif) {
            emittedOopif = true;
            for (const listener of listeners) {
              listener(
                {},
                'Target.attachedToTarget',
                { sessionId: 'oopif-session', targetInfo: { type: 'iframe' } },
                '',
              );
            }
          }
          return {};
        }
        if (method === 'DOM.performSearch' && params?.query === '*') {
          return { searchId: `document-${sessionId ?? 'root'}`, resultCount: 2 };
        }
        if (method === 'DOM.getFlattenedDocument') {
          return { nodes: sessionId === 'oopif-session' ? [{ shadowRootType: 'closed' }] : [] };
        }
        if (method === 'DOM.performSearch') {
          return { searchId: `inputs-${sessionId ?? 'root'}`, resultCount: 0 };
        }
        return {};
      },
    );
    let attached = false;
    const mainFrame = {
      detached: false,
      frameTreeNodeId: 101,
      processId: 1,
      isDestroyed: () => false,
      framesInSubtree: [] as unknown[],
    };
    const childFrame = {
      detached: false,
      frameTreeNodeId: 102,
      processId: 2,
      isDestroyed: () => false,
    };
    mainFrame.framesInSubtree = [mainFrame, childFrame];
    const contents = {
      debugger: {
        isAttached: () => attached,
        attach: vi.fn(() => {
          attached = true;
        }),
        detach: vi.fn(() => {
          attached = false;
        }),
        on: vi.fn((_event: string, listener: (...args: unknown[]) => void) => listeners.add(listener)),
        off: vi.fn((_event: string, listener: (...args: unknown[]) => void) => listeners.delete(listener)),
        sendCommand,
      },
      isDestroyed: () => false,
      mainFrame,
    };
    const manager = managerWithoutConstructor({});

    await expect(invokePrivate(manager, 'hasPopulatedPasswordFieldViaCdp', contents)).resolves.toBe(true);
    expect(sendCommand).toHaveBeenCalledWith(
      'DOM.getFlattenedDocument',
      expect.objectContaining({ pierce: true }),
      'oopif-session',
    );
    expect(contents.debugger.detach).toHaveBeenCalledOnce();
  });

  it('cancels a stalled closed-shadow password scan without crashing a renderer shared by sibling tabs', async () => {
    const scanStarted = deferred<void>();
    const scan = vi.fn(() => {
      scanStarted.resolve();
      return new Promise<boolean>(() => undefined);
    });
    const forcefullyCrashRenderer = vi.fn();
    const contents = {
      debugger: {
        isAttached: () => false,
        sendCommand: vi.fn(),
      },
      forcefullyCrashRenderer,
      isDestroyed: () => false,
    };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', sensitive: false, discarded: false },
      view: { webContents: contents },
    };
    const siblingTab = {
      shell: { id: 'tab-2', conversationId: 'chat-1', sensitive: false, discarded: false },
      view: { webContents: { isDestroyed: () => false } },
    };
    const destroyView = vi.fn();
    const manager = managerWithoutConstructor({
      destroyView,
      emitTabs: vi.fn(),
      evaluateWithDeadline: vi.fn(async () => false),
      hasPopulatedPasswordFieldInChildFrames: vi.fn(async () => false),
      hasPopulatedPasswordFieldViaCdp: scan,
      tabs: new Map([
        ['tab-1', tab],
        ['tab-2', siblingTab],
      ]),
    });
    const controller = new AbortController();

    const validation = invokePrivate(
      manager,
      'assertTabNotSensitive',
      tab,
      contents,
      'Script evaluation',
      controller.signal,
    ) as Promise<void>;
    await scanStarted.promise;
    controller.abort();

    await expect(validation).rejects.toThrow(/password-field scan was cancelled/i);
    expect(forcefullyCrashRenderer).not.toHaveBeenCalled();
    expect(destroyView).toHaveBeenCalledWith(tab);
    expect(destroyView).not.toHaveBeenCalledWith(siblingTab);
    expect(siblingTab.shell.discarded).toBe(false);
    expect(tab.shell.discarded).toBe(true);
  });

  it('bounds a stalled Chromium user-origin automation overlay and stops the action', async () => {
    vi.useFakeTimers();
    try {
      const forcefullyCrashRenderer = vi.fn();
      const contents = {
        debugger: {
          isAttached: () => false,
          sendCommand: vi.fn(),
        },
        insertCSS: vi.fn(() => new Promise<never>(() => undefined)),
        removeInsertedCSS: vi.fn(async () => undefined),
        forcefullyCrashRenderer,
        isDestroyed: () => false,
      };
      const tab = {
        shell: { id: 'tab-1', conversationId: 'chat-1', discarded: false },
        view: { webContents: contents },
        overlayGeneration: 0,
        overlayTimer: null,
        overlayCssKey: null,
        overlayCssText: null,
      };
      const destroyView = vi.fn();
      const manager = managerWithoutConstructor({
        destroyView,
        emitTabs: vi.fn(),
        tabs: new Map([['tab-1', tab]]),
        withAssistantScriptPopupAttribution: (_tab: unknown, operation: () => Promise<unknown>) => operation(),
      });

      const overlay = invokePrivate(manager, 'setAutomationOverlay', tab, {
        id: 'action-1',
        tabId: 'tab-1',
        kind: 'click',
        status: 'running',
        startedAt: new Date().toISOString(),
      }) as Promise<void>;
      const rejected = expect(overlay).rejects.toThrow(/Browser automation overlay exceeded 5 seconds/);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);

      await rejected;
      expect(forcefullyCrashRenderer).not.toHaveBeenCalled();
      expect(destroyView).toHaveBeenCalledWith(tab);
      expect(tab.shell.discarded).toBe(true);
      expect(Reflect.get(tab.shell, 'error')).toBe('Browser automation overlay timed out.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders automation disclosure as page-untouchable user-origin CSS', async () => {
    const insertCSS = vi.fn(async (_css: string, _options?: { cssOrigin?: 'author' | 'user' }) => 'overlay-css-key');
    const removeInsertedCSS = vi.fn(async () => undefined);
    const contents = {
      insertCSS,
      removeInsertedCSS,
      isDestroyed: () => false,
    };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', discarded: false },
      view: { webContents: contents },
      overlayGeneration: 0,
      overlayTimer: null,
      overlayCssKey: null,
      overlayCssText: null,
    };
    const manager = managerWithoutConstructor({
      tabs: new Map([['tab-1', tab]]),
    });

    await invokePrivate(manager, 'setAutomationOverlay', tab, {
      id: 'action-1',
      tabId: 'tab-1',
      kind: 'click',
      status: 'running',
      startedAt: new Date().toISOString(),
      summary: 'clicking Sign in',
      x: 40,
      y: 60,
    });

    expect(insertCSS).toHaveBeenCalledWith(expect.stringContaining('Kai · clicking Sign in'), { cssOrigin: 'user' });
    expect(insertCSS.mock.calls[0]?.[0]).toContain('left: 40px !important');
    expect(insertCSS.mock.calls[0]?.[0]).toContain('top: 60px !important');
    expect(tab.overlayCssKey).toBe('overlay-css-key');
  });

  it('retains the prior automation overlay key when cancellation prevents CSS removal', async () => {
    const insertCSS = vi.fn(async () => 'replacement-key');
    const removeInsertedCSS = vi.fn(async () => undefined);
    const contents = {
      insertCSS,
      removeInsertedCSS,
      isDestroyed: () => false,
    };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', discarded: false },
      view: { webContents: contents },
      overlayGeneration: 4,
      overlayTimer: null,
      overlayCssKey: 'existing-key',
      overlayCssText: 'existing-css',
    };
    const manager = managerWithoutConstructor({
      tabs: new Map([['tab-1', tab]]),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      invokePrivate(
        manager,
        'setAutomationOverlay',
        tab,
        {
          id: 'action-1',
          tabId: 'tab-1',
          kind: 'click',
          status: 'running',
          startedAt: new Date().toISOString(),
        },
        controller.signal,
      ),
    ).rejects.toThrow(/automation overlay was cancelled/i);

    expect(removeInsertedCSS).not.toHaveBeenCalled();
    expect(insertCSS).not.toHaveBeenCalled();
    expect(tab.overlayCssKey).toBe('existing-key');
    expect(tab.overlayCssText).toBe('existing-css');
  });

  it('cleans up a failed visible operation without reusing its aborted action signal', async () => {
    const controller = new AbortController();
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      lastUsedAt: 0,
    };
    const setAutomationOverlay = vi.fn(async () => undefined);
    const manager = managerWithoutConstructor({
      activeTabs: new Map(),
      emit: vi.fn(),
      emitTabs: vi.fn(),
      tabs: new Map([['tab-1', tab]]),
    });
    Reflect.set(manager, 'setAutomationOverlay', setAutomationOverlay);

    await expect(
      invokePrivate(
        manager,
        'performVisibleAssistantOperation',
        'chat-1',
        tab,
        { runId: 'run-1', abortSignal: controller.signal },
        'inspect',
        'inspecting page',
        async () => {
          controller.abort();
          throw new Error('operation cancelled');
        },
      ),
    ).rejects.toThrow('operation cancelled');

    expect(setAutomationOverlay).toHaveBeenCalledWith(
      tab,
      expect.objectContaining({ status: 'failed', error: 'operation cancelled' }),
    );
    expect(setAutomationOverlay.mock.calls[0]).toHaveLength(2);
  });

  it('keeps favicon payloads out of routine tab-state broadcasts', () => {
    const emit = vi.fn();
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        title: 'Example',
        favicon: `data:image/png;base64,${'a'.repeat(10_000)}`,
      },
    };
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'tab-1']]),
      emit,
      tabOrder: new Map([['chat-1', ['tab-1']]]),
      tabs: new Map([['tab-1', tab]]),
    });

    invokePrivate(manager, 'emitTabs', 'chat-1');
    expect(emit).toHaveBeenCalledWith({
      type: 'tabs-changed',
      conversationId: 'chat-1',
      tabs: [expect.not.objectContaining({ favicon: expect.anything() })],
    });
    invokePrivate(manager, 'emitTabFavicon', tab);
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'tab-favicon',
        tabId: 'tab-1',
        favicon: expect.stringContaining('data:image'),
      }),
    );
  });

  it('replays safe pending prompts and running actions through manager state', () => {
    const shell = {
      id: 'tab-1',
      conversationId: 'chat-1',
      title: 'Example',
      url: 'https://example.com',
    };
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'tab-1']]),
      tabOrder: new Map([['chat-1', ['tab-1']]]),
      tabs: new Map([['tab-1', { shell }]]),
      pendingCredentials: new Map([
        [
          'credential-1',
          {
            tabId: 'tab-1',
            conversationId: 'chat-1',
            origin: 'https://example.com',
            username: 'alice',
            password: 'never expose this',
            update: true,
            scopeKey: 'global',
          },
        ],
      ]),
      pendingPermissions: new Map([
        [
          'permission-1',
          {
            tabId: 'tab-1',
            conversationId: 'chat-1',
            origin: 'https://example.com',
            permission: 'camera',
          },
        ],
      ]),
      pendingAuth: new Map([
        [
          'auth-1',
          {
            tabId: 'tab-1',
            conversationId: 'chat-1',
            prompt: {
              id: 'auth-1',
              tabId: 'tab-1',
              host: 'example.com',
              endpoint: 'https://example.com:443',
              authScheme: 'basic',
              isProxy: false,
              assistantTriggered: false,
            },
          },
        ],
      ]),
      runningActions: new Map([
        [
          'action-1',
          {
            conversationId: 'chat-1',
            action: {
              id: 'action-1',
              tabId: 'tab-1',
              kind: 'click',
              status: 'running',
              startedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
      ]),
    });

    const state = manager.getState('chat-1');
    expect(state).toMatchObject({
      credentialPrompts: [
        {
          id: 'credential-1',
          tabId: 'tab-1',
          origin: 'https://example.com',
          username: 'alice',
          update: true,
        },
      ],
      permissionPrompts: [expect.objectContaining({ id: 'permission-1', permission: 'camera' })],
      authPrompts: [expect.objectContaining({ id: 'auth-1', endpoint: 'https://example.com:443' })],
      runningActions: [expect.objectContaining({ id: 'action-1', status: 'running' })],
    });
    expect(JSON.stringify(state)).not.toContain('never expose this');
    expect(manager.getAttentionState()).toEqual([
      {
        conversationId: 'chat-1',
        promptIds: ['credential-1', 'permission-1', 'auth-1'],
      },
    ]);
    expect(JSON.stringify(manager.getAttentionState())).not.toContain('alice');
    expect(JSON.stringify(manager.getAttentionState())).not.toContain('example.com');
  });

  it('binds a trusted user navigation to one Chromium main-frame request chain', async () => {
    let requestPolicy:
      | ((
          details: {
            id: number;
            webContentsId?: number;
            resourceType: string;
            url: string;
          },
          callback: (result: { cancel?: boolean }) => void,
        ) => void)
      | undefined;
    electronMocks.fromPartition.mockReturnValue({ resolveHost: vi.fn() });
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', loading: true } as {
        id: string;
        conversationId: string;
        loading: boolean;
        error?: string;
      },
      trustedUserNavigation: true,
      trustedUserNavigationTarget: 'https://example.com/',
      trustedUserNavigationRequestId: null as number | null,
      trustedUserNavigationLease: 1,
      aiNetworkRestricted: true,
    };
    const manager = managerWithoutConstructor({
      clearingScopes: new Set(),
      emitTabs: vi.fn(),
      getConfig: () => ({ browser: { aiAllowPrivateNetwork: false } }),
      getWindow: () => null,
      oneTimePermissions: new Set(),
      pagePreloadPath: '/tmp/browser-page.cjs',
      pendingAuth: new Map(),
      pendingCredentials: new Map(),
      pendingPermissions: new Map(),
      scopeActivityCounts: new Map(),
      scopeGenerations: new Map([['global', 0]]),
      scopeIdleWaiters: new Map(),
      scopeRequestActivities: new Map(),
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
      wiredSessions: new WeakSet(),
    });
    const fakeSession = {
      getPreloadScripts: () => [],
      on: vi.fn(),
      registerPreloadScript: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: (_filter: unknown, listener: typeof requestPolicy) => {
          requestPolicy = listener;
        },
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
      },
    };
    invokePrivate(manager, 'wireSession', fakeSession, 'persist:kai-browser-global', 'global');

    const intended = vi.fn();
    requestPolicy?.(
      {
        id: 7,
        webContentsId: 42,
        resourceType: 'mainFrame',
        url: 'https://example.com/',
      },
      intended,
    );
    expect(intended).toHaveBeenCalledWith({});
    expect(tab.trustedUserNavigationRequestId).toBe(7);

    const raced = vi.fn();
    requestPolicy?.(
      {
        id: 9,
        webContentsId: 42,
        resourceType: 'mainFrame',
        url: 'http://127.0.0.1/admin',
      },
      raced,
    );
    await vi.waitFor(() => expect(raced).toHaveBeenCalledWith({ cancel: true }));

    const redirect = vi.fn();
    requestPolicy?.(
      {
        id: 7,
        webContentsId: 42,
        resourceType: 'mainFrame',
        url: 'http://127.0.0.1/callback',
      },
      redirect,
    );
    expect(redirect).toHaveBeenCalledWith({});
  });

  it('cancels stalled DNS validation with the assistant run signal', async () => {
    electronMocks.fromPartition.mockReturnValue({
      resolveHost: () => new Promise(() => undefined),
    });
    const manager = managerWithoutConstructor({
      getConfig: () => ({ browser: { aiAllowPrivateNetwork: false } }),
    });
    const controller = new AbortController();

    const validation = invokePrivate(
      manager,
      'assertAssistantNavigationAllowed',
      'https://example.com',
      'persist:kai-browser-global',
      controller.signal,
    ) as Promise<void>;
    controller.abort();

    await expect(validation).rejects.toThrow(/cancelled/);
  });

  it('bounds stalled DNS validation even without an assistant abort signal', async () => {
    vi.useFakeTimers();
    try {
      electronMocks.fromPartition.mockReturnValue({
        resolveHost: () => new Promise(() => undefined),
      });
      const manager = managerWithoutConstructor({
        getConfig: () => ({ browser: { aiAllowPrivateNetwork: false } }),
      });
      const validation = invokePrivate(
        manager,
        'assertAssistantNavigationAllowed',
        'https://example.com',
        'persist:kai-browser-global',
      ) as Promise<void>;
      const rejection = expect(validation).rejects.toThrow(/DNS resolution exceeded 10 seconds/);

      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates assistant authorization when user navigation wins a deferred DNS race', async () => {
    const dnsValidation = deferred<void>();
    const assertAssistantNavigationAllowed = vi.fn(() => dnsValidation.promise);
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://public.example',
      },
      partition: 'persist:kai-browser-global',
      generation: 1,
      trustedUserNavigation: false,
      trustedUserNavigationTarget: null,
      trustedUserNavigationRequestId: null,
      trustedUserNavigationLease: 0,
      aiNetworkRestricted: false,
      aiControlOwnerId: null as string | null,
      aiControlGeneration: null as number | null,
    };
    const manager = managerWithoutConstructor({
      tabs: new Map([[tab.shell.id, tab]]),
      getConfig: () => ({ browser: { enabled: true } }),
      assistantGeneration: vi.fn(() => 7),
      assertAssistantNavigationAllowed,
    });

    const authorization = invokePrivate(manager, 'guardAssistantTab', tab, { id: 'run-1' }, 7) as Promise<unknown>;
    await vi.waitFor(() =>
      expect(assertAssistantNavigationAllowed).toHaveBeenCalledWith(
        'https://public.example',
        'persist:kai-browser-global',
        undefined,
      ),
    );

    tab.generation = 2;
    tab.trustedUserNavigationLease = 1;
    tab.shell.url = 'http://127.0.0.1/private';
    dnsValidation.resolve();

    await expect(authorization).rejects.toThrow(/page navigated while this assistant operation was waiting/i);
    expect(tab.aiNetworkRestricted).toBe(false);
    expect(tab.aiControlOwnerId).toBeNull();
    expect(tab.aiControlGeneration).toBeNull();
  });

  it('clears non-cookie origin state and recreates under AI restrictions after an unrestricted private resource', async () => {
    const contents = { isDestroyed: () => false };
    const recreatedContents = { isDestroyed: () => false };
    const view = { webContents: contents };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://public.example/page',
        sensitive: false,
      },
      view,
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      generation: 1,
      trustedUserNavigation: false,
      trustedUserNavigationTarget: null,
      trustedUserNavigationRequestId: null,
      trustedUserNavigationLease: 0,
      aiNetworkRestricted: false,
      aiControlOwnerId: null as string | null,
      aiControlGeneration: null as number | null,
      aiActionDepth: 0,
      queue: { whenIdle: vi.fn(async () => undefined) },
      unrestrictedNetworkGeneration: 1,
      unrestrictedNetworkValidations: new Map<string, Promise<void>>(),
      unrestrictedNetworkUnsafe: false,
    };
    const assertAssistantNavigationAllowed = vi.fn(async (url: string) => {
      if (url.includes('127.0.0.1')) throw new Error('private network');
    });
    const scopedSession = {
      clearStorageData: vi.fn(async (_options?: Electron.ClearStorageDataOptions) => undefined),
      closeAllConnections: vi.fn(async () => undefined),
    };
    electronMocks.fromPartition.mockReturnValue(scopedSession);
    const destroyView = vi.fn(() => {
      tab.view = null as unknown as typeof view;
    });
    const ensureView = vi.fn(async () => {
      expect(tab.aiNetworkRestricted).toBe(true);
      tab.generation++;
      const recreatedView = { webContents: recreatedContents };
      tab.view = recreatedView as typeof view;
      return recreatedView;
    });
    const stopRunningServiceWorkers = vi.fn(async () => undefined);
    const unsafeOrigins = new Set<string>();
    const store = {
      markUnsafeOrigin: vi.fn((origin: string) => unsafeOrigins.add(origin)),
      isUnsafeOrigin: vi.fn((origin: string) => unsafeOrigins.has(origin)),
      clearUnsafeOrigin: vi.fn((origin: string) => unsafeOrigins.delete(origin)),
    };
    const manager = managerWithoutConstructor({
      assertAssistantNavigationAllowed,
      assistantGeneration: vi.fn(() => 7),
      destroyView,
      emitTabs: vi.fn(),
      ensureView,
      getConfig: () => ({ browser: { enabled: true } }),
      markAssistantControlledOrigin: vi.fn(),
      restrictBackgroundNetworkForScope: vi.fn(),
      storeForScope: vi.fn(() => store),
      stopRunningServiceWorkers,
      tabs: new Map([[tab.shell.id, tab]]),
    });

    invokePrivate(manager, 'trackUnrestrictedDocumentRequest', tab, 'http://127.0.0.1/private-frame', tab.partition);
    await Promise.all(tab.unrestrictedNetworkValidations.values());
    expect(tab.unrestrictedNetworkUnsafe).toBe(true);
    expect(store.markUnsafeOrigin).toHaveBeenCalledWith('https://public.example');

    // Renderer teardown/reload resets only generation-local validation. The
    // profile marker must still force sanitation before later assistant access.
    invokePrivate(manager, 'resetUnrestrictedDocumentNetworkState', tab);
    expect(tab.unrestrictedNetworkUnsafe).toBe(false);

    const lease = await invokePrivate(manager, 'guardAssistantTab', tab, { id: 'run-1' }, 7);

    expect(destroyView).toHaveBeenCalledWith(tab);
    expect(stopRunningServiceWorkers).toHaveBeenCalledWith(scopedSession, undefined, true);
    expect(scopedSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(scopedSession.clearStorageData).toHaveBeenCalledWith({
      origin: 'https://public.example',
      storages: ['filesystem', 'indexdb', 'localstorage', 'websql', 'serviceworkers', 'cachestorage'],
    });
    expect(scopedSession.clearStorageData.mock.calls[0]?.[0]?.storages).not.toContain('cookies');
    expect(ensureView).toHaveBeenCalledWith(tab, undefined, 30_000);
    expect(lease).toMatchObject({
      runId: 'run-1',
      runGeneration: 7,
      tabGeneration: 3,
      url: 'https://public.example/page',
    });
    expect(tab.unrestrictedNetworkUnsafe).toBe(false);
    expect(tab.unrestrictedNetworkValidations).toHaveLength(0);
    expect(store.clearUnsafeOrigin).toHaveBeenCalledWith('https://public.example');
    expect(unsafeOrigins.size).toBe(0);
  });

  it('retains the unsafe-origin latch when non-cookie storage clearing fails', async () => {
    const contents = { isDestroyed: () => false };
    const view = { webContents: contents };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://public.example/page',
        sensitive: false,
      },
      view,
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      generation: 1,
      trustedUserNavigation: false,
      trustedUserNavigationTarget: null,
      trustedUserNavigationRequestId: null,
      trustedUserNavigationLease: 0,
      aiNetworkRestricted: false,
      aiControlOwnerId: null as string | null,
      aiControlGeneration: null as number | null,
      aiActionDepth: 0,
      queue: { whenIdle: vi.fn(async () => undefined) },
      unrestrictedNetworkGeneration: 1,
      unrestrictedNetworkValidations: new Map<string, Promise<void>>(),
      unrestrictedNetworkUnsafe: true,
    };
    electronMocks.fromPartition.mockReturnValue({
      clearStorageData: vi.fn(async () => {
        throw new Error('origin storage busy');
      }),
      closeAllConnections: vi.fn(async () => undefined),
    });
    const store = {
      isUnsafeOrigin: vi.fn(() => true),
      clearUnsafeOrigin: vi.fn(),
    };
    const manager = managerWithoutConstructor({
      assertAssistantNavigationAllowed: vi.fn(async () => undefined),
      assistantGeneration: vi.fn(() => 7),
      destroyView: vi.fn(() => {
        tab.view = null as unknown as typeof view;
      }),
      emitTabs: vi.fn(),
      getConfig: () => ({ browser: { enabled: true } }),
      markAssistantControlledOrigin: vi.fn(),
      restrictBackgroundNetworkForScope: vi.fn(),
      storeForScope: vi.fn(() => store),
      stopRunningServiceWorkers: vi.fn(async () => undefined),
      tabs: new Map([[tab.shell.id, tab]]),
    });

    await expect(invokePrivate(manager, 'guardAssistantTab', tab, { id: 'run-1' }, 7)).rejects.toThrow(
      /origin storage busy/,
    );
    expect(tab.unrestrictedNetworkGeneration).toBe(tab.generation);
    expect(tab.unrestrictedNetworkUnsafe).toBe(true);
    expect(tab.aiNetworkRestricted).toBe(false);
    expect(Reflect.get(manager, 'clearingOrigins')).toHaveLength(0);
    expect(store.clearUnsafeOrigin).not.toHaveBeenCalled();
  });

  it('does not destroy password-sensitive state to sanitize an unrestricted document', async () => {
    const contents = { isDestroyed: () => false };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://public.example/login',
        sensitive: true,
      },
      view: { webContents: contents },
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      generation: 1,
      trustedUserNavigation: false,
      trustedUserNavigationTarget: null,
      trustedUserNavigationRequestId: null,
      trustedUserNavigationLease: 0,
      aiNetworkRestricted: false,
      aiControlOwnerId: null as string | null,
      aiControlGeneration: null as number | null,
      unrestrictedNetworkGeneration: 1,
      unrestrictedNetworkValidations: new Map([['http://127.0.0.1', Promise.resolve()]]),
      unrestrictedNetworkUnsafe: true,
    };
    const reloadAssistantTab = vi.fn();
    const store = { isUnsafeOrigin: vi.fn(() => true) };
    const manager = managerWithoutConstructor({
      assertAssistantNavigationAllowed: vi.fn(async () => undefined),
      assistantGeneration: vi.fn(() => 7),
      getConfig: () => ({ browser: { enabled: true } }),
      reloadAssistantTab,
      storeForScope: vi.fn(() => store),
      tabs: new Map([[tab.shell.id, tab]]),
    });

    await expect(invokePrivate(manager, 'guardAssistantTab', tab, { id: 'run-1' }, 7)).rejects.toThrow(
      /combined password data with resources/i,
    );
    expect(reloadAssistantTab).not.toHaveBeenCalled();
    expect(tab.aiNetworkRestricted).toBe(false);
    expect(tab.aiControlOwnerId).toBeNull();
  });

  it('does not leave a trusted-navigation bypass after unavailable history or a failed user load', async () => {
    const contents = {
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
      },
      loadURL: vi.fn(async () => {
        throw new Error('navigation failed');
      }),
    };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      scopeKey: 'global',
      trustedUserNavigation: false,
      trustedUserNavigationTarget: null,
      trustedUserNavigationRequestId: null,
      trustedUserNavigationLease: 0,
      aiActionDepth: 0,
      aiActionUntil: 0,
      scriptTainted: false,
      aiNetworkRestricted: true,
      aiControlOwnerId: 'run-1',
      aiControlGeneration: 1,
    };
    const manager = managerWithoutConstructor({
      emitTabs: vi.fn(),
      ensureView: vi.fn(async () => ({ webContents: contents })),
      getConfig: () => ({ browser: { searchProvider: 'duckduckgo' } }),
      tabs: new Map([['tab-1', tab]]),
      withScopeActivity: (_scopeKey: string, operation: () => Promise<unknown>) => operation(),
    });

    await invokePrivate(manager, 'commandTabWithinOperation', tab, 'back', 'user');
    expect(tab.trustedUserNavigation).toBe(false);
    expect(tab.aiNetworkRestricted).toBe(true);
    await invokePrivate(manager, 'commandTabWithinOperation', tab, 'forward', 'user');
    expect(tab.trustedUserNavigation).toBe(false);
    expect(tab.aiNetworkRestricted).toBe(true);
    await expect(manager.navigate('chat-1', 'tab-1', 'https://example.com')).rejects.toThrow(/navigation failed/);
    expect(tab.trustedUserNavigation).toBe(false);
    expect(tab.aiNetworkRestricted).toBe(true);
  });

  it('does not let an older user load clear a newer trusted-navigation lease', async () => {
    const firstLoad = deferred<void>();
    const secondLoad = deferred<void>();
    const loadURL = vi.fn((url: string) => (url === 'https://first.example' ? firstLoad.promise : secondLoad.promise));
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      scopeKey: 'global',
      trustedUserNavigation: false,
      trustedUserNavigationTarget: null as string | null,
      trustedUserNavigationRequestId: null as number | null,
      trustedUserNavigationLease: 0,
      aiActionDepth: 0,
      aiActionUntil: 0,
      aiNetworkReleaseRequested: false,
      aiNetworkReleaseTimer: null,
      scriptTainted: false,
      aiNetworkRestricted: true,
      aiControlOwnerId: 'run-1' as string | null,
      aiControlGeneration: 1 as number | null,
    };
    const manager = managerWithoutConstructor({
      ensureView: vi.fn(async () => ({ webContents: { loadURL } })),
      getConfig: () => ({ browser: { searchProvider: 'duckduckgo' } }),
      tabs: new Map([['tab-1', tab]]),
      withScopeActivity: (_scopeKey: string, operation: () => Promise<unknown>) => operation(),
    });

    const firstNavigation = manager.navigate('chat-1', 'tab-1', 'https://first.example');
    await vi.waitFor(() => expect(loadURL).toHaveBeenCalledWith('https://first.example'));
    const secondNavigation = manager.navigate('chat-1', 'tab-1', 'https://second.example');
    await vi.waitFor(() => expect(loadURL).toHaveBeenCalledWith('https://second.example'));
    expect(tab.trustedUserNavigationTarget).toBe('https://second.example');

    firstLoad.resolve();
    await firstNavigation;
    expect(tab.trustedUserNavigation).toBe(true);
    expect(tab.trustedUserNavigationTarget).toBe('https://second.example');
    expect(tab.trustedUserNavigationLease).toBe(2);

    secondLoad.resolve();
    await secondNavigation;
    expect(tab.trustedUserNavigation).toBe(false);
    expect(tab.trustedUserNavigationTarget).toBeNull();
  });

  it('routes assistant navigation through the bounded page-load deadline', async () => {
    const loadURL = vi.fn(async () => undefined);
    const runRendererOperationWithDeadline = vi.fn(
      async (_tab: unknown, _contents: unknown, _operation: string, _timeout: number, task: () => Promise<unknown>) =>
        task(),
    );
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        owner: 'user',
        keepOpen: false,
        url: 'https://current.example',
      },
      scopeKey: 'global',
      partition: 'persist:kai-browser-global',
      aiNetworkRestricted: false,
      aiControlOwnerId: null,
      aiControlGeneration: null,
    };
    const manager = managerWithoutConstructor({
      tabs: new Map([['tab-1', tab]]),
      activeTabs: new Map([['chat-1', 'tab-1']]),
      getConfig: () => ({ browser: { searchProvider: 'duckduckgo' } }),
      ensureAssistantView: vi.fn(async () => ({ webContents: { loadURL } })),
      assertAssistantDocumentLease: vi.fn(),
      assertAssistantNavigationAllowed: vi.fn(async () => undefined),
      assistantGeneration: vi.fn(() => 1),
      runRendererOperationWithDeadline,
      withAssistantControl: (
        _tab: unknown,
        _run: unknown,
        operation: (lease: Record<string, unknown>) => Promise<unknown>,
      ) =>
        operation({
          runGeneration: 1,
          tabGeneration: 0,
          userNavigationLease: 0,
          url: 'https://current.example',
        }),
      withScopeActivity: (_scopeKey: string, operation: () => Promise<unknown>) => operation(),
      clearTrustedUserNavigation: vi.fn(),
    });

    await manager.navigate('chat-1', 'tab-1', 'https://example.com', 'assistant', { id: 'run-1' });

    expect(runRendererOperationWithDeadline).toHaveBeenCalledWith(
      tab,
      { loadURL },
      'Browser page load',
      30_000,
      expect.any(Function),
      undefined,
    );
    expect(loadURL).toHaveBeenCalledWith('https://example.com');
  });

  it('keeps assistant reload serialized until the replacement document stops loading', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const reload = vi.fn();
    const contents = {
      getURL: () => 'https://example.com/reloaded',
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      reload,
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        if (listeners.get(event) === listener) listeners.delete(event);
      },
    };
    const runRendererOperationWithDeadline = vi.fn(
      async (_tab: unknown, _contents: unknown, _operation: string, _timeout: number, task: () => Promise<unknown>) =>
        task(),
    );
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      scopeKey: 'global',
      partition: 'persist:kai-browser-global',
    };
    const assertAssistantNavigationAllowed = vi.fn(async () => undefined);
    const markAssistantControlledOrigin = vi.fn();
    const manager = managerWithoutConstructor({
      tabs: new Map([['tab-1', tab]]),
      emitTabs: vi.fn(),
      ensureAssistantView: vi.fn(async () => ({ webContents: contents })),
      runRendererOperationWithDeadline,
      assertAssistantNavigationAllowed,
      markAssistantControlledOrigin,
    });

    const reloading = invokePrivate(
      manager,
      'commandTabWithinOperation',
      tab,
      'reload',
      'assistant',
      { id: 'run-1' },
      {
        runGeneration: 1,
        tabGeneration: 1,
        userNavigationLease: 0,
        url: 'https://example.com',
      },
    ) as Promise<void>;
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());

    let completed = false;
    void reloading.then(() => {
      completed = true;
    });
    listeners.get('did-stop-loading')?.();
    await Promise.resolve();
    expect(completed).toBe(false);

    listeners.get('did-start-navigation')?.({}, 'https://example.com/reloaded', false, true);
    listeners.get('did-stop-loading')?.();
    await expect(reloading).resolves.toBeUndefined();

    expect(runRendererOperationWithDeadline).toHaveBeenCalledWith(
      tab,
      contents,
      'Browser page reload',
      30_000,
      expect.any(Function),
      undefined,
    );
    expect(assertAssistantNavigationAllowed).toHaveBeenCalledWith(
      'https://example.com/reloaded',
      'persist:kai-browser-global',
      undefined,
    );
    expect(markAssistantControlledOrigin).toHaveBeenCalledWith('global', 'https://example.com/reloaded');
    expect(listeners).toHaveLength(0);
  });

  it('ignores subframe in-page navigation and records main-frame SPA navigation safely', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    let currentUrl = 'https://example.com/app';
    const contents = {
      getTitle: () => 'Example app',
      getURL: () => currentUrl,
      isCurrentlyAudible: () => false,
      isDestroyed: () => false,
      navigationHistory: {
        canGoBack: () => true,
        canGoForward: () => false,
        clear: vi.fn(),
      },
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      setWindowOpenHandler: vi.fn(),
    };
    const addHistory = vi.fn();
    const emitTabs = vi.fn();
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: currentUrl,
        title: 'Example app',
        security: 'secure',
        sensitive: false,
        reloadRequired: true,
      },
      scopeKey: 'global',
      trustedUserNavigation: true,
      trustedUserNavigationTarget: 'https://example.com/app#next',
      trustedUserNavigationRequestId: 42,
      trustedUserNavigationLease: 1,
      aiNetworkRestricted: true,
      aiControlOwnerId: 'run-1',
      aiControlGeneration: 1,
      aiActionDepth: 0,
      aiActionUntil: 0,
      scriptTainted: true,
      view: { webContents: contents },
    };
    const manager = managerWithoutConstructor({
      clearingScopes: new Set(),
      emitTabs,
      stores: new Map([['global', { addHistory }]]),
    });

    invokePrivate(manager, 'wireWebContents', tab, contents);
    listeners.get('did-navigate-in-page')?.({}, 'https://frame.example/#next', false);

    expect(tab.trustedUserNavigation).toBe(true);
    expect(tab.aiNetworkRestricted).toBe(true);
    expect(addHistory).not.toHaveBeenCalled();

    listeners.get('did-navigate-in-page')?.({}, 'https://example.com/app#stale', true);
    expect(tab.trustedUserNavigation).toBe(true);
    expect(tab.trustedUserNavigationTarget).toBe('https://example.com/app#next');

    currentUrl = 'https://example.com/app#next';
    listeners.get('did-navigate-in-page')?.({}, currentUrl, true);

    expect(tab.trustedUserNavigation).toBe(false);
    expect(tab.trustedUserNavigationTarget).toBeNull();
    expect(tab.trustedUserNavigationRequestId).toBeNull();
    expect(tab.aiNetworkRestricted).toBe(true);
    expect(tab.scriptTainted).toBe(true);
    expect(tab.shell.reloadRequired).toBe(true);
    expect(tab.shell.url).toBe(currentUrl);
    expect(addHistory).toHaveBeenCalledWith('Example app', currentUrl);

    listeners.get('did-navigate')?.({}, currentUrl);
    expect(contents.navigationHistory.clear).toHaveBeenCalledOnce();
    expect(tab.scriptTainted).toBe(false);
    expect(tab.shell.reloadRequired).toBe(false);
  });

  it('keeps a scripted page quarantined when its BFCache history cannot be evicted', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const contents = {
      getTitle: () => 'Replacement',
      getURL: () => 'https://example.com/replacement',
      isCurrentlyAudible: () => false,
      isDestroyed: () => false,
      navigationHistory: {
        canGoBack: () => true,
        canGoForward: () => false,
        clear: vi.fn(() => {
          throw new Error('history busy');
        }),
      },
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      setWindowOpenHandler: vi.fn(),
    };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://example.com/scripted',
        title: 'Scripted',
        security: 'secure',
        sensitive: false,
        reloadRequired: true,
        error: undefined as string | undefined,
      },
      scopeKey: 'global',
      scriptTainted: true,
      trustedUserNavigation: false,
      trustedUserNavigationTarget: null,
      trustedUserNavigationRequestId: null,
      trustedUserNavigationLease: 0,
      aiActionDepth: 0,
      aiActionUntil: 0,
      aiNetworkReleaseRequested: false,
      aiNetworkReleaseTimer: null,
      view: { webContents: contents },
    };
    const manager = managerWithoutConstructor({
      clearingScopes: new Set(),
      emitTabs: vi.fn(),
      stores: new Map([['global', { addHistory: vi.fn() }]]),
    });

    invokePrivate(manager, 'wireWebContents', tab, contents);
    listeners.get('did-navigate')?.({}, 'https://example.com/replacement');

    expect(tab.scriptTainted).toBe(true);
    expect(tab.shell.reloadRequired).toBe(true);
    expect(tab.shell.error).toMatch(/history busy/);
  });

  it('contains history persistence failures raised from Electron navigation events', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const contents = {
      getTitle: () => 'Example app',
      getURL: () => 'https://example.com/app',
      isCurrentlyAudible: () => false,
      isDestroyed: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      setWindowOpenHandler: vi.fn(),
    };
    const emitTabs = vi.fn();
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://example.com/app',
        title: 'Example app',
      } as {
        id: string;
        conversationId: string;
        url: string;
        title: string;
        error?: string;
      },
      scopeKey: 'global',
      trustedUserNavigation: false,
      view: { webContents: contents },
    };
    const manager = managerWithoutConstructor({
      clearingScopes: new Set(),
      emitTabs,
      stores: new Map([
        [
          'global',
          {
            addHistory: () => {
              throw new Error('profile is read-only');
            },
          },
        ],
      ]),
    });

    invokePrivate(manager, 'wireWebContents', tab, contents);

    expect(() => listeners.get('did-stop-loading')?.()).not.toThrow();
    expect(tab.shell.error).toMatch(/history could not be saved.*profile is read-only/i);
    expect(emitTabs).toHaveBeenCalled();
  });

  it('surfaces rejected native shortcut commands instead of leaving an unhandled promise', async () => {
    const applyShortcut = vi.fn(async () => {
      throw new Error('shortcut failed');
    });
    const emitTabs = vi.fn();
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', sensitive: false } as {
        id: string;
        conversationId: string;
        sensitive: boolean;
        error?: string;
      },
      aiActionDepth: 0,
    };
    const manager = managerWithoutConstructor({
      applyShortcut,
      emitTabs,
      tabs: new Map([['tab-1', tab]]),
    });
    const event = { preventDefault: vi.fn() };

    invokePrivate(manager, 'handlePageShortcut', tab, { id: 42 }, event, {
      type: 'keyDown',
      key: '[',
      ...(process.platform === 'darwin' ? { meta: true } : { control: true }),
    });

    await vi.waitFor(() => expect(tab.shell.error).toBe('shortcut failed'));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(applyShortcut).toHaveBeenCalledWith('chat-1', 'tab-1', 'back', undefined, true);
    expect(emitTabs).toHaveBeenCalledWith('chat-1');
  });

  it('focuses the omnibox after a native-page new-tab shortcut', async () => {
    const createTab = vi.fn(async () => undefined);
    const emit = vi.fn();
    const setChromeFocus = vi.fn();
    const manager = managerWithoutConstructor({
      createTab,
      emit,
      setChromeFocus,
    });

    await invokePrivate(manager, 'applyShortcut', 'chat-1', 'tab-1', 'new-tab');

    expect(createTab).toHaveBeenCalledWith({
      conversationId: 'chat-1',
      owner: 'user',
    });
    expect(setChromeFocus).toHaveBeenCalledWith('chat-1', true);
    expect(setChromeFocus.mock.invocationCallOrder[0]).toBeLessThan(createTab.mock.invocationCallOrder[0]);
    expect(emit).toHaveBeenCalledWith({
      type: 'shortcut',
      conversationId: 'chat-1',
      action: 'focus-url',
    });
  });

  it.each(['close-tab', 'reopen-tab'] as const)(
    'focuses the replacement native page after a native-page %s shortcut',
    async (action) => {
      const focusActiveViewAfterNativeShortcut = vi.fn(async () => undefined);
      const manager = managerWithoutConstructor({
        commandTab: vi.fn(async () => undefined),
        focusActiveViewAfterNativeShortcut,
        reopenClosedTab: vi.fn(async () => ({ id: 'reopened' })),
      });

      await invokePrivate(manager, 'applyShortcut', 'chat-1', 'tab-1', action, undefined, true);

      expect(focusActiveViewAfterNativeShortcut).toHaveBeenCalledWith('chat-1');
    },
  );

  it('blocks platform clipboard accelerators while a page contains password data', () => {
    const applyShortcut = vi.fn();
    const dispatchClipboardCommand = vi.fn(() => true);
    const manager = managerWithoutConstructor({ applyShortcut, dispatchClipboardCommand });
    const contents = { id: 42 };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', sensitive: true },
      aiActionDepth: 0,
    };
    const event = { preventDefault: vi.fn() };

    invokePrivate(manager, 'handlePageShortcut', tab, contents, event, {
      type: 'keyDown',
      key: 'c',
      meta: true,
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(dispatchClipboardCommand).toHaveBeenCalledWith(contents, 'copy');
    expect(applyShortcut).not.toHaveBeenCalled();
  });

  it('dispatches managed clipboard shortcuts only on key down', () => {
    const dispatchClipboardCommand = vi.fn(() => true);
    const manager = managerWithoutConstructor({ dispatchClipboardCommand });
    const contents = { id: 42 };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', sensitive: false },
      aiActionDepth: 0,
    };
    const keyUpEvent = { preventDefault: vi.fn() };
    const keyDownEvent = { preventDefault: vi.fn() };

    invokePrivate(manager, 'handlePageShortcut', tab, contents, keyUpEvent, {
      type: 'keyUp',
      key: 'v',
      meta: true,
    });
    invokePrivate(manager, 'handlePageShortcut', tab, contents, keyDownEvent, {
      type: 'keyDown',
      key: 'v',
      meta: true,
    });

    expect(keyUpEvent.preventDefault).not.toHaveBeenCalled();
    expect(keyDownEvent.preventDefault).toHaveBeenCalledOnce();
    expect(dispatchClipboardCommand).toHaveBeenCalledOnce();
    expect(dispatchClipboardCommand).toHaveBeenCalledWith(contents, 'paste');
  });

  it('serializes managed clipboard commands behind a full sensitivity scan', async () => {
    const scan = deferred<void>();
    const focusedFrame = {
      detached: false,
      executeJavaScript: vi.fn(async () => 'stable-focus'),
      frameToken: 'frame-1',
      isDestroyed: () => false,
      processId: 1,
      routingId: 2,
    };
    const contents = { id: 42, isDestroyed: () => false, copy: vi.fn(), focusedFrame };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', sensitive: false },
      view: { webContents: contents },
    };
    const lease = { tabId: 'tab-1' };
    const assertBrowserPageLease = vi.fn();
    const manager = managerWithoutConstructor({
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
      captureBrowserPageLease: vi.fn(() => lease),
      assertBrowserPageLease,
      assertTabNotSensitive: vi.fn(() => scan.promise),
      runTabOperation: (_tab: unknown, operation: () => Promise<void>) => operation(),
      emitTabs: vi.fn(),
    });

    expect(manager.dispatchClipboardCommand(contents as never, 'copy')).toBe(true);
    expect(contents.copy).not.toHaveBeenCalled();
    scan.resolve();
    await vi.waitFor(() => expect(contents.copy).toHaveBeenCalledOnce());
    expect(assertBrowserPageLease).toHaveBeenCalledTimes(2);

    (Reflect.get(manager, 'tabs') as Map<string, unknown>).delete('tab-1');
    expect(manager.dispatchClipboardCommand(contents as never, 'copy')).toBe(true);
    expect(manager.dispatchClipboardCommand({ id: 99 } as never, 'copy')).toBe(false);
  });

  it('cancels a delayed clipboard command when focus moves to another frame', async () => {
    const scan = deferred<void>();
    const firstFrame = {
      detached: false,
      executeJavaScript: vi.fn(async () => 'stable-focus'),
      frameToken: 'frame-1',
      isDestroyed: () => false,
      processId: 1,
      routingId: 2,
    };
    const secondFrame = {
      ...firstFrame,
      executeJavaScript: vi.fn(async () => 'other-focus'),
      frameToken: 'frame-2',
      routingId: 3,
    };
    let focusedFrame = firstFrame;
    const contents = {
      id: 42,
      isDestroyed: () => false,
      copy: vi.fn(),
      get focusedFrame() {
        return focusedFrame;
      },
    };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', sensitive: false, error: undefined as string | undefined },
      view: { webContents: contents },
    };
    const assertTabNotSensitive = vi.fn(() => scan.promise);
    const manager = managerWithoutConstructor({
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
      captureBrowserPageLease: vi.fn(() => ({ tabId: 'tab-1' })),
      assertBrowserPageLease: vi.fn(),
      assertTabNotSensitive,
      runTabOperation: (_tab: unknown, operation: () => Promise<void>) => operation(),
      emitTabs: vi.fn(),
    });

    expect(manager.dispatchClipboardCommand(contents as never, 'copy')).toBe(true);
    await vi.waitFor(() => expect(assertTabNotSensitive).toHaveBeenCalledOnce());
    focusedFrame = secondFrame;
    scan.resolve();

    await vi.waitFor(() => expect(tab.shell.error).toMatch(/focused field or selection changed/i));
    expect(contents.copy).not.toHaveBeenCalled();
  });

  it('cancels a delayed clipboard command when the same frame selection changes', async () => {
    const focusedFrame = {
      detached: false,
      executeJavaScript: vi.fn().mockResolvedValueOnce('selection-before').mockResolvedValueOnce('selection-after'),
      frameToken: 'frame-1',
      isDestroyed: () => false,
      processId: 1,
      routingId: 2,
    };
    const contents = { id: 42, isDestroyed: () => false, copy: vi.fn(), focusedFrame };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', sensitive: false, error: undefined as string | undefined },
      view: { webContents: contents },
    };
    const manager = managerWithoutConstructor({
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
      captureBrowserPageLease: vi.fn(() => ({ tabId: 'tab-1' })),
      assertBrowserPageLease: vi.fn(),
      assertTabNotSensitive: vi.fn(async () => undefined),
      runTabOperation: (_tab: unknown, operation: () => Promise<void>) => operation(),
      emitTabs: vi.fn(),
    });

    expect(manager.dispatchClipboardCommand(contents as never, 'copy')).toBe(true);

    await vi.waitFor(() => expect(tab.shell.error).toMatch(/focused field or selection changed/i));
    expect(contents.copy).not.toHaveBeenCalled();
  });

  it('guards context-menu image copies with the full sensitivity scan', async () => {
    const scan = deferred<void>();
    const copyImageAt = vi.fn();
    const contents = {
      id: 42,
      isDestroyed: () => false,
      copyImageAt,
      getURL: () => 'https://example.com',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        title: 'Example',
        sensitive: false,
      },
      view: { webContents: contents },
    };
    const assertBrowserPageLease = vi.fn();
    const manager = managerWithoutConstructor({
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
      captureBrowserPageLease: vi.fn(() => ({
        tabId: 'tab-1',
        tabGeneration: 1,
        userNavigationLease: 0,
        contents,
      })),
      assertBrowserPageLease,
      assertTabNotSensitive: vi.fn(() => scan.promise),
      runTabOperation: (_tab: unknown, operation: () => Promise<void>) => operation(),
      emitTabs: vi.fn(),
    });

    const menu = invokePrivate(manager, 'buildContextMenu', tab, contents, {
      mediaType: 'image',
      srcURL: 'https://example.com/image.png',
      x: 12,
      y: 24,
    }) as {
      items: Array<{ label?: string; click?: () => void }>;
    };
    menu.items.find((item) => item.label === 'Copy Image')?.click?.();

    expect(copyImageAt).not.toHaveBeenCalled();
    scan.resolve();
    await vi.waitFor(() => expect(copyImageAt).toHaveBeenCalledWith(12, 24));
    expect(assertBrowserPageLease).toHaveBeenCalledTimes(2);
  });

  it('guards context-menu image downloads with the full sensitivity scan', async () => {
    const downloadURL = vi.fn();
    const contents = {
      id: 42,
      isDestroyed: () => false,
      downloadURL,
      getURL: () => 'https://example.com/login',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        title: 'Login',
        sensitive: false,
        error: undefined as string | undefined,
      },
      view: { webContents: contents },
    };
    const assertTabNotSensitive = vi.fn(async () => {
      throw new Error('Saving the image is blocked while this page contains password data.');
    });
    const manager = managerWithoutConstructor({
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
      captureBrowserPageLease: vi.fn(() => ({ tabId: 'tab-1', contents })),
      assertBrowserPageLease: vi.fn(),
      assertTabNotSensitive,
      runTabOperation: (_tab: unknown, operation: () => Promise<void>) => operation(),
      emitTabs: vi.fn(),
    });

    const menu = invokePrivate(manager, 'buildContextMenu', tab, contents, {
      mediaType: 'image',
      srcURL: 'https://example.com/private.png',
      x: 12,
      y: 24,
    }) as { items: Array<{ label?: string; click?: () => void }> };
    menu.items.find((item) => item.label === 'Save Image As…')?.click?.();

    await vi.waitFor(() => expect(tab.shell.error).toMatch(/password data/i));
    expect(assertTabNotSensitive).toHaveBeenCalledWith(tab, contents, 'Saving the image');
    expect(downloadURL).not.toHaveBeenCalled();
  });

  it('guards context-menu printing with the full sensitivity scan', async () => {
    const scan = deferred<void>();
    const print = vi.fn((_options: unknown, callback: (success: boolean, failureReason: string) => void) =>
      callback(true, ''),
    );
    const contents = {
      id: 42,
      isDestroyed: () => false,
      getURL: () => 'https://example.com',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      print,
    };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', title: 'Example', sensitive: false },
      view: { webContents: contents },
    };
    const assertBrowserPageLease = vi.fn();
    const assertTabNotSensitive = vi.fn(() => scan.promise);
    const manager = managerWithoutConstructor({
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
      captureBrowserPageLease: vi.fn(() => ({
        tabId: 'tab-1',
        tabGeneration: 1,
        userNavigationLease: 0,
        contents,
      })),
      assertBrowserPageLease,
      assertTabNotSensitive,
      runTabOperation: (_tab: unknown, operation: () => Promise<void>) => operation(),
      emitTabs: vi.fn(),
    });

    const menu = invokePrivate(manager, 'buildContextMenu', tab, contents, {}) as {
      items: Array<{ label?: string; click?: () => void }>;
    };
    menu.items.find((item) => item.label === 'Print…')?.click?.();

    expect(print).not.toHaveBeenCalled();
    scan.resolve();
    await vi.waitFor(() => expect(print).toHaveBeenCalledWith({ printBackground: true }, expect.any(Function)));
    expect(assertTabNotSensitive).toHaveBeenCalledWith(tab, contents, 'Printing');
    expect(assertBrowserPageLease).toHaveBeenCalledTimes(4);
  });

  it('rejects context-menu image coordinates after the originating document changes', async () => {
    const copyImageAt = vi.fn();
    const emitTabs = vi.fn();
    const contents = {
      id: 42,
      isDestroyed: () => false,
      copyImageAt,
      getURL: () => 'https://example.com',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        title: 'Example',
        sensitive: false,
        error: undefined as string | undefined,
      },
      view: { webContents: contents },
    };
    const pageLease = {
      tabId: 'tab-1',
      tabGeneration: 1,
      userNavigationLease: 0,
      contents,
    };
    let pageChanged = false;
    const assertTabNotSensitive = vi.fn(async () => undefined);
    const manager = managerWithoutConstructor({
      tabs: new Map([['tab-1', tab]]),
      webContentsToTab: new Map([[42, 'tab-1']]),
      captureBrowserPageLease: vi.fn(() => pageLease),
      assertBrowserPageLease: vi.fn(() => {
        if (pageChanged) throw new Error('The browser page changed while this context-menu action was in progress.');
      }),
      assertTabNotSensitive,
      runTabOperation: (_tab: unknown, operation: () => Promise<void>) => operation(),
      emitTabs,
    });

    const menu = invokePrivate(manager, 'buildContextMenu', tab, contents, {
      mediaType: 'image',
      srcURL: 'https://example.com/image.png',
      x: 12,
      y: 24,
    }) as { items: Array<{ label?: string; click?: () => void }> };
    pageChanged = true;
    menu.items.find((item) => item.label === 'Copy Image')?.click?.();

    await vi.waitFor(() => expect(tab.shell.error).toMatch(/context-menu action/));
    expect(copyImageAt).not.toHaveBeenCalled();
    expect(assertTabNotSensitive).not.toHaveBeenCalled();
    expect(emitTabs).toHaveBeenCalledWith('chat-1');
  });

  it('does not save a replacement page after a context-menu save dialog', async () => {
    const selected = deferred<{ canceled: boolean; filePath?: string }>();
    electronMocks.showSaveDialog.mockReturnValue(selected.promise);
    const savePage = vi.fn(async () => undefined);
    const contents = {
      id: 42,
      isDestroyed: () => false,
      getURL: () => 'https://example.com/original',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      savePage,
    };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        title: 'Original',
        error: undefined as string | undefined,
      },
      view: { webContents: contents },
    };
    const pageLease = {
      tabId: 'tab-1',
      tabGeneration: 1,
      userNavigationLease: 0,
      contents,
    };
    let pageChanged = false;
    const manager = managerWithoutConstructor({
      tabs: new Map([['tab-1', tab]]),
      captureBrowserPageLease: vi.fn(() => pageLease),
      assertBrowserPageLease: vi.fn(() => {
        if (pageChanged) throw new Error('The browser page changed while this context-menu action was in progress.');
      }),
      getWindow: () => null,
      runTabOperation: (_tab: unknown, operation: () => Promise<void>) => operation(),
      emitTabs: vi.fn(),
    });

    const menu = invokePrivate(manager, 'buildContextMenu', tab, contents, {}) as {
      items: Array<{ label?: string; click?: () => void }>;
    };
    menu.items.find((item) => item.label === 'Save Page As…')?.click?.();
    await vi.waitFor(() => expect(electronMocks.showSaveDialog).toHaveBeenCalledOnce());
    pageChanged = true;
    selected.resolve({ canceled: false, filePath: '/tmp/replacement.html' });

    await vi.waitFor(() => expect(tab.shell.error).toMatch(/context-menu action/));
    expect(savePage).not.toHaveBeenCalled();
  });

  it('scans for password data immediately before saving a page from the context menu', async () => {
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/sensitive.html' });
    const savePage = vi.fn(async () => undefined);
    const contents = {
      id: 42,
      isDestroyed: () => false,
      getURL: () => 'https://example.com/login',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      savePage,
    };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        title: 'Login',
        error: undefined as string | undefined,
      },
      view: { webContents: contents },
    };
    const pageLease = { tabId: 'tab-1', contents };
    const assertTabNotSensitive = vi.fn(async () => {
      throw new Error('Saving the page is blocked while this page contains password data.');
    });
    const manager = managerWithoutConstructor({
      tabs: new Map([['tab-1', tab]]),
      captureBrowserPageLease: vi.fn(() => pageLease),
      assertBrowserPageLease: vi.fn(),
      assertTabNotSensitive,
      getWindow: () => null,
      runTabOperation: (_tab: unknown, operation: () => Promise<void>) => operation(),
      emitTabs: vi.fn(),
    });

    const menu = invokePrivate(manager, 'buildContextMenu', tab, contents, {}) as {
      items: Array<{ label?: string; click?: () => void }>;
    };
    menu.items.find((item) => item.label === 'Save Page As…')?.click?.();

    await vi.waitFor(() => expect(tab.shell.error).toMatch(/password data/i));
    expect(assertTabNotSensitive).toHaveBeenCalledWith(tab, contents, 'Saving the page');
    expect(savePage).not.toHaveBeenCalled();
  });

  it('routes page context-menu navigation through user browser commands', async () => {
    const commandTab = vi.fn(async () => undefined);
    const manager = managerWithoutConstructor({
      commandTab,
      assertBrowserPageLease: vi.fn(),
    });
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', title: 'Example' },
    };
    const contents = {
      getURL: () => 'https://example.com',
      navigationHistory: { canGoBack: () => true, canGoForward: () => true },
    };

    const menu = invokePrivate(manager, 'buildContextMenu', tab, contents, {}) as {
      items: Array<{ click?: () => void }>;
    };
    menu.items[0].click?.();
    menu.items[1].click?.();
    menu.items[2].click?.();
    await Promise.resolve();

    expect(commandTab).toHaveBeenNthCalledWith(1, 'chat-1', 'tab-1', 'back', 'user');
    expect(commandTab).toHaveBeenNthCalledWith(2, 'chat-1', 'tab-1', 'forward', 'user');
    expect(commandTab).toHaveBeenNthCalledWith(3, 'chat-1', 'tab-1', 'reload', 'user');
  });

  it('contains rejected asynchronous context-menu actions in the owning tab', async () => {
    const emitTabs = vi.fn();
    const createTab = vi.fn(async () => {
      throw new Error('Tab limit reached');
    });
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        title: 'Example',
        error: undefined as string | undefined,
      },
    };
    const manager = managerWithoutConstructor({
      createTab,
      emitTabs,
      tabs: new Map([['tab-1', tab]]),
    });
    const contents = {
      isDestroyed: () => false,
      getURL: () => 'https://example.com',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    };
    Object.assign(tab, { view: { webContents: contents } });

    const menu = invokePrivate(manager, 'buildContextMenu', tab, contents, {
      linkURL: 'https://example.com/new',
    }) as { items: Array<{ label?: string; click?: () => void }> };
    menu.items.find((item) => item.label === 'Open Link in New Tab')?.click?.();

    await vi.waitFor(() => expect(tab.shell.error).toBe('Tab limit reached'));
    expect(emitTabs).toHaveBeenCalledWith('chat-1');
  });

  it('does not credential-fetch cross-origin favicons or redirects', async () => {
    const fetch = vi.fn(async () => ({
      status: 302,
      headers: {
        get: (name: string) => (name === 'location' ? 'https://cdn.example/icon.png' : null),
      },
    }));
    electronMocks.fromPartition.mockReturnValue({ fetch });
    const manager = managerWithoutConstructor({
      clearingScopes: new Set(),
      getConfig: () => ({ browser: { enabled: true } }),
    });
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      generation: 1,
      aiNetworkRestricted: false,
    };
    const contents = {
      getURL: () => 'https://example.com/account',
      isDestroyed: () => false,
    };

    invokePrivate(manager, 'updateFavicon', tab, contents, ['https://cdn.example/icon.png']);
    expect(electronMocks.fromPartition).not.toHaveBeenCalled();

    const result = await invokePrivate(
      manager,
      'fetchScopedFavicon',
      tab,
      { fetch },
      'https://example.com/icon.png',
      'https://example.com',
      new AbortController().signal,
    );
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized page-supplied favicon data URLs before broadcasting them', () => {
    const emitTabFavicon = vi.fn();
    const cancelFaviconFetch = vi.fn();
    const manager = managerWithoutConstructor({
      cancelFaviconFetch,
      emitTabFavicon,
    });
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        favicon: undefined as string | undefined,
      },
      generation: 1,
    };
    const contents = { getURL: () => 'https://example.com' };

    invokePrivate(manager, 'updateFavicon', tab, contents, [
      `data:image/png;base64,${Buffer.alloc(65 * 1024).toString('base64')}`,
    ]);

    expect(tab.shell.favicon).toBeUndefined();
    expect(cancelFaviconFetch).not.toHaveBeenCalled();
    expect(emitTabFavicon).not.toHaveBeenCalled();
  });

  it('deduplicates and aborts stale favicon fetches', async () => {
    const requests: Array<{ url: string; signal: AbortSignal }> = [];
    const fetch = vi.fn(
      (url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          requests.push({ url, signal: options.signal });
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    electronMocks.fromPartition.mockReturnValue({ fetch });
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      generation: 1,
      aiNetworkRestricted: false,
    };
    const manager = managerWithoutConstructor({
      activeFaviconFetches: 0,
      clearingScopes: new Set(),
      faviconFetches: new Map(),
      getConfig: () => ({ browser: { enabled: true } }),
      tabs: new Map([['tab-1', tab]]),
      withScopeActivity: (_scopeKey: string, operation: () => Promise<unknown>) => operation(),
    });
    const contents = {
      getURL: () => 'https://example.com/account',
      isDestroyed: () => false,
    };

    invokePrivate(manager, 'updateFavicon', tab, contents, ['https://example.com/one.png']);
    invokePrivate(manager, 'updateFavicon', tab, contents, ['https://example.com/one.png']);
    expect(fetch).toHaveBeenCalledTimes(1);

    invokePrivate(manager, 'updateFavicon', tab, contents, ['https://example.com/two.png']);
    expect(requests[0].signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    invokePrivate(manager, 'cancelFaviconFetch', 'tab-1');
    await Promise.resolve();
  });

  it('blocks assistant reopening of tabs that were closed while sensitive', async () => {
    const manager = managerWithoutConstructor({
      closedTabs: new Map([
        [
          'chat-1',
          [
            {
              url: 'https://secret.example',
              title: 'Secret',
              owner: 'user',
              keepOpen: false,
              sensitive: true,
              scopeKey: 'global',
            },
          ],
        ],
      ]),
    });

    await expect(manager.reopenClosedTab('chat-1', 'assistant', { id: 'run-1' })).rejects.toThrow(/password data/);
  });

  it('purges cleared profile downloads from the in-memory path cache', () => {
    const manager = managerWithoutConstructor({
      downloads: new Map([
        [
          'global-download',
          {
            id: 'global-download',
            path: '/tmp/global.pdf',
            scopeKey: 'global',
          },
        ],
        [
          'evicted-global-download',
          {
            id: 'evicted-global-download',
            path: '/tmp/old-global.pdf',
            scopeKey: 'global',
          },
        ],
        [
          'other-download',
          {
            id: 'other-download',
            path: '/tmp/other.pdf',
            scopeKey: 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ],
      ]),
    });

    invokePrivate(manager, 'purgeCachedDownloadsForScope', 'global');

    expect(Reflect.get(manager, 'downloads')).toEqual(
      new Map([
        [
          'other-download',
          {
            id: 'other-download',
            path: '/tmp/other.pdf',
            scopeKey: 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ],
      ]),
    );
  });

  it('rejects showing a completed download when no saved path was recorded', () => {
    const manager = managerWithoutConstructor({
      downloads: new Map([
        [
          'pathless-download',
          {
            id: 'pathless-download',
            filename: 'missing.pdf',
            state: 'completed',
            scopeKey: 'global',
          },
        ],
      ]),
    });

    expect(() => manager.showDownload('chat-1', 'pathless-download')).toThrow(/no saved path was recorded/i);
  });

  it('does not resolve a download id from another conversation profile', () => {
    const manager = managerWithoutConstructor({
      scopeKey: vi.fn(() => 'conversation-current'),
      storeForScope: vi.fn(() => ({ listDownloads: () => [] })),
      downloads: new Map([
        [
          'other-download',
          {
            id: 'other-download',
            filename: 'other.pdf',
            path: '/tmp/other.pdf',
            state: 'completed',
            scopeKey: 'conversation-other',
          },
        ],
      ]),
    });

    expect(() => manager.showDownload('chat-1', 'other-download')).toThrow(/no longer available/i);
  });

  it('bounds the live download path cache independently of profile persistence', () => {
    const downloads = new Map(
      Array.from({ length: 1_000 }, (_, index) => [
        `download-${index}`,
        {
          id: `download-${index}`,
          tabId: 'tab-1',
          filename: `${index}.pdf`,
          receivedBytes: 0,
          totalBytes: 1,
          state: 'progressing',
          scopeKey: 'global',
        },
      ]),
    );
    const manager = managerWithoutConstructor({ downloads });

    invokePrivate(manager, 'cacheDownload', 'global', {
      id: 'download-new',
      tabId: 'tab-1',
      filename: 'new.pdf',
      receivedBytes: 1,
      totalBytes: 1,
      state: 'completed',
    });

    expect(downloads).toHaveLength(1_000);
    expect(downloads.has('download-0')).toBe(false);
    expect(downloads.get('download-new')).toMatchObject({
      scopeKey: 'global',
      state: 'completed',
    });
  });

  it('evaluates bounded scripts in a fresh isolated execution world', async () => {
    const sendCommand = vi.fn(async (command: string) => {
      if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
      if (command === 'Page.createIsolatedWorld') return { executionContextId: 73 };
      if (command === 'Runtime.evaluate') return { result: { value: '{"ok":true}' } };
      throw new Error(`Unexpected debugger command: ${command}`);
    });
    const manager = managerWithoutConstructor({
      runRendererOperationWithDeadline: async (
        _tab: unknown,
        _contents: unknown,
        _operation: string,
        _timeoutMs: number,
        task: () => Promise<unknown>,
      ) => task(),
    });
    const contents = {
      debugger: {
        attach: vi.fn(),
        detach: vi.fn(),
        isAttached: () => true,
        sendCommand,
      },
      isDestroyed: () => false,
    };

    await expect(
      invokePrivate(manager, 'evaluateWithDeadline', { shell: { id: 'tab-1' } }, contents, 'bounded-expression'),
    ).resolves.toBe('{"ok":true}');
    expect(sendCommand).toHaveBeenNthCalledWith(1, 'Page.getFrameTree');
    expect(sendCommand).toHaveBeenNthCalledWith(
      2,
      'Page.createIsolatedWorld',
      expect.objectContaining({
        frameId: 'main-frame',
        worldName: expect.stringMatching(/^__kai_browser_evaluation_[a-f0-9]+$/),
        grantUniveralAccess: false,
      }),
    );
    expect(sendCommand).toHaveBeenNthCalledWith(
      3,
      'Runtime.evaluate',
      expect.objectContaining({
        expression: 'bounded-expression',
        contextId: 73,
        returnByValue: true,
        userGesture: false,
      }),
    );
  });

  it('rejects an ambiguous semantic target instead of choosing the first destructive control', async () => {
    const dom = new JSDOM('<button>Delete</button><button>Delete</button>', {
      url: 'https://example.com',
      runScripts: 'outside-only',
    });
    try {
      Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { value: vi.fn() });
      for (const element of dom.window.document.querySelectorAll('button')) {
        Object.defineProperty(element, 'getBoundingClientRect', {
          value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }),
        });
      }
      const sendCommand = vi.fn(async (command: string, params?: { expression?: string }) => {
        if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
        if (command === 'Page.createIsolatedWorld') return { executionContextId: 73 };
        if (command === 'Runtime.evaluate') {
          try {
            return { result: { value: dom.window.eval(params?.expression ?? '') } };
          } catch (error) {
            return { exceptionDetails: { exception: { description: (error as Error).message } } };
          }
        }
        throw new Error(`Unexpected debugger command: ${command}`);
      });
      const manager = managerWithoutConstructor({
        runRendererOperationWithDeadline: async (
          _tab: unknown,
          _contents: unknown,
          _operation: string,
          _timeoutMs: number,
          task: () => Promise<unknown>,
        ) => task(),
      });
      const contents = {
        debugger: {
          attach: vi.fn(),
          detach: vi.fn(),
          isAttached: () => true,
          sendCommand,
        },
        isDestroyed: () => false,
      };

      await expect(
        invokePrivate(manager, 'locate', { shell: { id: 'tab-1' } }, contents, {
          kind: 'click',
          role: 'button',
          name: 'Delete',
        }),
      ).rejects.toThrow(/multiple visible elements/i);
    } finally {
      dom.window.close();
    }
  });

  it('locates labeled textboxes and submit inputs by the same native roles and accessible names as inspection', async () => {
    const dom = new JSDOM(
      '<label for="email">Email address</label><input id="email"><input id="submit" type="submit" value="Sign in">',
      { url: 'https://example.com', runScripts: 'outside-only' },
    );
    try {
      const email = dom.window.document.querySelector('#email')!;
      const submit = dom.window.document.querySelector('#submit')!;
      Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { value: vi.fn() });
      Object.defineProperty(email, 'getBoundingClientRect', {
        value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }),
      });
      Object.defineProperty(submit, 'getBoundingClientRect', {
        value: () => ({ x: 120, y: 0, left: 120, top: 0, right: 220, bottom: 30, width: 100, height: 30 }),
      });
      Object.defineProperty(dom.window.document, 'elementFromPoint', {
        configurable: true,
        value: (x: number) => (x < 110 ? email : submit),
      });
      const sendCommand = vi.fn(async (command: string, params?: { expression?: string }) => {
        if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
        if (command === 'Page.createIsolatedWorld') return { executionContextId: 73 };
        if (command === 'Runtime.evaluate') {
          try {
            return { result: { value: dom.window.eval(params?.expression ?? '') } };
          } catch (error) {
            return { exceptionDetails: { exception: { description: (error as Error).message } } };
          }
        }
        throw new Error(`Unexpected debugger command: ${command}`);
      });
      const manager = managerWithoutConstructor({
        runRendererOperationWithDeadline: async (
          _tab: unknown,
          _contents: unknown,
          _operation: string,
          _timeoutMs: number,
          task: () => Promise<unknown>,
        ) => task(),
      });
      const contents = {
        debugger: {
          attach: vi.fn(),
          detach: vi.fn(),
          isAttached: () => true,
          sendCommand,
        },
        isDestroyed: () => false,
      };

      await expect(
        invokePrivate(manager, 'locate', { shell: { id: 'tab-1' } }, contents, {
          kind: 'focus',
          role: 'textbox',
          name: 'Email address',
        }),
      ).resolves.toMatchObject({ x: 50, y: 15, width: 100, height: 30 });
      await expect(
        invokePrivate(manager, 'locate', { shell: { id: 'tab-1' } }, contents, {
          kind: 'click',
          role: 'button',
          name: 'Sign in',
        }),
      ).resolves.toMatchObject({ x: 170, y: 15, width: 100, height: 30 });
    } finally {
      dom.window.close();
    }
  });

  it('rejects a semantic target hidden by a transparent ancestor', async () => {
    const dom = new JSDOM('<div style="opacity: 0"><button id="hidden">Submit</button></div>', {
      url: 'https://example.com',
      runScripts: 'outside-only',
    });
    try {
      const button = dom.window.document.querySelector('#hidden')!;
      Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { value: vi.fn() });
      Object.defineProperty(button, 'getBoundingClientRect', {
        value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }),
      });
      Object.defineProperty(dom.window.document, 'elementFromPoint', {
        configurable: true,
        value: () => button,
      });
      const sendCommand = vi.fn(async (command: string, params?: { expression?: string }) => {
        if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
        if (command === 'Page.createIsolatedWorld') return { executionContextId: 73 };
        if (command === 'Runtime.evaluate') {
          try {
            return { result: { value: dom.window.eval(params?.expression ?? '') } };
          } catch (error) {
            return { exceptionDetails: { exception: { description: (error as Error).message } } };
          }
        }
        throw new Error(`Unexpected debugger command: ${command}`);
      });
      const manager = managerWithoutConstructor({
        runRendererOperationWithDeadline: async (
          _tab: unknown,
          _contents: unknown,
          _operation: string,
          _timeoutMs: number,
          task: () => Promise<unknown>,
        ) => task(),
      });
      const contents = {
        debugger: {
          attach: vi.fn(),
          detach: vi.fn(),
          isAttached: () => true,
          sendCommand,
        },
        isDestroyed: () => false,
      };

      await expect(
        invokePrivate(manager, 'locate', { shell: { id: 'tab-1' } }, contents, {
          kind: 'click',
          selector: '#hidden',
        }),
      ).rejects.toThrow(/No visible, unobscured element/i);
    } finally {
      dom.window.close();
    }
  });

  it('retains a published tab when its initial navigation fails', async () => {
    const tabs = new Map<string, unknown>();
    const tabOrder = new Map<string, string[]>();
    const emitTabs = vi.fn();
    const manager = managerWithoutConstructor({
      activeTabs: new Map(),
      attachActiveView: vi.fn(),
      clearingScopes: new Set(),
      closedTabs: new Map(),
      emitTabs,
      ensureView: vi.fn(async () => {
        throw new Error('net::ERR_NAME_NOT_RESOLVED');
      }),
      getConfig: () => ({
        browser: {
          dataScope: 'global',
          enabled: true,
          maxTabsPerConversation: 20,
          searchProvider: 'duckduckgo',
        },
      }),
      oneTimePermissions: new Set(),
      pendingAuth: new Map(),
      pendingCredentials: new Map(),
      pendingElementPickerCancels: new Map(),
      pendingPermissions: new Map(),
      pendingTabCreations: new Map(),
      requireLiveWindow: vi.fn(),
      stores: new Map([['global', { getZoomLevel: () => 0 }]]),
      tabOrder,
      tabs,
      webContentsToTab: new Map(),
      withScopeActivity: (_scopeKey: string, operation: () => Promise<unknown>) => operation(),
    });

    await expect(
      manager.createTab({
        conversationId: 'chat-1',
        owner: 'user',
        url: 'https://unresolvable.invalid',
      }),
    ).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);

    expect(tabs).toHaveLength(1);
    expect(tabOrder.get('chat-1')).toHaveLength(1);
    expect(emitTabs).toHaveBeenCalled();
    const retained = [...tabs.values()][0] as {
      shell: { discarded: boolean; error?: string };
    };
    expect(retained.shell.discarded).toBe(true);
    expect(retained.shell.error).toMatch(/ERR_NAME_NOT_RESOLVED/);
  });

  it('publishes an unmounted background tab as discarded so approval can restore it', async () => {
    const tabs = new Map<string, unknown>();
    const tabOrder = new Map<string, string[]>([['chat-1', ['existing-tab']]]);
    const ensureView = vi.fn(async () => {
      throw new Error('A background renderer must not be created before the panel mounts.');
    });
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'existing-tab']]),
      clearingScopes: new Set(),
      ensureView,
      getConfig: () => ({
        browser: {
          dataScope: 'global',
          enabled: true,
          maxTabsPerConversation: 20,
          searchProvider: 'duckduckgo',
        },
      }),
      mountedConversationId: null,
      pendingTabCreations: new Map(),
      requireLiveWindow: vi.fn(),
      stores: new Map([['global', { getZoomLevel: () => 0 }]]),
      tabOrder,
      tabs,
      withScopeActivity: (_scopeKey: string, operation: () => Promise<unknown>) => operation(),
    });

    const created = await manager.createTab({
      background: true,
      conversationId: 'chat-1',
      owner: 'user',
      url: 'https://background.example',
    });

    expect(ensureView).not.toHaveBeenCalled();
    expect(created.discarded).toBe(true);
    expect(manager.captureDocumentApproval('chat-1', created.id)).toMatchObject({
      allowInternalRestore: true,
      tabId: created.id,
    });
  });

  it('publishes an unmounted assistant tab before creating its restricted native view', async () => {
    const tabs = new Map<string, unknown>();
    const tabOrder = new Map<string, string[]>();
    const ensureView = vi.fn(async () => {
      throw new Error('A restricted renderer must wait until its Browser panel mounts.');
    });
    const emit = vi.fn();
    const release = vi.fn();
    const manager = managerWithoutConstructor({
      activeTabs: new Map(),
      assistantRuns: {
        acquire: vi.fn(() => ({ generation: 3, release })),
        assertActive: vi.fn(() => 3),
      },
      assertAssistantNavigationAllowed: vi.fn(async () => undefined),
      assertScopeAvailable: vi.fn(),
      emit,
      emitTabs: vi.fn(),
      ensureView,
      getConfig: () => ({
        browser: {
          dataScope: 'global',
          enabled: true,
          maxTabsPerConversation: 20,
          searchProvider: 'duckduckgo',
        },
      }),
      mountedConversationId: null,
      notifyPanelStateChanged: vi.fn(),
      pendingTabCreations: new Map(),
      requireLiveWindow: vi.fn(),
      stores: new Map([['global', { getZoomLevel: () => 0 }]]),
      tabOrder,
      tabs,
      withScopeActivity: (_scopeKey: string, operation: () => Promise<unknown>) => operation(),
    });

    const created = await manager.createTab(
      {
        conversationId: 'chat-1',
        owner: 'assistant',
        url: 'about:blank',
      },
      { id: 'run-1' },
    );

    expect(ensureView).not.toHaveBeenCalled();
    expect(created).toMatchObject({ discarded: true, owner: 'assistant' });
    expect(emit).toHaveBeenCalledWith({ type: 'open-panel', conversationId: 'chat-1', tabId: created.id });
    expect(release).toHaveBeenCalledOnce();
  });

  it('attaches a restored active view before its page load settles', async () => {
    const pageLoad = deferred<void>();
    const view = {
      webContents: {
        isDestroyed: () => false,
        loadURL: vi.fn(() => pageLoad.promise),
      },
    };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://slow.example',
      },
      scopeKey: 'global',
      view: null as typeof view | null,
      viewLoadPromise: null as Promise<typeof view> | null,
    };
    const attachActiveView = vi.fn();
    const createView = vi.fn(() => {
      tab.view = view;
      return view;
    });
    const manager = managerWithoutConstructor({
      disposed: false,
      getConfig: () => ({ browser: { enabled: true } }),
      requireLiveWindow: vi.fn(),
      assertScopeAvailable: vi.fn(),
      storeForScope: () => ({ listScriptCleanupOrigins: () => [] }),
      tabs: new Map([[tab.shell.id, tab]]),
      createView,
      attachActiveView,
      runRendererOperationWithDeadline: async (
        _tab: unknown,
        _contents: unknown,
        _operation: string,
        _timeoutMs: number,
        task: () => Promise<unknown>,
      ) => task(),
    });

    const restoring = invokePrivate(manager, 'ensureView', tab) as Promise<unknown>;
    let joinedSettled = false;
    const joined = (invokePrivate(manager, 'ensureView', tab) as Promise<unknown>).finally(() => {
      joinedSettled = true;
    });
    expect(createView).toHaveBeenCalledOnce();
    expect(view.webContents.loadURL).toHaveBeenCalledOnce();
    expect(attachActiveView).toHaveBeenCalledWith('chat-1');
    await Promise.resolve();
    expect(joinedSettled).toBe(false);

    pageLoad.resolve();
    await expect(Promise.all([restoring, joined])).resolves.toEqual([view, view]);
    expect(tab.viewLoadPromise).toBeNull();
  });

  it('attaches an in-flight native view as soon as its Browser panel mounts', async () => {
    const pageLoad = deferred<void>();
    const addChildView = vi.fn();
    const setBounds = vi.fn();
    const view = {
      setBounds,
      webContents: { isDestroyed: () => false },
    };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        reloadRequired: false,
      },
      scriptTainted: false,
      view,
    };
    const window = visibleHostWindow({
      contentView: { addChildView, removeChildView: vi.fn() },
      getContentBounds: () => ({ width: 1_000, height: 800 }),
    });
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', tab.shell.id]]),
      attachedView: null,
      emitPendingPrompts: vi.fn(),
      ensureView: vi.fn(() => pageLoad.promise),
      getConfig: () => ({ browser: { enabled: true } }),
      getWindow: () => window,
      mountedBounds: null,
      mountedConversationId: null,
      notifyPanelStateChanged: vi.fn(),
      tabs: new Map([[tab.shell.id, tab]]),
    });

    const mounting = manager.mount('chat-1', { x: 10, y: 20, width: 300, height: 200 });

    expect(addChildView).toHaveBeenCalledWith(view);
    expect(setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 300, height: 200 });
    pageLoad.resolve();
    await mounting;
  });

  it('installs the private-network document guard before a restricted tab first loads', async () => {
    const order: string[] = [];
    const view = {
      webContents: {
        isDestroyed: () => false,
        loadURL: vi.fn(async () => {
          order.push('load');
        }),
      },
    };
    const tab = {
      aiNetworkRestricted: true,
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://restricted.example',
      },
      scopeKey: 'global',
      trustedUserNavigation: false,
      view: null as typeof view | null,
      viewLoadPromise: null as Promise<typeof view> | null,
    };
    const manager = managerWithoutConstructor({
      aiAllowPrivateNetwork: false,
      assertScopeAvailable: vi.fn(),
      attachActiveView: vi.fn(),
      createView: vi.fn(() => {
        tab.view = view;
        return view;
      }),
      getConfig: () => ({ browser: { enabled: true } }),
      installPrivateNetworkNewDocumentGuard: vi.fn(async () => {
        order.push('guard');
      }),
      requireLiveWindow: vi.fn(),
      storeForScope: () => ({ listScriptCleanupOrigins: () => [] }),
      runRendererOperationWithDeadline: async (
        _tab: unknown,
        _contents: unknown,
        _operation: string,
        _timeoutMs: number,
        task: () => Promise<unknown>,
      ) => task(),
      tabs: new Map([[tab.shell.id, tab]]),
    });

    await expect(invokePrivate(manager, 'ensureView', tab)).resolves.toBe(view);

    expect(order).toEqual(['guard', 'load']);
  });

  it('starts every newly created restricted view with the preload WebRTC guard active', () => {
    const pageSession = { setUserAgent: vi.fn() };
    electronMocks.fromPartition.mockReturnValue(pageSession);
    const webContents = {
      id: 42,
      setAudioMuted: vi.fn(),
      setUserAgent: vi.fn(),
      setWebRTCIPHandlingPolicy: vi.fn(),
      setZoomLevel: vi.fn(),
    };
    const setBounds = vi.fn();
    electronMocks.webContentsView.mockReturnValue({ setBounds, webContents });
    const tab = {
      aiNetworkRestricted: true,
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      shell: {
        conversationId: 'chat-1',
        discarded: true,
        id: 'tab-1',
        muted: false,
        zoomLevel: 0,
      },
      trustedUserNavigation: false,
      view: null,
    };
    const manager = managerWithoutConstructor({
      aiAllowPrivateNetwork: false,
      assertScopeAvailable: vi.fn(),
      getConfig: () => ({ browser: { aiAllowPrivateNetwork: false } }),
      requireLiveWindow: vi.fn(),
      webContentsToTab: new Map(),
      wireSession: vi.fn(),
      wireWebContents: vi.fn(),
    });
    const inheritedOptions = {
      webPreferences: { additionalArguments: ['--untrusted-popup-argument'] },
    };

    expect(invokePrivate(manager, 'createView', tab, inheritedOptions)).toMatchObject({ webContents });

    expect(electronMocks.webContentsView).toHaveBeenCalledWith({
      webPreferences: expect.objectContaining({
        additionalArguments: [BROWSER_PRIVATE_NETWORK_GUARD_ARGUMENT],
      }),
    });
    expect(tab).toMatchObject({
      privateNetworkNewDocumentGuard: { contentsId: 42, identifier: 'preload-pending' },
      shell: { discarded: false },
      view: { webContents },
    });
    expect(webContents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
  });

  it('keeps ordinary user-created views on Chromium default WebRTC behavior', () => {
    const pageSession = { setUserAgent: vi.fn() };
    electronMocks.fromPartition.mockReturnValue(pageSession);
    const webContents = {
      id: 43,
      setAudioMuted: vi.fn(),
      setUserAgent: vi.fn(),
      setWebRTCIPHandlingPolicy: vi.fn(),
      setZoomLevel: vi.fn(),
    };
    electronMocks.webContentsView.mockReturnValue({ setBounds: vi.fn(), webContents });
    const tab = {
      aiNetworkRestricted: false,
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      shell: {
        conversationId: 'chat-1',
        discarded: true,
        id: 'tab-user',
        muted: false,
        zoomLevel: 0,
      },
      trustedUserNavigation: false,
      view: null,
    };
    const manager = managerWithoutConstructor({
      aiAllowPrivateNetwork: false,
      assertScopeAvailable: vi.fn(),
      getConfig: () => ({ browser: { aiAllowPrivateNetwork: false } }),
      requireLiveWindow: vi.fn(),
      webContentsToTab: new Map(),
      wireSession: vi.fn(),
      wireWebContents: vi.fn(),
    });

    expect(invokePrivate(manager, 'createView', tab)).toMatchObject({ webContents });

    expect(electronMocks.webContentsView).toHaveBeenCalledWith({
      webPreferences: expect.objectContaining({ additionalArguments: [] }),
    });
    expect(webContents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('default');
    expect(tab).not.toHaveProperty('privateNetworkNewDocumentGuard');
  });

  it('refreshes an assistant lease when joining an in-flight discarded-tab restore', async () => {
    const pageLoad = deferred<void>();
    const view = {
      webContents: {
        isDestroyed: () => false,
        loadURL: vi.fn(() => pageLoad.promise),
        setWebRTCIPHandlingPolicy: vi.fn(),
      },
    };
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://example.com/account',
      },
      scopeKey: 'global',
      view: null as typeof view | null,
      viewLoadPromise: null as Promise<typeof view> | null,
      generation: 3,
      trustedUserNavigationLease: 0,
    };
    const createView = vi.fn(() => {
      tab.view = view;
      return view;
    });
    const guardAssistantTab = vi.fn(async () => ({
      runId: 'run-1',
      runGeneration: 7,
      hostRendererAuthorityGeneration: 0,
      tabGeneration: tab.generation,
      userNavigationLease: tab.trustedUserNavigationLease,
      url: tab.shell.url,
    }));
    const assertAssistantDocumentLease = vi.fn((_tab: unknown, lease: { tabGeneration: number; url: string }) => {
      if (lease.tabGeneration !== tab.generation || lease.url !== tab.shell.url) {
        throw new Error('The page navigated while this assistant operation was waiting.');
      }
    });
    const manager = managerWithoutConstructor({
      disposed: false,
      getConfig: () => ({ browser: { enabled: true } }),
      requireLiveWindow: vi.fn(),
      assertScopeAvailable: vi.fn(),
      storeForScope: () => ({ listScriptCleanupOrigins: () => [] }),
      tabs: new Map([[tab.shell.id, tab]]),
      createView,
      attachActiveView: vi.fn(),
      guardAssistantTab,
      assertAssistantDocumentLease,
      installPrivateNetworkNewDocumentGuard: vi.fn(async () => undefined),
      runRendererOperationWithDeadline: async (
        _tab: unknown,
        _contents: unknown,
        _operation: string,
        _timeoutMs: number,
        task: () => Promise<unknown>,
      ) => task(),
    });
    const lease = {
      runId: 'run-1',
      runGeneration: 7,
      hostRendererAuthorityGeneration: 0,
      tabGeneration: tab.generation,
      userNavigationLease: tab.trustedUserNavigationLease,
      url: tab.shell.url,
    };

    const restoring = invokePrivate(manager, 'ensureView', tab) as Promise<unknown>;
    const assistant = invokePrivate(manager, 'ensureAssistantView', tab, { id: 'run-1' }, lease) as Promise<unknown>;
    tab.generation++;
    tab.shell.url = 'https://example.com/restored';
    pageLoad.resolve();

    await expect(Promise.all([restoring, assistant])).resolves.toEqual([view, view]);
    expect(createView).toHaveBeenCalledOnce();
    expect(view.webContents.loadURL).toHaveBeenCalledOnce();
    expect(guardAssistantTab).toHaveBeenCalledWith(tab, { id: 'run-1' }, 7);
    expect(Reflect.get(manager, 'installPrivateNetworkNewDocumentGuard')).toHaveBeenCalledWith(tab, view.webContents);
    expect(lease).toMatchObject({ tabGeneration: 4, url: 'https://example.com/restored' });
  });

  it('applies an assistant abort while joining an in-flight user page load', async () => {
    const forcefullyCrashRenderer = vi.fn();
    const contents = {
      debugger: { isAttached: () => false },
      forcefullyCrashRenderer,
      isDestroyed: () => false,
    };
    const view = { webContents: contents };
    const pageLoad = deferred<typeof view>();
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://slow.example',
        discarded: false,
      },
      scopeKey: 'global',
      view,
      viewLoadPromise: pageLoad.promise,
    };
    const destroyView = vi.fn();
    const emitTabs = vi.fn();
    const manager = managerWithoutConstructor({
      assertScopeAvailable: vi.fn(),
      destroyView,
      emitTabs,
      getConfig: () => ({ browser: { enabled: true } }),
      requireLiveWindow: vi.fn(),
      tabs: new Map([[tab.shell.id, tab]]),
    });
    const controller = new AbortController();

    const joined = invokePrivate(manager, 'ensureView', tab, controller.signal, 30_000) as Promise<unknown>;
    controller.abort();

    await expect(joined).rejects.toThrow('Browser page load was cancelled');
    expect(forcefullyCrashRenderer).not.toHaveBeenCalled();
    expect(destroyView).toHaveBeenCalledWith(tab);
    expect(tab.shell).toMatchObject({ discarded: true, error: 'Browser page load was cancelled.' });
    expect(emitTabs).toHaveBeenCalledWith('chat-1');
    pageLoad.resolve(view);
  });

  it('applies an assistant deadline while joining an in-flight user page load', async () => {
    vi.useFakeTimers();
    const contents = {
      debugger: { isAttached: () => false },
      forcefullyCrashRenderer: vi.fn(),
      isDestroyed: () => false,
    };
    const view = { webContents: contents };
    const pageLoad = deferred<typeof view>();
    const tab = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://slow.example',
        discarded: false,
      },
      scopeKey: 'global',
      view,
      viewLoadPromise: pageLoad.promise,
    };
    const destroyView = vi.fn();
    const manager = managerWithoutConstructor({
      assertScopeAvailable: vi.fn(),
      destroyView,
      emitTabs: vi.fn(),
      getConfig: () => ({ browser: { enabled: true } }),
      requireLiveWindow: vi.fn(),
      tabs: new Map([[tab.shell.id, tab]]),
    });

    try {
      const joined = invokePrivate(manager, 'ensureView', tab, undefined, 25) as Promise<unknown>;
      const rejected = expect(joined).rejects.toThrow('Browser page load exceeded 0.025 seconds');
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
      expect(destroyView).toHaveBeenCalledWith(tab);
      pageLoad.resolve(view);
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes assistant authority and destroys host-owned views while preserving tab shells', () => {
    const first = {
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        discarded: false,
        sensitive: true,
      },
      view: { webContents: {} },
      generation: 2,
      aiNetworkRestricted: true,
    };
    const second = {
      shell: {
        id: 'tab-2',
        conversationId: 'chat-2',
        discarded: false,
        sensitive: false,
      },
      view: { webContents: {} },
      generation: 8,
      aiNetworkRestricted: false,
    };
    const destroyView = vi.fn((tab: typeof first | typeof second) => {
      tab.view = null as unknown as typeof tab.view;
    });
    const emitTabs = vi.fn();
    const assistantRuns = { clear: vi.fn() };
    const manager = managerWithoutConstructor({
      assistantRuns,
      attachedView: first.view,
      destroyView,
      detachAttachedView: vi.fn(),
      emitTabs,
      hostRendererAuthorityGeneration: 4,
      hostRendererAuthorityAvailable: true,
      mountedBounds: { x: 1, y: 2, width: 3, height: 4 },
      mountedConversationId: 'chat-1',
      tabs: new Map([
        ['tab-1', first],
        ['tab-2', second],
      ]),
    });

    manager.handleHostRendererUnavailable();

    expect(assistantRuns.clear).toHaveBeenCalledOnce();
    expect(destroyView).toHaveBeenCalledTimes(2);
    expect(first.shell).toMatchObject({ discarded: true, sensitive: false });
    expect(second.shell).toMatchObject({ discarded: true, sensitive: false });
    expect(first.aiNetworkRestricted).toBe(true);
    expect(second.aiNetworkRestricted).toBe(false);
    expect(first.generation).toBe(3);
    expect(second.generation).toBe(9);
    expect(manager.isHostRendererAuthorityCurrent(4)).toBe(false);
    expect(manager.isHostRendererAuthorityCurrent(5)).toBe(false);
    manager.handleHostRendererReady();
    expect(manager.isHostRendererAuthorityCurrent(5)).toBe(true);
    expect((manager as unknown as { mountedConversationId: string | null }).mountedConversationId).toBeNull();
    expect((manager as unknown as { mountedBounds: unknown }).mountedBounds).toBeNull();
    expect(emitTabs.mock.calls.map(([conversationId]) => conversationId).sort()).toEqual(['chat-1', 'chat-2']);
  });

  it('does not idle-close or discard tabs leased to an active assistant run', () => {
    const liveAssistantTab = {
      shell: {
        id: 'assistant-live',
        conversationId: 'chat-1',
        owner: 'assistant' as const,
        keepOpen: false,
        audible: false,
      },
      assistantOwnerId: 'run-live',
      aiControlOwnerId: 'run-live',
      aiActionDepth: 0,
      lastUsedAt: 0,
      view: null,
    };
    const staleAssistantTab = {
      ...liveAssistantTab,
      shell: { ...liveAssistantTab.shell, id: 'assistant-stale' },
      assistantOwnerId: 'run-stale',
      aiControlOwnerId: 'run-stale',
    };
    const continuationAssistantTab = {
      ...liveAssistantTab,
      shell: { ...liveAssistantTab.shell, id: 'assistant-continuation' },
      assistantOwnerId: 'run-continuation',
      aiControlOwnerId: 'run-continuation',
    };
    const controlledUserTab = {
      ...liveAssistantTab,
      shell: {
        ...liveAssistantTab.shell,
        id: 'user-controlled',
        owner: 'user' as const,
      },
      assistantOwnerId: null,
      view: { webContents: {} },
    };
    const closeTab = vi.fn();
    const destroyView = vi.fn();
    const generationIfActive = vi.fn((_conversationId: string, runId: string) => (runId === 'run-live' ? 1 : null));
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'some-other-tab']]),
      assistantContinuationLeases: new Set(['chat-1\u0000run-continuation']),
      assistantRuns: { generationIfActive },
      closeTab,
      destroyView,
      getConfig: () => ({ browser: { idleDiscardMinutes: 10 } }),
      mountedConversationId: null,
      tabs: new Map<string, unknown>([
        [liveAssistantTab.shell.id, liveAssistantTab],
        [staleAssistantTab.shell.id, staleAssistantTab],
        [continuationAssistantTab.shell.id, continuationAssistantTab],
        [controlledUserTab.shell.id, controlledUserTab],
      ]),
    });

    invokePrivate(manager, 'discardIdleTabs');

    expect(closeTab).toHaveBeenCalledOnce();
    expect(closeTab).toHaveBeenCalledWith(staleAssistantTab);
    expect(destroyView).not.toHaveBeenCalled();
    expect(generationIfActive).toHaveBeenCalledWith('chat-1', 'run-live');
  });

  it('binds assistant document leases to the host realm and assistant run', () => {
    const tab = {
      shell: { id: 'tab-1', url: 'https://example.com' },
      generation: 4,
      trustedUserNavigationLease: 2,
      aiControlOwnerId: 'run-1',
      aiControlGeneration: 7,
    };
    const manager = managerWithoutConstructor({
      hostRendererAuthorityAvailable: true,
      hostRendererAuthorityGeneration: 5,
      tabs: new Map([[tab.shell.id, tab]]),
    });
    const lease = {
      runId: 'run-1',
      runGeneration: 7,
      hostRendererAuthorityGeneration: 5,
      tabGeneration: 4,
      userNavigationLease: 2,
      url: 'https://example.com',
    };

    expect(() => invokePrivate(manager, 'assertAssistantDocumentLease', tab, lease)).not.toThrow();
    Reflect.set(manager, 'hostRendererAuthorityAvailable', false);
    expect(() => invokePrivate(manager, 'assertAssistantDocumentLease', tab, lease)).toThrow(/Kai renderer changed/);
    Reflect.set(manager, 'hostRendererAuthorityAvailable', true);
    tab.aiControlGeneration = 8;
    expect(() => invokePrivate(manager, 'assertAssistantDocumentLease', tab, lease)).toThrow(
      /assistant browser turn ended/,
    );
    tab.aiControlGeneration = 7;
    tab.generation++;
    expect(() => invokePrivate(manager, 'assertAssistantDocumentLease', tab, lease)).toThrow(/page navigated/);
  });

  it('prevents a queued renderer operation from starting after its host authority expires', async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const sideEffect = vi.fn(async () => undefined);
    const manager = managerWithoutConstructor({
      clearingScopes: new Set<string>(),
      hostRendererAuthorityAvailable: true,
      hostRendererAuthorityGeneration: 4,
      hostRendererOperationContext: new AsyncLocalStorage(),
      hostRendererOperationControllers: new Set<AbortController>(),
      scopeActivityCounts: new Map<string, number>(),
      scopeIdleWaiters: new Map<string, Set<() => void>>(),
      suspendedScopes: new Set<string>(),
    });

    const pending = manager.runHostRendererOperation(4, async () => {
      entered.resolve();
      await gate.promise;
      return invokePrivate(manager, 'withScopeActivity', 'global', sideEffect) as Promise<void>;
    });
    await entered.promise;
    Reflect.set(manager, 'hostRendererAuthorityAvailable', false);
    Reflect.set(manager, 'hostRendererAuthorityGeneration', 5);
    gate.resolve();

    await expect(pending).rejects.toThrow(/renderer changed/);
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('publishes a terminal empty tab state when a conversation is removed', async () => {
    const emitTabs = vi.fn();
    const closeTab = vi.fn();
    const cancelOpenTabDownload = vi.fn(async () => undefined);
    const cancelClosedTabDownload = vi.fn(async () => undefined);
    const cancelOtherConversationDownload = vi.fn(async () => undefined);
    const manager = managerWithoutConstructor({
      activeDownloads: new Map([
        [
          {},
          {
            conversationId: 'chat-removed',
            tabId: 'tab-1',
            cancel: cancelOpenTabDownload,
          },
        ],
        [
          {},
          {
            conversationId: 'chat-removed',
            tabId: 'tab-already-closed',
            cancel: cancelClosedTabDownload,
          },
        ],
        [
          {},
          {
            conversationId: 'chat-kept',
            tabId: 'tab-other-conversation',
            cancel: cancelOtherConversationDownload,
          },
        ],
      ]),
      activeTabs: new Map([['chat-removed', 'tab-1']]),
      appHome: '/tmp/kai-browser-no-profile-for-removed-chat',
      assistantRuns: { endConversation: vi.fn(async () => undefined) },
      closedTabs: new Map(),
      closeTab,
      emitTabs,
      removedConversations: new Set(),
      tabOrder: new Map([['chat-removed', ['tab-1']]]),
      tabs: new Map([
        [
          'tab-1',
          {
            scopeKey: 'global',
            shell: { id: 'tab-1', conversationId: 'chat-removed' },
          },
        ],
      ]),
    });

    await manager.removeConversation('chat-removed');

    expect(closeTab).toHaveBeenCalledOnce();
    expect(cancelOpenTabDownload).toHaveBeenCalledOnce();
    expect(cancelClosedTabDownload).toHaveBeenCalledOnce();
    expect(cancelOtherConversationDownload).not.toHaveBeenCalled();
    expect(emitTabs).toHaveBeenCalledWith('chat-removed');
    expect((manager as unknown as { tabOrder: Map<string, string[]> }).tabOrder.has('chat-removed')).toBe(false);
    expect((manager as unknown as { removedConversations: Set<string> }).removedConversations.has('chat-removed')).toBe(
      true,
    );
  });

  it('retains every removed-conversation fence for the manager lifetime', () => {
    const manager = managerWithoutConstructor({ removedConversations: new Set<string>() });

    for (let index = 0; index < 1_025; index += 1) {
      invokePrivate(manager, 'fenceRemovedConversation', `chat-${index}`);
    }

    const fences = Reflect.get(manager, 'removedConversations') as Set<string>;
    expect(fences.size).toBe(1_025);
    expect(fences.has('chat-0')).toBe(true);
    expect(fences.has('chat-1')).toBe(true);
    expect(fences.has('chat-1024')).toBe(true);

    invokePrivate(manager, 'fenceRemovedConversation', 'chat-1');
    invokePrivate(manager, 'fenceRemovedConversation', 'chat-1025');
    expect(fences.size).toBe(1_026);
    expect(fences.has('chat-1')).toBe(true);
    expect(fences.has('chat-2')).toBe(true);
    expect(fences.has('chat-1025')).toBe(true);
  });

  it('rejects delayed metadata and vault calls after a conversation is deleted', () => {
    const storeForScope = vi.fn();
    const vaultForScope = vi.fn();
    const manager = managerWithoutConstructor({
      dataScope: 'conversation',
      removedConversations: new Set(['chat-removed']),
      storeForScope,
      vaultForScope,
    });

    expect(() => manager.listHistory('chat-removed')).toThrow(/conversation was deleted/i);
    expect(() => manager.listCredentials('chat-removed')).toThrow(/conversation was deleted/i);
    expect(storeForScope).not.toHaveBeenCalled();
    expect(vaultForScope).not.toHaveBeenCalled();
  });

  it('releases an idle profile runtime when its last tab closes', async () => {
    const scopeKey = 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa';
    const tab = {
      scopeKey,
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        url: 'https://example.com',
        title: 'Example',
        owner: 'user' as const,
        keepOpen: false,
        sensitive: false,
      },
    };
    const releaseScopeRuntime = vi.fn();
    const flush = vi.fn(async () => undefined);
    const stopRunningServiceWorkers = vi.fn(async () => undefined);
    const closeAllConnections = vi.fn(async () => undefined);
    const waitForScopeIdle = vi.fn(async () => undefined);
    const scopedSession = { closeAllConnections };
    const manager = managerWithoutConstructor({
      attachActiveView: vi.fn(),
      destroyView: vi.fn(),
      dropPendingForTab: vi.fn(),
      releaseScopeRuntime,
      stores: new Map([[scopeKey, { flush }]]),
      stopRunningServiceWorkers,
      tabOrder: new Map([['chat-1', [tab.shell.id]]]),
      tabs: new Map([[tab.shell.id, tab]]),
      wiredSessionsByScope: new Map([[scopeKey, scopedSession]]),
      waitForScopeIdle,
    });

    invokePrivate(manager, 'closeTab', tab, false, false);

    expect((Reflect.get(manager, 'tabs') as Map<string, unknown>).size).toBe(0);
    await vi.waitFor(() => expect(releaseScopeRuntime).toHaveBeenCalledOnce());
    expect(stopRunningServiceWorkers).toHaveBeenCalledWith(scopedSession, undefined, true);
    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(stopRunningServiceWorkers.mock.invocationCallOrder[0]).toBeLessThan(
      waitForScopeIdle.mock.invocationCallOrder[0],
    );
    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(releaseScopeRuntime.mock.invocationCallOrder[0]);
    expect(releaseScopeRuntime).toHaveBeenCalledWith(scopeKey, true);
  });

  it('retains persistent-session request guards when releasing the last idle tab', () => {
    const scopeKey = 'conversation-bbbbbbbbbbbbbbbbbbbbbbbb';
    const cleanupSession = vi.fn();
    const disposeVault = vi.fn();
    const scopedSession = {};
    const restrictedBackgroundScopes = new Set([scopeKey]);
    const assistantControlledOrigins = new Map([[scopeKey, new Set(['https://assistant.example'])]]);
    const wiredSessionsByScope = new Map([[scopeKey, scopedSession]]);
    const wiredSessionCleanups = new Map([[scopeKey, cleanupSession]]);
    const suspendedScopes = new Set([scopeKey]);
    const manager = managerWithoutConstructor({
      assistantControlledOrigins,
      restrictedBackgroundScopes,
      stores: new Map([[scopeKey, {}]]),
      suspendedScopes,
      tabs: new Map(),
      vaults: new Map([[scopeKey, { dispose: disposeVault }]]),
      wiredSessionCleanups,
      wiredSessionsByScope,
    });

    invokePrivate(manager, 'releaseScopeRuntime', scopeKey, true);

    expect(cleanupSession).not.toHaveBeenCalled();
    expect(wiredSessionsByScope.get(scopeKey)).toBe(scopedSession);
    expect(wiredSessionCleanups.get(scopeKey)).toBe(cleanupSession);
    expect(restrictedBackgroundScopes.has(scopeKey)).toBe(true);
    expect(assistantControlledOrigins.has(scopeKey)).toBe(true);
    expect(suspendedScopes.has(scopeKey)).toBe(true);
    expect(disposeVault).toHaveBeenCalledOnce();
    expect((Reflect.get(manager, 'stores') as Map<string, unknown>).has(scopeKey)).toBe(false);
  });

  it('hydrates pending-clear quarantine before any profile API wires a Session', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-startup-quarantine-'));
    markPendingBrowserCleanupScopeKey(appHome, 'global');
    const manager = new BrowserManager(
      appHome,
      () =>
        ({
          browser: {
            dataScope: 'global',
            enabled: true,
            structuredActions: 'allow',
            scriptInjection: 'allow',
            passwordAccess: 'user-only',
            aiAllowPrivateNetwork: false,
            idleDiscardMinutes: 10,
          },
        }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    try {
      expect((Reflect.get(manager, 'clearQuarantinedScopes') as Set<string>).has('global')).toBe(true);
      expect(() => invokePrivate(manager, 'store', 'chat-before-view')).toThrow(/quarantined/i);
      expect((Reflect.get(manager, 'stores') as Map<string, unknown>).size).toBe(0);
    } finally {
      manager.dispose();
      rmSync(appHome, { recursive: true, force: true });
    }
  });

  it('retains an idle profile runtime when its final metadata flush fails', async () => {
    const scopeKey = 'conversation-cccccccccccccccccccccccc';
    const releaseScopeRuntime = vi.fn();
    const flush = vi.fn(async () => {
      throw new Error('profile write failed');
    });
    const manager = managerWithoutConstructor({
      releaseScopeRuntime,
      stopRunningServiceWorkers: vi.fn(async () => undefined),
      stores: new Map([[scopeKey, { flush }]]),
      tabs: new Map(),
      wiredSessionsByScope: new Map([[scopeKey, { closeAllConnections: vi.fn(async () => undefined) }]]),
    });

    invokePrivate(manager, 'releaseScopeRuntimeWhenIdle', scopeKey);

    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    expect(releaseScopeRuntime).not.toHaveBeenCalled();
    expect((Reflect.get(manager, 'stores') as Map<string, unknown>).has(scopeKey)).toBe(true);
  });

  it('retains an idle profile runtime until its active download finishes', async () => {
    const scopeKey = 'global';
    const stopRunningServiceWorkers = vi.fn(async () => undefined);
    const manager = managerWithoutConstructor({
      activeDownloads: new Map([[{}, { scopeKey }]]),
      releaseScopeRuntime: vi.fn(),
      stopRunningServiceWorkers,
      tabs: new Map(),
      wiredSessionsByScope: new Map([[scopeKey, { closeAllConnections: vi.fn(async () => undefined) }]]),
    });

    invokePrivate(manager, 'releaseScopeRuntimeWhenIdle', scopeKey);
    await vi.waitFor(() => expect(Reflect.get(manager, 'scopeRuntimeReleaseTokens')).toHaveLength(0));

    expect(stopRunningServiceWorkers).not.toHaveBeenCalled();
    expect(Reflect.get(manager, 'releaseScopeRuntime')).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled Browser', 'global', { dataScope: 'global', enabled: false }, false],
    ['deselected profile mode', 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa', { dataScope: 'global', enabled: true }, false],
    [
      'suspended selected profile',
      'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
      { dataScope: 'conversation', enabled: true },
      true,
    ],
  ])('does not release an idle runtime for a %s', async (_label, scopeKey, browserConfig, suspended) => {
    const releaseScopeRuntime = vi.fn();
    const stopRunningServiceWorkers = vi.fn(async () => undefined);
    const manager = managerWithoutConstructor({
      getConfig: () => ({ browser: browserConfig }),
      releaseScopeRuntime,
      stopRunningServiceWorkers,
      suspendedScopes: new Set(suspended ? [scopeKey] : []),
      tabs: new Map(),
      wiredSessionsByScope: new Map([[scopeKey, { closeAllConnections: vi.fn(async () => undefined) }]]),
    });

    invokePrivate(manager, 'releaseScopeRuntimeWhenIdle', scopeKey);
    await vi.waitFor(() => expect(Reflect.get(manager, 'scopeRuntimeReleaseTokens')).toHaveLength(0));

    expect(stopRunningServiceWorkers).not.toHaveBeenCalled();
    expect(releaseScopeRuntime).not.toHaveBeenCalled();
  });

  it('invalidates and suspends a pending idle release during config preemption', async () => {
    const scopeKey = 'global';
    const scopedSession = { closeAllConnections: vi.fn(async () => undefined) };
    electronMocks.fromPartition.mockReturnValue(scopedSession);
    const manager = managerWithoutConstructor({
      browserEnabled: true,
      dataScope: 'global',
      getConfig: () => ({ browser: { dataScope: 'global', enabled: false } }),
      scopeRuntimeReleaseTokens: new Map([[scopeKey, {}]]),
      stopRunningServiceWorkers: vi.fn(async () => undefined),
      wiredSessionsByScope: new Map(),
    });

    const preemption = invokePrivate(manager, 'preemptBrowserConfigTransition', {
      dataScope: 'global',
      enabled: false,
      structuredActions: 'allow',
      scriptInjection: 'allow',
      passwordAccess: 'user-only',
      aiAllowPrivateNetwork: false,
    }) as { connectionDrain: Promise<void>; scopeKeys: Set<string> };

    expect(Reflect.get(manager, 'scopeRuntimeReleaseTokens')).toHaveLength(0);
    expect(preemption.scopeKeys).toContain(scopeKey);
    expect((Reflect.get(manager, 'suspendedScopes') as Set<string>).has(scopeKey)).toBe(true);
    await preemption.connectionDrain;
  });

  it('releases every runtime resource owned by a deleted conversation profile', () => {
    const scopeKey = 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa';
    const cleanupSession = vi.fn();
    const disposeVault = vi.fn();
    const scopedSession = {};
    const wiredSessions = new WeakSet([scopedSession]);
    const manager = managerWithoutConstructor({
      assistantControlledOrigins: new Map([[scopeKey, new Set(['https://example.com'])]]),
      restrictedBackgroundScopes: new Set([scopeKey]),
      scopeActivityCounts: new Map([[scopeKey, 0]]),
      scopeGenerations: new Map([[scopeKey, 2]]),
      scopeIdleWaiters: new Map([[scopeKey, new Set()]]),
      scopeRequestActivities: new Map([[scopeKey, new Map()]]),
      stores: new Map([[scopeKey, {}]]),
      suspendedScopes: new Set([scopeKey]),
      tabs: new Map(),
      vaults: new Map([[scopeKey, { dispose: disposeVault }]]),
      wiredSessionCleanups: new Map([[scopeKey, cleanupSession]]),
      wiredSessions,
      wiredSessionsByScope: new Map([[scopeKey, scopedSession]]),
    });

    invokePrivate(manager, 'releaseScopeRuntime', scopeKey);

    expect(cleanupSession).toHaveBeenCalledOnce();
    expect(disposeVault).toHaveBeenCalledOnce();
    for (const property of [
      'assistantControlledOrigins',
      'scopeActivityCounts',
      'scopeGenerations',
      'scopeIdleWaiters',
      'scopeRequestActivities',
      'stores',
      'vaults',
      'wiredSessionCleanups',
      'wiredSessionsByScope',
    ]) {
      expect((Reflect.get(manager, property) as Map<string, unknown>).has(scopeKey)).toBe(false);
    }
    expect((Reflect.get(manager, 'restrictedBackgroundScopes') as Set<string>).has(scopeKey)).toBe(false);
    expect((Reflect.get(manager, 'suspendedScopes') as Set<string>).has(scopeKey)).toBe(false);
    expect(wiredSessions.has(scopedSession)).toBe(false);
  });

  it('never reuses a released scope generation for delayed request callbacks', () => {
    const scopeKey = 'conversation-bbbbbbbbbbbbbbbbbbbbbbbb';
    const manager = managerWithoutConstructor({ tabs: new Map() });

    const beforeClear = invokePrivate(manager, 'currentScopeGeneration', scopeKey);
    const duringClear = invokePrivate(manager, 'bumpScopeGeneration', scopeKey);
    invokePrivate(manager, 'releaseScopeRuntime', scopeKey);
    const afterRelease = invokePrivate(manager, 'currentScopeGeneration', scopeKey);

    expect(beforeClear).toBe(1);
    expect(duringClear).toBe(2);
    expect(afterRelease).toBe(3);
  });

  it('unregisters all session hooks only after graceful disposal quiesces sessions', async () => {
    const cleanupGlobal = vi.fn();
    const cleanupConversation = vi.fn();
    const flush = vi.fn(async () => undefined);
    const disposeVault = vi.fn();
    const idleTimer = setInterval(() => undefined, 60_000);
    const manager = managerWithoutConstructor({
      activeDownloads: new Map(),
      activeTabs: new Map(),
      assistantContinuationLeases: new Set(),
      assistantRuns: { clear: vi.fn() },
      automationGestureTokens: new Map(),
      pendingSyntheticInputs: new Map(),
      cancelActiveDownloadsForScopes: vi.fn(async () => undefined),
      closedTabs: new Map(),
      detachAttachedView: vi.fn(),
      faviconFetches: new Map(),
      idleTimer,
      pendingAssistantContinuations: new Map(),
      stores: new Map([['global', { flush }]]),
      tabOrder: new Map(),
      tabs: new Map(),
      vaults: new Map([['global', { dispose: disposeVault }]]),
      wiredSessionCleanups: new Map([
        ['global', cleanupGlobal],
        ['conversation-aaaaaaaaaaaaaaaaaaaaaaaa', cleanupConversation],
      ]),
      wiredSessionsByScope: new Map([
        [
          'global',
          { closeAllConnections: vi.fn(async () => undefined), serviceWorkers: { getAllRunning: () => ({}) } },
        ],
        [
          'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
          { closeAllConnections: vi.fn(async () => undefined), serviceWorkers: { getAllRunning: () => ({}) } },
        ],
      ]),
    });

    await manager.shutdown();

    expect(cleanupGlobal).toHaveBeenCalledOnce();
    expect(cleanupConversation).toHaveBeenCalledOnce();
    expect(disposeVault).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect((Reflect.get(manager, 'wiredSessionCleanups') as Map<string, unknown>).size).toBe(0);
    expect((Reflect.get(manager, 'wiredSessionsByScope') as Map<string, unknown>).size).toBe(0);
    expect((Reflect.get(manager, 'stores') as Map<string, unknown>).size).toBe(0);
    expect((Reflect.get(manager, 'vaults') as Map<string, unknown>).size).toBe(0);
  });

  it('does not let a stale BrowserPanel mount recreate tabs for a removed conversation', async () => {
    const createTab = vi.fn();
    const manager = managerWithoutConstructor({
      createTab,
      getConfig: () => ({ browser: { enabled: true } }),
      mountedBounds: null,
      mountedConversationId: null,
      removedConversations: new Set(['chat-removed']),
    });

    await manager.mount('chat-removed', {
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });

    expect(createTab).not.toHaveBeenCalled();
    expect((manager as unknown as { mountedConversationId: string | null }).mountedConversationId).toBeNull();
  });

  it('rejects tabs and profile APIs when the durable conversation record is missing', async () => {
    const manager = managerWithoutConstructor({
      conversationExists: vi.fn(() => false),
      requireLiveWindow: vi.fn(),
    });

    await expect(
      manager.createTab({ conversationId: 'chat-missing', owner: 'user', url: 'about:blank' }),
    ).rejects.toThrow(/deleted or no longer exists/i);
    expect(() => manager.listHistory('chat-missing')).toThrow(/deleted or no longer exists/i);
    expect(Reflect.get(manager, 'removedConversations')).toContain('chat-missing');
  });

  it('keeps a mounted conversation empty after its final tab closes', async () => {
    const createTab = vi.fn();
    const detachAttachedView = vi.fn();
    const manager = managerWithoutConstructor({
      activeTabs: new Map(),
      createTab,
      detachAttachedView,
      emitPendingPrompts: vi.fn(),
      getConfig: () => ({ browser: { enabled: true } }),
      getWindow: () => ({
        isDestroyed: () => false,
        getContentBounds: () => ({ width: 800, height: 600 }),
      }),
      mountedBounds: null,
      mountedConversationId: null,
      removedConversations: new Set(),
      tabs: new Map(),
    });

    await manager.mount('chat-empty', {
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });

    expect(createTab).not.toHaveBeenCalled();
    expect(detachAttachedView).toHaveBeenCalledOnce();
    expect(Reflect.get(manager, 'mountedConversationId')).toBe('chat-empty');
  });

  it('restores a mounted discarded neighbor after the active tab closes', async () => {
    let finishRestore!: () => void;
    const closingTab = {
      scopeKey: 'global',
      shell: {
        id: 'tab-closing',
        conversationId: 'chat-1',
        url: 'https://closing.example',
        title: 'Closing',
        owner: 'user' as const,
        keepOpen: false,
        sensitive: false,
      },
    };
    const discardedTab = {
      scopeKey: 'global',
      shell: {
        id: 'tab-discarded',
        conversationId: 'chat-1',
        url: 'https://discarded.example',
        title: 'Discarded',
        owner: 'user' as const,
        keepOpen: false,
        sensitive: false,
        discarded: true,
        reloadRequired: false,
      },
      view: null,
      scriptTainted: false,
      privateNetworkNewDocumentGuard: false,
    };
    const ensureView = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRestore = resolve;
        }),
    );
    const attachActiveView = vi.fn();
    const notifyPanelStateChanged = vi.fn();
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', closingTab.shell.id]]),
      attachActiveView,
      browserEnabled: true,
      destroyView: vi.fn(),
      dropPendingForTab: vi.fn(),
      emitTabs: vi.fn(),
      ensureView,
      mountedBounds: { x: 10, y: 20, width: 300, height: 200 },
      mountedConversationId: 'chat-1',
      notifyPanelStateChanged,
      releaseScopeRuntimeWhenIdle: vi.fn(),
      tabOrder: new Map([['chat-1', [closingTab.shell.id, discardedTab.shell.id]]]),
      tabs: new Map([
        [closingTab.shell.id, closingTab],
        [discardedTab.shell.id, discardedTab],
      ]),
    });

    invokePrivate(manager, 'closeTab', closingTab);

    expect(Reflect.get(manager, 'activeTabs').get('chat-1')).toBe(discardedTab.shell.id);
    expect(ensureView).toHaveBeenCalledWith(discardedTab);
    expect(attachActiveView).not.toHaveBeenCalled();

    finishRestore();
    await vi.waitFor(() => expect(attachActiveView).toHaveBeenCalledWith('chat-1'));
    expect(notifyPanelStateChanged).toHaveBeenCalledWith('chat-1');
  });

  it('contains failed scope remounts and propagates find view-creation failures', async () => {
    electronMocks.fromPartition.mockReturnValue({
      closeAllConnections: vi.fn(async () => undefined),
      serviceWorkers: { getAllRunning: () => ({}) },
    });
    const tab = {
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        discarded: false,
        error: undefined as string | undefined,
        sensitive: false,
        zoomLevel: 0,
      },
      view: null,
      queue: { whenIdle: vi.fn(async () => undefined) },
    };
    const ensureView = vi.fn(async () => {
      throw new Error('net::ERR_NAME_NOT_RESOLVED');
    });
    const emitTabs = vi.fn();
    const manager = managerWithoutConstructor({
      activeDownloads: new Map(),
      activeTabs: new Map([['chat-1', 'tab-1']]),
      browserEnabled: true,
      profileMutationTail: Promise.resolve(),
      dataScope: 'global',
      destroyView: vi.fn(),
      emitBookmarks: vi.fn(),
      emitTabs,
      ensureView,
      mountedConversationId: 'chat-1',
      scopeActivityCounts: new Map(),
      scopeGenerations: new Map(),
      scopeIdleWaiters: new Map(),
      scopeRequestActivities: new Map(),
      storeForScope: vi.fn(() => ({ getZoomLevel: () => 0 })),
      suspendedScopes: new Set(),
      tabs: new Map([['tab-1', tab]]),
      wiredSessionsByScope: new Map(),
    });

    await manager.handleConfigChanged({
      dataScope: 'conversation',
      enabled: true,
    } as never);
    await vi.waitFor(() => expect(tab.shell.error).toBe('net::ERR_NAME_NOT_RESOLVED'));
    expect(tab.shell.error).toBe('net::ERR_NAME_NOT_RESOLVED');
    expect(tab.shell.discarded).toBe(true);

    await expect(manager.find('chat-1', 'tab-1', 'needle', true, false, 1)).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
  });

  it('quiesces the old session and downloads before completing a data-scope transition', async () => {
    let finishConnections!: () => void;
    let finishDownload!: () => void;
    const closeAllConnections = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishConnections = resolve;
        }),
    );
    electronMocks.fromPartition.mockReturnValue({ closeAllConnections });
    const downloadItem = {};
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve;
        }),
    );
    const tab = {
      partition: 'persist:kai-browser-global',
      scopeKey: 'global',
      shell: {
        id: 'tab-1',
        conversationId: 'chat-1',
        title: 'Reset account',
        url: 'https://example.com/reset?token=profile-secret',
        discarded: false,
        loading: false,
        audible: false,
        canGoBack: true,
        canGoForward: false,
        reloadRequired: false,
        security: 'secure' as const,
        sensitive: true,
        zoomLevel: 0,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      view: { webContents: {} },
      queue: { whenIdle: vi.fn(async () => undefined) },
    };
    const stopRunningServiceWorkers = vi.fn(async () => undefined);
    const emit = vi.fn();
    const manager = managerWithoutConstructor({
      activeDownloads: new Map([
        [
          downloadItem,
          {
            scopeKey: 'global',
            item: downloadItem,
            cancel,
            done: Promise.resolve(),
          },
        ],
      ]),
      activeTabs: new Map([['chat-1', 'tab-1']]),
      browserEnabled: true,
      closedTabs: new Map([
        [
          'chat-1',
          [
            {
              id: 'closed-1',
              url: 'https://example.com/closed?token=profile-secret',
              title: 'Closed secret',
              owner: 'user',
              keepOpen: false,
              sensitive: false,
              scopeKey: 'global',
            },
          ],
        ],
      ]),
      profileMutationTail: Promise.resolve(),
      dataScope: 'global',
      disposed: false,
      destroyView: vi.fn((target: typeof tab) => {
        target.view = null as unknown as typeof tab.view;
      }),
      emit,
      emitBookmarks: vi.fn(),
      emitTabs: vi.fn(),
      mountedConversationId: null,
      scopeActivityCounts: new Map(),
      scopeGenerations: new Map(),
      scopeIdleWaiters: new Map(),
      scopeRequestActivities: new Map(),
      stopRunningServiceWorkers,
      storeForScope: vi.fn(() => ({ getZoomLevel: () => 0 })),
      suspendedScopes: new Set(),
      tabs: new Map([['tab-1', tab]]),
      wiredSessionsByScope: new Map(),
    });

    const transition = manager.handleConfigChanged({
      dataScope: 'conversation',
      enabled: true,
    } as never);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());

    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(stopRunningServiceWorkers).toHaveBeenCalledOnce();
    expect(Reflect.get(manager, 'scopeGenerations')).toEqual(new Map([['global', 1]]));
    expect(tab.scopeKey).toBe('global');
    expect(emit).not.toHaveBeenCalled();

    finishConnections();
    finishDownload();
    await transition;

    expect(tab.scopeKey).toMatch(/^conversation-[a-f0-9]{24}$/);
    expect(tab.partition).toMatch(/^persist:.*-browser-conversation-[a-f0-9]{24}$/);
    expect(tab.shell.url).toBe('about:blank');
    expect(tab.shell.title).toBe('New Tab');
    expect(Reflect.get(manager, 'closedTabs').has('chat-1')).toBe(false);
    expect(Reflect.get(manager, 'suspendedScopes')).toContain('global');
    expect(Reflect.get(manager, 'suspendedScopes')).not.toContain(tab.scopeKey);
    expect(emit).toHaveBeenCalledWith({
      type: 'profile-scope-changed',
      dataScope: 'conversation',
    });
  });

  it.each([
    ['service-worker shutdown', true],
    ['connection shutdown', false],
  ])('does not commit a preempted config transition when %s fails', async (_label, failWorkerStop) => {
    const networkFailure = new Error('network quiescence failed');
    const stopRunningServiceWorkers = failWorkerStop
      ? vi.fn().mockRejectedValue(networkFailure)
      : vi.fn(async () => undefined);
    const scopedSession = {
      closeAllConnections: failWorkerStop ? vi.fn(async () => undefined) : vi.fn().mockRejectedValue(networkFailure),
    };
    const finishAllScopeRequestActivities = vi.fn();
    const tab = {
      scopeKey: 'global',
      shell: { id: 'tab-1', conversationId: 'chat-1', discarded: false, sensitive: false },
      view: { webContents: { id: 42 } },
      queue: { whenIdle: vi.fn(async () => undefined) },
    };
    const manager = managerWithoutConstructor({
      cancelActiveDownloadsForScopes: vi.fn(async () => undefined),
      destroyView: vi.fn(),
      emitTabs: vi.fn(),
      finishAllScopeRequestActivities,
      profileMutationTail: Promise.resolve(),
      stopRunningServiceWorkers,
      tabs: new Map([['tab-1', tab]]),
      wiredSessionsByScope: new Map([['global', scopedSession]]),
    });

    await expect(manager.handleConfigChanged({ dataScope: 'conversation', enabled: true } as never)).rejects.toThrow(
      'Browser network quiescence failed during a config transition.',
    );

    expect(stopRunningServiceWorkers).toHaveBeenCalledWith(scopedSession, undefined, true);
    expect(scopedSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(finishAllScopeRequestActivities).not.toHaveBeenCalled();
    expect(Reflect.get(manager, 'dataScope')).toBe('global');
    expect(Reflect.get(manager, 'suspendedScopes')).toContain('global');
  });

  it.each([
    ['service-worker shutdown', true],
    ['connection shutdown', false],
  ])('does not commit an unpreempted config application when %s fails', async (_label, failWorkerStop) => {
    const networkFailure = new Error('network quiescence failed');
    const stopRunningServiceWorkers = failWorkerStop
      ? vi.fn().mockRejectedValue(networkFailure)
      : vi.fn(async () => undefined);
    const scopedSession = {
      closeAllConnections: failWorkerStop ? vi.fn(async () => undefined) : vi.fn().mockRejectedValue(networkFailure),
    };
    const finishAllScopeRequestActivities = vi.fn();
    const tab = {
      scopeKey: 'global',
      shell: { id: 'tab-1', conversationId: 'chat-1', discarded: false, sensitive: false },
      view: { webContents: { id: 42 } },
      queue: { whenIdle: vi.fn(async () => undefined) },
    };
    const manager = managerWithoutConstructor({
      cancelActiveDownloadsForScopes: vi.fn(async () => undefined),
      destroyView: vi.fn(),
      emitTabs: vi.fn(),
      finishAllScopeRequestActivities,
      stopRunningServiceWorkers,
      tabs: new Map([['tab-1', tab]]),
      wiredSessionsByScope: new Map([['global', scopedSession]]),
    });

    await expect(
      invokePrivate(
        manager,
        'applyBrowserConfig',
        { dataScope: 'conversation', enabled: true },
        0,
        null,
      ) as Promise<void>,
    ).rejects.toThrow('Browser network quiescence failed during a config transition.');

    expect(stopRunningServiceWorkers).toHaveBeenCalledWith(scopedSession, undefined, true);
    expect(scopedSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(finishAllScopeRequestActivities).not.toHaveBeenCalled();
    expect(Reflect.get(manager, 'dataScope')).toBe('global');
    expect(Reflect.get(manager, 'suspendedScopes')).toContain('global');
  });

  it.each([
    {
      label: 'read access',
      initial: {},
      next: { readAccess: 'ask', structuredActions: 'allow', scriptInjection: 'allow', passwordAccess: 'user-only' },
    },
    {
      label: 'structured actions',
      initial: {},
      next: { readAccess: 'allow', structuredActions: 'ask', scriptInjection: 'allow', passwordAccess: 'user-only' },
    },
    {
      label: 'script injection',
      initial: {},
      next: { readAccess: 'allow', structuredActions: 'allow', scriptInjection: 'ask', passwordAccess: 'user-only' },
    },
    {
      label: 'password autofill',
      initial: { passwordAccessPolicy: 'automatic' },
      next: { readAccess: 'allow', structuredActions: 'allow', scriptInjection: 'allow', passwordAccess: 'ask' },
    },
  ] as const)(
    'revokes assistant authority without tearing down user activity when $label policy tightens',
    ({ initial, next }) => {
      const closeAllConnections = vi.fn(async () => undefined);
      const tab = {
        scopeKey: 'global',
        shell: { id: 'tab-1', conversationId: 'chat-1', discarded: false, sensitive: false },
        view: { webContents: {} },
        queue: new BrowserActionQueue(),
      };
      const destroyView = vi.fn();
      const cancelActiveDownloadsForScopes = vi.fn(async () => undefined);
      const revokeAssistantAccess = vi.fn();
      const manager = managerWithoutConstructor({
        ...initial,
        cancelActiveDownloadsForScopes,
        destroyView,
        emitTabs: vi.fn(),
        revokeAssistantAccess,
        stopRunningServiceWorkers: vi.fn(async () => undefined),
        tabs: new Map([['tab-1', tab]]),
        wiredSessionsByScope: new Map([['global', { closeAllConnections }]]),
      });

      const preemption = invokePrivate(manager, 'preemptBrowserConfigTransition', {
        dataScope: 'global',
        enabled: true,
        ...next,
        aiAllowPrivateNetwork: false,
      });

      expect(preemption).toBeNull();
      expect(revokeAssistantAccess).toHaveBeenCalledOnce();
      expect(destroyView).not.toHaveBeenCalled();
      expect(cancelActiveDownloadsForScopes).not.toHaveBeenCalled();
      expect(closeAllConnections).not.toHaveBeenCalled();
    },
  );

  it('tears down live renderers and connections when private-network AI access is tightened', async () => {
    const closeAllConnections = vi.fn(async () => undefined);
    const setWebRTCIPHandlingPolicy = vi.fn();
    const tab = {
      aiNetworkRestricted: true,
      scopeKey: 'global',
      shell: { id: 'tab-1', conversationId: 'chat-1', discarded: false, sensitive: false },
      view: { webContents: { isDestroyed: () => false, setWebRTCIPHandlingPolicy } },
    };
    const destroyView = vi.fn();
    const manager = managerWithoutConstructor({
      aiAllowPrivateNetwork: true,
      cancelActiveDownloadsForScopes: vi.fn(async () => undefined),
      destroyView,
      emitTabs: vi.fn(),
      stopRunningServiceWorkers: vi.fn(async () => undefined),
      tabs: new Map([['tab-1', tab]]),
      wiredSessionsByScope: new Map([['global', { closeAllConnections }]]),
    });

    const preemption = invokePrivate(manager, 'preemptBrowserConfigTransition', {
      dataScope: 'global',
      enabled: true,
      structuredActions: 'allow',
      scriptInjection: 'allow',
      passwordAccess: 'user-only',
      aiAllowPrivateNetwork: false,
    }) as { connectionDrain: Promise<void>; privateNetworkTightened: boolean };

    expect(preemption.privateNetworkTightened).toBe(true);
    expect(destroyView).toHaveBeenCalledWith(tab);
    expect(setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
    expect(tab.aiNetworkRestricted).toBe(true);
    await preemption.connectionDrain;
    expect(closeAllConnections).toHaveBeenCalledOnce();
  });

  it('publishes private-network tightening before a queued profile transition can admit a new scope', async () => {
    const queuedMutation = deferred<void>();
    const applyBrowserConfig = vi.fn(async () => undefined);
    const manager = managerWithoutConstructor({
      aiAllowPrivateNetwork: true,
      applyBrowserConfig,
      cancelActiveDownloadsForScopes: vi.fn(async () => undefined),
      dataScope: 'conversation',
      profileMutationTail: queuedMutation.promise,
    });

    const transition = manager.handleConfigChanged({
      dataScope: 'conversation',
      enabled: true,
      readAccess: 'allow',
      structuredActions: 'allow',
      scriptInjection: 'allow',
      passwordAccess: 'user-only',
      aiAllowPrivateNetwork: false,
    } as never);

    expect(applyBrowserConfig).not.toHaveBeenCalled();
    expect(Reflect.get(manager, 'aiAllowPrivateNetwork')).toBe(false);

    queuedMutation.resolve();
    await transition;
    expect(applyBrowserConfig).toHaveBeenCalledOnce();
  });

  it('does not let a superseded queued transition loosen the cached private-network policy', async () => {
    const queuedMutation = deferred<void>();
    const manager = managerWithoutConstructor({
      aiAllowPrivateNetwork: false,
      dataScope: 'conversation',
      profileMutationTail: queuedMutation.promise,
    });

    const staleAllow = manager.handleConfigChanged({
      dataScope: 'conversation',
      enabled: true,
      readAccess: 'allow',
      structuredActions: 'allow',
      scriptInjection: 'allow',
      passwordAccess: 'user-only',
      aiAllowPrivateNetwork: true,
    } as never);
    const latestDeny = manager.handleConfigChanged({
      dataScope: 'conversation',
      enabled: true,
      readAccess: 'allow',
      structuredActions: 'allow',
      scriptInjection: 'allow',
      passwordAccess: 'user-only',
      aiAllowPrivateNetwork: false,
    } as never);

    queuedMutation.resolve();
    await expect(staleAllow).resolves.toEqual({ committed: false });
    await expect(latestDeny).resolves.toEqual({ committed: true });

    expect(Reflect.get(manager, 'aiAllowPrivateNetwork')).toBe(false);
  });

  it('quiesces a wired session and active download during a no-tab scope transition', async () => {
    let finishConnections!: () => void;
    let finishDownload!: () => void;
    const closeAllConnections = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishConnections = resolve;
        }),
    );
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve;
        }),
    );
    const downloadItem = {};
    const scopedSession = { closeAllConnections };
    const manager = managerWithoutConstructor({
      activeDownloads: new Map([
        [
          downloadItem,
          {
            scopeKey: 'global',
            item: downloadItem,
            cancel,
            done: Promise.resolve(),
          },
        ],
      ]),
      browserEnabled: true,
      profileMutationTail: Promise.resolve(),
      dataScope: 'global',
      disposed: false,
      mountedConversationId: null,
      scopeActivityCounts: new Map(),
      scopeGenerations: new Map(),
      scopeIdleWaiters: new Map(),
      scopeRequestActivities: new Map(),
      stopRunningServiceWorkers: vi.fn(async () => undefined),
      suspendedScopes: new Set(),
      tabs: new Map(),
      wiredSessionsByScope: new Map([['global', scopedSession]]),
    });

    const transition = manager.handleConfigChanged({
      dataScope: 'conversation',
      enabled: true,
    } as never);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());

    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(Reflect.get(manager, 'scopeGenerations')).toEqual(new Map([['global', 1]]));
    expect(Reflect.get(manager, 'dataScope')).toBe('global');

    finishConnections();
    finishDownload();
    await transition;

    expect(Reflect.get(manager, 'dataScope')).toBe('conversation');
    expect(Reflect.get(manager, 'suspendedScopes')).toContain('global');
  });

  it('releases a previously suspended global profile after a no-tab scope round trip', async () => {
    const scopedSession = { closeAllConnections: vi.fn(async () => undefined) };
    const manager = managerWithoutConstructor({
      activeDownloads: new Map(),
      browserEnabled: true,
      profileMutationTail: Promise.resolve(),
      dataScope: 'global',
      disposed: false,
      mountedConversationId: null,
      scopeActivityCounts: new Map(),
      scopeGenerations: new Map(),
      scopeIdleWaiters: new Map(),
      scopeRequestActivities: new Map(),
      stopRunningServiceWorkers: vi.fn(async () => undefined),
      suspendedScopes: new Set(),
      tabs: new Map(),
      wiredSessionsByScope: new Map([['global', scopedSession]]),
    });

    await manager.handleConfigChanged({
      dataScope: 'conversation',
      enabled: true,
    } as never);
    expect(Reflect.get(manager, 'suspendedScopes')).toContain('global');

    await manager.handleConfigChanged({
      dataScope: 'global',
      enabled: true,
    } as never);

    expect(Reflect.get(manager, 'suspendedScopes')).not.toContain('global');
    expect(scopedSession.closeAllConnections).toHaveBeenCalledTimes(2);
  });

  it('reconciles and remounts two queued notifications for the same new data scope', async () => {
    const closeAllConnections = vi.fn(async () => undefined);
    electronMocks.fromPartition.mockReturnValue({ closeAllConnections });
    const attachActiveView = vi.fn();
    const emit = vi.fn();
    const emitBookmarks = vi.fn();
    const emitTabs = vi.fn();
    const view = { webContents: { isDestroyed: () => false } };
    const tab = {
      scopeKey: 'global',
      partition: 'persist:kai-browser-global',
      shell: { id: 'tab-1', conversationId: 'chat-1', discarded: false, sensitive: false },
      view,
      queue: { whenIdle: vi.fn(async () => undefined) },
    };
    const destroyView = vi.fn((target: typeof tab) => {
      target.view = null as unknown as typeof view;
      target.shell.discarded = true;
    });
    const ensureView = vi.fn(async (target: typeof tab) => {
      target.view = view;
      target.shell.discarded = false;
      return view;
    });
    const manager = managerWithoutConstructor({
      activeTabs: new Map([['chat-1', 'tab-1']]),
      attachActiveView,
      destroyView,
      emit,
      emitBookmarks,
      emitTabs,
      ensureView,
      mountedConversationId: 'chat-1',
      profileMutationTail: Promise.resolve(),
      stopRunningServiceWorkers: vi.fn(async () => undefined),
      storeForScope: vi.fn(() => ({ getZoomLevel: () => 1 })),
      tabs: new Map([['tab-1', tab]]),
      wiredSessionsByScope: new Map([['global', { closeAllConnections }]]),
    });

    const first = manager.handleConfigChanged({ dataScope: 'conversation', enabled: true } as never);
    const latest = manager.handleConfigChanged({ dataScope: 'conversation', enabled: true } as never);
    await Promise.all([first, latest]);
    await vi.waitFor(() => expect(attachActiveView).toHaveBeenCalledWith('chat-1'));

    expect(tab.scopeKey).toMatch(/^conversation-/);
    expect(tab.shell.discarded).toBe(false);
    expect(ensureView).toHaveBeenCalledWith(tab);
    expect(emitBookmarks).toHaveBeenCalledWith('chat-1');
    expect(emit).toHaveBeenCalledWith({ type: 'profile-scope-changed', dataScope: 'conversation' });
  });

  it('serializes data clearing behind a settings-driven profile transition', async () => {
    const transitionGate = deferred<void>();
    const applyBrowserConfig = vi.fn(() => transitionGate.promise);
    const clearDataLocked = vi.fn(async () => undefined);
    const manager = managerWithoutConstructor({
      applyBrowserConfig,
      clearDataLocked,
      disposed: false,
      profileMutationTail: Promise.resolve(),
      shuttingDown: false,
    });

    const transition = manager.handleConfigChanged({
      dataScope: 'conversation',
      enabled: true,
    } as never);
    const clearing = manager.clearData({ includeGlobal: true });
    await vi.waitFor(() => expect(applyBrowserConfig).toHaveBeenCalledOnce());
    expect(clearDataLocked).not.toHaveBeenCalled();

    transitionGate.resolve();
    await transition;
    await clearing;
    expect(clearDataLocked).toHaveBeenCalledWith({ includeGlobal: true });
  });

  it('gates and tears down the old profile before a queued config transition can run', async () => {
    const queuedMutation = deferred<void>();
    const closeAllConnections = vi.fn(async () => undefined);
    const stopRunningServiceWorkers = vi.fn(async () => undefined);
    const cancelActiveDownloadsForScopes = vi.fn(async () => undefined);
    const destroyView = vi.fn();
    const emitTabs = vi.fn();
    const applyBrowserConfig = vi.fn(async () => undefined);
    const tab = {
      scopeKey: 'global',
      shell: {
        conversationId: 'chat-1',
        discarded: false,
        sensitive: true,
      },
      view: { webContents: { id: 1 } },
    };
    const manager = managerWithoutConstructor({
      applyBrowserConfig,
      cancelActiveDownloadsForScopes,
      destroyView,
      emitTabs,
      profileMutationTail: queuedMutation.promise,
      stopRunningServiceWorkers,
      tabs: new Map([['tab-1', tab]]),
      wiredSessionsByScope: new Map([['global', { closeAllConnections }]]),
    });

    const transition = manager.handleConfigChanged({
      dataScope: 'conversation',
      enabled: true,
    } as never);

    expect(applyBrowserConfig).not.toHaveBeenCalled();
    expect(Reflect.get(manager, 'suspendedScopes')).toContain('global');
    expect(Reflect.get(manager, 'scopeGenerations')).toEqual(new Map([['global', 1]]));
    expect(stopRunningServiceWorkers).toHaveBeenCalledWith(
      expect.objectContaining({ closeAllConnections }),
      undefined,
      true,
    );
    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(cancelActiveDownloadsForScopes).toHaveBeenCalledWith(new Set(['global']));
    expect(destroyView).toHaveBeenCalledWith(tab);
    expect(tab.shell.discarded).toBe(true);
    expect(tab.shell.sensitive).toBe(false);
    expect(emitTabs).toHaveBeenCalledWith('chat-1');

    queuedMutation.resolve();
    await transition;
    expect(applyBrowserConfig).toHaveBeenCalledOnce();
  });

  it('stops running service workers with a temporary sandboxed view when no tab renderer is live', async () => {
    let attached = false;
    const debuggerApi = {
      isAttached: vi.fn(() => attached),
      attach: vi.fn(() => {
        attached = true;
      }),
      detach: vi.fn(() => {
        attached = false;
      }),
      sendCommand: vi.fn(async () => undefined),
    };
    const close = vi.fn();
    const webContents = {
      close,
      debugger: debuggerApi,
      isDestroyed: () => false,
    };
    electronMocks.webContentsView.mockReturnValue({ webContents });
    const scopedSession = {
      serviceWorkers: { getAllRunning: () => ({ 'worker-version-1': {} }) },
    };
    const manager = managerWithoutConstructor({});

    await invokePrivate(manager, 'stopRunningServiceWorkers', scopedSession);

    expect(electronMocks.webContentsView).toHaveBeenCalledWith({
      webPreferences: expect.objectContaining({
        session: scopedSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      }),
    });
    expect(debuggerApi.attach).toHaveBeenCalledWith('1.3');
    expect(debuggerApi.sendCommand).toHaveBeenNthCalledWith(1, 'ServiceWorker.enable');
    expect(debuggerApi.sendCommand).toHaveBeenNthCalledWith(2, 'ServiceWorker.stopWorker', {
      versionId: 'worker-version-1',
    });
    expect(debuggerApi.detach).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
  });

  it('stops service-worker versions sequentially instead of fanning out CDP commands', async () => {
    const firstStop = deferred<void>();
    let attached = false;
    const debuggerApi = {
      isAttached: vi.fn(() => attached),
      attach: vi.fn(() => {
        attached = true;
      }),
      detach: vi.fn(() => {
        attached = false;
      }),
      sendCommand: vi.fn(async (method: string, params?: { versionId?: string }) => {
        if (method === 'ServiceWorker.stopWorker' && params?.versionId === 'worker-version-1') {
          await firstStop.promise;
        }
      }),
    };
    const webContents = {
      close: vi.fn(),
      debugger: debuggerApi,
      isDestroyed: () => false,
    };
    electronMocks.webContentsView.mockReturnValue({ webContents });
    const scopedSession = {
      serviceWorkers: {
        getAllRunning: () => ({ 'worker-version-1': {}, 'worker-version-2': {} }),
      },
    };
    const manager = managerWithoutConstructor({});

    const stopping = invokePrivate(manager, 'stopRunningServiceWorkers', scopedSession) as Promise<void>;
    await vi.waitFor(() => expect(debuggerApi.sendCommand).toHaveBeenCalledTimes(2));
    expect(debuggerApi.sendCommand).not.toHaveBeenCalledWith('ServiceWorker.stopWorker', {
      versionId: 'worker-version-2',
    });

    firstStop.resolve();
    await stopping;

    expect(debuggerApi.sendCommand).toHaveBeenNthCalledWith(3, 'ServiceWorker.stopWorker', {
      versionId: 'worker-version-2',
    });
  });

  it('fails a required service-worker stop when CDP cannot stop every worker', async () => {
    let attached = false;
    const debuggerApi = {
      isAttached: vi.fn(() => attached),
      attach: vi.fn(() => {
        attached = true;
      }),
      detach: vi.fn(() => {
        attached = false;
      }),
      sendCommand: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('worker stop failed')),
    };
    const webContents = {
      close: vi.fn(),
      debugger: debuggerApi,
      isDestroyed: () => false,
    };
    electronMocks.webContentsView.mockReturnValue({ webContents });
    const scopedSession = {
      serviceWorkers: { getAllRunning: () => ({ 'worker-version-1': {} }) },
    };
    const manager = managerWithoutConstructor({});

    await expect(
      invokePrivate(manager, 'stopRunningServiceWorkers', scopedSession, undefined, true) as Promise<void>,
    ).rejects.toThrow('worker stop failed');

    expect(debuggerApi.detach).toHaveBeenCalledOnce();
    expect(webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
  });

  it('fails a required service-worker stop when a CDP command stalls', async () => {
    vi.useFakeTimers();
    let attached = false;
    const debuggerApi = {
      isAttached: vi.fn(() => attached),
      attach: vi.fn(() => {
        attached = true;
      }),
      detach: vi.fn(() => {
        attached = false;
      }),
      sendCommand: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => new Promise(() => undefined)),
    };
    const webContents = {
      close: vi.fn(),
      debugger: debuggerApi,
      isDestroyed: () => false,
    };
    electronMocks.webContentsView.mockReturnValue({ webContents });
    const scopedSession = {
      serviceWorkers: { getAllRunning: () => ({ 'worker-version-1': {} }) },
    };
    const manager = managerWithoutConstructor({});

    try {
      const stopping = invokePrivate(
        manager,
        'stopRunningServiceWorkers',
        scopedSession,
        undefined,
        true,
      ) as Promise<void>;
      const rejected = expect(stopping).rejects.toThrow(/ServiceWorker\.stopWorker.*deadline/);
      await vi.advanceTimersByTimeAsync(0);
      expect(debuggerApi.sendCommand).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(BROWSER_SERVICE_WORKER_COMMAND_TIMEOUT_MS);
      await rejected;
      expect(debuggerApi.detach).toHaveBeenCalledOnce();
      expect(webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Browser request guards and views alive until shutdown network drains complete', async () => {
    const workerStop = deferred<void>();
    const connectionDrain = deferred<void>();
    const cleanupSession = vi.fn();
    const destroyView = vi.fn();
    const stopRunningServiceWorkers = vi.fn(() => workerStop.promise);
    const contents = { id: 42 };
    const scopedSession = {
      closeAllConnections: vi.fn(() => connectionDrain.promise),
      serviceWorkers: { getAllRunning: () => ({}) },
    };
    const manager = new BrowserManager(
      '/tmp/kai-browser-shutdown-guard-test',
      () => ({ browser: { dataScope: 'global', enabled: true } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    Reflect.set(manager, 'stopRunningServiceWorkers', stopRunningServiceWorkers);
    Reflect.set(manager, 'destroyView', destroyView);
    Reflect.get(manager, 'wiredSessionsByScope').set('global', scopedSession);
    Reflect.get(manager, 'wiredSessionCleanups').set('global', cleanupSession);
    Reflect.get(manager, 'tabs').set('tab-1', {
      scopeKey: 'global',
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      view: { webContents: contents },
      queue: { whenIdle: vi.fn(async () => undefined) },
    });

    const shutdown = manager.shutdown();
    await vi.waitFor(() => expect(stopRunningServiceWorkers).toHaveBeenCalledWith(scopedSession, contents, true));
    expect(scopedSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(cleanupSession).not.toHaveBeenCalled();
    expect(destroyView).not.toHaveBeenCalled();

    workerStop.resolve();
    await Promise.resolve();
    expect(cleanupSession).not.toHaveBeenCalled();
    expect(destroyView).not.toHaveBeenCalled();

    connectionDrain.resolve();
    await shutdown;
    expect(cleanupSession).toHaveBeenCalledOnce();
    expect(destroyView).toHaveBeenCalledOnce();
  });

  it.each([
    ['service-worker shutdown', true],
    ['connection shutdown', false],
  ])('keeps Browser request guards and views alive when %s fails', async (_label, failWorkerStop) => {
    const networkFailure = new Error('network quiescence failed');
    const cleanupSession = vi.fn();
    const destroyView = vi.fn();
    const stopRunningServiceWorkers = failWorkerStop
      ? vi.fn().mockRejectedValue(networkFailure)
      : vi.fn(async () => undefined);
    const contents = { id: 42 };
    const scopedSession = {
      closeAllConnections: failWorkerStop ? vi.fn(async () => undefined) : vi.fn().mockRejectedValue(networkFailure),
      serviceWorkers: { getAllRunning: () => ({}) },
    };
    const manager = new BrowserManager(
      '/tmp/kai-browser-shutdown-failure-test',
      () => ({ browser: { dataScope: 'global', enabled: true } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    Reflect.set(manager, 'stopRunningServiceWorkers', stopRunningServiceWorkers);
    Reflect.set(manager, 'destroyView', destroyView);
    Reflect.get(manager, 'wiredSessionsByScope').set('global', scopedSession);
    Reflect.get(manager, 'wiredSessionCleanups').set('global', cleanupSession);
    const flush = vi.fn(async () => undefined);
    Reflect.get(manager, 'stores').set('global', { flush });
    const queueIdle = vi.fn(async () => undefined);
    const cancelDownload = vi.fn(async () => undefined);
    Reflect.get(manager, 'activeDownloads').set(
      {},
      {
        scopeKey: 'global',
        done: Promise.resolve(),
        cancel: cancelDownload,
      },
    );
    Reflect.get(manager, 'tabs').set('tab-1', {
      scopeKey: 'global',
      shell: { id: 'tab-1', conversationId: 'chat-1' },
      view: { webContents: contents },
      queue: { whenIdle: queueIdle },
    });

    try {
      await expect(manager.shutdown()).rejects.toThrow('Browser network quiescence failed during shutdown.');

      expect(stopRunningServiceWorkers).toHaveBeenCalledWith(scopedSession, contents, true);
      expect(scopedSession.closeAllConnections).toHaveBeenCalledOnce();
      expect(queueIdle).toHaveBeenCalledOnce();
      expect(cancelDownload).toHaveBeenCalledOnce();
      expect(flush).toHaveBeenCalledTimes(2);
      expect(cleanupSession).not.toHaveBeenCalled();
      expect(destroyView).not.toHaveBeenCalled();
      expect(Reflect.get(manager, 'disposed')).toBe(false);
      expect(Reflect.get(manager, 'shuttingDown')).toBe(false);
      expect(Reflect.get(manager, 'shutdownPromise')).toBeNull();
      expect(Reflect.get(manager, 'suspendedScopes')).not.toContain('global');
    } finally {
      manager.dispose();
    }
  });

  it('retries shutdown after a transient pre-teardown network failure', async () => {
    const stopRunningServiceWorkers = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary worker stop failure'))
      .mockResolvedValue(undefined);
    const cleanupSession = vi.fn();
    const scopedSession = {
      closeAllConnections: vi.fn(async () => undefined),
      serviceWorkers: { getAllRunning: () => ({}) },
    };
    const manager = new BrowserManager(
      '/tmp/kai-browser-shutdown-retry-test',
      () => ({ browser: { dataScope: 'global', enabled: true } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    Reflect.set(manager, 'stopRunningServiceWorkers', stopRunningServiceWorkers);
    Reflect.get(manager, 'wiredSessionsByScope').set('global', scopedSession);
    Reflect.get(manager, 'wiredSessionCleanups').set('global', cleanupSession);

    await expect(manager.shutdown()).rejects.toThrow('Browser network quiescence failed during shutdown.');
    await expect(manager.shutdown()).resolves.toBeUndefined();

    expect(stopRunningServiceWorkers).toHaveBeenCalledTimes(2);
    expect(scopedSession.closeAllConnections).toHaveBeenCalledTimes(2);
    expect(cleanupSession).toHaveBeenCalledOnce();
    expect(Reflect.get(manager, 'disposed')).toBe(true);
  });

  it('waits for the profile-mutation tail before shutdown teardown', async () => {
    const profileMutation = deferred<void>();
    const manager = new BrowserManager(
      '/tmp/kai-browser-shutdown-tail-test',
      () => ({ browser: { dataScope: 'global', enabled: true } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    Reflect.set(manager, 'profileMutationTail', profileMutation.promise);
    const closeAllConnections = vi.fn(async () => undefined);
    const wiredSessionsByScope = Reflect.get(manager, 'wiredSessionsByScope') as Map<string, unknown>;
    wiredSessionsByScope.set('global', {
      closeAllConnections,
      serviceWorkers: { getAllRunning: () => ({}) },
    });
    const flush = vi.fn(async () => undefined);
    const stores = Reflect.get(manager, 'stores') as Map<string, { flush: () => Promise<void> }>;
    stores.set('global', { flush });
    const cancel = vi.fn(async () => undefined);
    const downloadItem = {};
    const activeDownloads = Reflect.get(manager, 'activeDownloads') as Map<object, unknown>;
    activeDownloads.set(downloadItem, {
      scopeKey: 'global',
      item: downloadItem,
      done: Promise.resolve(),
      cancel,
    });

    const shutdown = manager.shutdown();
    await Promise.resolve();
    expect(closeAllConnections).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();

    profileMutation.resolve();
    await shutdown;

    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
  });

  it('disposes cached credential vaults during shutdown', async () => {
    const manager = new BrowserManager(
      '/tmp/kai-browser-shutdown-vault-test',
      () => ({ browser: { dataScope: 'global', enabled: true } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    const disposeVault = vi.fn();
    Reflect.get(manager, 'vaults').set('global', { dispose: disposeVault });

    await manager.shutdown();

    expect(disposeVault).toHaveBeenCalledOnce();
  });

  it('waits for every profile store before returning a flush failure', async () => {
    const healthyStore = deferred<void>();
    const profileFailure = new Error('profile metadata is corrupt');
    const failedFlush = vi.fn().mockRejectedValue(profileFailure);
    const healthyFlush = vi.fn().mockReturnValue(healthyStore.promise);
    const manager = managerWithoutConstructor({
      stores: new Map([
        ['failed', { flush: failedFlush }],
        ['healthy', { flush: healthyFlush }],
      ]),
    });

    let settled = false;
    const observed = manager.flushProfileData().then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await Promise.resolve();

    expect(failedFlush).toHaveBeenCalledOnce();
    expect(healthyFlush).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    healthyStore.resolve();
    await expect(observed).resolves.toBe(profileFailure);
  });

  it('cancels and drains downloads before the final shutdown profile flush', async () => {
    const order: string[] = [];
    let finishConnections!: () => void;
    let finishDownload!: () => void;
    const manager = new BrowserManager(
      '/tmp/kai-browser-shutdown-test',
      () => ({ browser: { dataScope: 'global', enabled: true } }) as never,
      () => null,
      '/tmp/browser-page.cjs',
    );
    const closeAllConnections = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishConnections = () => {
            order.push('connections');
            resolve();
          };
        }),
    );
    const scopedSession = {
      closeAllConnections,
      serviceWorkers: { getAllRunning: () => ({}) },
    };
    const wiredSessionsByScope = Reflect.get(manager, 'wiredSessionsByScope') as Map<string, unknown>;
    wiredSessionsByScope.set('global', scopedSession);
    const stores = Reflect.get(manager, 'stores') as Map<string, { flush: () => Promise<void> }>;
    const flush = vi.fn(async () => {
      order.push('flush');
    });
    stores.set('global', { flush });
    const activeDownloads = Reflect.get(manager, 'activeDownloads') as Map<object, unknown>;
    const downloadItem = {};
    const done = Promise.resolve();
    activeDownloads.set(downloadItem, {
      scopeKey: 'global',
      item: downloadItem,
      done,
      cancel: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishDownload = () => {
              order.push('download');
              activeDownloads.delete(downloadItem);
              resolve();
            };
          }),
      ),
    });

    const shutdown = manager.shutdown();
    await vi.waitFor(() => expect(closeAllConnections).toHaveBeenCalledOnce());
    expect(flush).not.toHaveBeenCalled();

    finishConnections();
    finishDownload();
    await shutdown;

    expect(order).toEqual(['connections', 'download', 'flush']);
    expect(flush).toHaveBeenCalledOnce();
  });

  it('attaches a recreated page before starting find-in-page', async () => {
    const findInPage = vi.fn();
    const attachActiveView = vi.fn();
    const tab = { shell: { id: 'tab-1', conversationId: 'chat-1' } };
    const manager = managerWithoutConstructor({
      attachActiveView,
      ensureView: vi.fn(async () => ({ webContents: { findInPage } })),
      tabs: new Map([['tab-1', tab]]),
    });

    findInPage.mockReturnValue(42);
    await manager.find('chat-1', 'tab-1', 'needle', false, true, 7);

    expect(findInPage).toHaveBeenCalledWith('needle', {
      forward: false,
      findNext: true,
    });
    expect(attachActiveView).toHaveBeenCalledWith('chat-1');
    expect(Reflect.get(manager, 'activeFindRequests').get('tab-1')).toEqual({
      requestId: 7,
      electronRequestId: 42,
    });
  });

  it('rejects oversized structured-action payloads at the manager boundary', async () => {
    const manager = managerWithoutConstructor({});

    await expect(
      manager.action('chat-1', { kind: 'click', selector: 's'.repeat(8 * 1024 + 1) }, { id: 'assistant-run' }),
    ).rejects.toThrow();
  });

  it('serializes screenshot capture and postprocessing across different tabs', async () => {
    const firstTabId = '00000000-0000-4000-8000-000000000001';
    const secondTabId = '00000000-0000-4000-8000-000000000002';
    const processingStarted = deferred<void>();
    const releaseProcessing = deferred<void>();
    const image = (label: string) => ({
      getSize: () => ({ width: 1, height: 1 }),
      toPNG: () => Buffer.from(label),
    });
    const firstCapture = vi.fn(async () => image('first'));
    const secondCapture = vi.fn(async () => image('second'));
    const firstContents = { id: 1, capturePage: firstCapture, isDestroyed: () => false };
    const secondContents = { id: 2, capturePage: secondCapture, isDestroyed: () => false };
    const firstTab = {
      shell: { id: firstTabId, conversationId: 'chat-1', url: 'https://one.example', sensitive: false },
      view: { webContents: firstContents },
    };
    const secondTab = {
      shell: { id: secondTabId, conversationId: 'chat-1', url: 'https://two.example', sensitive: false },
      view: { webContents: secondContents },
    };
    const tabs = new Map([
      [firstTabId, firstTab],
      [secondTabId, secondTab],
    ]);
    const manager = managerWithoutConstructor({
      assertBrowserPageLease: vi.fn(),
      assertTabNotSensitive: vi.fn(async () => undefined),
      captureBrowserPageLease: vi.fn((tab: typeof firstTab | typeof secondTab) => ({ tabId: tab.shell.id })),
      ensureView: vi.fn(async (tab: typeof firstTab | typeof secondTab) => tab.view),
      hideAutomationOverlay: vi.fn(async () => false),
      isBrowserPageLeaseCurrent: vi.fn(() => true),
      requireTab: (_conversationId: string, tabId?: string) => tabs.get(tabId ?? '')!,
      runRendererOperationWithDeadline: vi.fn(
        async (
          _tab: unknown,
          _contents: unknown,
          _operation: string,
          _timeoutMs: number,
          task: () => Promise<unknown>,
        ) => task(),
      ),
      runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
    });

    const first = manager.screenshot(
      'chat-1',
      { tabId: firstTabId, mode: 'viewport' },
      'user',
      undefined,
      async (screenshot) => {
        processingStarted.resolve();
        await releaseProcessing.promise;
        return screenshot;
      },
    );
    await processingStarted.promise;
    expect(firstCapture).toHaveBeenCalledOnce();
    const second = manager.screenshot('chat-1', { tabId: secondTabId, mode: 'viewport' });
    await Promise.resolve();
    expect(secondCapture).not.toHaveBeenCalled();

    releaseProcessing.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ tabId: firstTabId }),
      expect.objectContaining({ tabId: secondTabId }),
    ]);
    expect(secondCapture).toHaveBeenCalledOnce();
  });

  it('rejects oversized viewport bounds before capturePage allocates a NativeImage', async () => {
    const tabId = '00000000-0000-4000-8000-000000000001';
    const capturePage = vi.fn();
    const contents = { id: 1, capturePage, isDestroyed: () => false };
    const tab = {
      shell: { id: tabId, conversationId: 'chat-1', url: 'https://example.com', sensitive: false },
      view: {
        webContents: contents,
        getBounds: () => ({ x: 0, y: 0, width: 8_000, height: 8_000 }),
      },
    };
    const manager = managerWithoutConstructor({
      assertBrowserPageLease: vi.fn(),
      assertTabNotSensitive: vi.fn(async () => undefined),
      captureBrowserPageLease: vi.fn(() => ({ tabId })),
      ensureView: vi.fn(async () => tab.view),
      hideAutomationOverlay: vi.fn(async () => false),
      isBrowserPageLeaseCurrent: vi.fn(() => true),
      requireTab: () => tab,
      restoreAutomationOverlay: vi.fn(async () => undefined),
      runRendererOperationWithDeadline: vi.fn(
        async (
          _tab: unknown,
          _contents: unknown,
          _operation: string,
          _timeoutMs: number,
          task: () => Promise<unknown>,
        ) => task(),
      ),
      runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
    });

    await expect(manager.screenshot('chat-1', { tabId, mode: 'viewport' })).rejects.toThrow(/safe .*pixel limit/i);
    expect(capturePage).not.toHaveBeenCalled();
  });

  it('accounts for display scale before viewport capture allocates a NativeImage', async () => {
    electronMocks.screenGetAllDisplays.mockReturnValue([{ scaleFactor: 2 }]);
    const tabId = '00000000-0000-4000-8000-000000000002';
    const capturePage = vi.fn();
    const contents = { id: 2, capturePage, isDestroyed: () => false };
    const tab = {
      shell: { id: tabId, conversationId: 'chat-1', url: 'https://example.com', sensitive: false },
      view: {
        webContents: contents,
        getBounds: () => ({ x: 0, y: 0, width: 3_000, height: 2_000 }),
      },
    };
    const manager = managerWithoutConstructor({
      assertBrowserPageLease: vi.fn(),
      assertTabNotSensitive: vi.fn(async () => undefined),
      captureBrowserPageLease: vi.fn(() => ({ tabId })),
      ensureView: vi.fn(async () => tab.view),
      hideAutomationOverlay: vi.fn(async () => false),
      isBrowserPageLeaseCurrent: vi.fn(() => true),
      requireTab: () => tab,
      restoreAutomationOverlay: vi.fn(async () => undefined),
      runRendererOperationWithDeadline: vi.fn(
        async (
          _tab: unknown,
          _contents: unknown,
          _operation: string,
          _timeoutMs: number,
          task: () => Promise<unknown>,
        ) => task(),
      ),
      runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
    });

    await expect(manager.screenshot('chat-1', { tabId, mode: 'viewport' })).rejects.toThrow(/safe .*pixel limit/i);
    expect(capturePage).not.toHaveBeenCalled();
  });

  it('preserves negative element origins until the screenshot clip is intersected', async () => {
    const captureScreenshot = vi.fn(async (_params?: Record<string, unknown>) => ({
      data: Buffer.from('png').toString('base64'),
    }));
    const executeJavaScript = vi.fn(async (source: string) => {
      expect(source).toContain('x: r.left + scrollX');
      expect(source).not.toContain('x: Math.max(0');
      return { x: -10, y: -5, width: 40, height: 20 };
    });
    const contents = {
      debugger: {
        isAttached: () => true,
        sendCommand: vi.fn(async (command: string, params?: Record<string, unknown>) => {
          if (command === 'Page.getLayoutMetrics') {
            return { cssContentSize: { width: 100, height: 100 } };
          }
          if (command === 'Page.captureScreenshot') return captureScreenshot(params);
          throw new Error(`Unexpected debugger command: ${command}`);
        }),
      },
      executeJavaScript,
      isDestroyed: () => false,
    };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', url: 'https://example.com', sensitive: false },
      view: { webContents: contents },
    };
    const runRendererOperationWithDeadline = vi.fn(
      async (_tab: unknown, _contents: unknown, _operation: string, _timeoutMs: number, task: () => Promise<unknown>) =>
        task(),
    );
    const manager = managerWithoutConstructor({
      appHome: '/tmp/kai-browser-screenshot-test',
      assertBrowserPageLease: vi.fn(),
      assertTabNotSensitive: vi.fn(async () => undefined),
      captureBrowserPageLease: vi.fn(() => ({ tabId: 'tab-1' })),
      ensureView: vi.fn(async () => tab.view),
      getWindow: () => null,
      hideAutomationOverlay: vi.fn(async () => false),
      requireTab: () => tab,
      runRendererOperationWithDeadline,
      runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
      tabs: new Map([['tab-1', tab]]),
    });

    await expect(manager.screenshot('chat-1', { mode: 'element', selector: '#partial' })).resolves.toMatchObject({
      width: 30,
      height: 15,
    });
    expect(captureScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        clip: { x: 0, y: 0, width: 30, height: 15, scale: 1 },
      }),
    );
    expect(runRendererOperationWithDeadline).toHaveBeenCalledWith(
      tab,
      contents,
      'Browser screenshot',
      60_000,
      expect.any(Function),
      undefined,
      undefined,
    );
  });

  it('rejects an element capture when the picked document token is stale', async () => {
    const capturePage = vi.fn();
    const contents = {
      id: 42,
      isDestroyed: () => false,
      capturePage,
    };
    const tab = {
      shell: { id: 'tab-1', conversationId: 'chat-1', url: 'https://example.com', sensitive: false },
      view: { webContents: contents },
      generation: 2,
      trustedUserNavigationLease: 4,
    };
    const manager = managerWithoutConstructor({
      requireTab: () => tab,
      ensureView: vi.fn(async () => tab.view),
      captureBrowserPageLease: vi.fn(() => ({
        tabId: 'tab-1',
        tabGeneration: 2,
        userNavigationLease: 4,
        contents,
      })),
      runTabOperation: (_tab: unknown, task: () => Promise<unknown>) => task(),
    });

    await expect(
      manager.screenshot('chat-1', {
        mode: 'element',
        selector: '#picked',
        documentToken: 'tab-1:1:4:42',
      }),
    ).rejects.toThrow(/changed after the element was picked/);
    expect(capturePage).not.toHaveBeenCalled();
  });

  it('rejects oversized screenshot selectors at the manager boundary', async () => {
    const manager = managerWithoutConstructor({});

    await expect(
      manager.screenshot('chat-1', {
        mode: 'element',
        selector: 's'.repeat(8 * 1024 + 1),
      }),
    ).rejects.toThrow();
  });
});
