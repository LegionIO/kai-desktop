import { app, dialog, type IpcMain } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { broadcastToAllWindows } from '../utils/window-send.js';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_DELAY_MS = 30_000; // 30 seconds after launch

function broadcast(state: string, version?: string): void {
  broadcastToAllWindows('auto-update:status', { state, version });
}

/**
 * Show native dialogs when the user manually triggers "Check for Updates…".
 * Background/automatic checks remain silent.
 */
export function checkForUpdatesInteractive(): void {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Updates',
      message: 'Updates are not available in development mode.',
      buttons: ['OK'],
    });
    return;
  }

  const cleanup = () => {
    autoUpdater.removeListener('update-available', onAvailable);
    autoUpdater.removeListener('update-not-available', onNotAvailable);
    autoUpdater.removeListener('error', onError);
  };

  const onAvailable = (info: { version: string }) => {
    cleanup();
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `A new version of ${__BRAND_PRODUCT_NAME} is ready to install!`,
      detail: `${__BRAND_PRODUCT_NAME} ${info.version} has been downloaded and is ready to use. Would you like to install it and relaunch ${__BRAND_PRODUCT_NAME} now?`,
      buttons: ['Install Update', 'Remind Me Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  };

  const onNotAvailable = () => {
    cleanup();
    dialog.showMessageBox({
      type: 'info',
      title: 'No Updates',
      message: `${__BRAND_PRODUCT_NAME} is up to date.`,
      detail: `You are running the latest version (${__APP_VERSION}).`,
      buttons: ['OK'],
    });
  };

  const onError = (err: Error) => {
    cleanup();
    dialog.showMessageBox({
      type: 'warning',
      title: 'Update Error',
      message: 'Could not check for updates.',
      detail: err.message,
      buttons: ['OK'],
    });
  };

  autoUpdater.once('update-available', onAvailable);
  autoUpdater.once('update-not-available', onNotAvailable);
  autoUpdater.once('error', onError);

  autoUpdater.checkForUpdates().catch(onError);
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
