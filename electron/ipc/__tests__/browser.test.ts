import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMain } from 'electron';
import { createIpcHarness } from '../../../test-utils/ipc-harness.js';

const manager = vi.hoisted(() => ({
  authorityAvailable: false,
  authorityGeneration: 3,
  enabled: true,
  isEnabled: vi.fn(function (this: { enabled: boolean }) {
    return this.enabled;
  }),
  assertEnabled: vi.fn(function (this: { enabled: boolean }) {
    if (!this.enabled) throw new Error('The in-app browser is disabled in Settings.');
  }),
  getHostRendererAuthorityGeneration: vi.fn(function (this: { authorityGeneration: number }) {
    return this.authorityGeneration;
  }),
  isHostRendererAuthorityCurrent: vi.fn(function (
    this: { authorityAvailable: boolean; authorityGeneration: number },
    generation: number,
  ) {
    return this.authorityAvailable && generation === this.authorityGeneration;
  }),
  handleHostRendererReady: vi.fn(function (this: { authorityAvailable: boolean }) {
    this.authorityAvailable = true;
  }),
  runHostRendererOperation: vi.fn(async function <T>(
    this: { authorityAvailable: boolean; authorityGeneration: number },
    generation: number,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    if (!this.authorityAvailable || generation !== this.authorityGeneration) {
      throw new Error("The in-app browser's renderer authority has expired.");
    }
    const result = await operation();
    if (!this.authorityAvailable || generation !== this.authorityGeneration) {
      throw new Error("The in-app browser's renderer authority has expired.");
    }
    return result;
  }),
  getState: vi.fn((conversationId: string) => ({
    conversationId,
    tabs: [],
    activeTabId: null,
  })),
  getAttentionState: vi.fn(() => [{ conversationId: 'chat-2', promptIds: ['prompt-1'] }]),
  mount: vi.fn(async (): Promise<void> => undefined),
  screenshot: vi.fn(async () => ({
    tabId: 'tab-1',
    mode: 'viewport' as const,
    mimeType: 'image/png' as const,
    width: 10,
    height: 10,
  })),
  pickElement: vi.fn(async () => ({ selector: '#target', documentToken: 'tab-1:7:2:3:42' })),
  setZoom: vi.fn(async (_conversationId: string, _tabId: string, level: number) => level),
  setChromeFocus: vi.fn(),
  listCredentials: vi.fn(() => []),
  respondPermissionPrompt: vi.fn(),
  dataSummary: vi.fn(async () => []),
  clearData: vi.fn(async () => undefined),
}));

vi.mock('../../browser/service.js', () => ({
  getBrowserManager: () => manager,
  getExistingBrowserManager: () => manager,
}));

const { registerBrowserHandlers } = await import('../browser.js');

