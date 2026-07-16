import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { applyBrandUserAgent } from './utils/user-agent.js';
import { showMacDockWithPaddedIcon } from './utils/dock-icon.js';
import type { Alert } from './ipc/alert-store.js';

// TEMP debug instrumentation (notification window path). Remove once diagnosed.
const NOTIF_DEBUG_LOG = join(import.meta.dirname, '../../debug-logs/approval.log');
function notifDebug(msg: string): void {
  try {
    appendFileSync(NOTIF_DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* best-effort */
  }
}
/** Focused-window title for logs; defensive (BrowserWindow may be a test mock). */
function focusedWindowTitle(): string {
  try {
    return BrowserWindow.getFocusedWindow?.()?.getTitle?.() ?? 'none';
  } catch {
    return 'unknown';
  }
}

// Same app icon path as electron/main.ts + overlay-window.ts.
const APP_ICON = join(import.meta.dirname, '../build/icon.png');

/**
 * A dedicated pop-out window renders ANY actionable notification-tab item:
 *  - `tool-approval` — an interactive tool approval from a live chat
 *    (`ask_user` question form, or `exit_plan_mode`/generic approve-reject).
 *    Answered via the agent approve/reject/answer channels (resolves the awaiting
 *    turn in place).
 *  - `alert` — a persisted automation Alert (question/approval/fyi). Answered via
 *    the alerts channels (re-injects a new turn into the originating conversation).
 *
 * Both are keyed by a stable id and rendered by the same NotificationShell.
 */
export type NotificationWindowItem =
  | {
      source: 'tool-approval';
      /** The pending approval / ask_user id (the tool-approval-required toolCallId). */
      id: string;
      conversationId: string;
      toolName: string;
      /** Tool args — carries a `reason` (generic) or `questions` (ask_user). */
      args?: unknown;
    }
  | {
      source: 'alert';
      /** The alert id. */
      id: string;
      alert: Alert;
    };

/** Back-compat payload for the legacy approval-only entrypoint. */
export type ApprovalWindowRequest = {
  approvalId: string;
  conversationId: string;
  toolName: string;
  args?: unknown;
};

// Deduped by item id — a repeat request for the same id focuses the existing
// window instead of opening a second one.
const notificationWindows = new Map<string, BrowserWindow>();
// The item payload per open window id, so the renderer can PULL it on mount
// (notif:get) rather than racing the push on ready-to-show (the renderer's React
// effect may not have subscribed yet when we send — that dropped the payload and
// left the window spinning forever).
const notificationItems = new Map<string, NotificationWindowItem>();

function loadNotificationRoute(win: BrowserWindow, query: Record<string, string>): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const rendererHtmlPath = join(import.meta.dirname, '../renderer/index.html');

  // Swallow load rejections: a load can fail/abort (ERR_ABORTED) if the window
  // is closed or navigated while loading — that must not surface as an unhandled
  // promise rejection. The window is cleaned up via its 'closed' handler.
  const onLoadErr = (err: unknown): void => {
    if (!win.isDestroyed()) {
      console.warn('[notification-window] failed to load route:', err instanceof Error ? err.message : err);
    }
  };
  if (rendererUrl) {
    const targetUrl = new URL(rendererUrl);
    for (const [key, value] of Object.entries(query)) {
      targetUrl.searchParams.set(key, value);
    }
    win.loadURL(targetUrl.toString()).catch(onLoadErr);
    return;
  }
  win.loadFile(rendererHtmlPath, { query }).catch(onLoadErr);
}

function safelySend(win: BrowserWindow, channel: string, data: unknown): void {
  try {
    if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  } catch {
    // Window/frame disposed between check and send — ignore.
  }
}

/**
 * Grow the window to fit its rendered content, clamped to 75% of the display's
 * work area (and never smaller than the current size). Best-effort — any failure
 * leaves the base size. Re-centers horizontally so a wider window stays centered.
 */
async function autoSizeToContent(win: BrowserWindow, display: Electron.Display): Promise<void> {
  try {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    const measured = (await win.webContents.executeJavaScript(
      `({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })`,
    )) as { w?: number; h?: number };
    const [curW, curH] = win.getContentSize();
    const maxW = Math.floor(display.workArea.width * 0.75);
    const maxH = Math.floor(display.workArea.height * 0.75);
    const nextW = Math.min(Math.max(curW, Math.ceil(measured.w ?? curW)), maxW);
    const nextH = Math.min(Math.max(curH, Math.ceil(measured.h ?? curH)), maxH);
    if (nextW === curW && nextH === curH) return;
    win.setContentSize(nextW, nextH);
    // Re-center horizontally within the work area; keep the top offset.
    const [, y] = win.getPosition();
    const x = Math.round(display.workArea.x + (display.workArea.width - nextW) / 2);
    win.setPosition(x, y);
  } catch {
    // best-effort — leave the base size
  }
}

/**
 * Open (or focus) the dedicated notification window for an item. Idempotent per
 * item id. show() (focus-grab) so the user can answer immediately; the main
 * window is never touched, and focus returns to the prior window on close.
 */
