import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
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
    pausePlugin: vi.fn(async () => {}),
    resumePlugin: vi.fn(async () => {}),
    killPlugin: vi.fn(async () => {}),
  } as unknown as PluginManager;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerPluginHandlers(ipcMain, manager);
  });

  it.each([
    ['plugin:pause', 'pausePlugin'],
    ['plugin:resume', 'resumePlugin'],
    ['plugin:kill', 'killPlugin'],
  ] as const)('forwards %s to PluginManager.%s', async (channel, method) => {
    await expect(handlers.get(channel)?.({}, 'fixture-plugin')).resolves.toEqual({ success: true });
    expect(manager[method]).toHaveBeenCalledWith('fixture-plugin');
  });
});
