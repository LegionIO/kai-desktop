/**
 * Platform capability IPC (#82, ADR-0005).
 *
 * Exposes the pure `getPlatformCapabilities()` result to the renderer so
 * settings UI can disable + explain features that aren't supported on the
 * current OS yet.
 */

import type { IpcMain } from 'electron';
import { getPlatformCapabilities, type PlatformCapabilities } from '../platform/capabilities.js';

export function registerPlatformHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('platform:get-feature-capabilities', (): PlatformCapabilities => getPlatformCapabilities());
}
