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

/* ── Plugin Lifecycle Hook Runner ── */

export type UpdateHookRunner = {
  runPreUpdateHooks: (args: { version: string; artifactPath: string }) => Promise<{ abort?: boolean; abortReason?: string }>;
  runPostUpdateHooks: (args: { version: string; success: boolean }) => Promise<void>;
};

let hookRunner: UpdateHookRunner | null = null;

export function setUpdateHookRunner(runner: UpdateHookRunner): void {
  hookRunner = runner;
}

/**
 * Escape a string for safe interpolation inside a POSIX single-quoted shell argument.
 * Single quotes cannot appear inside single-quoted strings, so we close the quote,
 * insert an escaped quote, then reopen the quote: ' → '\''
 */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Locate the staged update artifact on disk.
 *
 * Preferred source: the `downloadedFile` path captured from the
 * `update-downloaded` event — that is the exact, authoritative path
 * electron-updater wrote the artifact to.
 *
 * Fallback: scan both possible cache directories for a .zip artifact.
 * electron-updater places pending artifacts under
 * `~/Library/Caches/<updaterCacheDirName>/pending/`, where
 * `updaterCacheDirName` comes from `app-update.yml` (for this app,
 * "kai-updater"). Older assumptions pointed at `app.getName()` ("Kai")
 * with a hardcoded `update.zip` filename — both of which are wrong on a
 * real notarized build, which is why Install Update was silently failing.
 * We try the correct path first, then the legacy guess, before giving up.
 */
function resolveDownloadedUpdatePath(): string | null {
  if (downloadedFilePath && existsSync(downloadedFilePath)) {
    return downloadedFilePath;
  }

  const homedir = app.getPath('home');
  const candidateDirs = [
    // Correct location per app-update.yml (updaterCacheDirName: kai-updater).
    join(homedir, 'Library', 'Caches', 'kai-updater', 'pending'),
    // Legacy guess we used to hardcode — kept only as a last-ditch fallback.
    join(homedir, 'Library', 'Caches', app.getName(), 'pending'),
  ];

  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir);
      // Prefer the real release artifact (e.g. "Kai-1.0.68-arm64.zip");
      // fall back to the old hardcoded filename if present.
      const zips = entries.filter((e) => e.endsWith('.zip'));
      const preferred = zips.find((e) => e !== 'update.zip') ?? zips.find((e) => e === 'update.zip');
      if (preferred) return join(dir, preferred);
    } catch {
      /* ignore and try next candidate */
    }
  }

  return null;
}

