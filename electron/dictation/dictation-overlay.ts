/**
 * Dictation overlay window — small floating bubble near the menu bar.
 *
 * Shows recording state, waveform level bars, elapsed time,
 * and expandable device picker.
 *
 * Key behavior: The overlay must be clickable (for stop/expand/device picker)
 * but must NOT steal focus from the user's active app. We achieve this by:
 * - Setting `focusable: false` on the BrowserWindow
 * - Resetting mouse acceptance every time the hidden window is shown
 * - The renderer detects mouseenter/mouseleave and keeps click-through state
 *   in sync while the overlay is visible.
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

  // Position: top-center, 8px below work area top (below menu bar)
  const width = 280;
  const height = 52;
  const x = workArea.x + Math.round((workArea.width - width) / 2);
  const y = workArea.y + 8;

  overlayWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    type: 'panel',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // macOS panels can keep a hidden titlebar hit region when native rounded
    // corners are enabled. That region activates Kai on click, which briefly
    // raises the main window. CSS supplies the bubble rounding instead.
    roundedCorners: false,
    acceptFirstMouse: true,
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

  // Hidden windows start click-through. showDictationOverlay() makes the reused
  // window interactive again before showing, because the renderer may not emit a
  // new mouseenter if the window was hidden while hovered.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  // Apply brand user agent
  applyBrandUserAgent(overlayWindow.webContents);

  // Load the renderer with dictation overlay query param
  loadOverlayRoute(overlayWindow);

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  // Safety: if the overlay ever receives focus (shouldn't with focusable:false),
  // immediately restore focus to the user's target app. We avoid calling blur()
  // here because that activates the Electron app (bringing the main window
  // forward briefly) before the AppleScript focus-restore can fire.
  overlayWindow.on('focus', () => {
    restoreDictationTargetFocusSoon();
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
    overlayWindow.setFocusable(false);
    overlayWindow.setIgnoreMouseEvents(false);
    overlayWindow.setFocusable(false);
    overlayWindow.showInactive();
    restoreDictationTargetFocusSoon();
  }
}

/**
 * Hide the overlay (dictation stopped).
 */
export function hideDictationOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      overlayWindow.hide();
    } catch {
      try { overlayWindow.destroy(); } catch { /* ignore */ }
      overlayWindow = null;
    }
    restoreDictationTargetFocusSoon();
  }
}

/**
 * Destroy the overlay window entirely.
 */
export function destroyDictationOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      overlayWindow.hide();
      overlayWindow.destroy();
    } catch {
      try { overlayWindow.close(); } catch { /* ignore */ }
    }
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

  const x = workArea.x + Math.round((workArea.width - bounds.width) / 2);
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
