import { app, dialog, type IpcMain } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { broadcastToAllWindows } from '../utils/window-send.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, basename } from 'path';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_DELAY_MS = 5_000; // 5 seconds after launch

// Set KAI_UPDATE_TEST_VERSION=0.0.1 to test the auto-updater in dev mode.
// This fakes the current version so the updater sees the latest release as new.
// Optionally set KAI_UPDATE_URL for a generic server (e.g. S3) or
// KAI_UPDATE_REPO=owner/repo to override the GitHub release source.
const DEV_TEST_VERSION = process.env.KAI_UPDATE_TEST_VERSION;
const isUpdateTestMode = !!DEV_TEST_VERSION;

if (isUpdateTestMode) {
  const updateUrl = process.env.KAI_UPDATE_URL;
  if (updateUrl) {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: updateUrl,
      useMultipleRangeRequest: false,
    } as Parameters<typeof autoUpdater.setFeedURL>[0]);
    console.info(`[auto-update] TEST MODE: faking version ${DEV_TEST_VERSION}, url ${updateUrl}`);
  } else {
    const repo = process.env.KAI_UPDATE_REPO ?? 'legionio/kai-desktop';
    const [owner, repoName] = repo.split('/');
    autoUpdater.setFeedURL({ provider: 'github', owner, repo: repoName });
    console.info(`[auto-update] TEST MODE: faking version ${DEV_TEST_VERSION}, repo ${repo}`);
  }
  // Reuse the SemVer constructor from the existing currentVersion instance
  // so we get a real SemVer object without importing semver directly
  // (pnpm doesn't hoist it).
  const SemVer = (autoUpdater.currentVersion as unknown as { constructor: new (v: string) => typeof autoUpdater.currentVersion }).constructor;
  (autoUpdater as { currentVersion: typeof autoUpdater.currentVersion }).currentVersion = new SemVer(DEV_TEST_VERSION!);
}

interface UpdateStatus {
  state: string;
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

function broadcast(status: UpdateStatus): void {
  broadcastToAllWindows('auto-update:status', status);
}

const execFileAsync = promisify(execFile);

/**
 * Escape a string for safe interpolation inside a POSIX single-quoted shell argument.
 * Single quotes cannot appear inside single-quoted strings, so we close the quote,
 * insert an escaped quote, then reopen the quote: ' → '\''
 */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Attempt to install the downloaded update by manually extracting the zip
 * and replacing the app bundle via osascript with administrator privileges.
 *
 * On macOS, writing to /Applications requires admin authorization. Rather than
 * using Squirrel's fire-and-forget quitAndInstall (which quits the app before
 * the user can enter their password), we trigger the admin prompt ourselves
 * via osascript. This blocks until the user authorizes or cancels, giving us
 * definitive success/failure feedback.
 *
 * Returns true if install succeeded, false if user cancelled or it failed.
 */
