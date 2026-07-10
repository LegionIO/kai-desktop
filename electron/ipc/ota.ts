/**
 * OTA IPC Handlers
 *
 * Exposes OTA update functionality to the renderer process via IPC.
 */

import type { IpcMain } from 'electron';
import { app } from 'electron';
import {
  checkForOtaUpdate,
  downloadOtaUpdate,
  applyOtaUpdate,
  getOtaStatus,
  isOtaReady,
  getReadyVersion,
  startOtaChecks,
  stopOtaChecks,
} from '../ota/ota-updater.js';
import { manualRollback, getOtaMeta } from '../ota/rollback.js';
import type { CodePaths } from '../ota/types.js';

/**
 * Register OTA-related IPC handlers.
 *
 * @param ipcMain - Electron IPC main
 * @param codePaths - The resolved code paths from bootstrap (to know current version)
 * @param appSlug - App slug (e.g. "kai")
 * @param shellVersion - The shell/base version of the installed .app
 */
export function registerOtaHandlers(
  ipcMain: IpcMain,
  codePaths: CodePaths,
  appSlug: string,
  shellVersion: string,
): void {
  // Manual check for OTA updates
  ipcMain.handle('ota:check', async () => {
    try {
      const available = await checkForOtaUpdate(appSlug, codePaths.codeVersion, shellVersion);
      return { ok: true, available };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OTA check failed';
      return { ok: false, error: message };
    }
  });

  // Download (and verify) an available OTA update
  ipcMain.handle('ota:download', async () => {
    try {
      const result = await downloadOtaUpdate(appSlug, codePaths.codeVersion, shellVersion);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OTA download failed';
      return { success: false, error: message };
    }
  });

  // Apply a staged OTA update (swap staging → current)
  ipcMain.handle('ota:apply', () => {
    const result = applyOtaUpdate(appSlug, codePaths.codeVersion);
    return result;
  });

  // Apply and restart the app
  ipcMain.handle('ota:apply-and-restart', () => {
    const result = applyOtaUpdate(appSlug, codePaths.codeVersion);
    if (result.success) {
      // Relaunch the app to load the new code
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 500);
    }
    return result;
  });

  // Get current OTA status
  ipcMain.handle('ota:status', () => {
    return {
      status: getOtaStatus(),
      ready: isOtaReady(),
      readyVersion: getReadyVersion(),
      meta: getOtaMeta(appSlug),
      currentCodeVersion: codePaths.codeVersion,
      shellVersion,
      isOverlay: codePaths.isOverlay,
    };
  });

  // Manual rollback to bundled code
  ipcMain.handle('ota:rollback', () => {
    const result = manualRollback(appSlug);
    if (result.success) {
      // Relaunch to load bundled code
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 500);
    }
    return result;
  });

  // Start automatic OTA checks
  startOtaChecks(
    appSlug,
    () => codePaths.codeVersion,
    () => shellVersion,
  );
}

/**
 * Cleanup OTA state on app quit.
 */
export function cleanupOta(): void {
  stopOtaChecks();
}
