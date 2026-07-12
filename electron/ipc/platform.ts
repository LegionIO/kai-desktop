/**
 * Platform capability IPC (#82, ADR-0005).
 *
 * Exposes the pure `getPlatformCapabilities()` result to the renderer so
 * settings UI can disable + explain features that aren't supported on the
 * current OS yet.
 */

import type { BrowserWindow, IpcMain } from 'electron';
import { getPlatformCapabilities, type PlatformCapabilities } from '../platform/capabilities.js';
import { setDockBadge, type DockBadgeStyle } from '../platform/dock-badge.js';

const DOCK_BADGE_STYLES: readonly DockBadgeStyle[] = ['dot', 'truncate', 'full'];

export function registerPlatformHandlers(ipcMain: IpcMain, getPrimaryWindow?: () => BrowserWindow | null): void {
  ipcMain.handle('platform:get-feature-capabilities', (): PlatformCapabilities => getPlatformCapabilities());

  // Renderer pushes the aggregate "attention" badge (sum of numeric plugin nav
  // badges + whether any text badge is present); main renders it on the OS app
  // icon (macOS Dock / Windows taskbar overlay / Linux Unity count). Validate the
  // payload at the boundary: count → non-negative finite int; style → known enum.
  ipcMain.handle('ui:set-dock-badge', (_event, payload: { count?: number; hasText?: boolean; style?: string }) => {
    const rawCount = payload?.count;
    const count = typeof rawCount === 'number' && Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : 0;
    const style: DockBadgeStyle = DOCK_BADGE_STYLES.includes(payload?.style as DockBadgeStyle)
      ? (payload!.style as DockBadgeStyle)
      : 'dot';
    setDockBadge(getPrimaryWindow?.() ?? null, { count, hasText: !!payload?.hasText, style });
  });
}
