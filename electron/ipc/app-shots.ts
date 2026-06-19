import type { IpcMain } from 'electron';
import {
  captureAppShot,
  isAppShotsEnabled,
  resolveAppShotRef,
  resumeAppShotsHotkey,
  suspendAppShotsHotkey,
} from '../app-shots/manager.js';
import { getPlatformAdapter } from '../platform/index.js';
import { checkPlatformPermissions } from '../platform/permissions.js';

export function registerAppShotsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('app-shots:capture', () => {
    if (!isAppShotsEnabled()) throw new Error('App Shots is disabled in settings.');
    return captureAppShot();
  });
  ipcMain.handle('app-shots:suspend-hotkey', () => {
    suspendAppShotsHotkey();
    return { ok: true };
  });
  ipcMain.handle('app-shots:resume-hotkey', () => {
    resumeAppShotsHotkey();
    return { ok: true };
  });
  ipcMain.handle('app-shots:resolve-ref', (_event, refId: string) => resolveAppShotRef(refId));

  ipcMain.handle('platform:get-capabilities', async () => {
    const adapter = await getPlatformAdapter();
    return { kind: adapter.kind, capabilities: adapter.capabilities };
  });
  ipcMain.handle('platform:get-permissions', () => checkPlatformPermissions());
}