describe('browser IPC authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manager.authorityAvailable = false;
    manager.authorityGeneration = 3;
    manager.enabled = true;
  });

  it('allows only the primary desktop renderer to invoke native browser handlers', async () => {
    const mainFrame = { url: 'file:///app/index.html' };
    const primaryContents = {
      isDestroyed: () => false,
      getZoomFactor: () => 1.5,
      mainFrame,
    };
    const primaryWindow = {
      isDestroyed: () => false,
      webContents: primaryContents,
    } as unknown as BrowserWindow;
    const harness = await createIpcHarness({
      registerHandlers: (ipc) =>
        registerBrowserHandlers(
          ipc as unknown as IpcMain,
          () => primaryWindow,
          (url) => url === 'file:///app/index.html',
        ),
    });

    await expect(
      harness.invoke('browser:get-state', { sender: primaryContents, senderFrame: mainFrame }, 'chat-1'),
    ).rejects.toThrow(/renderer is ready/);
    harness.send('browser:host-renderer-ready', {
      sender: primaryContents,
      senderFrame: {},
    });
    expect(manager.handleHostRendererReady).not.toHaveBeenCalled();
    harness.send('browser:host-renderer-ready', {
      sender: primaryContents,
      senderFrame: mainFrame,
    });
    expect(manager.handleHostRendererReady).toHaveBeenCalledOnce();

    await expect(
      harness.invoke('browser:get-state', { sender: primaryContents, senderFrame: mainFrame }, 'chat-1'),
    ).resolves.toEqual({
      conversationId: 'chat-1',
      tabs: [],
      activeTabId: null,
    });
    await expect(
      harness.invoke('browser:get-attention-state', { sender: primaryContents, senderFrame: mainFrame }),
    ).resolves.toEqual([{ conversationId: 'chat-2', promptIds: ['prompt-1'] }]);
    await expect(
      harness.invoke('browser:get-state', { sender: { isDestroyed: () => false }, senderFrame: mainFrame }, 'chat-1'),
    ).rejects.toThrow(/primary desktop window/);
    await expect(harness.invoke('browser:get-state', { sender: null, __kaiWebBridge: true }, 'chat-1')).rejects.toThrow(
      /primary desktop window/,
    );

    await harness.invoke('browser:mount', { sender: primaryContents, senderFrame: mainFrame }, 'chat-1', {
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    expect(manager.mount).toHaveBeenCalledWith('chat-1', {
      x: 15,
      y: 30,
      width: 450,
      height: 300,
    });
    await harness.invoke(
      'browser:set-chrome-focus',
      { sender: primaryContents, senderFrame: mainFrame },
      'chat-1',
      true,
    );
    expect(manager.setChromeFocus).toHaveBeenCalledWith('chat-1', true);

    await expect(
      harness.invoke(
        'browser:set-zoom',
        { sender: primaryContents, senderFrame: mainFrame },
        'chat-1',
        'tab-1',
        Number.NaN,
      ),
    ).rejects.toThrow(/finite number/);
    expect(manager.setZoom).not.toHaveBeenCalled();

    await expect(
      harness.invoke(
        'browser:respond-permission',
        { sender: primaryContents, senderFrame: mainFrame },
        'permission-1',
        'allow-forever',
      ),
    ).rejects.toThrow(/permission decision/i);
    expect(manager.respondPermissionPrompt).not.toHaveBeenCalled();
    await expect(
      harness.invoke(
        'browser:respond-permission',
        { sender: primaryContents, senderFrame: mainFrame },
        'permission-1',
        'allow-once',
      ),
    ).resolves.toBeUndefined();
    expect(manager.respondPermissionPrompt).toHaveBeenCalledWith('permission-1', 'allow-once');

    mainFrame.url = 'file:///tmp/plugin-controlled.html';
    await expect(
      harness.invoke('browser:get-state', { sender: primaryContents, senderFrame: mainFrame }, 'chat-1'),
    ).rejects.toThrow(/primary desktop window/);
    harness.send('browser:host-renderer-ready', { sender: primaryContents, senderFrame: mainFrame });
    expect(manager.handleHostRendererReady).toHaveBeenCalledOnce();
  });

  it('blocks ordinary profile APIs while disabled but preserves data maintenance', async () => {
    const mainFrame = { url: 'file:///app/index.html' };
    const primaryContents = { isDestroyed: () => false, getZoomFactor: () => 1, mainFrame };
    const primaryWindow = {
      isDestroyed: () => false,
      webContents: primaryContents,
    } as unknown as BrowserWindow;
    const harness = await createIpcHarness({
      registerHandlers: (ipc) =>
        registerBrowserHandlers(
          ipc as unknown as IpcMain,
          () => primaryWindow,
          (url) => url === 'file:///app/index.html',
        ),
    });
    harness.send('browser:host-renderer-ready', { sender: primaryContents, senderFrame: mainFrame });
    manager.enabled = false;

    await expect(
      harness.invoke('browser:list-credentials', { sender: primaryContents, senderFrame: mainFrame }, 'chat-1'),
    ).rejects.toThrow(/disabled in Settings/);
    expect(manager.listCredentials).not.toHaveBeenCalled();
    await expect(
      harness.invoke('browser:available', { sender: primaryContents, senderFrame: mainFrame }),
    ).resolves.toBe(true);
    expect(manager.isEnabled).not.toHaveBeenCalled();
    await expect(
      harness.invoke('browser:data-summary', { sender: primaryContents, senderFrame: mainFrame }, 'chat-1'),
    ).resolves.toEqual([]);
    await expect(
      harness.invoke(
        'browser:clear-data',
        { sender: primaryContents, senderFrame: mainFrame },
        { includeGlobal: true },
      ),
    ).resolves.toBeUndefined();

    await expect(
      harness.invoke('browser:mount', { sender: primaryContents, senderFrame: mainFrame }, 'chat-1', {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      }),
    ).rejects.toThrow(/disabled in Settings/);
    expect(manager.mount).not.toHaveBeenCalled();

    await expect(
      harness.invoke('browser:mount', { sender: primaryContents, senderFrame: mainFrame }, 'chat-1', null),
    ).resolves.toBeUndefined();
    expect(manager.mount).toHaveBeenCalledWith('chat-1', null);
  });

  it('rejects renderer-owned work when authority changes while it is waiting', async () => {
    let releaseMount!: () => void;
    const mountPending = new Promise<void>((resolve) => {
      releaseMount = resolve;
    });
    manager.mount.mockImplementationOnce(() => mountPending);
    const mainFrame = { url: 'file:///app/index.html' };
    const primaryContents = {
      isDestroyed: () => false,
      getZoomFactor: () => 1,
      mainFrame,
    };
    const primaryWindow = {
      isDestroyed: () => false,
      webContents: primaryContents,
    } as unknown as BrowserWindow;
    const harness = await createIpcHarness({
      registerHandlers: (ipc) =>
        registerBrowserHandlers(
          ipc as unknown as IpcMain,
          () => primaryWindow,
          (url) => url === 'file:///app/index.html',
        ),
    });
    harness.send('browser:host-renderer-ready', {
      sender: primaryContents,
      senderFrame: mainFrame,
    });

    const invocation = harness.invoke('browser:mount', { sender: primaryContents, senderFrame: mainFrame }, 'chat-1', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    await vi.waitFor(() => expect(manager.mount).toHaveBeenCalledOnce());
    manager.authorityAvailable = false;
    manager.authorityGeneration++;
    releaseMount();

    await expect(invocation).rejects.toThrow(/authority has expired/);
  });

  it('requires renderer screenshot requests to carry a main-issued document token', async () => {
    const mainFrame = { url: 'file:///app/index.html' };
    const primaryContents = { isDestroyed: () => false, getZoomFactor: () => 1, mainFrame };
    const primaryWindow = {
      isDestroyed: () => false,
      webContents: primaryContents,
    } as unknown as BrowserWindow;
    const harness = await createIpcHarness({
      registerHandlers: (ipc) =>
        registerBrowserHandlers(
          ipc as unknown as IpcMain,
          () => primaryWindow,
          (url) => url === 'file:///app/index.html',
        ),
    });
    harness.send('browser:host-renderer-ready', { sender: primaryContents, senderFrame: mainFrame });

    await expect(
      harness.invoke('browser:screenshot', { sender: primaryContents, senderFrame: mainFrame }, 'chat-1', {
        tabId: 'tab-1',
        mode: 'viewport',
        exportToFile: true,
      }),
    ).rejects.toThrow(/document token/i);
    expect(manager.screenshot).not.toHaveBeenCalled();

    const request = {
      tabId: 'tab-1',
      mode: 'viewport' as const,
      documentToken: 'tab-1:7:2:3:42',
      exportToFile: true,
    };
    await expect(
      harness.invoke('browser:screenshot', { sender: primaryContents, senderFrame: mainFrame }, 'chat-1', request),
    ).resolves.toMatchObject({ tabId: 'tab-1', mode: 'viewport' });
    expect(manager.screenshot).toHaveBeenCalledWith('chat-1', request);

    await expect(
      harness.invoke('browser:pick-element', { sender: primaryContents, senderFrame: mainFrame }, 'chat-1', 'tab-1'),
    ).rejects.toThrow(/document token/i);
    expect(manager.pickElement).not.toHaveBeenCalled();

    await expect(
      harness.invoke(
        'browser:pick-element',
        { sender: primaryContents, senderFrame: mainFrame },
        'chat-1',
        'tab-1',
        request.documentToken,
      ),
    ).resolves.toMatchObject({ selector: '#target' });
    expect(manager.pickElement).toHaveBeenCalledWith('chat-1', 'tab-1', request.documentToken);
  });
});
