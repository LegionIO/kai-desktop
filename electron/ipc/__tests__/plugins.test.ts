import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMain } from 'electron';
import type { PluginManager } from '../../plugins/plugin-manager.js';

vi.mock('electron', () => ({
  app: { relaunch: vi.fn(), quit: vi.fn() },
}));

vi.mock('../../plugins/marketplace-service.js', () => ({
  UnverifiedPluginError: class UnverifiedPluginError extends Error {},
}));

const { registerPluginHandlers } = await import('../plugins.js');

describe('plugin process control IPC', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  } as unknown as IpcMain;
  const manager = {
    acknowledgeRendererUnload: vi.fn(),
    beginRendererUnload: vi.fn(() => false),
    cancelRendererUnload: vi.fn(() => true),
    setRendererReplacementHandler: vi.fn(),
    disablePlugin: vi.fn(async () => {}),
    uninstallFromMarketplace: vi.fn(async () => {}),
    pausePlugin: vi.fn(async () => {}),
    resumePlugin: vi.fn(async () => {}),
    killPlugin: vi.fn(async () => {}),
    getMarketplaceStatus: vi.fn(() => ({ configured: true, ready: false, reachable: false, catalogSize: 0 })),
    getMarketplaceSnapshot: vi.fn(() => ({
      catalog: [],
      status: { configured: true, ready: false, reachable: false, catalogSize: 0 },
    })),
  } as unknown as PluginManager;
  const webContentsListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const loadURL = vi.fn(async () => undefined);
  const forcefullyCrashRenderer = vi.fn();
  const destroyWindow = vi.fn();
  const revokePrimaryRendererAuthority = vi.fn();
  const primaryWindow = {
    isDestroyed: () => false,
    destroy: destroyWindow,
    webContents: {
      isDestroyed: () => false,
      loadURL,
      forcefullyCrashRenderer,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        const listeners = webContentsListeners.get(event) ?? new Set();
        listeners.add(listener);
        webContentsListeners.set(event, listeners);
      },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        webContentsListeners.get(event)?.delete(listener);
      },
    },
  } as unknown as BrowserWindow;
  const emitWebContents = (event: string, ...args: unknown[]) => {
    for (const listener of [...(webContentsListeners.get(event) ?? [])]) listener(...args);
  };

  beforeEach(() => {
    handlers.clear();
    webContentsListeners.clear();
    vi.clearAllMocks();
    registerPluginHandlers(
      ipcMain,
      manager,
      () => primaryWindow,
      revokePrimaryRendererAuthority,
      'file:///app/index.html',
    );
  });

  it.each([
    ['plugin:pause', 'pausePlugin'],
    ['plugin:resume', 'resumePlugin'],
    ['plugin:kill', 'killPlugin'],
  ] as const)('forwards %s to PluginManager.%s', async (channel, method) => {
    await expect(handlers.get(channel)?.({}, 'fixture-plugin')).resolves.toEqual({ success: true });
    expect(manager[method]).toHaveBeenCalledWith('fixture-plugin');
  });

  it('registers renderer replacement for background marketplace updates', () => {
    expect(manager.setRendererReplacementHandler).toHaveBeenCalledOnce();
    expect(manager.setRendererReplacementHandler).toHaveBeenCalledWith(expect.any(Function));
  });

  it('fails closed when primary-renderer revocation callbacks are omitted', () => {
    expect(() =>
      registerPluginHandlers(ipcMain, manager, undefined as never, undefined as never, undefined as never),
    ).toThrow(/requires primary-renderer revocation callbacks and a canonical URL/);
  });

  it('uses the same confirmed primary-renderer replacement for a background update', async () => {
    const replacement = vi.mocked(manager.setRendererReplacementHandler).mock.calls[0]?.[0];
    const pending = replacement?.('frontend-plugin');
    await vi.waitFor(() => expect(loadURL).toHaveBeenCalledWith('file:///app/index.html'));

    expect(revokePrimaryRendererAuthority).toHaveBeenCalledOnce();
    expect(revokePrimaryRendererAuthority.mock.invocationCallOrder[0]).toBeLessThan(
      loadURL.mock.invocationCallOrder[0]!,
    );

    emitWebContents('did-navigate', {}, 'file:///app/index.html');
    await expect(pending).resolves.toBeUndefined();
  });

  it('still replaces loaded renderers when Browser authority revocation throws', async () => {
    revokePrimaryRendererAuthority.mockImplementationOnce(() => {
      throw new Error('authority bookkeeping failed');
    });
    const replacement = vi.mocked(manager.setRendererReplacementHandler).mock.calls[0]?.[0];
    const pending = replacement?.('frontend-plugin');
    await vi.waitFor(() => expect(loadURL).toHaveBeenCalledWith('file:///app/index.html'));

    emitWebContents('did-navigate', {}, 'file:///app/index.html');
    await expect(pending).rejects.toThrow('authority bookkeeping failed');
  });

  it('forwards plugin:marketplace-status to PluginManager.getMarketplaceStatus', () => {
    expect(handlers.get('plugin:marketplace-status')?.({})).toEqual({
      configured: true,
      ready: false,
      reachable: false,
      catalogSize: 0,
    });
    expect(manager.getMarketplaceStatus).toHaveBeenCalledTimes(1);
  });

  it('forwards plugin:marketplace-snapshot to PluginManager.getMarketplaceSnapshot', () => {
    expect(handlers.get('plugin:marketplace-snapshot')?.({})).toEqual({
      catalog: [],
      status: { configured: true, ready: false, reachable: false, catalogSize: 0 },
    });
    expect(manager.getMarketplaceSnapshot).toHaveBeenCalledTimes(1);
  });

  it('delegates disable and uninstall so PluginManager can hold its lifecycle lock across renderer replacement', async () => {
    await expect(handlers.get('plugin:disable')?.({}, 'frontend-plugin', { persist: false })).resolves.toEqual({
      success: true,
    });
    await expect(handlers.get('plugin:marketplace-uninstall')?.({}, 'frontend-plugin')).resolves.toEqual({
      success: true,
    });

    expect(manager.disablePlugin).toHaveBeenCalledWith('frontend-plugin', { persist: false });
    expect(manager.uninstallFromMarketplace).toHaveBeenCalledWith('frontend-plugin');
  });

  it('forcefully revokes a frontend plugin renderer when replacement fails', async () => {
    const replacement = vi.mocked(manager.setRendererReplacementHandler).mock.calls[0]?.[0];
    const response = replacement?.('frontend-plugin');
    await vi.waitFor(() => expect(loadURL).toHaveBeenCalledWith('file:///app/index.html'));
    emitWebContents('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'file:///app/index.html', true);

    await expect(response).rejects.toThrow(/Primary renderer reload failed \(-105\): ERR_NAME_NOT_RESOLVED/);
    expect(revokePrimaryRendererAuthority).toHaveBeenCalledOnce();
    expect(forcefullyCrashRenderer).toHaveBeenCalledOnce();
    expect(destroyWindow).not.toHaveBeenCalled();
  });

  it('fails closed if replacement commits any non-canonical renderer URL', async () => {
    const replacement = vi.mocked(manager.setRendererReplacementHandler).mock.calls[0]?.[0];
    const response = replacement?.('frontend-plugin');
    await vi.waitFor(() => expect(loadURL).toHaveBeenCalledWith('file:///app/index.html'));
    emitWebContents('did-navigate', {}, 'file:///tmp/plugin-controlled.html');

    await expect(response).rejects.toThrow(/unexpected URL/);
    expect(forcefullyCrashRenderer).toHaveBeenCalledOnce();
  });

  it('forcefully revokes a frontend plugin renderer when replacement times out', async () => {
    vi.useFakeTimers();
    try {
      const replacement = vi.mocked(manager.setRendererReplacementHandler).mock.calls[0]?.[0];
      const response = replacement?.('frontend-plugin');
      await Promise.resolve();
      expect(loadURL).toHaveBeenCalledWith('file:///app/index.html');
      const rejection = expect(response).rejects.toThrow(/Timed out waiting for the primary renderer to reload/);

      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(forcefullyCrashRenderer).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