export function openNotificationWindow(item: NotificationWindowItem): BrowserWindow {
  // Store the payload so the renderer can pull it on mount (notif:get).
  notificationItems.set(item.id, item);
  const existing = notificationWindows.get(item.id);
  if (existing && !existing.isDestroyed()) {
    // Re-send the payload (renderer may have mounted late) and surface it.
    safelySend(existing, 'notif:request', item);
    if (!existing.isVisible()) existing.showInactive();
    return existing;
  }

  const preloadPath = join(import.meta.dirname, '../preload/index.mjs');
  const primary = screen.getPrimaryDisplay();
  const width = 460;
  // Alerts (esp. multi-question) need more room than a generic approve/reject.
  const height =
    item.source === 'alert' || (item.source === 'tool-approval' && item.toolName === 'ask_user') ? 420 : 300;
  // Top-center of the primary display — visible without covering the main
  // window's content area.
  const x = Math.round(primary.workArea.x + (primary.workArea.width - width) / 2);
  const y = Math.round(primary.workArea.y + 64);

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Kai — needs your input',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  applyBrandUserAgent(win.webContents);

  // Float above normal windows across Spaces so it's answerable without
  // switching to the main window.
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadNotificationRoute(win, { notif: '1', notifId: item.id });
  notifDebug(
    `open source=${item.source} id=${item.id} ${item.source === 'tool-approval' ? `tool=${item.toolName} conv=${item.conversationId}` : `kind=${item.alert.kind}`} rendererUrl=${process.env.ELECTRON_RENDERER_URL ?? '(file)'} focusedBefore=${focusedWindowTitle()}`,
  );

  win.once('ready-to-show', () => {
    notifDebug(`ready-to-show id=${item.id}`);
    win.show();
    safelySend(win, 'notif:request', item);
    showMacDockWithPaddedIcon(APP_ICON);
    // Auto-size to fit the rendered content, capped at 75% of the work area. The
    // item arrives via notif:get on mount, so wait a couple frames for the shell
    // to render before measuring. Best-effort; failure leaves the base size.
    setTimeout(() => void autoSizeToContent(win, primary), 250);
  });

  win.on('closed', () => {
    notifDebug(`closed id=${item.id}`);
    // Identity-guard the delete: only clear the map entry if it still points at
    // THIS window, so a late 'closed' from a replaced window can't evict a newer
    // window registered under the same id.
    if (notificationWindows.get(item.id) === win) {
      notificationWindows.delete(item.id);
      notificationItems.delete(item.id);
    }
  });

  notificationWindows.set(item.id, win);
  return win;
}

/** Close the notification window for an id once it's resolved/aborted. Idempotent. */
export function closeNotificationWindow(id: string): void {
  const win = notificationWindows.get(id);
  notifDebug(`closeNotificationWindow id=${id} found=${Boolean(win && !win.isDestroyed())}`);
  notificationWindows.delete(id);
  notificationItems.delete(id);
  if (win && !win.isDestroyed()) win.destroy();
}

/** Close every notification window (app quit / conversation cancel). */
export function closeAllNotificationWindows(): void {
  for (const [id, win] of notificationWindows) {
    notificationWindows.delete(id);
    notificationItems.delete(id);
    if (!win.isDestroyed()) win.destroy();
  }
  notificationItems.clear();
}

export function hasNotificationWindow(id: string): boolean {
  const win = notificationWindows.get(id);
  return Boolean(win && !win.isDestroyed());
}

// ---------------------------------------------------------------------------
// Back-compat aliases (approval-only names) — kept for one release so existing
// call sites (ipc/agent.ts) + the `?approval=1` route keep working. New code
// should use the openNotificationWindow / closeNotificationWindow API.
// ---------------------------------------------------------------------------

export function openApprovalWindow(request: ApprovalWindowRequest): BrowserWindow {
  return openNotificationWindow({
    source: 'tool-approval',
    id: request.approvalId,
    conversationId: request.conversationId,
    toolName: request.toolName,
    args: request.args,
  });
}
export const closeApprovalWindow = closeNotificationWindow;
export const closeAllApprovalWindows = closeAllNotificationWindows;
export const hasApprovalWindow = hasNotificationWindow;

let closeIpcRegistered = false;
/**
 * Register the one IPC the notification window itself needs: a request from the
 * renderer to close its own window after it has posted the answer through the
 * existing agent approve/reject/answer or alerts channels. Call once at startup.
 */
export function registerNotificationWindowIpc(): void {
  if (closeIpcRegistered) return;
  closeIpcRegistered = true;
  const closeHandler = (_event: unknown, id: unknown): void => {
    if (typeof id === 'string' && id) closeNotificationWindow(id);
  };
  ipcMain.on('notif:close', closeHandler);
  // Back-compat channel (ApprovalShell during migration).
  ipcMain.on('approval:close', closeHandler);
  // Renderer pulls its item on mount — avoids the ready-to-show push racing the
  // renderer's not-yet-mounted subscription (which left the window spinning).
  ipcMain.handle('notif:get', (_event, id: unknown) =>
    typeof id === 'string' ? (notificationItems.get(id) ?? null) : null,
  );
}
/** Back-compat alias. */
export const registerApprovalWindowIpc = registerNotificationWindowIpc;