/**
 * Attempt to install the downloaded update by extracting the zip and replacing
 * the app bundle.
 *
 * Strategy:
 * 1. Try a plain shell move (works if user is already elevated to admin via
 *    Privileges.app or similar).
 * 2. If that fails with a permission error, fall back to osascript with
 *    administrator privileges (triggers the macOS password prompt).
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

  const zipPath = resolveDownloadedUpdatePath();
  if (!zipPath) {
    console.error('[auto-update] Cannot find downloaded update artifact. Checked downloadedFile event payload and both ~/Library/Caches/kai-updater/pending/ and ~/Library/Caches/Kai/pending/.');
    return false;
  }
  console.info('[auto-update] Installing from artifact:', zipPath);

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

    // The shell commands to replace the app bundle:
    // 1. Rename current app to backup
    // 2. Move new app into place
    // 3. Remove backup on success
    const moveCommands = [
      `mv '${shellEscape(appDir)}/${shellEscape(appName)}' '${shellEscape(appDir)}/${shellEscape(appName)}.old'`,
      `mv '${shellEscape(extractedApp)}' '${shellEscape(appDir)}/${shellEscape(appName)}'`,
      `rm -rf '${shellEscape(appDir)}/${shellEscape(appName)}.old'`,
    ].join(' && ');

    // --- Phase 1: Try plain shell (works if user is already admin) ---
    try {
      await execFileAsync('/bin/sh', ['-c', moveCommands]);
      console.info('[auto-update] Install succeeded via plain shell (user already has write access)');
      return true;
    } catch (plainErr: unknown) {
      const plainError = plainErr as { stderr?: string; message?: string };
      const plainMsg = plainError.stderr || plainError.message || '';
      // Only fall through to osascript if this looks like a permission error
      if (!plainMsg.includes('Permission denied') && !plainMsg.includes('Operation not permitted') && !plainMsg.includes('Read-only file system')) {
        // Some other error — attempt restore and bail
        console.error('[auto-update] Plain install failed (non-permission):', plainMsg);
        await attemptRestore(appDir, appName);
        return false;
      }
      console.info('[auto-update] Plain shell failed with permission error, falling back to osascript');
    }

    // --- Phase 2: Fall back to osascript with administrator privileges ---
    // Re-check state: if Phase 1 partially ran (moved to .old but failed on second mv),
    // we need to restore before retrying with admin.
    const backupExists = existsSync(join(appDir, `${appName}.old`));
    const appExists = existsSync(join(appDir, appName));
    let adminCommands: string;
    if (backupExists && !appExists) {
      // Phase 1 partially succeeded: .old exists but app doesn't. Restore first, then redo all.
      adminCommands = [
        `mv '${shellEscape(appDir)}/${shellEscape(appName)}.old' '${shellEscape(appDir)}/${shellEscape(appName)}'`,
        moveCommands,
      ].join(' && ');
    } else if (backupExists && appExists) {
      // Phase 1 rename succeeded but second mv failed — the original is at .old, something is at the app path.
      // Clean up and redo.
      adminCommands = [
        `rm -rf '${shellEscape(appDir)}/${shellEscape(appName)}'`,
        `mv '${shellEscape(appDir)}/${shellEscape(appName)}.old' '${shellEscape(appDir)}/${shellEscape(appName)}'`,
        moveCommands,
      ].join(' && ');
    } else {
      adminCommands = moveCommands;
    }

    const script = `do shell script "${adminCommands}" with administrator privileges`;

    try {
      await execFileAsync('osascript', ['-e', script]);
      console.info('[auto-update] Install succeeded via osascript admin fallback');
      return true;
    } catch (err: unknown) {
      const error = err as { stderr?: string; message?: string };
      const msg = error.stderr || error.message || '';
      if (msg.includes('User canceled') || msg.includes('user canceled')) {
        console.info('[auto-update] User cancelled admin authorization — will retry when ready');
      } else {
        console.error('[auto-update] osascript install failed:', msg);
        await attemptRestore(appDir, appName);
      }
      return false;
    }
  } finally {
    // Cleanup temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}

/**
 * Attempt to restore the app bundle from its .old backup after a failed install.
 */
async function attemptRestore(appDir: string, appName: string): Promise<void> {
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

/**
 * Attempt to install the update, keeping the app running until we get
 * definitive success/failure feedback.
 *
 * Flow:
 * 1. Run pre-update hooks (e.g., elevate to admin via Privileges.app)
 * 2. Attempt install (plain shell first, osascript fallback)
 * 3. Run post-update hooks (e.g., revoke admin privileges)
 * 4. On success: relaunch the app on the new version
 * 5. On failure: return to 'downloaded' state so the user can retry
 */
export async function performQuitAndInstall(): Promise<void> {
  const artifactPath = resolveDownloadedUpdatePath();

  // Run pre-update hooks (e.g., elevate to admin)
  if (hookRunner && artifactPath) {
    broadcast({ state: 'preparing', version: downloadedVersion });
    try {
      const result = await hookRunner.runPreUpdateHooks({
        version: downloadedVersion ?? 'unknown',
        artifactPath,
      });
      if (result.abort) {
        console.info('[auto-update] Pre-update hook aborted install:', result.abortReason ?? '(no reason)');
        broadcast({ state: 'downloaded', version: downloadedVersion });
        return;
      }
    } catch (err) {
      console.error('[auto-update] Pre-update hooks threw, continuing with install:', err);
    }
  }

  broadcast({ state: 'installing', version: downloadedVersion });

  const success = await attemptInstall();

  // Run post-update hooks (e.g., revoke admin privileges)
  if (hookRunner) {
    try {
      await hookRunner.runPostUpdateHooks({
        version: downloadedVersion ?? 'unknown',
        success,
      });
    } catch (err) {
      console.error('[auto-update] Post-update hooks threw:', err);
    }
  }

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
let downloadedFilePath: string | undefined;
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
    // electron-updater sets `downloadedFile` to the absolute path of the
    // staged artifact. Capture it so attemptInstall() can use it directly
    // instead of guessing the cache location + filename.
    const maybeFile = (info as { downloadedFile?: unknown }).downloadedFile;
    if (typeof maybeFile === 'string' && maybeFile.length > 0) {
      downloadedFilePath = maybeFile;
    }
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
