import { app, dialog, type IpcMain } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { broadcastToAllWindows } from '../utils/window-send.js';
import { existsSync, writeFileSync, readFileSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
    const repo = process.env.KAI_UPDATE_REPO ?? __BRAND_UPDATE_REPO;
    const [owner, repoName] = repo.split('/');
    autoUpdater.setFeedURL({ provider: 'github', owner, repo: repoName });
    console.info(`[auto-update] TEST MODE: faking version ${DEV_TEST_VERSION}, repo ${repo}`);
  }
  // Reuse the SemVer constructor from the existing currentVersion instance
  // so we get a real SemVer object without importing semver directly
  // (pnpm doesn't hoist it).
  const SemVer = (
    autoUpdater.currentVersion as unknown as { constructor: new (v: string) => typeof autoUpdater.currentVersion }
  ).constructor;
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

/* ── Plugin Lifecycle Hook Runner ── */

export type UpdateHookRunner = {
  runPreUpdateHooks: (args: {
    version: string;
    artifactPath: string;
  }) => Promise<{ abort?: boolean; abortReason?: string }>;
  runPostUpdateHooks: (args: { version: string; success: boolean }) => Promise<void>;
};

let hookRunner: UpdateHookRunner | null = null;

export function setUpdateHookRunner(runner: UpdateHookRunner): void {
  hookRunner = runner;
}

/* ── Post-Update Marker ── */

const POST_UPDATE_MARKER = join(app.getPath('userData'), '.update-completed');

function writePostUpdateMarker(version: string): void {
  try {
    writeFileSync(
      POST_UPDATE_MARKER,
      JSON.stringify({
        version,
        fromVersion: app.getVersion(),
        timestamp: Date.now(),
      }),
    );
  } catch {
    /* non-fatal */
  }
}

/**
 * Consume the post-update marker file written before quitAndInstall().
 * Returns the update metadata if a marker existed, null otherwise.
 * Deletes the marker after reading.
 */
export function consumePostUpdateMarker(): { version: string; fromVersion: string } | null {
  try {
    if (!existsSync(POST_UPDATE_MARKER)) return null;
    const data = JSON.parse(readFileSync(POST_UPDATE_MARKER, 'utf-8'));
    unlinkSync(POST_UPDATE_MARKER);
    return data;
  } catch {
    try {
      unlinkSync(POST_UPDATE_MARKER);
    } catch {
      /* */
    }
    return null;
  }
}

/**
 * Install the downloaded update.
 *
 * Flow:
 * 1. Run pre-update hooks (e.g., elevate to admin via Privileges.app)
 * 2. Write a marker file so post-update hooks fire after relaunch
 * 3. Delegate to autoUpdater.quitAndInstall() (Squirrel.Mac handles
 *    extract + replace + relaunch atomically)
 */
export async function performQuitAndInstall(): Promise<void> {
  // Run pre-update hooks (e.g., elevate to admin)
  if (hookRunner) {
    broadcast({ state: 'preparing', version: downloadedVersion });
    try {
      const result = await hookRunner.runPreUpdateHooks({
        version: downloadedVersion ?? 'unknown',
        artifactPath: downloadedFilePath ?? '',
      });
      if (result.abort) {
        console.info('[auto-update] Pre-update hook aborted install:', result.abortReason ?? '(no reason)');
        broadcast({ state: 'downloaded', version: downloadedVersion });
        return;
      }
    } catch (err) {
      console.error('[auto-update] Pre-update hooks threw, aborting install:', err);
      broadcast({ state: 'downloaded', version: downloadedVersion });
      return;
    }
  }

  // Write marker so post-update hooks fire after relaunch
  writePostUpdateMarker(downloadedVersion ?? 'unknown');

  broadcast({ state: 'restarting', version: downloadedVersion });

  // Let Squirrel.Mac handle extract + replace + relaunch
  autoUpdater.quitAndInstall(false, true);
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
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: `A new version of ${__BRAND_PRODUCT_NAME} is ready to install.`,
        detail:
          `${__BRAND_PRODUCT_NAME} ${downloadedVersion ?? ''} has been downloaded. Would you like to restart now to finish updating?`.trim(),
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
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
let downloadedFilePath: string | undefined;
let pendingVersion: string | undefined;

export function registerAutoUpdateHandlers(ipcMain: IpcMain, onUpdateDownloaded?: () => void): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
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
    // electron-updater sets `downloadedFile` to the absolute path of the
    // staged artifact. Capture it so pre-update hooks can reference the path.
    const maybeFile = (info as { downloadedFile?: unknown }).downloadedFile;
    if (typeof maybeFile === 'string' && maybeFile.length > 0) {
      downloadedFilePath = maybeFile;
    }
    broadcast({ state: 'downloaded', version: info.version });
    onUpdateDownloaded?.();
  });
  autoUpdater.on('error', (err) => {
    console.error('[auto-update] Error:', err.message);
    // Squirrel.Mac leaves the extracted bundle in ~/Library/Caches/<appId>.ShipIt
    // when validation fails (e.g. a published zip with dereferenced framework
    // symlinks). Every subsequent check then re-fails on that stale extract
    // before it even re-downloads. Clear it so a fixed release can land.
    if (process.platform === 'darwin' && /SQRL|Code signature|ShipIt/i.test(err.message)) {
      const shipItCache = join(homedir(), 'Library', 'Caches', `${__BRAND_APP_ID}.ShipIt`);
      try {
        rmSync(shipItCache, { recursive: true, force: true });
        console.info('[auto-update] Cleared stale ShipIt cache:', shipItCache);
      } catch {
        /* non-fatal */
      }
    }
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
