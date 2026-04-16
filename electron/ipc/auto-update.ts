import { app, type IpcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { broadcastToAllWindows } from '../utils/window-send.js';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_DELAY_MS = 30_000; // 30 seconds after launch

function broadcast(state: string, version?: string): void {
  broadcastToAllWindows('auto-update:status', { state, version });
}

export function registerAutoUpdateHandlers(
  ipcMain: IpcMain,
  onUpdateDownloaded?: () => void,
): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => broadcast('checking'));
  autoUpdater.on('update-available', (info) => broadcast('available', info.version));
  autoUpdater.on('update-not-available', () => broadcast('idle'));
  autoUpdater.on('update-downloaded', (info) => {
    broadcast('downloaded', info.version);
    onUpdateDownloaded?.();
  });
  autoUpdater.on('error', (err) => {
    console.error('[auto-update] Error:', err.message);
    broadcast('idle');
  });

  ipcMain.handle('auto-update:check', async () => {
    if (!app.isPackaged) return { ok: false, error: 'Updates disabled in dev mode' };
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update check failed';
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('auto-update:install', () => {
    autoUpdater.quitAndInstall();
  });

  // Automatic update checks (only in packaged builds)
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('[auto-update] Initial check failed:', err.message);
      });
    }, INITIAL_DELAY_MS);

    setInterval(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('[auto-update] Periodic check failed:', err.message);
      });
    }, CHECK_INTERVAL_MS);
  }
}