async function attemptInstall(): Promise<boolean> {
  // Resolve the current .app bundle path
  // app.getPath('exe') returns something like /Applications/Kai.app/Contents/MacOS/Kai
  const exePath = app.getPath('exe');
  const appPath = exePath.replace(/\/Contents\/MacOS\/.*$/, '');
  const appName = basename(appPath); // e.g. "Kai.app"
  const appDir = dirname(appPath); // e.g. "/Applications"

  // Locate the downloaded update zip in electron-updater's cache
  // Cache path: ~/Library/Caches/<appName>/pending/update.zip
  const homedir = app.getPath('home');
  const cacheName = app.getName(); // "Kai" (from package.json name or productName)
  const cachePath = join(homedir, 'Library', 'Caches', cacheName, 'pending');
  const zipPath = join(cachePath, 'update.zip');

  if (!existsSync(zipPath)) {
    console.error('[auto-update] Cannot find downloaded update at:', zipPath);
    return false;
  }

  // Create a temp directory for extraction
  const tempDir = mkdtempSync(join(tmpdir(), 'kai-update-'));

  try {
    // Extract the zip
    await execFileAsync('ditto', ['-xk', zipPath, tempDir]);

    // Find the .app bundle in the extracted contents
    // It should match the current app name, but also handle slight variations
    let extractedApp = join(tempDir, appName);
    if (!existsSync(extractedApp)) {
      // Search for any .app bundle in the extracted directory
      const entries = readdirSync(tempDir).filter(e => e.endsWith('.app'));
      if (entries.length === 1) {
        extractedApp = join(tempDir, entries[0]);
      } else {
        console.error('[auto-update] Could not find .app bundle in extracted update. Found:', entries);
        return false;
      }
    }

    // Use osascript to replace the app with admin privileges.
    // This triggers the macOS password prompt and BLOCKS until the user responds.
    // Strategy: rename current app to .old backup, move new app in, delete backup on success.
    // If the move fails, attempt to restore from backup.
    const script = [
      `do shell script "`,
      // Rename current app to backup
      `mv '${shellEscape(appDir)}/${shellEscape(appName)}' '${shellEscape(appDir)}/${shellEscape(appName)}.old' && `,
      // Move new app into place
      `mv '${shellEscape(extractedApp)}' '${shellEscape(appDir)}/${shellEscape(appName)}' && `,
      // Remove backup on success
      `rm -rf '${shellEscape(appDir)}/${shellEscape(appName)}.old'`,
      `" with administrator privileges`,
    ].join('');

    await execFileAsync('osascript', ['-e', script]);

    // If we get here, install succeeded
    console.info('[auto-update] Install succeeded via manual osascript approach');
    return true;
  } catch (err: unknown) {
    const error = err as { code?: number; killed?: boolean; stderr?: string; message?: string };
    // osascript exits with code 1 and stderr containing "User canceled" when user clicks Cancel
    const msg = error.stderr || error.message || '';
    if (msg.includes('User canceled') || msg.includes('user canceled')) {
      console.info('[auto-update] User cancelled admin authorization — will retry when ready');
    } else {
      console.error('[auto-update] Install failed:', msg);
      // Attempt to restore from backup if it exists
      const backupPath = join(appDir, `${appName}.old`);
      if (existsSync(backupPath) && !existsSync(join(appDir, appName))) {
        try {
          await execFileAsync('osascript', [
            '-e',
            `do shell script "mv '${shellEscape(backupPath)}' '${shellEscape(appDir)}/${shellEscape(appName)}'" with administrator privileges`,
          ]);
          console.info('[auto-update] Restored app from backup after failed install');
        } catch {
          console.error('[auto-update] Could not restore backup — user may need to reinstall from DMG');
        }
      }
    }
    return false;
  } finally {
    // Cleanup temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}

/**
 * Attempt to install the update, keeping the app running until we get
 * definitive success/failure feedback.
 *
 * On success: relaunches the app on the new version.
 * On failure: returns to 'downloaded' state so the user can retry
 * (e.g. after enabling admin privileges via their corporate tool).
 */
export async function performQuitAndInstall(): Promise<void> {
  broadcast({ state: 'installing', version: downloadedVersion });

  const success = await attemptInstall();

  if (success) {
    broadcast({ state: 'restarting', version: downloadedVersion });
    // Disable autoInstallOnAppQuit since we already installed manually —
    // prevents Squirrel from trying to install again during the quit/relaunch.
    autoUpdater.autoInstallOnAppQuit = false;
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 300);
  } else {
    // Install failed or was cancelled — return to downloaded state so user can retry
    broadcast({ state: 'downloaded', version: downloadedVersion });
  }
}

/**
 * Show native dialogs when the user manually triggers "Check for Updates…".
 * Background/automatic checks remain silent.
 */
export function checkForUpdatesInteractive(): void {
  if (!app.isPackaged && !isUpdateTestMode) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Updates',
      message: 'Updates are not available in development mode.',
      buttons: ['OK'],
    });
    return;
  }

  // If an update was already downloaded, skip the check and offer install
  if (downloaded) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `A new version of ${__BRAND_PRODUCT_NAME} is ready to install.`,
      detail: `${__BRAND_PRODUCT_NAME} ${downloadedVersion ?? ''} has been downloaded. Would you like to restart now to finish updating?`.trim(),
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        void performQuitAndInstall();
      }
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
      message: `${__BRAND_PRODUCT_NAME} ${info.version} is available.`,
      detail: `The update is downloading in the background. You'll be notified when it's ready to install.`,
      buttons: ['OK'],
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

let downloaded = false;
let downloadedVersion: string | undefined;
let pendingVersion: string | undefined;

export function registerAutoUpdateHandlers(
  ipcMain: IpcMain,
  onUpdateDownloaded?: () => void,
): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;

  autoUpdater.on('checking-for-update', () => {
    if (!downloaded) broadcast({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version;
    if (!downloaded) broadcast({ state: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => {
    if (!downloaded) broadcast({ state: 'idle' });
  });
  autoUpdater.on('download-progress', (progress) => {
    if (!downloaded) {
      broadcast({
        state: 'downloading',
        version: pendingVersion,
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = true;
    downloadedVersion = info.version;
    broadcast({ state: 'downloaded', version: info.version });
    onUpdateDownloaded?.();
  });
  autoUpdater.on('error', (err) => {
    console.error('[auto-update] Error:', err.message);
    if (!downloaded) broadcast({ state: 'idle' });
  });

  ipcMain.handle('auto-update:check', async () => {
    if (!app.isPackaged && !isUpdateTestMode) return { ok: false, error: 'Updates disabled in dev mode' };
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update check failed';
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('auto-update:install', async () => {
    await performQuitAndInstall();
  });

  // Automatic update checks (only in packaged builds or test mode)
  if (app.isPackaged || isUpdateTestMode) {
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
