/**
 * Dictation overlay window — small floating bubble near the menu bar.
 *
 * Shows recording state, waveform level bars, elapsed time,
 * and expandable device picker.
 *
 * Key behavior: The overlay must be clickable (for stop/expand/device picker)
 * but must NOT steal focus from the user's active app. We achieve this by:
 * - Setting `focusable: false` on the BrowserWindow
 * - Using `setIgnoreMouseEvents(true, { forward: true })` as default
 * - The renderer detects mouseenter/mouseleave and toggles mouse acceptance
 *   via IPC so that clicks work when hovering but don't interfere otherwise
 */

import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { applyBrandUserAgent } from '../utils/user-agent.js';
import { setPaddedMacDockIcon } from '../utils/dock-icon.js';
import {
  beginDictationFocusSession,
  refreshDictationTargetFocus,
  restoreDictationTargetFocusSoon,
} from './focus-preserver.js';

const APP_ICON = join(import.meta.dirname, '../../build/icon.png');

let overlayWindow: BrowserWindow | null = null;
let ipcRegistered = false;

function ensureIpcHandlers(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  // Toggle mouse events — renderer sends this on mouseenter/mouseleave
  ipcMain.on('dictation:overlay-set-interactive', (event, interactive: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || win !== overlayWindow) return;
    if (interactive) {
      refreshDictationTargetFocus();
      win.setFocusable(false);
      win.setIgnoreMouseEvents(false);
      win.setFocusable(false);
    } else {
      win.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  // Resize request from renderer (e.g., when device picker expands)
  ipcMain.on('dictation:overlay-resize', (event, height: number) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || win !== overlayWindow) return;
    const bounds = win.getBounds();
    win.setBounds({ ...bounds, height: Math.max(52, Math.min(height, 400)) });
    restoreDictationTargetFocusSoon();
  });

  ipcMain.on('dictation:overlay-restore-focus', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || win !== overlayWindow) return;
    restoreDictationTargetFocusSoon();
  });
}

/**
 * Create the overlay window (hidden). Called once at init.
 */
export function createDictationOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;

  ensureIpcHandlers();

  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;

  // Position: top-right, 8px below work area top (below menu bar), 16px from right
  const width = 280;
  const height = 52;
  const x = workArea.x + workArea.width - width - 16;
  const y = workArea.y + 8;

  overlayWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    type: 'panel',
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'floating');
  overlayWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });

  // Start with click-through — renderer will toggle on hover
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  // Apply brand user agent
  applyBrandUserAgent(overlayWindow.webContents);

  // Load the renderer with dictation overlay query param
  loadOverlayRoute(overlayWindow);

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  // Safety: if the overlay ever receives focus (shouldn't with focusable:false),
  // immediately blur it to prevent the Electron app from activating and stealing
  // focus from the user's foreground app.
  overlayWindow.on('focus', () => {
    overlayWindow?.blur();
  });
}

/**
 * Show the overlay (dictation started).
 */
export async function showDictationOverlay(): Promise<void> {
  await beginDictationFocusSession();
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createDictationOverlay();
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // Reposition in case display changed
    repositionOverlay();
    setPaddedMacDockIcon(APP_ICON);
    overlayWindow.showInactive();
    restoreDictationTargetFocusSoon();
  }
}

/**
 * Hide the overlay (dictation stopped).
 */
export function hideDictationOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.hide();
    restoreDictationTargetFocusSoon();
  }
}

/**
 * Destroy the overlay window entirely.
 */
export function destroyDictationOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  overlayWindow = null;
}

/**
 * Send data to the overlay window.
 */
export function sendToOverlay(channel: string, data: unknown): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.webContents.send(channel, data);
    } catch { /* ignore */ }
  }
}

/**
 * Resize the overlay (e.g., when device picker is expanded).
 */
export function resizeDictationOverlay(height: number): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const bounds = overlayWindow.getBounds();
    overlayWindow.setBounds({ ...bounds, height });
  }
}

// ─── Private ─────────────────────────────────────────────────────────────────

function repositionOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;
  const bounds = overlayWindow.getBounds();

  const x = workArea.x + workArea.width - bounds.width - 16;
  const y = workArea.y + 8;

  overlayWindow.setPosition(x, y);
}

function loadOverlayRoute(win: BrowserWindow): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const rendererHtmlPath = join(import.meta.dirname, '../renderer/index.html');
  const query = { dictationOverlay: '1' };

  if (rendererUrl) {
    const targetUrl = new URL(rendererUrl);
    targetUrl.searchParams.set('dictationOverlay', '1');
    void win.loadURL(targetUrl.toString());
    return;
  }

  void win.loadFile(rendererHtmlPath, { query });
}
