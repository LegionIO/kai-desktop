import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { CodePaths } from '../../ota/types.js';

const appMocks = vi.hoisted(() => ({
  exit: vi.fn(),
  quit: vi.fn(),
  relaunch: vi.fn(),
}));
const otaMocks = vi.hoisted(() => ({
  applyOtaUpdate: vi.fn(() => ({ success: true })),
  checkForOtaUpdate: vi.fn(),
  downloadOtaUpdate: vi.fn(),
  getOtaStatus: vi.fn(() => ({ state: 'idle' })),
  getReadyVersion: vi.fn(() => null),
  isOtaReady: vi.fn(() => false),
  startOtaChecks: vi.fn(),
  stopOtaChecks: vi.fn(),
}));
const rollbackMocks = vi.hoisted(() => ({
  getOtaMeta: vi.fn(() => null),
  manualRollback: vi.fn(() => ({ success: true })),
}));

vi.mock('electron', () => ({ app: appMocks }));
vi.mock('../../ota/ota-updater.js', () => otaMocks);
vi.mock('../../ota/rollback.js', () => rollbackMocks);
vi.mock('../../browser/service.js', () => ({ BROWSER_FORCE_EXIT_GRACE_MS: 12_000 }));

const { registerOtaHandlers } = await import('../ota.js');

const codePaths: CodePaths = {
  main: '/app/out/main',
  preload: '/app/out/preload',
  renderer: '/app/out/renderer',
  isOverlay: false,
  codeVersion: '1.0.0',
  mainCodeVersion: '1.0.0',
};

describe('OTA restart lifecycle', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();

  beforeEach(() => {
    vi.useFakeTimers();
    handlers.clear();
    vi.clearAllMocks();
    otaMocks.applyOtaUpdate.mockReturnValue({ success: true });
    rollbackMocks.manualRollback.mockReturnValue({ success: true });
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
    } as unknown as IpcMain;
    registerOtaHandlers(ipcMain, codePaths, 'kai', '1.0.0');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['ota:apply-and-restart', 'ota:rollback'])(
    '%s relaunches through graceful cleanup with an unload-veto fallback',
    async (channel) => {
      expect(handlers.get(channel)?.({})).toEqual({ success: true });
      expect(appMocks.quit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);

      expect(appMocks.relaunch).toHaveBeenCalledOnce();
      expect(appMocks.quit).toHaveBeenCalledOnce();
      expect(appMocks.exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(12_000);
      expect(appMocks.exit).toHaveBeenCalledWith(0);
    },
  );
});
